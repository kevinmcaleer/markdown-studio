"""Who may do what with a file.

Every file route and the co-editing websocket ask :func:`file_access` for the
caller's role, so sharing only has to change this one function. Roles are
ordered: ``view`` < ``comment`` < ``edit`` < ``owner``.

- view: read the file and export it
- comment: view, plus comment on it
- edit: comment, plus change its contents (directly or by co-editing)
- owner: edit, plus rename, move and delete it
"""

from __future__ import annotations

import sqlite3

ROLES = ("view", "comment", "edit", "owner")


def file_access(
    conn: sqlite3.Connection,
    file_id: int,
    user: sqlite3.Row | None,
    share_token: str | None = None,
) -> str | None:
    """The caller's role on ``file_id``, or None if they can't see it (or it doesn't exist).

    ``user`` is None for anonymous callers; ``share_token`` is the token from a
    share link, if the request came with one.
    """
    row = conn.execute("SELECT owner_id FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None:
        return None
    if user is not None and row["owner_id"] == user["id"]:
        return "owner"
    return None


def allows(role: str | None, needed: str) -> bool:
    """True if ``role`` is at least ``needed``."""
    return role is not None and ROLES.index(role) >= ROLES.index(needed)
