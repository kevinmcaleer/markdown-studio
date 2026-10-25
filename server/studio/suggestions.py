"""Suggested edits on a document (Suggesting mode), anchored like comments.

A suggestion says "replace this passage with that": an insertion has no
passage (an empty ``quote``), a deletion has no ``replacement``. The server
only stores them; the document changes when someone with edit access accepts
one and their editor applies it, so it merges with everyone's live edits.

Who may do what follows the caller's sharing role (see :mod:`studio.access`):

* ``view`` and up can see suggestions.
* ``comment`` and up can suggest, and reply (which starts a comment thread on
  the same passage, or adds to it).
* Authors can change their own open suggestions, and withdraw them.
* ``edit`` and up can accept or reject; the owner can delete any.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from powertools_auth import Auth
from powertools_auth.security import RateLimiter

from .access import allows, file_access
from .comments import (
    MAX_ANCHOR,
    MAX_QUOTE,
    Caller,
    NewReply,
    _clean_body,
    _insert_comment,
    get_thread,
)
from .db import transaction, utcnow
from .files import share_token

MAX_REPLACEMENT = 20_000


class SuggestionBody(BaseModel):
    anchor_from: int = 0
    anchor_to: int = 0
    quote: str = ""
    anchor: str | None = None
    replacement: str = ""
    author_name: str = ""


def public_suggestion(s: sqlite3.Row, caller: Caller) -> dict:
    mine = caller.wrote(s)
    is_open = s["status"] == "open"
    return {
        "id": s["id"],
        "file_id": s["file_id"],
        "anchor_from": s["anchor_from"],
        "anchor_to": s["anchor_to"],
        "quote": s["quote"],
        "anchor": s["anchor"],
        "replacement": s["replacement"],
        "author": {
            "name": s["author_name"],
            "user_id": s["author_id"],
            "anonymous": s["author_id"] is None and s["author_anon"] is not None,
        },
        "status": s["status"],
        "decided_at": s["decided_at"],
        "decided_by": s["decided_by"],
        "thread_id": s["thread_id"],
        "created_at": s["created_at"],
        "updated_at": s["updated_at"],
        "mine": mine,
        "can_edit": mine and is_open and allows(caller.role, "comment"),
        "can_decide": is_open and allows(caller.role, "edit"),
        "can_delete": (mine and is_open) or caller.role == "owner",
    }


def _checked(body: SuggestionBody) -> tuple[int, int, str, str | None, str]:
    anchor_from = max(0, body.anchor_from)
    anchor_to = max(anchor_from, body.anchor_to)
    if len(body.quote) > MAX_QUOTE:
        raise HTTPException(status_code=400, detail="That's too much text to suggest a change to.")
    if len(body.replacement) > MAX_REPLACEMENT:
        raise HTTPException(
            status_code=400, detail=f"Keep suggestions under {MAX_REPLACEMENT} characters."
        )
    if body.anchor is not None and len(body.anchor) > MAX_ANCHOR:
        raise HTTPException(status_code=400, detail="anchor is too long")
    if not body.quote and not body.replacement:
        raise HTTPException(status_code=400, detail="This suggestion doesn't change anything.")
    return anchor_from, anchor_to, body.quote, body.anchor, body.replacement


def make_router(auth: Auth, get_db) -> APIRouter:
    router = APIRouter(tags=["suggestions"])
    # Each new suggestion is a burst of typing, so this is looser than comments.
    limiter = RateLimiter(limit=60, window=60)

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

    def suggestion_caller(
        suggestion_id: int, request: Request, conn: sqlite3.Connection, user: sqlite3.Row | None
    ) -> tuple[sqlite3.Row, Caller]:
        s = conn.execute("SELECT * FROM suggestions WHERE id = ?", (suggestion_id,)).fetchone()
        if s is None:
            raise HTTPException(status_code=404, detail="Suggestion not found")
        try:
            return s, caller_for(s["file_id"], request, conn, user)
        except HTTPException as exc:
            if exc.status_code == 404:
                exc.detail = "Suggestion not found"
            raise

    def require_comment_role(caller: Caller, what: str = "suggest changes to") -> None:
        if not allows(caller.role, "comment"):
            raise HTTPException(
                status_code=403, detail=f"You can view this file but not {what} it."
            )

    def throttle(caller: Caller) -> None:
        key = f"user:{caller.user['id']}" if caller.user else f"anon:{caller.anon}"
        allowed, retry_after = limiter.hit(key)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"You're suggesting very fast. Try again in {retry_after} seconds.",
                headers={"Retry-After": str(retry_after)},
            )

    def fetch(conn: sqlite3.Connection, suggestion_id: int, caller: Caller) -> dict:
        s = conn.execute("SELECT * FROM suggestions WHERE id = ?", (suggestion_id,)).fetchone()
        return public_suggestion(s, caller)

    @router.get("/api/files/{file_id}/suggestions")
    def list_suggestions(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        caller = caller_for(file_id, request, conn, user)
        rows = conn.execute(
            "SELECT * FROM suggestions WHERE file_id = ? ORDER BY anchor_from, id", (file_id,)
        ).fetchall()
        return {
            "suggestions": [public_suggestion(s, caller) for s in rows],
            "role": caller.role,
            "can_suggest": allows(caller.role, "comment"),
            "can_decide": allows(caller.role, "edit"),
        }

    @router.post("/api/files/{file_id}/suggestions")
    def suggest(
        file_id: int,
        body: SuggestionBody,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        caller = caller_for(file_id, request, conn, user)
        require_comment_role(caller)
        throttle(caller)
        anchor_from, anchor_to, quote, anchor, replacement = _checked(body)
        now = utcnow()
        cur = conn.execute(
            "INSERT INTO suggestions (file_id, anchor_from, anchor_to, quote, anchor, replacement,"
            " author_id, author_anon, author_name, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                file_id,
                anchor_from,
                anchor_to,
                quote,
                anchor,
                replacement,
                caller.user["id"] if caller.user else None,
                caller.anon,
                caller.name(body.author_name),
                now,
                now,
            ),
        )
        return {"suggestion": fetch(conn, cur.lastrowid, caller)}

    @router.patch("/api/suggestions/{suggestion_id}")
    def change(
        suggestion_id: int,
        body: SuggestionBody,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        s, caller = suggestion_caller(suggestion_id, request, conn, user)
        if not public_suggestion(s, caller)["can_edit"]:
            raise HTTPException(
                status_code=403, detail="You can only change your own open suggestions."
            )
        anchor_from, anchor_to, quote, anchor, replacement = _checked(body)
        conn.execute(
            "UPDATE suggestions SET anchor_from = ?, anchor_to = ?, quote = ?, anchor = ?,"
            " replacement = ?, updated_at = ? WHERE id = ?",
            (anchor_from, anchor_to, quote, anchor, replacement, utcnow(), suggestion_id),
        )
        return {"suggestion": fetch(conn, suggestion_id, caller)}

    @router.delete("/api/suggestions/{suggestion_id}")
    def withdraw(
        suggestion_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        s, caller = suggestion_caller(suggestion_id, request, conn, user)
        if not public_suggestion(s, caller)["can_delete"]:
            raise HTTPException(
                status_code=403, detail="You can only withdraw your own open suggestions."
            )
        conn.execute("DELETE FROM suggestions WHERE id = ?", (suggestion_id,))
        return {"deleted_id": suggestion_id}

    def decide(suggestion_id: int, status: str, request, conn, user) -> dict:
        s, caller = suggestion_caller(suggestion_id, request, conn, user)
        if not allows(caller.role, "edit"):
            raise HTTPException(
                status_code=403, detail="Only people who can edit this file can do that."
            )
        now = utcnow()
        # Only an open suggestion can be decided, so two editors pressing Accept
        # at once don't both apply it.
        cur = conn.execute(
            "UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ?, updated_at = ?"
            " WHERE id = ? AND status = 'open'",
            (status, now, caller.name(""), now, suggestion_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status_code=409, detail=f"This suggestion was already {s['status']}."
            )
        return {"suggestion": fetch(conn, suggestion_id, caller)}

    @router.post("/api/suggestions/{suggestion_id}/accept")
    def accept(
        suggestion_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        return decide(suggestion_id, "accepted", request, conn, user)

    @router.post("/api/suggestions/{suggestion_id}/reject")
    def reject(
        suggestion_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        return decide(suggestion_id, "rejected", request, conn, user)

    @router.post("/api/suggestions/{suggestion_id}/replies")
    def reply(
        suggestion_id: int,
        body: NewReply,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        s, caller = suggestion_caller(suggestion_id, request, conn, user)
        require_comment_role(caller, "comment on")
        throttle(caller)
        text = _clean_body(body.body)
        now = utcnow()
        with transaction(conn):
            thread_id = s["thread_id"]
            if thread_id is None:
                cur = conn.execute(
                    "INSERT INTO comment_threads (file_id, anchor_from, anchor_to, quote, anchor,"
                    " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        s["file_id"],
                        s["anchor_from"],
                        s["anchor_to"],
                        s["quote"],
                        s["anchor"],
                        now,
                        now,
                    ),
                )
                thread_id = cur.lastrowid
                conn.execute(
                    "UPDATE suggestions SET thread_id = ? WHERE id = ?", (thread_id, suggestion_id)
                )
            else:
                conn.execute(
                    "UPDATE comment_threads SET updated_at = ? WHERE id = ?", (now, thread_id)
                )
            _insert_comment(conn, thread_id, caller, body.author_name, text, now)
        return {
            "suggestion": fetch(conn, suggestion_id, caller),
            "thread": get_thread(conn, thread_id, caller),
        }

    return router
