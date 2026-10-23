"""The Tables API: databases, their tables and fields, rows, saved queries and forms.

A database is a ``.tables`` file, so who may do what comes from
:func:`studio.access.file_access`, as for notes:

* view and comment: open the database, read rows, run queries, export
* edit: change rows, and the design (tables, fields, queries, forms)
* owner: rename, move, delete and share the file (through the files API)

Every change bumps the database's revision; open copies poll it and fetch
again when it moves, so several people can work in one database at once.
"""

from __future__ import annotations

import csv
import io
import json
import sqlite3
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from .. import db
from ..access import allows, file_access
from ..files import clean_name, share_token, unique_name
from ..sharing import shared_with
from . import query as q
from . import store
from . import types as ft

NAME_MAX = 100
MAX_ROWS_PER_REQUEST = 5000
MAX_IMPORT_ROWS = 100_000
MAX_FIELDS = 200
STARTER_FIELDS = [("Name", "text", {}), ("Notes", "long_text", {})]


# ------------------------------------------------------------------ bodies


class NewDatabase(BaseModel):
    name: str = "Database"
    folder_id: int | None = None
    # Start with an empty "Table 1" (the usual), or nothing at all (imports).
    starter: bool = True


class NewTable(BaseModel):
    name: str = "Table"


class TableChange(BaseModel):
    name: str | None = None
    primary_field_id: int | None = None
    field_order: list[int] | None = None
    position: int | None = None


class NewField(BaseModel):
    name: str = "Field"
    type: str = "text"
    options: dict = Field(default_factory=dict)
    position: int | None = None


class FieldChange(BaseModel):
    name: str | None = None
    type: str | None = None
    options: dict | None = None
    width: int | None = None
    # Only report what changing the type would lose; change nothing.
    dry_run: bool = False


class ViewBody(BaseModel):
    filters: list[dict] = Field(default_factory=list)
    match: Literal["all", "any"] = "all"
    sort: list[dict] = Field(default_factory=list)
    search: str = ""
    offset: int = 0
    limit: int = 200


class NewRows(BaseModel):
    rows: list[dict] = Field(default_factory=lambda: [{}])
    # Forms check required fields; the datasheet adds empty rows to fill in.
    strict: bool = False
    add_choices: bool = False


class RowUpdate(BaseModel):
    id: int
    values: dict


class RowUpdates(BaseModel):
    updates: list[RowUpdate]
    add_choices: bool = False


class RowIds(BaseModel):
    ids: list[int]


class LookupBody(BaseModel):
    search: str = ""
    limit: int = 50


class NewObject(BaseModel):
    kind: Literal["query", "form"]
    name: str = ""
    spec: dict = Field(default_factory=dict)


class ObjectChange(BaseModel):
    name: str | None = None
    spec: dict | None = None


class RunBody(BaseModel):
    spec: dict
    offset: int = 0
    limit: int = 200


class ImportColumn(BaseModel):
    name: str
    type: str | None = None


class ImportBody(BaseModel):
    name: str = "Imported"
    columns: list[ImportColumn]
    rows: list[list[Any]]


# ----------------------------------------------------------------- helpers


def _name(value: str, what: str = "it") -> str:
    name = " ".join(value.split())
    if not name:
        raise HTTPException(status_code=422, detail=f"Give {what} a name.")
    if len(name) > NAME_MAX:
        raise HTTPException(status_code=422, detail=f"Names can be at most {NAME_MAX} characters.")
    return name


def _bad(exc: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


def _database_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "folder_id": row["folder_id"],
        "owner_id": row["owner_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _column_json(c: q.Column) -> dict:
    return {
        "key": c.key,
        "name": c.name,
        "field_id": c.field.id if c.field else None,
        "type": c.type,
        "options": c.options,
        "editable": c.editable,
    }


def _rows_json(
    conn: sqlite3.Connection, compiled: q.Compiled, rows: list[sqlite3.Row]
) -> list[dict]:
    if compiled.grouped:
        return [
            {"id": None, "number": None, "values": {c.key: r[c.key] for c in compiled.columns}}
            for r in rows
        ]
    datas = [store.row_values(r["data"]) for r in rows]
    link_fields = [c.field for c in compiled.columns if c.field and c.field.type == "link"]
    labels = store.link_labels(conn, link_fields, datas)
    out = []
    for r, data in zip(rows, datas, strict=True):
        values = {c.key: data.get(c.key) for c in compiled.columns if c.field}
        row_labels = {
            str(f.id): labels[f.id].get(data[str(f.id)], "")
            for f in link_fields
            if data.get(str(f.id)) is not None
        }
        out.append({"id": r["id"], "number": r["number"], "values": values, "labels": row_labels})
    return out


def _result(conn, compiled: q.Compiled, offset: int) -> dict:
    try:
        total, rows = q.run(conn, compiled)
    except q.QueryError as exc:
        raise _bad(exc) from None
    return {
        "columns": [_column_json(c) for c in compiled.columns],
        "rows": _rows_json(conn, compiled, rows),
        "total": total,
        "offset": offset,
        "grouped": compiled.grouped,
    }


def _fields_by_id(conn, table_id: int) -> dict[int, q.Field]:
    return {f.id: f for f in store.fields(conn, table_id)}


def _schema(conn: sqlite3.Connection, file_id: int) -> dict:
    out_tables = []
    for t in store.tables(conn, file_id):
        count = conn.execute("SELECT count(*) FROM tb_rows WHERE table_id = ?", (t["id"],))
        primary = store.primary_field(conn, t["id"])
        out_tables.append(
            {
                "id": t["id"],
                "name": t["name"],
                "primary_field_id": primary["id"] if primary else None,
                "row_count": count.fetchone()[0],
                "fields": [store.field_json(f) for f in store.field_rows(conn, t["id"])],
            }
        )
    objs = [store.object_json(o) for o in store.objects(conn, file_id)]
    return {
        "tables": out_tables,
        "queries": [o for o in objs if o["kind"] == "query"],
        "forms": [o for o in objs if o["kind"] == "form"],
        "revision": store.revision(conn, file_id),
    }


def _csv(columns: list[str], rows: list[list[str]], filename: str) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    writer.writerows(rows)
    return Response(
        # A byte order mark, so Excel reads the file as UTF-8.
        "﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}.csv"},
    )


# ------------------------------------------------------------------ router


def make_router(auth, get_db) -> APIRouter:
    router = APIRouter(prefix="/api/tables", tags=["tables"])

    def database(
        request: Request, conn: sqlite3.Connection, file_id: int, user, needed: str
    ) -> tuple[sqlite3.Row, str]:
        token = share_token(request)
        role = file_access(conn, file_id, user, token)
        if role is None:
            if user is None and token is None:
                raise HTTPException(status_code=401, detail="Sign in required")
            raise HTTPException(status_code=404, detail="Database not found")
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if not store.is_database(row["mime_type"]):
            raise HTTPException(status_code=415, detail="That file isn't a Tables database.")
        if not allows(role, needed):
            raise HTTPException(status_code=403, detail="You can't change this database.")
        return row, role

    def table_of(conn, file_id: int, table_id: int) -> sqlite3.Row:
        row = store.get_table(conn, file_id, table_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Table not found")
        return row

    def field_of(conn, file_id: int, field_id: int) -> sqlite3.Row:
        row = conn.execute(
            "SELECT f.* FROM tb_fields f JOIN tb_tables t ON t.id = f.table_id"
            " WHERE f.id = ? AND t.file_id = ?",
            (field_id, file_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Field not found")
        return row

    def object_of(conn, file_id: int, object_id: int) -> sqlite3.Row:
        row = conn.execute(
            "SELECT * FROM tb_objects WHERE id = ? AND file_id = ?", (object_id, file_id)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        return row

    def table_ids(conn, file_id: int) -> set[int]:
        return {t["id"] for t in store.tables(conn, file_id)}

    # --------------------------------------------------------- databases

    @router.get("/databases")
    def list_databases(conn=Depends(get_db), user=Depends(auth.require_user)):
        """The user's databases, and those other people shared with them."""
        mine = conn.execute(
            "SELECT * FROM files WHERE owner_id = ? AND mime_type = ? ORDER BY updated_at DESC",
            (user["id"], store.MIME_TYPE),
        ).fetchall()
        shared = shared_with(conn, user["id"])
        ids = [s["id"] for s in shared]
        kinds = {}
        if ids:
            marks = ",".join("?" * len(ids))
            kinds = {
                r["id"]: r["mime_type"]
                for r in conn.execute(f"SELECT id, mime_type FROM files WHERE id IN ({marks})", ids)
            }
        return {
            "databases": [_database_json(r) for r in mine],
            "shared": [s for s in shared if store.is_database(kinds.get(s["id"], ""))],
        }

    @router.post("/databases")
    def create_database(body: NewDatabase, conn=Depends(get_db), user=Depends(auth.require_user)):
        name = clean_name(body.name)
        if not name.lower().endswith(store.EXTENSION):
            name += store.EXTENSION
        now = db.utcnow()
        with db.transaction(conn):
            if (
                body.folder_id is not None
                and not conn.execute(
                    "SELECT 1 FROM folders WHERE id = ? AND owner_id = ?",
                    (body.folder_id, user["id"]),
                ).fetchone()
            ):
                raise HTTPException(status_code=404, detail="Folder not found")
            name = unique_name(conn, user["id"], body.folder_id, name)
            file_id = conn.execute(
                "INSERT INTO files (owner_id, folder_id, name, mime_type, size, content,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, 0, X'', ?, ?)",
                (user["id"], body.folder_id, name, store.MIME_TYPE, now, now),
            ).lastrowid
            store.ensure_database(conn, file_id)
            if body.starter:
                store.create_table(conn, file_id, "Table 1", STARTER_FIELDS)
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        return {"database": _database_json(row)}

    @router.get("/{file_id}")
    def open_database(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        row, role = database(request, conn, file_id, user, "view")
        with db.transaction(conn):
            store.ensure_database(conn, file_id)
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        owner = conn.execute("SELECT username FROM users WHERE id = ?", (row["owner_id"],))
        return {
            "database": {**_database_json(row), "owner": owner.fetchone()["username"]},
            "role": role,
            **_schema(conn, file_id),
        }

    @router.get("/{file_id}/revision")
    def get_revision(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        database(request, conn, file_id, user, "view")
        return {"revision": store.revision(conn, file_id)}

    # ------------------------------------------------------------ tables

    @router.post("/{file_id}/tables")
    def create_table(
        file_id: int,
        body: NewTable,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            store.ensure_database(conn, file_id)
            name = store.unique_table_name(conn, file_id, _name(body.name, "the table"))
            table_id = store.create_table(conn, file_id, name, STARTER_FIELDS)
            store.bump(conn, file_id)
        return {"table_id": table_id, **_schema(conn, file_id)}

    @router.patch("/{file_id}/tables/{table_id}")
    def change_table(
        file_id: int,
        table_id: int,
        body: TableChange,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            table = table_of(conn, file_id, table_id)
            if body.name is not None:
                name = _name(body.name, "the table")
                if name.lower() != table["name"].lower():
                    name = store.unique_table_name(conn, file_id, name)
                conn.execute(
                    "UPDATE tb_tables SET name = ?, updated_at = ? WHERE id = ?",
                    (name, db.utcnow(), table_id),
                )
            if body.primary_field_id is not None:
                field = field_of(conn, file_id, body.primary_field_id)
                if field["table_id"] != table_id:
                    raise HTTPException(status_code=422, detail="That field is in another table.")
                conn.execute(
                    "UPDATE tb_tables SET primary_field_id = ? WHERE id = ?",
                    (field["id"], table_id),
                )
            if body.field_order is not None:
                existing = [f["id"] for f in store.field_rows(conn, table_id)]
                order = [i for i in body.field_order if i in existing]
                order += [i for i in existing if i not in order]
                for position, fid in enumerate(order):
                    conn.execute("UPDATE tb_fields SET position = ? WHERE id = ?", (position, fid))
            if body.position is not None:
                others = [t["id"] for t in store.tables(conn, file_id) if t["id"] != table_id]
                others.insert(max(0, min(body.position, len(others))), table_id)
                for position, tid in enumerate(others):
                    conn.execute("UPDATE tb_tables SET position = ? WHERE id = ?", (position, tid))
            store.bump(conn, file_id)
        return _schema(conn, file_id)

    @router.delete("/{file_id}/tables/{table_id}")
    def delete_table(
        file_id: int,
        table_id: int,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            table_of(conn, file_id, table_id)
            linking = [
                f"{r['table_name']}.{r['name']}"
                for r in conn.execute(
                    "SELECT f.name, t.name AS table_name FROM tb_fields f"
                    " JOIN tb_tables t ON t.id = f.table_id WHERE t.file_id = ? AND f.type = 'link'"
                    " AND json_extract(f.options, '$.table_id') = ? AND t.id <> ?",
                    (file_id, table_id, table_id),
                )
            ]
            if linking:
                raise HTTPException(
                    status_code=409,
                    detail=f"{', '.join(linking)} links to this table. "
                    "Delete that field or change its type first.",
                )
            conn.execute("DELETE FROM tb_tables WHERE id = ?", (table_id,))
            # Queries and forms on the table go with it.
            conn.execute(
                "DELETE FROM tb_objects WHERE file_id = ? AND json_extract(spec, '$.table_id') = ?",
                (file_id, table_id),
            )
            store.bump(conn, file_id)
        return _schema(conn, file_id)

    # ------------------------------------------------------------ fields

    @router.post("/{file_id}/tables/{table_id}/fields")
    def create_field(
        file_id: int,
        table_id: int,
        body: NewField,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            table_of(conn, file_id, table_id)
            if len(store.field_rows(conn, table_id)) >= MAX_FIELDS:
                raise HTTPException(
                    status_code=422, detail=f"A table can have at most {MAX_FIELDS} fields."
                )
            try:
                options = ft.clean_options(body.type, body.options, table_ids(conn, file_id))
            except ft.InvalidValue as exc:
                raise _bad(exc) from None
            name = store.unique_field_name(conn, table_id, _name(body.name, "the field"))
            field_id = store.add_field(conn, table_id, name, body.type, options, body.position)
            store.bump(conn, file_id)
        return {"field_id": field_id, **_schema(conn, file_id)}

    @router.patch("/{file_id}/fields/{field_id}")
    def change_field(
        file_id: int,
        field_id: int,
        body: FieldChange,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            row = field_of(conn, file_id, field_id)
            old = store.as_field(conn, row)
            new_type = body.type or row["type"]
            raw_options = body.options if body.options is not None else old.options
            try:
                options = ft.clean_options(new_type, raw_options, table_ids(conn, file_id))
            except ft.InvalidValue as exc:
                raise _bad(exc) from None
            converted = (
                _convert(conn, old, new_type, options)
                if (
                    new_type != old.type
                    or (
                        new_type == "choice"
                        and options.get("choices") != old.options.get("choices")
                    )
                    or (
                        new_type == "link"
                        and options.get("table_id") != old.options.get("table_id")
                    )
                )
                else None
            )
            if body.dry_run:
                # Nothing has been written yet.
                lost = converted["lost"] if converted else []
                return {"lost": len(lost), "examples": lost[:5]}
            if converted:
                options = converted["options"]
                for row_id, data in converted["rows"]:
                    conn.execute(
                        "UPDATE tb_rows SET data = ?, updated_at = ? WHERE id = ?",
                        (json.dumps(data), db.utcnow(), row_id),
                    )
            name = row["name"]
            if body.name is not None:
                name = _name(body.name, "the field")
                if name.lower() != row["name"].lower():
                    name = store.unique_field_name(conn, row["table_id"], name)
            width = row["width"] if body.width is None else max(60, min(1000, body.width))
            conn.execute(
                "UPDATE tb_fields SET name = ?, type = ?, options = ?, width = ? WHERE id = ?",
                (name, new_type, json.dumps(options), width, field_id),
            )
            store.bump(conn, file_id)
        result = _schema(conn, file_id)
        result["lost"] = len(converted["lost"]) if converted else 0
        return result

    def _convert(conn, old: q.Field, new_type: str, options: dict) -> dict:
        """Every value of a field as the new type: the new rows' data, and what didn't fit."""
        key = str(old.id)
        rows = conn.execute(
            "SELECT id, data FROM tb_rows WHERE table_id = (SELECT table_id FROM tb_fields"
            " WHERE id = ?) AND json_extract(data, ?) IS NOT NULL",
            (old.id, f'$."{key}"'),
        ).fetchall()
        datas = [(r["id"], store.row_values(r["data"])) for r in rows]
        labels = store.link_labels(conn, [old], [d for _, d in datas]).get(old.id, {})
        texts = [
            (row_id, data, ft.to_text(old.type, old.options, data[key], labels.get(data[key])))
            for row_id, data in datas
        ]
        if new_type == "choice":
            # Like turning a text field into a lookup: its values become the choices.
            options = ft.add_choices(options, [t for _, _, t in texts])
        finder = store.LinkFinder(conn, options["table_id"]) if new_type == "link" else None
        lost, out = [], []
        for row_id, data, text in texts:
            try:
                value = ft.coerce(new_type, options, text, finder)
            except ft.InvalidValue:
                value = None
                lost.append(text)
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
            out.append((row_id, data))
        return {"rows": out, "lost": lost, "options": options}

    @router.delete("/{file_id}/fields/{field_id}")
    def delete_field(
        file_id: int,
        field_id: int,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            row = field_of(conn, file_id, field_id)
            conn.execute(
                "UPDATE tb_rows SET data = json_remove(data, ?) WHERE table_id = ?",
                (f'$."{field_id}"', row["table_id"]),
            )
            conn.execute("DELETE FROM tb_fields WHERE id = ?", (field_id,))
            conn.execute(
                "UPDATE tb_tables SET primary_field_id = NULL WHERE primary_field_id = ?",
                (field_id,),
            )
            store.bump(conn, file_id)
        return _schema(conn, file_id)

    # -------------------------------------------------------------- rows

    @router.post("/{file_id}/tables/{table_id}/rows/query")
    def query_rows(
        file_id: int,
        table_id: int,
        body: ViewBody,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        """A page of the datasheet, with its filters, sort and search."""
        database(request, conn, file_id, user, "view")
        table_of(conn, file_id, table_id)
        fields = store.fields(conn, table_id)
        design = q.design_from_view(body.model_dump(), fields)
        try:
            compiled = q.compile_design(
                table_id, design, {f.id: f for f in fields}, body.offset, body.limit
            )
        except q.QueryError as exc:
            raise _bad(exc) from None
        return {**_result(conn, compiled, body.offset), "revision": store.revision(conn, file_id)}

    def _grow_choices(conn, fields: dict[int, q.Field], rows: list[dict]) -> dict[int, q.Field]:
        """Add any choice a pasted or imported value names to its field's choices."""
        changed = dict(fields)
        for f in fields.values():
            if f.type != "choice":
                continue
            names = [str(v) for r in rows if not ft.is_empty(v := r.get(str(f.id), r.get(f.id)))]
            options = ft.add_choices(f.options, names)
            if options != f.options:
                conn.execute(
                    "UPDATE tb_fields SET options = ? WHERE id = ?", (json.dumps(options), f.id)
                )
                changed[f.id] = q.Field(f.id, f.name, f.type, options, f.link_primary)
        return changed

    def _rows_by_id(conn, file_id: int, table_id: int, ids: list[int]) -> dict:
        if not ids:
            return {"rows": [], "columns": []}
        fields = store.fields(conn, table_id)
        design = q.design_from_view({}, fields)
        compiled = q.compile_design(table_id, design, {f.id: f for f in fields}, 0, 1)
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT r.id, r.number, r.data FROM tb_rows r WHERE r.id IN ({marks})", ids
        ).fetchall()
        by_id = {r["id"]: r for r in rows}
        ordered = [by_id[i] for i in ids if i in by_id]
        return {"rows": _rows_json(conn, compiled, ordered)}

    @router.post("/{file_id}/tables/{table_id}/rows")
    def create_rows(
        file_id: int,
        table_id: int,
        body: NewRows,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        if len(body.rows) > MAX_ROWS_PER_REQUEST:
            raise HTTPException(status_code=413, detail="Too many rows at once.")
        with db.transaction(conn):
            table_of(conn, file_id, table_id)
            fields = _fields_by_id(conn, table_id)
            if body.add_choices:
                fields = _grow_choices(conn, fields, body.rows)
            finders: dict[int, store.LinkFinder] = {}
            ids = []
            for values in body.rows:
                try:
                    data = store.clean_values(conn, fields, values, finders)
                    if body.strict:
                        missing = [
                            f.name
                            for f in fields.values()
                            if f.options.get("required") and data.get(str(f.id)) is None
                        ]
                        if missing:
                            raise ft.InvalidValue(f"{', '.join(missing)} can't be empty.")
                except ft.InvalidValue as exc:
                    raise _bad(exc) from None
                ids.append(store.insert_row(conn, table_id, data))
            revision = store.bump(conn, file_id)
        return {**_rows_by_id(conn, file_id, table_id, ids), "revision": revision}

    @router.patch("/{file_id}/tables/{table_id}/rows")
    def update_rows(
        file_id: int,
        table_id: int,
        body: RowUpdates,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        """Change some fields of some rows: one cell, or a pasted block."""
        database(request, conn, file_id, user, "edit")
        if len(body.updates) > MAX_ROWS_PER_REQUEST:
            raise HTTPException(status_code=413, detail="Too many rows at once.")
        with db.transaction(conn):
            table_of(conn, file_id, table_id)
            fields = _fields_by_id(conn, table_id)
            if body.add_choices:
                fields = _grow_choices(conn, fields, [u.values for u in body.updates])
            finders: dict[int, store.LinkFinder] = {}
            ids = []
            for u in body.updates:
                row = conn.execute(
                    "SELECT * FROM tb_rows WHERE id = ? AND table_id = ?", (u.id, table_id)
                ).fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=404,
                        detail="That row has been deleted. Refresh to see the table.",
                    )
                try:
                    changes = store.clean_values(conn, fields, u.values, finders)
                except ft.InvalidValue as exc:
                    raise _bad(exc) from None
                store.update_row(conn, row, changes)
                ids.append(u.id)
            revision = store.bump(conn, file_id)
        return {**_rows_by_id(conn, file_id, table_id, ids), "revision": revision}

    @router.post("/{file_id}/tables/{table_id}/rows/delete")
    def delete_rows(
        file_id: int,
        table_id: int,
        body: RowIds,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        ids = body.ids[:MAX_ROWS_PER_REQUEST]
        with db.transaction(conn):
            table_of(conn, file_id, table_id)
            if ids:
                marks = ",".join("?" * len(ids))
                deleted = conn.execute(
                    f"DELETE FROM tb_rows WHERE table_id = ? AND id IN ({marks})", [table_id, *ids]
                ).rowcount
                # Links to the deleted rows are emptied, not left pointing at nothing.
                for f in conn.execute(
                    "SELECT f.id, f.table_id FROM tb_fields f JOIN tb_tables t ON t.id = f.table_id"
                    " WHERE t.file_id = ? AND f.type = 'link'"
                    " AND json_extract(f.options, '$.table_id') = ?",
                    (file_id, table_id),
                ).fetchall():
                    path = f'$."{f["id"]}"'
                    conn.execute(
                        "UPDATE tb_rows SET data = json_remove(data, ?) WHERE table_id = ?"
                        f" AND json_extract(data, ?) IN ({marks})",
                        [path, f["table_id"], path, *ids],
                    )
            else:
                deleted = 0
            revision = store.bump(conn, file_id)
        return {"deleted": deleted, "revision": revision}

    @router.post("/{file_id}/tables/{table_id}/lookup")
    def lookup(
        file_id: int,
        table_id: int,
        body: LookupBody,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        """Rows to pick from for a link field that points at this table."""
        database(request, conn, file_id, user, "view")
        table_of(conn, file_id, table_id)
        primary = store.primary_field(conn, table_id)
        label = "NULL" if primary is None else f"json_extract(data, {q._path(primary['id'])})"
        sql = f"SELECT id, number, {label} AS label FROM tb_rows WHERE table_id = ?"
        params: list[Any] = [table_id]
        search = body.search.strip()
        if search:
            sql += f" AND (lower(CAST({label} AS TEXT)) LIKE ? ESCAPE '\\' OR number = ?)"
            params += [q._like(search, True, True), search.lstrip("#")]
        sql += f" ORDER BY ({label} IS NULL), {label} COLLATE NOCASE, number"
        sql += f" LIMIT {max(1, min(200, body.limit))}"
        ptype = primary["type"] if primary is not None else "number"
        return {
            "rows": [
                {
                    "id": r["id"],
                    "number": r["number"],
                    "label": "" if r["label"] is None else ft.to_text(ptype, {}, r["label"]),
                }
                for r in conn.execute(sql, params).fetchall()
            ]
        }

    # ------------------------------------------------- queries and forms

    @router.post("/{file_id}/objects")
    def create_object(
        file_id: int,
        body: NewObject,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            table_id = body.spec.get("table_id")
            if table_id not in table_ids(conn, file_id):
                raise HTTPException(status_code=422, detail="Pick a table for it.")
            default = "Query" if body.kind == "query" else "Form"
            name = store.unique_object_name(
                conn, file_id, body.kind, _name(body.name or default, "it")
            )
            now = db.utcnow()
            object_id = conn.execute(
                "INSERT INTO tb_objects (file_id, kind, name, spec, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (file_id, body.kind, name, json.dumps(body.spec), now, now),
            ).lastrowid
            store.bump(conn, file_id)
        return {"object_id": object_id, **_schema(conn, file_id)}

    @router.patch("/{file_id}/objects/{object_id}")
    def change_object(
        file_id: int,
        object_id: int,
        body: ObjectChange,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            row = object_of(conn, file_id, object_id)
            name = row["name"]
            if body.name is not None:
                name = _name(body.name, "it")
                if name.lower() != row["name"].lower():
                    name = store.unique_object_name(conn, file_id, row["kind"], name)
            spec = json.loads(row["spec"]) if body.spec is None else body.spec
            if spec.get("table_id") not in table_ids(conn, file_id):
                raise HTTPException(status_code=422, detail="Pick a table for it.")
            conn.execute(
                "UPDATE tb_objects SET name = ?, spec = ?, updated_at = ? WHERE id = ?",
                (name, json.dumps(spec), db.utcnow(), object_id),
            )
            store.bump(conn, file_id)
        return _schema(conn, file_id)

    @router.delete("/{file_id}/objects/{object_id}")
    def delete_object(
        file_id: int,
        object_id: int,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        database(request, conn, file_id, user, "edit")
        with db.transaction(conn):
            object_of(conn, file_id, object_id)
            conn.execute("DELETE FROM tb_objects WHERE id = ?", (object_id,))
            store.bump(conn, file_id)
        return _schema(conn, file_id)

    def compile_spec(conn, file_id: int, spec: dict, offset: int, limit: int) -> q.Compiled:
        table_id = spec.get("table_id")
        if not isinstance(table_id, int) or store.get_table(conn, file_id, table_id) is None:
            raise HTTPException(status_code=422, detail="Pick a table for the query.")
        design = q.design_from_spec(spec)
        if not design.fields:
            raise HTTPException(status_code=422, detail="Add a field to the grid to see results.")
        try:
            return q.compile_design(table_id, design, _fields_by_id(conn, table_id), offset, limit)
        except q.QueryError as exc:
            raise _bad(exc) from None

    @router.post("/{file_id}/query")
    def run_query(
        file_id: int,
        body: RunBody,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        """Run a query design: a saved one, or the one being edited."""
        database(request, conn, file_id, user, "view")
        compiled = compile_spec(conn, file_id, body.spec, body.offset, body.limit)
        return {
            **_result(conn, compiled, body.offset),
            "table_id": body.spec.get("table_id"),
            "revision": store.revision(conn, file_id),
        }

    # ------------------------------------------------- import and export

    @router.get("/{file_id}/export.csv")
    def export_csv(
        file_id: int,
        request: Request,
        table: Annotated[int | None, Query()] = None,
        query: Annotated[int | None, Query()] = None,
        view: Annotated[str | None, Query()] = None,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        """A table (as filtered and sorted in the datasheet) or a saved query, as CSV."""
        database(request, conn, file_id, user, "view")
        if query is not None:
            obj = object_of(conn, file_id, query)
            name = obj["name"]
            compile_spec(conn, file_id, json.loads(obj["spec"]), 0, 1)  # checks it can run
            table_id = json.loads(obj["spec"])["table_id"]
            spec_source = ("spec", json.loads(obj["spec"]))
        elif table is not None:
            table_row = table_of(conn, file_id, table)
            name = table_row["name"]
            table_id = table
            try:
                view_body = json.loads(view) if view else {}
            except json.JSONDecodeError:
                view_body = {}
            spec_source = ("view", view_body if isinstance(view_body, dict) else {})
        else:
            raise HTTPException(status_code=422, detail="Say which table or query to export.")

        fields = store.fields(conn, table_id)
        by_id = {f.id: f for f in fields}
        header: list[str] | None = None
        out: list[list[str]] = []
        offset = 0
        while True:
            try:
                if spec_source[0] == "spec":
                    design = q.design_from_spec(spec_source[1])
                else:
                    design = q.design_from_view(spec_source[1], fields)
                compiled = q.compile_design(table_id, design, by_id, offset, q.MAX_PAGE)
                total, rows = q.run(conn, compiled)
            except q.QueryError as exc:
                raise _bad(exc) from None
            if header is None:
                header = (["ID"] if not compiled.grouped else []) + [
                    c.name for c in compiled.columns
                ]
            for r in _rows_json(conn, compiled, rows):
                line = [] if compiled.grouped else [str(r["number"])]
                for c in compiled.columns:
                    value = r["values"].get(c.key)
                    label = r.get("labels", {}).get(c.key)
                    line.append(ft.to_text(c.type, c.options, value, label))
                out.append(line)
            offset += len(rows)
            if not rows or offset >= total:
                break
        return _csv(header or [], out, name)

    @router.get("/{file_id}/export.json")
    def export_json(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        """The whole database as a .tables file, which Tables opens again when uploaded."""
        row, _ = database(request, conn, file_id, user, "view")
        data = json.dumps(store.dump(conn, file_id), ensure_ascii=False, indent=1)
        return Response(
            data,
            media_type=store.MIME_TYPE,
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(row['name'])}"},
        )

    @router.post("/{file_id}/import")
    def import_table(
        file_id: int,
        body: ImportBody,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        """A new table from rows of text (a CSV file or a pasted spreadsheet)."""
        database(request, conn, file_id, user, "edit")
        if not body.columns:
            raise HTTPException(status_code=422, detail="There's nothing to import.")
        if len(body.columns) > MAX_FIELDS:
            raise HTTPException(
                status_code=422, detail=f"A table can have at most {MAX_FIELDS} fields."
            )
        if len(body.rows) > MAX_IMPORT_ROWS:
            raise HTTPException(
                status_code=413, detail=f"Tables can import up to {MAX_IMPORT_ROWS:,} rows at once."
            )
        width = len(body.columns)
        rows = [
            [("" if v is None else str(v)) for v in (r + [None] * width)[:width]] for r in body.rows
        ]
        with db.transaction(conn):
            store.ensure_database(conn, file_id)
            name = store.unique_table_name(conn, file_id, _name(body.name, "the table"))
            table_id = store.create_table(conn, file_id, name)
            keys: list[tuple[int, str, dict]] = []
            for i, col in enumerate(body.columns):
                column_values = [r[i] for r in rows]
                type_ = col.type if col.type in ft.TYPES and col.type != "link" else None
                type_ = type_ or ft.guess_type(column_values)
                options = ft.clean_options(type_, {})
                if type_ == "choice":
                    options = ft.add_choices(options, column_values)
                fname = store.unique_field_name(
                    conn, table_id, " ".join(col.name.split())[:NAME_MAX] or f"Field {i + 1}"
                )
                fid = store.add_field(conn, table_id, fname, type_, options)
                keys.append((fid, type_, options))
            skipped = 0
            for r in rows:
                data = {}
                for (fid, type_, options), raw in zip(keys, r, strict=True):
                    try:
                        value = ft.coerce(type_, options, raw)
                    except ft.InvalidValue:
                        # Only with a type the importer chose: guessed types fit every value.
                        skipped += 1
                        value = None
                    if value is not None:
                        data[str(fid)] = value
                store.insert_row(conn, table_id, data)
            store.bump(conn, file_id)
        return {"table_id": table_id, "skipped": skipped, **_schema(conn, file_id)}

    return router
