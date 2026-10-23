from __future__ import annotations

import sqlite3

import pytest

from powertools_auth import migrations_dir, store
from powertools_auth.security import RateLimiter, csrf_token, csrf_valid, token_digest

PASSWORD = "correct horse battery"


@pytest.fixture
def conn():
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    for file in sorted(migrations_dir().glob("*.sql")):
        conn.executescript(file.read_text())
    yield conn
    conn.close()


def test_create_and_authenticate(conn):
    user_id = store.create_user(conn, "kev", PASSWORD, "kev@example.com")
    assert store.authenticate(conn, "KEV", PASSWORD)["id"] == user_id
    assert store.authenticate(conn, "kev", "wrong password!!") is None
    assert store.authenticate(conn, "nobody", PASSWORD) is None


@pytest.mark.parametrize(
    ("username", "password", "email", "message"),
    [
        ("ab", PASSWORD, None, "Username"),
        ("kev", "short", None, "at least"),
        ("kev", PASSWORD, "not-an-email", "email"),
    ],
)
def test_create_user_validation(conn, username, password, email, message):
    with pytest.raises(store.UserError, match=message):
        store.create_user(conn, username, password, email)


def test_duplicate_username_and_email(conn):
    store.create_user(conn, "kev", PASSWORD, "kev@example.com")
    with pytest.raises(store.UserError, match="username"):
        store.create_user(conn, "Kev", PASSWORD)
    with pytest.raises(store.UserError, match="email"):
        store.create_user(conn, "other", PASSWORD, "KEV@example.com")


def test_registration_open_for_first_user_only(conn):
    assert store.registration_open(conn, allow_registration=False)
    store.create_user(conn, "kev", PASSWORD)
    assert not store.registration_open(conn, allow_registration=False)
    assert store.registration_open(conn, allow_registration=True)


def test_sessions_are_stored_hashed_and_expire(conn):
    user_id = store.create_user(conn, "kev", PASSWORD)
    token = store.create_session(conn, user_id, max_age=60)
    assert store.session_user(conn, token)["id"] == user_id
    row = conn.execute("SELECT id FROM sessions").fetchone()
    assert row["id"] == token_digest(token) != token

    expired = store.create_session(conn, user_id, max_age=-1)
    assert store.session_user(conn, expired) is None

    store.delete_session(conn, token)
    assert store.session_user(conn, token) is None


def test_set_password_ends_sessions(conn):
    user_id = store.create_user(conn, "kev", PASSWORD)
    token = store.create_session(conn, user_id, max_age=60)
    store.set_password(conn, user_id, "a brand new passphrase")
    assert store.session_user(conn, token) is None
    assert store.authenticate(conn, "kev", "a brand new passphrase")


def test_delete_user_cascades_sessions(conn):
    user_id = store.create_user(conn, "kev", PASSWORD)
    store.create_session(conn, user_id, max_age=60)
    store.delete_user(conn, user_id)
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_public_user_has_no_hash(conn):
    user = store.get_user(conn, store.create_user(conn, "kev", PASSWORD))
    assert "password_hash" not in store.public_user(user)


def test_csrf_token_is_bound():
    token = csrf_token("secret", "session-a")
    assert csrf_valid("secret", "session-a", token)
    assert not csrf_valid("secret", "session-b", token)
    assert not csrf_valid("secret", None, token)


def test_rate_limiter_window():
    now = [0.0]
    limiter = RateLimiter(2, 10, clock=lambda: now[0])
    assert limiter.hit("ip")[0] and limiter.hit("ip")[0]
    allowed, retry = limiter.hit("ip")
    assert not allowed and retry > 0
    now[0] = 11
    assert limiter.hit("ip")[0]
