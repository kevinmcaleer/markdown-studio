"""Sharing: links (for signed-in and anonymous visitors) and per-user grants.

Who can do what with a file is decided in one place,
:func:`studio.access.file_access`, which the file routes, comments and the
co-editing websocket all call; it asks :func:`shared_role` here about anyone
but the owner. Roles, lowest first::

    view     read and export, read comments
    comment  view, plus add and reply to comments
    edit     comment, plus change the content and resolve any thread
    owner    edit, plus rename, move, delete and manage sharing

A link carries a role and says whether visitors must sign in. Revoking a link
(or letting it expire) ends access for everyone who came in through it,
including signed-in users who have it in "Shared with me".
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from powertools_auth import Auth
from powertools_auth import store as users
from powertools_auth.security import new_token

from .access import ROLES, file_access
from .db import transaction, utcnow

Role = Literal["view", "comment", "edit"]
MAX_LINKS_PER_FILE = 50


def _active_link_sql(alias: str = "l") -> str:
    return f"{alias}.revoked_at IS NULL AND ({alias}.expires_at IS NULL OR {alias}.expires_at > ?)"


def active_link(conn: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    return conn.execute(
        f"SELECT * FROM share_links l WHERE token = ? AND {_active_link_sql()}",
        (token[:128], utcnow()),
    ).fetchone()


def best_role(*roles: str | None) -> str | None:
    known = [r for r in roles if r in ROLES]
    return max(known, key=ROLES.index) if known else None


def shared_role(
    conn: sqlite3.Connection, file_id: int, user: sqlite3.Row | None, share_token: str | None
) -> str | None:
    """The best role a link or a grant gives the caller (ownership aside)."""
    roles: list[str | None] = []
    link = active_link(conn, share_token)
    if link is not None and link["file_id"] == file_id and (link["anonymous"] or user):
        roles.append(link["role"])
    if user is not None:
        member = conn.execute(
            "SELECT role FROM file_members WHERE file_id = ? AND user_id = ?",
            (file_id, user["id"]),
        ).fetchone()
        roles.append(member["role"] if member else None)
        # Links this user opened before still work without the token in the URL.
        roles.extend(
            r["role"]
            for r in conn.execute(
                "SELECT l.role FROM share_link_visits v JOIN share_links l ON l.id = v.link_id"
                f" WHERE v.user_id = ? AND l.file_id = ? AND {_active_link_sql()}",
                (user["id"], file_id, utcnow()),
            )
        )
    return best_role(*roles)


# ---------------------------------------------------------------- store


def _expiry(days: int | None) -> str | None:
    if not days:
        return None
    when = datetime.now(UTC) + timedelta(days=days)
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_link(
    conn: sqlite3.Connection,
    file_id: int,
    created_by: int,
    role: str,
    anonymous: bool = True,
    expires_in_days: int | None = None,
) -> sqlite3.Row:
    cur = conn.execute(
        "INSERT INTO share_links (file_id, token, role, anonymous, created_by, created_at,"
        " expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (file_id, new_token(24), role, int(anonymous), created_by, utcnow(),
         _expiry(expires_in_days)),
    )  # fmt: skip
    return conn.execute("SELECT * FROM share_links WHERE id = ?", (cur.lastrowid,)).fetchone()


def public_link(link: sqlite3.Row) -> dict:
    now = utcnow()
    expired = link["expires_at"] is not None and link["expires_at"] <= now
    return {
        "id": link["id"],
        "token": link["token"],
        "path": f"/s/{link['token']}",
        "role": link["role"],
        "anonymous": bool(link["anonymous"]),
        "created_at": link["created_at"],
        "expires_at": link["expires_at"],
        "revoked_at": link["revoked_at"],
        "active": link["revoked_at"] is None and not expired,
    }


def list_shares(conn: sqlite3.Connection, file_id: int) -> dict:
    links = conn.execute(
        "SELECT * FROM share_links WHERE file_id = ? AND revoked_at IS NULL ORDER BY id",
        (file_id,),
    ).fetchall()
    members = conn.execute(
        "SELECT m.user_id, m.role, m.created_at, u.username FROM file_members m"
        " JOIN users u ON u.id = m.user_id WHERE m.file_id = ? ORDER BY u.username",
        (file_id,),
    ).fetchall()
    return {
        "links": [public_link(link) for link in links],
        "members": [
            {
                "user_id": m["user_id"],
                "username": m["username"],
                "role": m["role"],
                "created_at": m["created_at"],
            }
            for m in members
        ],
    }


def shared_with(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    """Files other people shared with this user, by name or by a link they opened."""
    now = utcnow()
    rows = conn.execute(
        "SELECT f.id, f.name, f.updated_at, o.username AS owner, m.role AS role,"
        " m.created_at AS shared_at FROM file_members m JOIN files f ON f.id = m.file_id"
        " JOIN users o ON o.id = f.owner_id WHERE m.user_id = ? AND f.owner_id != ?"
        " UNION ALL"
        " SELECT f.id, f.name, f.updated_at, o.username, l.role, v.last_opened_at"
        " FROM share_link_visits v JOIN share_links l ON l.id = v.link_id"
        " JOIN files f ON f.id = l.file_id JOIN users o ON o.id = f.owner_id"
        f" WHERE v.user_id = ? AND f.owner_id != ? AND {_active_link_sql()}",
        (user_id, user_id, user_id, user_id, now),
    ).fetchall()
    merged: dict[int, dict] = {}
    for r in rows:
        item = merged.get(r["id"])
        if item is None:
            merged[r["id"]] = {
                "id": r["id"],
                "name": r["name"],
                "owner": r["owner"],
                "role": r["role"],
                "updated_at": r["updated_at"],
                "shared_at": r["shared_at"],
            }
        else:
            item["role"] = best_role(item["role"], r["role"])
            item["shared_at"] = max(item["shared_at"], r["shared_at"])
    return sorted(merged.values(), key=lambda f: f["shared_at"], reverse=True)


# ---------------------------------------------------------------- routes


class LinkBody(BaseModel):
    role: Role = "view"
    anonymous: bool = True
    expires_in_days: int | None = None


class LinkUpdate(BaseModel):
    role: Role | None = None
    anonymous: bool | None = None


class MemberBody(BaseModel):
    username: str = ""
    role: Role = "view"


def make_router(auth: Auth, get_db) -> APIRouter:
    router = APIRouter(tags=["sharing"])

    def owned_file(file_id: int, conn: sqlite3.Connection, user: sqlite3.Row) -> sqlite3.Row:
        """The file, if the user owns it. Anyone else gets the same 404."""
        row = conn.execute(
            "SELECT * FROM files WHERE id = ? AND owner_id = ?", (file_id, user["id"])
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="File not found")
        return row

    def owned_link(file_id: int, link_id: int, conn: sqlite3.Connection) -> sqlite3.Row:
        link = conn.execute(
            "SELECT * FROM share_links WHERE id = ? AND file_id = ? AND revoked_at IS NULL",
            (link_id, file_id),
        ).fetchone()
        if link is None:
            raise HTTPException(status_code=404, detail="Link not found")
        return link

    @router.get("/api/files/{file_id}/shares")
    def get_shares(file_id: int, conn=Depends(get_db), user=Depends(auth.require_user)):
        owned_file(file_id, conn, user)
        return list_shares(conn, file_id)

    @router.post("/api/files/{file_id}/shares")
    def add_link(
        file_id: int, body: LinkBody, conn=Depends(get_db), user=Depends(auth.require_user)
    ):
        owned_file(file_id, conn, user)
        if body.expires_in_days is not None and not 1 <= body.expires_in_days <= 3650:
            raise HTTPException(status_code=400, detail="A link can expire in 1 to 3650 days.")
        with transaction(conn):
            count = conn.execute(
                "SELECT COUNT(*) FROM share_links WHERE file_id = ? AND revoked_at IS NULL",
                (file_id,),
            ).fetchone()[0]
            if count >= MAX_LINKS_PER_FILE:
                raise HTTPException(
                    status_code=400, detail="This file has too many links. Turn some off first."
                )
            link = create_link(
                conn, file_id, user["id"], body.role, body.anonymous, body.expires_in_days
            )
        return {"link": public_link(link)}

    @router.patch("/api/files/{file_id}/shares/{link_id}")
    def update_link(
        file_id: int,
        link_id: int,
        body: LinkUpdate,
        conn=Depends(get_db),
        user=Depends(auth.require_user),
    ):
        owned_file(file_id, conn, user)
        link = owned_link(file_id, link_id, conn)
        role = body.role or link["role"]
        anonymous = link["anonymous"] if body.anonymous is None else int(body.anonymous)
        conn.execute(
            "UPDATE share_links SET role = ?, anonymous = ? WHERE id = ?",
            (role, anonymous, link_id),
        )
        return {"link": public_link(owned_link(file_id, link_id, conn))}

    @router.delete("/api/files/{file_id}/shares/{link_id}")
    def revoke_link(
        file_id: int, link_id: int, conn=Depends(get_db), user=Depends(auth.require_user)
    ):
        owned_file(file_id, conn, user)
        owned_link(file_id, link_id, conn)
        conn.execute("UPDATE share_links SET revoked_at = ? WHERE id = ?", (utcnow(), link_id))
        return {"ok": True}

    @router.post("/api/files/{file_id}/members")
    def add_member(
        file_id: int, body: MemberBody, conn=Depends(get_db), user=Depends(auth.require_user)
    ):
        owned_file(file_id, conn, user)
        member = users.find_user(conn, body.username) if body.username.strip() else None
        if member is None:
            raise HTTPException(status_code=404, detail="There's no user with that name.")
        if member["id"] == user["id"]:
            raise HTTPException(status_code=400, detail="You already own this file.")
        conn.execute(
            "INSERT INTO file_members (file_id, user_id, role, added_by, created_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT (file_id, user_id) DO UPDATE SET role = excluded.role",
            (file_id, member["id"], body.role, user["id"], utcnow()),
        )
        return list_shares(conn, file_id)

    @router.delete("/api/files/{file_id}/members/{member_id}")
    def remove_member(
        file_id: int, member_id: int, conn=Depends(get_db), user=Depends(auth.require_user)
    ):
        owned_file(file_id, conn, user)
        conn.execute(
            "DELETE FROM file_members WHERE file_id = ? AND user_id = ?", (file_id, member_id)
        )
        return list_shares(conn, file_id)

    @router.get("/api/shared-with-me")
    def shared_with_me(conn=Depends(get_db), user=Depends(auth.require_user)):
        return {"files": shared_with(conn, user["id"])}

    @router.get("/api/s/{token}")
    def open_link(token: str, conn=Depends(get_db), user=Depends(auth.current_user)):
        """What a share link points at, and the visitor's role. Public."""
        link = active_link(conn, token)
        if link is None:
            raise HTTPException(
                status_code=404, detail="This link has been turned off or has expired."
            )
        if not link["anonymous"] and user is None:
            raise HTTPException(status_code=401, detail="Sign in to open this link.")
        file = conn.execute(
            "SELECT f.id, f.name, f.owner_id, f.updated_at, u.username AS owner FROM files f"
            " JOIN users u ON u.id = f.owner_id WHERE f.id = ?",
            (link["file_id"],),
        ).fetchone()
        role = file_access(conn, file["id"], user, token)
        if user is not None and file["owner_id"] != user["id"]:
            conn.execute(
                "INSERT INTO share_link_visits (link_id, user_id, last_opened_at) VALUES (?, ?, ?)"
                " ON CONFLICT (link_id, user_id)"
                " DO UPDATE SET last_opened_at = excluded.last_opened_at",
                (link["id"], user["id"], utcnow()),
            )
        return {
            "file": {
                "id": file["id"],
                "name": file["name"],
                "owner": file["owner"],
                "updated_at": file["updated_at"],
            },
            "role": role,
            "anonymous": bool(link["anonymous"]),
        }

    return router
