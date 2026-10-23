"""Reading and writing a Tables database: its tables, fields, rows and saved objects."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from typing import Any

from ..db import utcnow
from . import EXTENSION, MIME_TYPE
from . import types as ft
from .query import Field

__all__ = ["EXTENSION", "MIME_TYPE"]
DUMP_FORMAT = "markdown-studio.tables"


def is_database(mime_type: str) -> bool:
    return mime_type == MIME_TYPE


# ---------------------------------------------------------------- database


def bump(conn: sqlite3.Connection, file_id: int) -> int:
    """Record a change: open copies see the new revision and fetch again."""
    now = utcnow()
    conn.execute("UPDATE tb_databases SET revision = revision + 1 WHERE file_id = ?", (file_id,))
    conn.execute("UPDATE files SET updated_at = ? WHERE id = ?", (now, file_id))
    return revision(conn, file_id)


def revision(conn: sqlite3.Connection, file_id: int) -> int:
    row = conn.execute("SELECT revision FROM tb_databases WHERE file_id = ?", (file_id,)).fetchone()
    return row["revision"] if row else 0


def ensure_database(conn: sqlite3.Connection, file_id: int) -> None:
    """Set up a database file the first time it's opened.

    A ``.tables`` file that was uploaded (an export from Tables) is restored
    from its contents; one made in Tables starts with nothing in it.
    """
    if conn.execute("SELECT 1 FROM tb_databases WHERE file_id = ?", (file_id,)).fetchone():
        return
    conn.execute("INSERT OR IGNORE INTO tb_databases (file_id) VALUES (?)", (file_id,))
    content = conn.execute("SELECT content FROM files WHERE id = ?", (file_id,)).fetchone()[0]
    if content:
        try:
            dump = json.loads(bytes(content).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if isinstance(dump, dict) and dump.get("format") == DUMP_FORMAT:
            restore(conn, file_id, dump)
        # The rows live in the tb_ tables from now on.
        conn.execute("UPDATE files SET content = X'', size = 0 WHERE id = ?", (file_id,))


# ------------------------------------------------------------------ tables


def tables(conn: sqlite3.Connection, file_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM tb_tables WHERE file_id = ? ORDER BY position, id", (file_id,)
    ).fetchall()


def get_table(conn: sqlite3.Connection, file_id: int, table_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM tb_tables WHERE id = ? AND file_id = ?", (table_id, file_id)
    ).fetchone()


def create_table(
    conn: sqlite3.Connection, file_id: int, name: str, fields: Iterable[tuple[str, str, dict]] = ()
) -> int:
    now = utcnow()
    position = conn.execute(
        "SELECT coalesce(max(position), -1) + 1 FROM tb_tables WHERE file_id = ?", (file_id,)
    ).fetchone()[0]
    table_id = conn.execute(
        "INSERT INTO tb_tables (file_id, name, position, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (file_id, name, position, now, now),
    ).lastrowid
    for field_name, type_, options in fields:
        add_field(conn, table_id, field_name, type_, options)
    return table_id


def unique_table_name(conn: sqlite3.Connection, file_id: int, name: str) -> str:
    taken = {
        r[0].lower()
        for r in conn.execute("SELECT name FROM tb_tables WHERE file_id = ?", (file_id,))
    }
    if name.lower() not in taken:
        return name
    n = 2
    while f"{name} {n}".lower() in taken:
        n += 1
    return f"{name} {n}"


# ------------------------------------------------------------------ fields


def field_rows(conn: sqlite3.Connection, table_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM tb_fields WHERE table_id = ? ORDER BY position, id", (table_id,)
    ).fetchall()


def primary_field(conn: sqlite3.Connection, table_id: int) -> sqlite3.Row | None:
    """The field that names a table's rows: the chosen one, or the first."""
    table = conn.execute(
        "SELECT primary_field_id FROM tb_tables WHERE id = ?", (table_id,)
    ).fetchone()
    if table and table["primary_field_id"]:
        row = conn.execute(
            "SELECT * FROM tb_fields WHERE id = ? AND table_id = ?",
            (table["primary_field_id"], table_id),
        ).fetchone()
        if row:
            return row
    return conn.execute(
        "SELECT * FROM tb_fields WHERE table_id = ? ORDER BY position, id LIMIT 1", (table_id,)
    ).fetchone()


def as_field(conn: sqlite3.Connection, row: sqlite3.Row) -> Field:
    options = json.loads(row["options"])
    link_primary = None
    if row["type"] == "link" and options.get("table_id"):
        primary = primary_field(conn, options["table_id"])
        if primary is not None:
            link_primary = (primary["id"], primary["type"])
    return Field(
        id=row["id"],
        name=row["name"],
        type=row["type"],
        options=options,
        link_primary=link_primary,
    )


def fields(conn: sqlite3.Connection, table_id: int) -> list[Field]:
    return [as_field(conn, r) for r in field_rows(conn, table_id)]


def field_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "table_id": row["table_id"],
        "name": row["name"],
        "type": row["type"],
        "options": json.loads(row["options"]),
        "position": row["position"],
        "width": row["width"],
    }


def add_field(
    conn: sqlite3.Connection,
    table_id: int,
    name: str,
    type_: str,
    options: dict,
    position: int | None = None,
    width: int | None = None,
) -> int:
    if position is None:
        position = conn.execute(
            "SELECT coalesce(max(position), -1) + 1 FROM tb_fields WHERE table_id = ?",
            (table_id,),
        ).fetchone()[0]
    else:
        conn.execute(
            "UPDATE tb_fields SET position = position + 1 WHERE table_id = ? AND position >= ?",
            (table_id, position),
        )
    return conn.execute(
        "INSERT INTO tb_fields (table_id, name, type, options, position, width, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (table_id, name, type_, json.dumps(options), position, width, utcnow()),
    ).lastrowid


def unique_field_name(conn: sqlite3.Connection, table_id: int, name: str) -> str:
    taken = {
        r[0].lower()
        for r in conn.execute("SELECT name FROM tb_fields WHERE table_id = ?", (table_id,))
    }
    taken.add("id")  # the ID column every table has
    if name.lower() not in taken:
        return name
    n = 2
    while f"{name} {n}".lower() in taken:
        n += 1
    return f"{name} {n}"


# -------------------------------------------------------------------- rows


def row_values(data: str | dict) -> dict[str, Any]:
    return json.loads(data) if isinstance(data, str) else data


class LinkFinder:
    """Resolves what someone typed or pasted into a link field to a row of the linked table."""

    def __init__(self, conn: sqlite3.Connection, table_id: int) -> None:
        self.conn = conn
        self.table_id = table_id
        self._by_label: dict[str, int] | None = None

    def __call__(self, value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            row = self.conn.execute(
                "SELECT id FROM tb_rows WHERE id = ? AND table_id = ?", (value, self.table_id)
            ).fetchone()
            return row["id"] if row else None
        text = str(value).strip()
        if self._by_label is None:
            self._by_label = {}
            primary = primary_field(self.conn, self.table_id)
            if primary is not None:
                for r in self.conn.execute(
                    "SELECT id, json_extract(data, ?) AS label FROM tb_rows WHERE table_id = ?"
                    " ORDER BY number DESC",
                    (f'$."{primary["id"]}"', self.table_id),
                ):
                    if r["label"] is not None:
                        self._by_label[str(r["label"]).lower()] = r["id"]
        found = self._by_label.get(text.lower())
        if found is None and text.lstrip("#").isdigit():
            row = self.conn.execute(
                "SELECT id FROM tb_rows WHERE table_id = ? AND number = ?",
                (self.table_id, int(text.lstrip("#"))),
            ).fetchone()
            found = row["id"] if row else None
        return found


def clean_values(
    conn: sqlite3.Connection,
    table_fields: dict[int, Field],
    values: dict,
    finders: dict[int, LinkFinder],
) -> dict[str, Any]:
    """``values`` (field id -> input) as stored values; None means clear the field."""
    out: dict[str, Any] = {}
    for key, raw in values.items():
        try:
            field_id = int(key)
        except (TypeError, ValueError):
            raise ft.InvalidValue(f"There's no field {key} in this table.") from None
        f = table_fields.get(field_id)
        if f is None:
            raise ft.InvalidValue("That field has been deleted. Refresh to see the table as it is.")
        finder = None
        if f.type == "link":
            target = f.options.get("table_id")
            finder = finders.setdefault(target, LinkFinder(conn, target))
        try:
            value = ft.coerce(f.type, f.options, raw, finder)
        except ft.InvalidValue as exc:
            raise ft.InvalidValue(f"{f.name}: {exc}") from None
        if value is None and f.options.get("required"):
            raise ft.InvalidValue(f"{f.name} can't be empty.")
        out[str(field_id)] = value
    return out


def insert_row(conn: sqlite3.Connection, table_id: int, data: dict[str, Any]) -> int:
    number = conn.execute(
        "UPDATE tb_tables SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1",
        (table_id,),
    ).fetchone()[0]
    now = utcnow()
    stored = {k: v for k, v in data.items() if v is not None}
    return conn.execute(
        "INSERT INTO tb_rows (table_id, number, data, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (table_id, number, json.dumps(stored), now, now),
    ).lastrowid


def update_row(conn: sqlite3.Connection, row: sqlite3.Row, changes: dict[str, Any]) -> None:
    data = row_values(row["data"])
    for key, value in changes.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    conn.execute(
        "UPDATE tb_rows SET data = ?, updated_at = ? WHERE id = ?",
        (json.dumps(data), utcnow(), row["id"]),
    )


def link_labels(
    conn: sqlite3.Connection, link_fields: list[Field], datas: list[dict]
) -> dict[int, dict[int, str]]:
    """For each link field, the names of the rows it points at: {field id: {row id: name}}."""
    labels: dict[int, dict[int, str]] = {}
    for f in link_fields:
        ids = {d[str(f.id)] for d in datas if isinstance(d.get(str(f.id)), int)}
        found: dict[int, str] = {}
        if ids:
            if f.link_primary is None or f.link_primary[1] == "link":
                name_sql, params = "number", []
            else:
                name_sql, params = "json_extract(data, ?)", [f'$."{f.link_primary[0]}"']
            marks = ",".join("?" * len(ids))
            for r in conn.execute(
                f"SELECT id, number, {name_sql} AS label FROM tb_rows WHERE id IN ({marks})",
                [*params, *ids],
            ):
                label = r["label"]
                ptype = f.link_primary[1] if f.link_primary else "number"
                text = "" if label is None else ft.to_text(ptype, {}, label)
                found[r["id"]] = text or f"#{r['number']}"
        labels[f.id] = found
    return labels


# ----------------------------------------------------------------- objects


def objects(conn: sqlite3.Connection, file_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM tb_objects WHERE file_id = ? ORDER BY kind, name COLLATE NOCASE",
        (file_id,),
    ).fetchall()


def object_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "spec": json.loads(row["spec"]),
        "updated_at": row["updated_at"],
    }


def unique_object_name(conn: sqlite3.Connection, file_id: int, kind: str, name: str) -> str:
    taken = {
        r[0].lower()
        for r in conn.execute(
            "SELECT name FROM tb_objects WHERE file_id = ? AND kind = ?", (file_id, kind)
        )
    }
    if name.lower() not in taken:
        return name
    n = 2
    while f"{name} {n}".lower() in taken:
        n += 1
    return f"{name} {n}"


# --------------------------------------------------------- export, restore


def dump(conn: sqlite3.Connection, file_id: int) -> dict:
    """The whole database as JSON: the .tables file Tables exports and restores."""
    out_tables = []
    for t in tables(conn, file_id):
        rows = conn.execute(
            "SELECT id, number, data FROM tb_rows WHERE table_id = ? ORDER BY number", (t["id"],)
        ).fetchall()
        out_tables.append(
            {
                "id": t["id"],
                "name": t["name"],
                "primary_field_id": t["primary_field_id"],
                "fields": [
                    {k: v for k, v in field_json(f).items() if k not in ("table_id", "position")}
                    for f in field_rows(conn, t["id"])
                ],
                "rows": [
                    {"id": r["id"], "number": r["number"], "values": row_values(r["data"])}
                    for r in rows
                ],
            }
        )
    return {
        "format": DUMP_FORMAT,
        "version": 1,
        "tables": out_tables,
        "objects": [
            {"kind": o["kind"], "name": o["name"], "spec": json.loads(o["spec"])}
            for o in objects(conn, file_id)
        ],
    }


def restore(conn: sqlite3.Connection, file_id: int, data: dict) -> None:
    """Load a dump into an empty database, giving everything new ids."""
    table_ids: dict[int, int] = {}
    field_ids: dict[int, int] = {}
    row_ids: dict[int, int] = {}
    links: list[tuple[int, dict]] = []
    source_tables = [t for t in data.get("tables") or [] if isinstance(t, dict)]
    # Tables and fields first, so links can point at tables later in the list.
    for t in source_tables:
        name = unique_table_name(conn, file_id, str(t.get("name") or "Table").strip()[:100])
        new_id = create_table(conn, file_id, name)
        table_ids[t.get("id")] = new_id
    for t in source_tables:
        table_id = table_ids[t.get("id")]
        for f in t.get("fields") or []:
            type_ = f.get("type") if f.get("type") in ft.TYPES else "text"
            options = dict(f.get("options") or {})
            if type_ == "link":
                target = table_ids.get(options.get("table_id"))
                if target is None:
                    type_, options = "number", {"decimals": 0}
                else:
                    options["table_id"] = target
            try:
                options = ft.clean_options(type_, options)
            except ft.InvalidValue:
                type_, options = "text", {}
            fname = unique_field_name(conn, table_id, str(f.get("name") or "Field").strip()[:100])
            new_field = add_field(conn, table_id, fname, type_, options, width=f.get("width"))
            field_ids[f.get("id")] = new_field
            if type_ == "link":
                links.append((new_field, options))
        if t.get("primary_field_id") in field_ids:
            conn.execute(
                "UPDATE tb_tables SET primary_field_id = ? WHERE id = ?",
                (field_ids[t["primary_field_id"]], table_id),
            )
    for t in source_tables:
        table_id = table_ids[t.get("id")]
        max_number = 0
        for r in t.get("rows") or []:
            values = {
                str(field_ids[int(k)]): v
                for k, v in (r.get("values") or {}).items()
                if k.isdigit() and int(k) in field_ids and v is not None
            }
            number = int(r.get("number") or max_number + 1)
            max_number = max(max_number, number)
            now = utcnow()
            new_row = conn.execute(
                "INSERT INTO tb_rows (table_id, number, data, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (table_id, number, json.dumps(values), now, now),
            ).lastrowid
            row_ids[r.get("id")] = new_row
        conn.execute(
            "UPDATE tb_tables SET next_number = ? WHERE id = ?", (max_number + 1, table_id)
        )
    # Link values point at the old row ids: move them to the new ones.
    for field_id, _ in links:
        key = str(field_id)
        table_id = conn.execute(
            "SELECT table_id FROM tb_fields WHERE id = ?", (field_id,)
        ).fetchone()[0]
        for r in conn.execute(
            "SELECT id, data FROM tb_rows WHERE table_id = ? AND json_extract(data, ?) IS NOT NULL",
            (table_id, f'$."{key}"'),
        ).fetchall():
            values = row_values(r["data"])
            moved = row_ids.get(values.get(key))
            if moved is None:
                values.pop(key, None)
            else:
                values[key] = moved
            conn.execute("UPDATE tb_rows SET data = ? WHERE id = ?", (json.dumps(values), r["id"]))
    now = utcnow()
    for o in data.get("objects") or []:
        if not isinstance(o, dict) or o.get("kind") not in ("query", "form"):
            continue
        spec = remap_spec(o.get("spec") or {}, table_ids, field_ids)
        name = unique_object_name(conn, file_id, o["kind"], str(o.get("name") or "Query")[:100])
        conn.execute(
            "INSERT INTO tb_objects (file_id, kind, name, spec, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (file_id, o["kind"], name, json.dumps(spec), now, now),
        )


def remap_spec(spec: dict, table_ids: dict, field_ids: dict) -> dict:
    """A query's or form's spec with its table and field ids moved to new ones."""
    out = dict(spec)
    if "table_id" in out:
        out["table_id"] = table_ids.get(out["table_id"])
    out["fields"] = [
        {**f, "field": f["field"] if f.get("field") == "id" else field_ids.get(f.get("field"))}
        for f in spec.get("fields") or []
        if isinstance(f, dict) and (f.get("field") == "id" or f.get("field") in field_ids)
    ]
    return out
