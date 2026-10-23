"""Files and folders, stored in SQLite with each file's contents as a blob.

Folders belong to one user and nest freely. A file's ``folder_id`` (and a
folder's ``parent_id``) is NULL at the top level. Names are unique within a
folder, ignoring case.

Routes that touch a single file ask :func:`studio.access.file_access` for the
caller's role, so share links work without changes here. A share link's token
comes in the ``X-Share-Token`` header or a ``share`` query parameter.
"""

from __future__ import annotations

import mimetypes
import re
import sqlite3
from collections.abc import Callable
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import db, export
from .access import allows, file_access

NAME_MAX = 255
_BAD_NAME = re.compile(r"[/\\\x00-\x1f\x7f]")
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TEXT_TYPES = {"application/json", "application/xml", "image/svg+xml"}
# Decks are Markdown files named *.deck.md.
DOUBLE_EXTENSIONS = (".deck.md",)

mimetypes.add_type("text/markdown", ".md")
mimetypes.add_type("text/markdown", ".markdown")

# Called with (file_id, new_text) after a file's contents are replaced over HTTP,
# so live editing sessions can catch up. Set by the co-editing module.
ContentListener = Callable[[int, str], None]

# Uploaded HTML or SVG opened in a tab must never run as part of the app.
DOWNLOAD_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"

FILE_COLUMNS = "id, owner_id, folder_id, name, mime_type, size, created_at, updated_at"
FOLDER_COLUMNS = "id, owner_id, parent_id, name, created_at, updated_at"


class NewFolder(BaseModel):
    name: str
    parent_id: int | None = None


class FolderChange(BaseModel):
    name: str | None = None
    parent_id: int | None = None
    # parent_id is nullable, so "move to the top level" needs saying explicitly.
    move: bool = False


class NewFile(BaseModel):
    name: str
    folder_id: int | None = None
    content: str = ""


class FileChange(BaseModel):
    name: str | None = None
    folder_id: int | None = None
    move: bool = False


def clean_name(name: str) -> str:
    name = name.strip()
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=422, detail="Give it a name.")
    if len(name) > NAME_MAX:
        raise HTTPException(status_code=422, detail=f"Names can be at most {NAME_MAX} characters.")
    if _BAD_NAME.search(name):
        raise HTTPException(status_code=422, detail="Names can't contain / or \\.")
    return name


def guess_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def is_text(mime_type: str) -> bool:
    return mime_type.startswith("text/") or mime_type in TEXT_TYPES


def is_markdown(mime_type: str) -> bool:
    return mime_type == "text/markdown"


def file_json(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys() if key != "content"}  # noqa: SIM118 (Row iterates values)


def folder_json(row: sqlite3.Row) -> dict:
    return dict(row)


def share_token(request: Request) -> str | None:
    return request.headers.get("x-share-token") or request.query_params.get("share") or None


def _taken(
    conn: sqlite3.Connection, table: str, owner_id: int, parent: int | None, name: str, skip=None
) -> bool:
    column = "folder_id" if table == "files" else "parent_id"
    row = conn.execute(
        f"SELECT id FROM {table} WHERE owner_id = ? AND coalesce({column}, 0) = ?"
        " AND name = ? COLLATE NOCASE AND id IS NOT ?",
        (owner_id, parent or 0, name, skip),
    ).fetchone()
    return row is not None


def unique_name(conn: sqlite3.Connection, owner_id: int, folder_id: int | None, name: str) -> str:
    """``name``, or ``name (2)``, ``name (3)``... if a file already has it."""
    if not _taken(conn, "files", owner_id, folder_id, name):
        return name
    # Keep two-part extensions whole, so a copy of a deck is still a deck.
    lower = name.lower()
    double = next((e for e in DOUBLE_EXTENSIONS if lower.endswith(e) and lower != e), None)
    if double:
        stem, ext = name[: -len(double)], name[-len(double) :]
    else:
        stem, dot, ext = name.rpartition(".")
        if not dot or not stem:
            stem, ext = name, ""
        else:
            ext = "." + ext
    n = 2
    while _taken(conn, "files", owner_id, folder_id, f"{stem} ({n}){ext}"):
        n += 1
    return f"{stem} ({n}){ext}"


def _own_folder(conn: sqlite3.Connection, user_id: int, folder_id: int | None) -> None:
    if folder_id is None:
        return
    row = conn.execute(
        "SELECT 1 FROM folders WHERE id = ? AND owner_id = ?", (folder_id, user_id)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Folder not found")


def make_router(auth, get_db) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["files"])
    require_user = auth.require_user
    current_user = auth.current_user

    def get_file(conn: sqlite3.Connection, file_id: int) -> sqlite3.Row:
        row = conn.execute(f"SELECT {FILE_COLUMNS} FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="File not found")
        return row

    def require_role(
        request: Request, conn: sqlite3.Connection, file_id: int, user, needed: str
    ) -> str:
        token = share_token(request)
        role = file_access(conn, file_id, user, token)
        if role is None:
            if user is None and token is None:
                raise HTTPException(status_code=401, detail="Sign in required")
            raise HTTPException(status_code=404, detail="File not found")
        if not allows(role, needed):
            raise HTTPException(status_code=403, detail="You can't do that with this file")
        return role

    # ------------------------------------------------------------- listing

    @router.get("/files")
    def tree(conn=Depends(get_db), user=Depends(require_user)):
        """Everything the user owns, without contents. The client builds the tree."""
        folders = conn.execute(
            f"SELECT {FOLDER_COLUMNS} FROM folders WHERE owner_id = ? ORDER BY name COLLATE NOCASE",
            (user["id"],),
        ).fetchall()
        files = conn.execute(
            f"SELECT {FILE_COLUMNS} FROM files WHERE owner_id = ? ORDER BY name COLLATE NOCASE",
            (user["id"],),
        ).fetchall()
        return {
            "folders": [folder_json(r) for r in folders],
            "files": [file_json(r) for r in files],
        }

    # ------------------------------------------------------------- folders

    @router.post("/folders")
    def create_folder(body: NewFolder, conn=Depends(get_db), user=Depends(require_user)):
        name = clean_name(body.name)
        now = db.utcnow()
        with db.transaction(conn):
            _own_folder(conn, user["id"], body.parent_id)
            if _taken(conn, "folders", user["id"], body.parent_id, name):
                raise _exists("folder", name)
            cur = conn.execute(
                "INSERT INTO folders (owner_id, parent_id, name, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (user["id"], body.parent_id, name, now, now),
            )
        row = conn.execute(
            f"SELECT {FOLDER_COLUMNS} FROM folders WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return {"folder": folder_json(row)}

    @router.patch("/folders/{folder_id}")
    def change_folder(
        folder_id: int, body: FolderChange, conn=Depends(get_db), user=Depends(require_user)
    ):
        with db.transaction(conn):
            row = conn.execute(
                f"SELECT {FOLDER_COLUMNS} FROM folders WHERE id = ? AND owner_id = ?",
                (folder_id, user["id"]),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Folder not found")
            name = clean_name(body.name) if body.name is not None else row["name"]
            parent = body.parent_id if body.move else row["parent_id"]
            if body.move:
                _own_folder(conn, user["id"], parent)
                # Walk up from the new parent: reaching this folder means a loop.
                ancestor = parent
                while ancestor is not None:
                    if ancestor == folder_id:
                        raise HTTPException(
                            status_code=422, detail="A folder can't go inside itself."
                        )
                    ancestor = conn.execute(
                        "SELECT parent_id FROM folders WHERE id = ?", (ancestor,)
                    ).fetchone()["parent_id"]
            if _taken(conn, "folders", user["id"], parent, name, skip=folder_id):
                raise _exists("folder", name)
            conn.execute(
                "UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?",
                (name, parent, db.utcnow(), folder_id),
            )
        row = conn.execute(
            f"SELECT {FOLDER_COLUMNS} FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        return {"folder": folder_json(row)}

    @router.delete("/folders/{folder_id}")
    def delete_folder(folder_id: int, conn=Depends(get_db), user=Depends(require_user)):
        """Deletes the folder and everything in it."""
        cur = conn.execute(
            "DELETE FROM folders WHERE id = ? AND owner_id = ?", (folder_id, user["id"])
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Folder not found")
        return {"ok": True}

    # --------------------------------------------------------------- files

    def insert_file(
        conn, owner_id: int, folder_id: int | None, name: str, mime_type: str, content: bytes
    ) -> sqlite3.Row:
        now = db.utcnow()
        with db.transaction(conn):
            _own_folder(conn, owner_id, folder_id)
            name = unique_name(conn, owner_id, folder_id, name)
            cur = conn.execute(
                "INSERT INTO files (owner_id, folder_id, name, mime_type, size, content,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (owner_id, folder_id, name, mime_type, len(content), content, now, now),
            )
        return get_file(conn, cur.lastrowid)

    @router.post("/files")
    def create_file(body: NewFile, conn=Depends(get_db), user=Depends(require_user)):
        """A new text file, usually a Markdown note."""
        name = clean_name(body.name)
        if "." not in name:
            name += ".md"
        row = insert_file(
            conn, user["id"], body.folder_id, name, guess_type(name), body.content.encode()
        )
        return {"file": file_json(row)}

    @router.post("/files/upload")
    async def upload(
        request: Request,
        name: Annotated[str, Query()],
        folder_id: Annotated[int | None, Query()] = None,
        conn=Depends(get_db),
        user=Depends(require_user),
    ):
        """Upload one file as the raw request body (no multipart)."""
        limit = request.app.state.settings.max_upload_bytes
        if int(request.headers.get("content-length") or 0) > limit:
            raise HTTPException(status_code=413, detail=_too_big(limit))
        content = await request.body()
        if len(content) > limit:
            raise HTTPException(status_code=413, detail=_too_big(limit))
        name = clean_name(name)
        row = insert_file(conn, user["id"], folder_id, name, guess_type(name), content)
        return {"file": file_json(row)}

    @router.get("/files/{file_id}")
    def file_info(file_id: int, request: Request, conn=Depends(get_db), user=Depends(current_user)):
        role = require_role(request, conn, file_id, user, "view")
        return {"file": file_json(get_file(conn, file_id)), "role": role}

    @router.get("/files/{file_id}/content")
    def download(
        file_id: int,
        request: Request,
        download: bool = False,
        conn=Depends(get_db),
        user=Depends(current_user),
    ):
        require_role(request, conn, file_id, user, "view")
        row = conn.execute(
            "SELECT name, mime_type, content, updated_at FROM files WHERE id = ?", (file_id,)
        ).fetchone()
        media_type = row["mime_type"]
        if is_text(media_type):
            media_type += "; charset=utf-8"
        disposition = "attachment" if download else "inline"
        return Response(
            row["content"],
            media_type=media_type,
            headers={
                "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(row['name'])}",
                "Content-Security-Policy": DOWNLOAD_CSP,
            },
        )

    @router.put("/files/{file_id}/content")
    async def replace_content(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(current_user)
    ):
        require_role(request, conn, file_id, user, "edit")
        limit = request.app.state.settings.max_upload_bytes
        content = await request.body()
        if len(content) > limit:
            raise HTTPException(status_code=413, detail=_too_big(limit))
        save_content(conn, file_id, content)
        row = get_file(conn, file_id)
        if is_text(row["mime_type"]):
            listener = getattr(request.app.state, "content_listener", None)
            if listener is not None:
                listener(file_id, content.decode("utf-8", errors="replace"))
        return {"file": file_json(row)}

    @router.get("/files/{file_id}/export")
    async def export_file(
        file_id: int,
        request: Request,
        format: Annotated[str, Query(pattern="^(docx|pdf)$")],
        conn=Depends(get_db),
        user=Depends(current_user),
    ):
        """The note as a Word document or a PDF."""
        token = share_token(request)
        require_role(request, conn, file_id, user, "view")
        row = get_file(conn, file_id)
        if not is_markdown(row["mime_type"]):
            raise HTTPException(status_code=415, detail="Only Markdown notes can be exported.")
        # Someone may be typing: save the live copy first so the export is current.
        room = request.app.state.rooms.rooms.get(file_id)
        if room is not None:
            await room.save()
        source = bytes(
            conn.execute("SELECT content FROM files WHERE id = ?", (file_id,)).fetchone()[0]
        ).decode("utf-8", errors="replace")

        def load_image(image_id: int) -> tuple[bytes, str] | None:
            # Its own connection: this runs on a worker thread.
            image_conn = db.connect(request.app.state.settings.database_path)
            try:
                if file_access(image_conn, image_id, user, token) is None:
                    return None
                found = image_conn.execute(
                    "SELECT content, mime_type FROM files WHERE id = ?", (image_id,)
                ).fetchone()
            finally:
                image_conn.close()
            if found is None or not found["mime_type"].startswith("image/"):
                return None
            return bytes(found["content"]), found["mime_type"]

        title = row["name"].rsplit(".", 1)[0]
        convert = export.to_docx if format == "docx" else export.to_pdf
        data = await run_in_threadpool(convert, source, title, load_image)
        media_type = DOCX_TYPE if format == "docx" else "application/pdf"
        return Response(
            data,
            media_type=media_type,
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(title)}.{format}"
            },
        )

    @router.patch("/files/{file_id}")
    def change_file(
        file_id: int,
        body: FileChange,
        request: Request,
        conn=Depends(get_db),
        user=Depends(require_user),
    ):
        require_role(request, conn, file_id, user, "owner")
        with db.transaction(conn):
            row = get_file(conn, file_id)
            name = clean_name(body.name) if body.name is not None else row["name"]
            folder = body.folder_id if body.move else row["folder_id"]
            if body.move:
                _own_folder(conn, user["id"], folder)
            if _taken(conn, "files", user["id"], folder, name, skip=file_id):
                raise _exists("file", name)
            mime_type = guess_type(name) if name != row["name"] else row["mime_type"]
            conn.execute(
                "UPDATE files SET name = ?, folder_id = ?, mime_type = ?, updated_at = ?"
                " WHERE id = ?",
                (name, folder, mime_type, db.utcnow(), file_id),
            )
        return {"file": file_json(get_file(conn, file_id))}

    @router.delete("/files/{file_id}")
    def delete_file(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(require_user)
    ):
        require_role(request, conn, file_id, user, "owner")
        conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        return {"ok": True}

    return router


def save_content(conn: sqlite3.Connection, file_id: int, content: bytes) -> None:
    conn.execute(
        "UPDATE files SET content = ?, size = ?, updated_at = ? WHERE id = ?",
        (content, len(content), db.utcnow(), file_id),
    )


def _exists(kind: str, name: str) -> HTTPException:
    return HTTPException(status_code=409, detail=f"There's already a {kind} called {name} there.")


def _too_big(limit: int) -> str:
    return f"That file is too big. The limit is {limit // (1024 * 1024)} MB."
