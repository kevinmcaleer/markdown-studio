"""Threaded comments on a document, anchored to a selection.

Who may do what follows the caller's sharing role (see :mod:`studio.access`):

* ``view`` and up can read every thread.
* ``comment`` and up can start threads and reply. Anonymous visitors on a
  link that allows commenting sign their comments with a name of their choice.
* Authors can edit and delete their own comments; the owner can delete any.
* The thread's starter and anyone with ``edit`` can resolve and reopen it.

An anonymous author is recognised by the anonymous cookie the auth package
gives every visitor (stored hashed), so they keep control of their comments
for as long as they keep that browser.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from powertools_auth import Auth
from powertools_auth.security import RateLimiter, token_digest

from .access import allows, file_access
from .db import transaction, utcnow
from .files import share_token

MAX_BODY = 10_000
MAX_QUOTE = 2_000
MAX_ANCHOR = 4_000
MAX_NAME = 40


class NewThread(BaseModel):
    body: str = ""
    anchor_from: int = 0
    anchor_to: int = 0
    quote: str = ""
    anchor: str | None = None
    author_name: str = ""


class NewReply(BaseModel):
    body: str = ""
    author_name: str = ""


class EditBody(BaseModel):
    body: str = ""


class Caller:
    """Who is asking, and what their sharing role allows."""

    def __init__(self, user: sqlite3.Row | None, anon_id: str, role: str | None) -> None:
        self.user = user
        self.anon = None if user else token_digest(anon_id) if anon_id else None
        self.role = role

    def wrote(self, comment: sqlite3.Row) -> bool:
        if self.user is not None:
            return comment["author_id"] == self.user["id"]
        return self.anon is not None and comment["author_anon"] == self.anon

    def name(self, supplied: str) -> str:
        if self.user is not None:
            return self.user["username"]
        name = " ".join(supplied.split())[:MAX_NAME]
        return name or "Guest"


def _clean_body(body: str) -> str:
    body = body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Write something first.")
    if len(body) > MAX_BODY:
        raise HTTPException(status_code=400, detail=f"Keep comments under {MAX_BODY} characters.")
    return body


def _public_comment(c: sqlite3.Row, caller: Caller) -> dict:
    deleted = c["deleted_at"] is not None
    mine = caller.wrote(c)
    return {
        "id": c["id"],
        "author": {
            "name": c["author_name"],
            "user_id": c["author_id"],
            "anonymous": c["author_id"] is None and c["author_anon"] is not None,
        },
        "body": "" if deleted else c["body"],
        "created_at": c["created_at"],
        "edited_at": c["edited_at"],
        "deleted": deleted,
        "mine": mine,
        "can_edit": mine and not deleted and allows(caller.role, "comment"),
        "can_delete": not deleted and (mine or caller.role == "owner"),
    }


def _can_resolve(thread_starter: sqlite3.Row | None, caller: Caller) -> bool:
    if allows(caller.role, "edit"):
        return True
    return (
        thread_starter is not None
        and caller.wrote(thread_starter)
        and allows(caller.role, "comment")
    )


def list_threads(conn: sqlite3.Connection, file_id: int, caller: Caller) -> list[dict]:
    threads = conn.execute(
        "SELECT * FROM comment_threads WHERE file_id = ? ORDER BY anchor_from, id", (file_id,)
    ).fetchall()
    comments: dict[int, list[sqlite3.Row]] = {}
    for c in conn.execute(
        "SELECT c.* FROM comments c JOIN comment_threads t ON t.id = c.thread_id"
        " WHERE t.file_id = ? ORDER BY c.id",
        (file_id,),
    ):
        comments.setdefault(c["thread_id"], []).append(c)
    return [_public_thread(t, comments.get(t["id"], []), caller) for t in threads]


def _public_thread(t: sqlite3.Row, comments: list[sqlite3.Row], caller: Caller) -> dict:
    return {
        "id": t["id"],
        "file_id": t["file_id"],
        "anchor_from": t["anchor_from"],
        "anchor_to": t["anchor_to"],
        "quote": t["quote"],
        "anchor": t["anchor"],
        "resolved": t["resolved_at"] is not None,
        "resolved_at": t["resolved_at"],
        "resolved_by": t["resolved_by"],
        "created_at": t["created_at"],
        "updated_at": t["updated_at"],
        "comments": [_public_comment(c, caller) for c in comments],
        "can_reply": allows(caller.role, "comment"),
        "can_resolve": _can_resolve(comments[0] if comments else None, caller),
    }


def get_thread(conn: sqlite3.Connection, thread_id: int, caller: Caller) -> dict:
    t = conn.execute("SELECT * FROM comment_threads WHERE id = ?", (thread_id,)).fetchone()
    comments = conn.execute(
        "SELECT * FROM comments WHERE thread_id = ? ORDER BY id", (thread_id,)
    ).fetchall()
    return _public_thread(t, comments, caller)


def make_router(auth: Auth, get_db) -> APIRouter:
    router = APIRouter(tags=["comments"])
    # Keeps a link that allows anonymous comments from being used to flood a file.
    limiter = RateLimiter(limit=30, window=60)

    def caller_for(
        file_id: int, request: Request, conn: sqlite3.Connection, user: sqlite3.Row | None
    ) -> Caller:
        token = share_token(request)
        role = file_access(conn, file_id, user, token)
        if role is None:
            if user is None and token is None:
                raise HTTPException(status_code=401, detail="Sign in required")
            raise HTTPException(status_code=404, detail="File not found")
        return Caller(user, getattr(request.state, "anon_id", ""), role)

    def thread_caller(
        thread_id: int, request: Request, conn: sqlite3.Connection, user: sqlite3.Row | None
    ) -> tuple[sqlite3.Row, Caller]:
        thread = conn.execute("SELECT * FROM comment_threads WHERE id = ?", (thread_id,)).fetchone()
        if thread is None:
            raise HTTPException(status_code=404, detail="Comment not found")
        try:
            return thread, caller_for(thread["file_id"], request, conn, user)
        except HTTPException as exc:
            if exc.status_code == 404:
                exc.detail = "Comment not found"
            raise

    def comment_caller(
        comment_id: int, request: Request, conn: sqlite3.Connection, user: sqlite3.Row | None
    ) -> tuple[sqlite3.Row, Caller]:
        comment = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if comment is None:
            raise HTTPException(status_code=404, detail="Comment not found")
        _, caller = thread_caller(comment["thread_id"], request, conn, user)
        return comment, caller

    def require_comment_role(caller: Caller, request: Request) -> None:
        if not allows(caller.role, "comment"):
            raise HTTPException(status_code=403, detail="You can view this file but not comment.")
        key = f"user:{caller.user['id']}" if caller.user else f"anon:{caller.anon}"
        allowed, retry_after = limiter.hit(key)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"You're commenting very fast. Try again in {retry_after} seconds.",
                headers={"Retry-After": str(retry_after)},
            )

    @router.get("/api/files/{file_id}/comments")
    def get_comments(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        caller = caller_for(file_id, request, conn, user)
        return {
            "threads": list_threads(conn, file_id, caller),
            "role": caller.role,
            "can_comment": allows(caller.role, "comment"),
        }

    @router.post("/api/files/{file_id}/comments")
    def start_thread(
        file_id: int,
        body: NewThread,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        caller = caller_for(file_id, request, conn, user)
        require_comment_role(caller, request)
        text = _clean_body(body.body)
        anchor_from = max(0, body.anchor_from)
        anchor_to = max(anchor_from, body.anchor_to)
        if body.anchor is not None and len(body.anchor) > MAX_ANCHOR:
            raise HTTPException(status_code=400, detail="anchor is too long")
        now = utcnow()
        with transaction(conn):
            cur = conn.execute(
                "INSERT INTO comment_threads (file_id, anchor_from, anchor_to, quote, anchor,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (file_id, anchor_from, anchor_to, body.quote[:MAX_QUOTE], body.anchor, now, now),
            )
            thread_id = cur.lastrowid
            _insert_comment(conn, thread_id, caller, body.author_name, text, now)
        return {"thread": get_thread(conn, thread_id, caller)}

    @router.post("/api/comment-threads/{thread_id}/replies")
    def reply(
        thread_id: int,
        body: NewReply,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        _, caller = thread_caller(thread_id, request, conn, user)
        require_comment_role(caller, request)
        text = _clean_body(body.body)
        now = utcnow()
        with transaction(conn):
            _insert_comment(conn, thread_id, caller, body.author_name, text, now)
            conn.execute("UPDATE comment_threads SET updated_at = ? WHERE id = ?", (now, thread_id))
        return {"thread": get_thread(conn, thread_id, caller)}

    def set_resolved(thread_id: int, resolved: bool, request, conn, user) -> dict:
        thread, caller = thread_caller(thread_id, request, conn, user)
        starter = conn.execute(
            "SELECT * FROM comments WHERE thread_id = ? ORDER BY id LIMIT 1", (thread_id,)
        ).fetchone()
        if not _can_resolve(starter, caller):
            raise HTTPException(
                status_code=403, detail="Only editors and the person who started this can do that."
            )
        now = utcnow()
        conn.execute(
            "UPDATE comment_threads SET resolved_at = ?, resolved_by = ?, updated_at = ?"
            " WHERE id = ?",
            (now if resolved else None, caller.name("") if resolved else None, now, thread_id),
        )
        return {"thread": get_thread(conn, thread["id"], caller)}

    @router.post("/api/comment-threads/{thread_id}/resolve")
    def resolve(
        thread_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        return set_resolved(thread_id, True, request, conn, user)

    @router.post("/api/comment-threads/{thread_id}/reopen")
    def reopen(
        thread_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        return set_resolved(thread_id, False, request, conn, user)

    @router.patch("/api/comments/{comment_id}")
    def edit_comment(
        comment_id: int,
        body: EditBody,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        comment, caller = comment_caller(comment_id, request, conn, user)
        if not _public_comment(comment, caller)["can_edit"]:
            raise HTTPException(status_code=403, detail="You can only edit your own comments.")
        text = _clean_body(body.body)
        conn.execute(
            "UPDATE comments SET body = ?, edited_at = ? WHERE id = ?", (text, utcnow(), comment_id)
        )
        return {"thread": get_thread(conn, comment["thread_id"], caller)}

    @router.delete("/api/comments/{comment_id}")
    def delete_comment(
        comment_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        comment, caller = comment_caller(comment_id, request, conn, user)
        if not _public_comment(comment, caller)["can_delete"]:
            raise HTTPException(status_code=403, detail="You can only delete your own comments.")
        thread_id = comment["thread_id"]
        with transaction(conn):
            conn.execute(
                "UPDATE comments SET body = '', deleted_at = ? WHERE id = ?",
                (utcnow(), comment_id),
            )
            left = conn.execute(
                "SELECT COUNT(*) FROM comments WHERE thread_id = ? AND deleted_at IS NULL",
                (thread_id,),
            ).fetchone()[0]
            if left == 0:
                # Nothing left to read, so the thread goes too.
                conn.execute("DELETE FROM comment_threads WHERE id = ?", (thread_id,))
        if left == 0:
            return {"thread": None, "deleted_thread_id": thread_id}
        return {"thread": get_thread(conn, thread_id, caller)}

    return router


def _insert_comment(
    conn: sqlite3.Connection, thread_id: int, caller: Caller, name: str, body: str, now: str
) -> None:
    conn.execute(
        "INSERT INTO comments (thread_id, author_id, author_anon, author_name, body, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (
            thread_id,
            caller.user["id"] if caller.user else None,
            caller.anon,
            caller.name(name),
            body,
            now,
        ),
    )
