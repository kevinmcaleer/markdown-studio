"""Users and sessions in SQLite. Framework-free, so a CLI or another app can use it.

Every function takes an open ``sqlite3.Connection`` (row factory ``sqlite3.Row``)
on a database that has had :func:`powertools_auth.migrations_dir` applied.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime, timedelta

from .security import hash_password, needs_rehash, new_token, password_problem, token_digest
from .security import verify_password as _verify

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class UserError(ValueError):
    """Invalid input; the message is safe to show to the user."""


def utcnow(offset_seconds: int = 0) -> str:
    """UTC time as an ISO-8601 string with millisecond precision."""
    when = datetime.now(UTC) + timedelta(seconds=offset_seconds)
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------- users


def user_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def registration_open(conn: sqlite3.Connection, allow_registration: bool) -> bool:
    """Registration is always open on a fresh install so the owner can sign up."""
    return allow_registration or user_count(conn) == 0


def get_user(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def find_user(conn: sqlite3.Connection, username: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE username = ?", (username.strip(),)).fetchone()


def find_user_by_login(conn: sqlite3.Connection, login: str) -> sqlite3.Row | None:
    """Look a user up by username or, if it has an '@', by email address."""
    login = login.strip()
    if "@" in login:
        return conn.execute("SELECT * FROM users WHERE email = ?", (login,)).fetchone()
    return find_user(conn, login)


def create_user(
    conn: sqlite3.Connection, username: str, password: str, email: str | None = None
) -> int:
    """Create a user and return its id. Raises UserError on invalid input."""
    username = username.strip()
    email = (email or "").strip() or None
    if not USERNAME_RE.match(username):
        raise UserError("Username must be 3-32 characters: letters, numbers, '.', '_' or '-'.")
    if email and not EMAIL_RE.match(email):
        raise UserError("That email address doesn't look right.")
    problem = password_problem(password)
    if problem:
        raise UserError(problem)
    now = utcnow()
    try:
        cur = conn.execute(
            "INSERT INTO users (username, email, password_hash, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (username, email, hash_password(password), now, now),
        )
    except sqlite3.IntegrityError as exc:
        if "email" in str(exc):
            raise UserError("That email address is already registered.") from None
        raise UserError("That username is already taken.") from None
    return cur.lastrowid


def authenticate(conn: sqlite3.Connection, username: str, password: str) -> sqlite3.Row | None:
    user = find_user(conn, username)
    if not _verify(user["password_hash"] if user else None, password):
        return None
    if needs_rehash(user["password_hash"]):
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(password), user["id"])
        )
    return user


def check_password(user: sqlite3.Row, password: str) -> bool:
    return _verify(user["password_hash"], password)


def set_password(conn: sqlite3.Connection, user_id: int, password: str) -> None:
    """Change a password and end every session of that user. Raises UserError."""
    problem = password_problem(password)
    if problem:
        raise UserError(problem)
    conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        (hash_password(password), utcnow(), user_id),
    )
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))


def set_email(conn: sqlite3.Connection, user_id: int, email: str) -> None:
    """Change (or, with an empty string, remove) a user's email. Raises UserError."""
    email = email.strip()
    if email and not EMAIL_RE.match(email):
        raise UserError("That email address doesn't look right.")
    try:
        conn.execute(
            "UPDATE users SET email = ?, updated_at = ? WHERE id = ?",
            (email or None, utcnow(), user_id),
        )
    except sqlite3.IntegrityError:
        raise UserError("That email address is already registered.") from None
    # A reset link already sent to the old address must not keep working.
    conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))


def delete_user(conn: sqlite3.Connection, user_id: int) -> None:
    # ON DELETE CASCADE removes sessions and anything an app hangs off users(id).
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


# ------------------------------------------------------------------------ sessions


def create_session(
    conn: sqlite3.Connection, user_id: int, max_age: int, user_agent: str = ""
) -> str:
    """Store a new session and return the token for the cookie (only its hash is kept)."""
    token = new_token()
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (utcnow(),))
    conn.execute(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent)"
        " VALUES (?, ?, ?, ?, ?)",
        (token_digest(token), user_id, utcnow(), utcnow(max_age), user_agent[:255]),
    )
    return token


def session_user(conn: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    return conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id"
        " WHERE s.id = ? AND s.expires_at > ?",
        (token_digest(token), utcnow()),
    ).fetchone()


def delete_session(conn: sqlite3.Connection, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE id = ?", (token_digest(token),))


# ------------------------------------------------------------------ password resets


def create_reset_token(
    conn: sqlite3.Connection, user_id: int, max_age: int, min_interval: int = 0
) -> str | None:
    """Store a one-time password reset token and return it (only its hash is kept).

    Any earlier link for the user stops working. Returns None, creating nothing,
    if a link was issued less than ``min_interval`` seconds ago, so repeated
    requests can't flood someone's inbox.
    """
    conn.execute("DELETE FROM password_resets WHERE expires_at <= ?", (utcnow(),))
    if (
        min_interval
        and conn.execute(
            "SELECT 1 FROM password_resets WHERE user_id = ? AND created_at > ?",
            (user_id, utcnow(-min_interval)),
        ).fetchone()
    ):
        return None
    conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))
    token = new_token()
    conn.execute(
        "INSERT INTO password_resets (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token_digest(token), user_id, utcnow(), utcnow(max_age)),
    )
    return token


def reset_token_user(conn: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    """The user a still-valid reset token belongs to, or None."""
    if not token:
        return None
    return conn.execute(
        "SELECT u.* FROM password_resets r JOIN users u ON u.id = r.user_id"
        " WHERE r.id = ? AND r.expires_at > ?",
        (token_digest(token), utcnow()),
    ).fetchone()


def reset_password(conn: sqlite3.Connection, token: str | None, password: str) -> sqlite3.Row:
    """Use a reset token to set a new password; returns the user. Raises UserError.

    Like :func:`set_password`, this ends every session and every other reset link.
    """
    user = reset_token_user(conn, token)
    if user is None:
        raise UserError("This reset link has expired or has already been used.")
    set_password(conn, user["id"], password)
    return user


def public_user(user: sqlite3.Row) -> dict:
    """The fields of a user that are safe to send to the browser."""
    return {
        "id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "created_at": user["created_at"],
    }
