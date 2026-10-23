"""Filters, sorting and queries, compiled to one SQLite SELECT over ``tb_rows``.

Ported from puddle's query designer (``src/compiler/query.ts``), which works
like Access's: a grid of fields, each with Show, Sort and criteria. The
Criteria row and the "or" rows below it are ORed, and each row's conditions
are ANDed: ``(a AND b) OR (c)``. With the Totals row on, the same SELECT groups
and summarises: Where fields filter rows before grouping, and criteria on the
other fields filter the groups (HAVING). A summary is named as Access names
it, SumOfAmount, unless renamed.

The datasheet's own filter and sort bar compiles through the same code: its
filters become one criteria row (match all) or one row each (match any).

Values only ever reach SQL as parameters. Field ids are integers, so the JSON
paths built from them are safe to write into the SQL.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Literal

from . import types as ft

CRITERIA_OPS: dict[str, dict] = {
    "=": {"label": "Equals", "value": True},
    "<>": {"label": "Isn't", "value": True},
    "<": {"label": "Less than", "value": True},
    "<=": {"label": "At most", "value": True},
    ">": {"label": "More than", "value": True},
    ">=": {"label": "At least", "value": True},
    "contains": {"label": "Contains", "value": True},
    "notContains": {"label": "Doesn't contain", "value": True},
    "starts": {"label": "Starts with", "value": True},
    "ends": {"label": "Ends with", "value": True},
    "empty": {"label": "Is empty", "value": False},
    "notEmpty": {"label": "Isn't empty", "value": False},
}
COMPARE = {"=", "<>", "<", "<=", ">", ">="}

TOTALS: dict[str, dict] = {
    "group": {"label": "Group by"},
    "sum": {"label": "Sum", "prefix": "Sum", "sql": "sum({})", "numeric": True},
    "avg": {"label": "Average", "prefix": "Avg", "sql": "avg({})", "numeric": True},
    "min": {"label": "Min", "prefix": "Min", "sql": "min({})"},
    "max": {"label": "Max", "prefix": "Max", "sql": "max({})"},
    "count": {"label": "Count", "prefix": "Count", "sql": "count({})"},
    "where": {"label": "Where"},
}

MAX_OR_ROWS = 20
MAX_PAGE = 1000

Ref = int | Literal["id"]


class QueryError(ValueError):
    """A query that can't run; the message says why, in the user's terms."""


@dataclass(frozen=True)
class Field:
    id: int
    name: str
    type: str
    options: dict
    # For a link field: the linked table's naming field (id and type), if it has one.
    link_primary: tuple[int, str] | None = None


ID_FIELD = Field(id=0, name="ID", type="number", options={"decimals": 0})


@dataclass
class Criterion:
    op: str
    value: str = ""


@dataclass
class GridField:
    """One column of the query designer's grid."""

    ref: Ref
    show: bool = True
    sort: str = "none"
    criteria: Criterion | None = None
    # The "or" rows' conditions, in order; None where a row has none for this field.
    or_: list[Criterion | None] = field(default_factory=list)
    total: str | None = None
    name: str = ""


@dataclass
class Design:
    fields: list[GridField]
    or_rows: int = 0
    totals: bool = False
    limit: int | None = None
    search: str = ""
    # Sorting with no field in the grid (the datasheet sorts on any field).
    extra_sort: list[tuple[Ref, str]] = field(default_factory=list)


@dataclass
class Column:
    key: str
    name: str
    field: Field | None
    type: str
    options: dict
    editable: bool


@dataclass
class Compiled:
    sql: str
    params: list[Any]
    count_sql: str
    count_params: list[Any]
    columns: list[Column]
    grouped: bool


# ------------------------------------------------------------- parsing specs


def _criterion(raw: Any) -> Criterion | None:
    if not isinstance(raw, dict):
        return None
    op = raw.get("op")
    if op not in CRITERIA_OPS:
        return None
    value = str(raw.get("value") if raw.get("value") is not None else "")
    if CRITERIA_OPS[op]["value"] and not value.strip():
        return None
    return Criterion(op=op, value=value)


def _ref(raw: Any) -> Ref | None:
    if raw == "id":
        return "id"
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _dir(raw: Any) -> str:
    return raw if raw in ("asc", "desc") else "none"


def design_from_spec(spec: dict) -> Design:
    """A saved query's spec (as the designer writes it) read into a Design."""
    fields = []
    for raw in spec.get("fields") or []:
        if not isinstance(raw, dict) or (ref := _ref(raw.get("field"))) is None:
            continue
        total = raw.get("total") if raw.get("total") in TOTALS else None
        fields.append(
            GridField(
                ref=ref,
                show=bool(raw.get("show", True)),
                sort=_dir(raw.get("sort")),
                criteria=_criterion(raw.get("criteria")),
                or_=[_criterion(c) for c in (raw.get("or") or [])[:MAX_OR_ROWS]],
                total=total,
                name=str(raw.get("name") or "").strip()[:100],
            )
        )
    try:
        limit = int(spec["limit"]) if spec.get("limit") else None
    except (TypeError, ValueError):
        limit = None
    return Design(
        fields=fields,
        or_rows=max(0, min(MAX_OR_ROWS, int(spec.get("or_rows") or 0))),
        totals=bool(spec.get("totals")),
        limit=limit if limit and limit > 0 else None,
    )


def design_from_view(view: dict, all_fields: list[Field]) -> Design:
    """The datasheet's filter and sort bar as a Design that shows every field.

    ``filters`` match all (one criteria row) or any (a row each); ``sort`` is a
    list of ``{field, dir}``; ``search`` looks for text in every field.
    """
    filters = [
        (ref, crit)
        for raw in view.get("filters") or []
        if isinstance(raw, dict)
        and (ref := _ref(raw.get("field"))) is not None
        and (crit := _criterion(raw)) is not None
    ]
    any_ = view.get("match") == "any"
    grid = [GridField(ref="id", show=False)] + [GridField(ref=f.id) for f in all_fields]
    by_ref = {g.ref: g for g in grid}
    rows = len(filters) if any_ else 1
    for i, (ref, crit) in enumerate(filters):
        target = by_ref.get(ref)
        if target is None:
            continue
        row = i if any_ else 0
        if row == 0:
            if target.criteria is not None:
                # Two filters on one field, matching all: put the second in its own grid column.
                extra = GridField(ref=ref, show=False, criteria=crit)
                grid.append(extra)
            else:
                target.criteria = crit
        else:
            while len(target.or_) < row:
                target.or_.append(None)
            target.or_[row - 1] = crit
    sort = [
        (ref, _dir(raw.get("dir")))
        for raw in view.get("sort") or []
        if isinstance(raw, dict) and (ref := _ref(raw.get("field"))) is not None
    ]
    return Design(
        fields=grid,
        or_rows=max(0, rows - 1),
        search=str(view.get("search") or "").strip()[:200],
        extra_sort=[(r, d) for r, d in sort if d != "none"],
    )


# ----------------------------------------------------------------- compiling


def _criteria_cell(f: GridField, row: int) -> Criterion | None:
    if row == 0:
        return f.criteria
    return f.or_[row - 1] if row - 1 < len(f.or_) else None


def _path(field_id: int) -> str:
    return f"'$.\"{int(field_id)}\"'"


def value_sql(f: Field, alias: str = "r") -> str:
    """The SQL for a field's value in a row (a link field's: the linked row's name)."""
    if f is ID_FIELD:
        return f"{alias}.number"
    raw = f"json_extract({alias}.data, {_path(f.id)})"
    if f.type == "checkbox":
        return f"coalesce({raw}, 0)"  # an empty box is a No
    if f.type != "link":
        return raw
    if f.link_primary is None:
        name = "l.number"
    else:
        pid, ptype = f.link_primary
        name = "l.number" if ptype == "link" else f"json_extract(l.data, {_path(pid)})"
    return f"(SELECT {name} FROM tb_rows l WHERE l.id = {raw})"


def _family(f: Field) -> str:
    if f.type == "link":
        return "number" if f.link_primary is None else ft.sort_family(f.link_primary[1])
    return ft.sort_family(f.type)


def _like(value: str, start: bool, end: bool) -> str:
    escaped = value.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{'%' if start else ''}{escaped}{'%' if end else ''}"


def criterion_sql(term: str, family: str, c: Criterion, label: str) -> tuple[str, list[Any]]:
    """A criterion as a SQL condition on ``term``, whose values compare as ``family``."""
    value = c.value.strip()
    text = f"lower(CAST({term} AS TEXT))"
    if c.op == "empty":
        if family == "checkbox":
            return f"coalesce({term}, 0) = 0", []
        return f"({term} IS NULL OR trim(CAST({term} AS TEXT)) = '')", []
    if c.op == "notEmpty":
        if family == "checkbox":
            return f"coalesce({term}, 0) <> 0", []
        return f"({term} IS NOT NULL AND trim(CAST({term} AS TEXT)) <> '')", []
    if c.op in ("contains", "notContains", "starts", "ends"):
        pattern = _like(
            value, start=c.op in ("contains", "notContains", "ends"), end=c.op != "ends"
        )
        if c.op == "notContains":
            return f"({term} IS NULL OR {text} NOT LIKE ? ESCAPE '\\')", [pattern]
        return f"{text} LIKE ? ESCAPE '\\'", [pattern]
    # Comparisons: the value is read as the field's kind of value.
    if family == "checkbox":
        try:
            want = ft.parse_bool(value)
        except ft.InvalidValue:
            raise QueryError(f"{label} is a yes/no field, so compare it with Yes or No.") from None
        if c.op not in ("=", "<>"):
            raise QueryError(f"{label} is a yes/no field: it can only equal Yes or No.")
        if c.op == "<>":
            want = not want
        return f"coalesce({term}, 0) = ?", [1 if want else 0]
    if family == "number":
        try:
            param: Any = ft.parse_number(value)
        except ft.InvalidValue:
            raise QueryError(f"{label} holds numbers, and {value} isn't one.") from None
        lhs = term
    elif family == "date":
        try:
            param = ft.parse_datetime(value) if ":" in value else ft.parse_date(value)
        except ft.InvalidValue as exc:
            raise QueryError(f"{label}: {exc}") from None
        # A date with no time matches every time that day.
        lhs = term if len(param) > 10 else f"substr({term}, 1, 10)"
    else:
        param, lhs = value.lower(), text
    if c.op == "<>":
        return f"({term} IS NULL OR {lhs} <> ?)", [param]
    return f"{lhs} {c.op} ?", [param]


def _order_sql(term: str, family: str, direction: str) -> str:
    collate = " COLLATE NOCASE" if family == "text" else ""
    return f"({term} IS NULL), {term}{collate} {'DESC' if direction == 'desc' else 'ASC'}"


def default_names(design: Design, fields: dict[int, Field]) -> list[str]:
    """Each grid field's name unless renamed: the field's own, or SumOfAmount for a summary."""
    names = []
    for g in design.fields:
        f = _resolve(g.ref, fields)
        total = g.total if design.totals else None
        prefix = TOTALS[total].get("prefix") if total else None
        names.append(g.name or (f"{prefix}Of{f.name}" if prefix else f.name))
    return names


def _resolve(ref: Ref, fields: dict[int, Field]) -> Field:
    if ref == "id":
        return ID_FIELD
    f = fields.get(ref)  # type: ignore[arg-type]
    if f is None:
        raise QueryError("The query uses a field that has been deleted. Take it out of the grid.")
    return f


def compile_design(
    table_id: int, design: Design, fields: dict[int, Field], offset: int = 0, limit: int = 200
) -> Compiled:
    """The design as a SELECT (and a COUNT) over the table's rows."""
    totals = design.totals
    grid = [(g, _resolve(g.ref, fields)) for g in design.fields]
    names = default_names(design, fields)

    def total_of(g: GridField) -> str | None:
        return (g.total or "group") if totals else None

    def term(g: GridField, f: Field) -> str:
        base = value_sql(f)
        total = total_of(g)
        sql = TOTALS[total].get("sql") if total else None
        return sql.format(base) if sql else base

    def family(g: GridField, f: Field) -> str:
        total = total_of(g)
        return "number" if total in ("count", "sum", "avg") else _family(f)

    for g, f in grid:
        total = total_of(g)
        if total and TOTALS[total].get("numeric") and _family(f) != "number":
            raise QueryError(
                f"{TOTALS[total]['label']} needs numbers, and {f.name} isn't a number field. "
                "Pick Count, Min or Max for it."
            )
        if total == "where":
            if g.show:
                g.show = False
            if not any(_criteria_cell(g, r) for r in range(design.or_rows + 1)):
                raise QueryError(f"{f.name} is a Where field, so give it criteria to filter on.")

    # Criteria: each row's conditions ANDed, the rows ORed; Where fields (or any
    # field, without totals) in WHERE, summaries and groups in HAVING.
    rows = []
    for row in range(design.or_rows + 1):
        parts: dict[str, list[tuple[str, list]]] = {"where": [], "having": []}
        for g, f in grid:
            c = _criteria_cell(g, row)
            if c is None:
                continue
            total = total_of(g)
            place = "where" if not total or total == "where" else "having"
            # A Where field filters the rows themselves, not a summary of them.
            t = value_sql(f) if total == "where" else term(g, f)
            fam = _family(f) if total == "where" else family(g, f)
            parts[place].append(criterion_sql(t, fam, c, f.name))
        if parts["where"] or parts["having"]:
            rows.append(parts)

    def joined(conds: list[tuple[str, list]]) -> tuple[str, list]:
        return " AND ".join(s for s, _ in conds), [p for _, ps in conds for p in ps]

    def ored(part_rows: list[list[tuple[str, list]]]) -> list[tuple[str, list]]:
        if any(not p for p in part_rows):
            return []  # a row with no conditions here matches everything
        if len(part_rows) == 1:
            return part_rows[0]
        sqls, params = [], []
        for p in part_rows:
            s, ps = joined(p)
            sqls.append(f"({s})")
            params.extend(ps)
        return [(" OR ".join(sqls), params)]

    if not rows:
        where, having = [], []
    elif all(not r["having"] for r in rows):
        where, having = ored([r["where"] for r in rows]), []
    elif all(not r["where"] for r in rows):
        where, having = [], ored([r["having"] for r in rows])
    elif all(joined(r["where"]) == joined(rows[0]["where"]) for r in rows):
        where, having = rows[0]["where"], ored([r["having"] for r in rows])
    else:
        raise QueryError(
            "Each criteria row has different Where conditions, which can't be split between "
            "the rows and the groups. Give every row the same Where criteria."
        )

    # Search: the words anywhere in the row's text.
    where = list(where)
    if design.search:
        searched = [ID_FIELD, *fields.values()]
        pattern = _like(design.search, True, True)
        cond = " OR ".join(
            f"lower(CAST({value_sql(f)} AS TEXT)) LIKE ? ESCAPE '\\'" for f in searched
        )
        where.append((f"({cond})", [pattern] * len(searched)))

    where_sql, where_params = joined(where) if where else ("", [])
    having_sql, having_params = joined(having) if having else ("", [])

    shown = [(i, g, f) for i, (g, f) in enumerate(grid) if g.show]
    columns: list[Column] = []
    select: list[str] = []
    seen_keys: set[str] = set()
    for i, g, f in shown:
        total = total_of(g)
        if totals:
            key = f"c{i}"
        else:
            key = "id" if f is ID_FIELD else str(f.id)
            if key in seen_keys:
                continue
        seen_keys.add(key)
        result_type, options = f.type, f.options
        if total == "count":
            result_type, options = "number", {"decimals": 0}
        elif total == "avg":
            options = {**f.options, "decimals": f.options.get("decimals", 2)}
        if totals:
            # Grouped results are new values: a link field's group is its linked row's name.
            if f.type == "link":
                result_type, options = "text", {}
            select.append(f"{term(g, f)} AS {key}")
        columns.append(
            Column(
                key=key,
                name=names[i],
                field=None if totals or f is ID_FIELD else f,
                type=result_type,
                options=options,
                editable=not totals and f is not ID_FIELD,
            )
        )

    order = [
        _order_sql(term(g, f), family(g, f), g.sort) for g, f in grid if g.sort in ("asc", "desc")
    ]
    if not totals:
        for ref, direction in design.extra_sort:
            f = _resolve(ref, fields)
            order.append(_order_sql(value_sql(f), _family(f), direction))
        order.append("r.number")

    base_from = "FROM tb_rows r WHERE r.table_id = ?"
    base_params: list[Any] = [table_id]
    if where_sql:
        base_from += f" AND {where_sql}"
        base_params += where_params

    if totals:
        groups = list(dict.fromkeys(value_sql(f) for g, f in grid if total_of(g) == "group"))
        body = f"SELECT {', '.join(select) or 'count(*) AS c'} {base_from}"
        if groups:
            body += f" GROUP BY {', '.join(groups)}"
        if having_sql:
            body += f" HAVING {having_sql}"
        params = base_params + having_params
    else:
        body = f"SELECT r.id, r.number, r.data {base_from}"
        params = base_params
    if design.limit:
        body = f"SELECT * FROM ({body}{' ORDER BY ' + ', '.join(order) if order else ''}"
        body += f" LIMIT {int(design.limit)})"
        # The outer query keeps the inner order.
        ordered = body
        count_sql = f"SELECT count(*) FROM ({body})"
    else:
        ordered = body + (f" ORDER BY {', '.join(order)}" if order else "")
        count_sql = f"SELECT count(*) FROM ({body})"
    page = max(1, min(MAX_PAGE, int(limit)))
    sql = f"{ordered} LIMIT {page} OFFSET {max(0, int(offset))}"
    return Compiled(
        sql=sql,
        params=params,
        count_sql=count_sql,
        count_params=list(params),
        columns=columns,
        grouped=totals,
    )


def run(conn: sqlite3.Connection, compiled: Compiled) -> tuple[int, list[sqlite3.Row]]:
    try:
        total = conn.execute(compiled.count_sql, compiled.count_params).fetchone()[0]
        rows = conn.execute(compiled.sql, compiled.params).fetchall()
    except sqlite3.OperationalError as exc:  # pragma: no cover - a bug, not the user's
        raise QueryError(f"The query couldn't run ({exc}).") from exc
    return total, rows
