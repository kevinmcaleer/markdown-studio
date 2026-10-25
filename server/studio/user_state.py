"""Each person's private state for a file: resume position, bookmarks, folds.

The editor decides what goes in it; the server only checks that it is a JSON
object of sensible size and that the caller can still see the file. It needs
an account: anonymous share-link visitors keep theirs in their browser.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from powertools_auth import Auth

from .access import file_access
from .db import utcnow
from .files import share_token

# Plenty for a few hundred bookmarks with notes, and folds.
MAX_STATE = 64_000


class SaveState(BaseModel):
    state: dict[str, Any]


def make_router(auth: Auth, get_db) -> APIRouter:
    router = APIRouter(tags=["user-state"])

    def check(file_id: int, request: Request, conn: sqlite3.Connection, user) -> None:
        if user is None:
            raise HTTPException(status_code=401, detail="Sign in required")
        if file_access(conn, file_id, user, share_token(request)) is None:
            raise HTTPException(status_code=404, detail="File not found")

    @router.get("/api/files/{file_id}/my-state")
    def get_state(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(auth.current_user)
    ):
        check(file_id, request, conn, user)
        row = conn.execute(
            "SELECT state, updated_at FROM file_user_state WHERE file_id = ? AND user_id = ?",
            (file_id, user["id"]),
        ).fetchone()
        if row is None:
            return {"state": None, "updated_at": None}
        return {"state": json.loads(row["state"]), "updated_at": row["updated_at"]}

    @router.put("/api/files/{file_id}/my-state")
    def put_state(
        file_id: int,
        body: SaveState,
        request: Request,
        conn=Depends(get_db),
        user=Depends(auth.current_user),
    ):
        check(file_id, request, conn, user)
        text = json.dumps(body.state, separators=(",", ":"))
        if len(text) > MAX_STATE:
            raise HTTPException(status_code=400, detail="That's too much to remember for one file.")
        now = utcnow()
        conn.execute(
            "INSERT INTO file_user_state (file_id, user_id, state, updated_at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT (file_id, user_id) DO UPDATE SET state = excluded.state,"
            " updated_at = excluded.updated_at",
            (file_id, user["id"], text, now),
        )
        return {"updated_at": now}

    return router
