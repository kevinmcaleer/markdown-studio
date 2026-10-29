"""The admin commands in ``python -m studio``."""

from __future__ import annotations

import io

import pytest

from powertools_auth import store
from studio import db
from studio.__main__ import main

OLD_PASSWORD = "correct horse battery"
NEW_PASSWORD = "a brand new passphrase"


@pytest.fixture
def database(tmp_path, monkeypatch):
    path = tmp_path / "data" / "studio.db"
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("SECRET_KEY", "test-secret-key-that-is-long-enough-0123456789")
    monkeypatch.setenv("DATABASE_PATH", str(path))
    db.init_db(path)
    conn = db.connect(path)
    with db.transaction(conn):
        user_id = store.create_user(conn, "kev", OLD_PASSWORD, "kev@example.com")
        store.create_user(conn, "sam", OLD_PASSWORD)
        token = store.create_session(conn, user_id, 3600)
        reset = store.create_reset_token(conn, user_id, 3600)
    yield conn, token, reset
    conn.close()


def password_works(conn, username, password):
    return store.check_password(store.find_user(conn, username), password)


def test_reset_with_prompt_signs_user_out(database, monkeypatch, capsys):
    conn, token, reset = database
    monkeypatch.setattr("getpass.getpass", lambda prompt="": NEW_PASSWORD)
    assert main(["reset-password", "kev"]) == 0
    assert password_works(conn, "kev", NEW_PASSWORD)
    assert store.session_user(conn, token) is None
    assert store.reset_token_user(conn, reset) is None
    assert password_works(conn, "sam", OLD_PASSWORD)
    assert "Password changed for kev" in capsys.readouterr().out


def test_prompt_mismatch_changes_nothing(database, monkeypatch, capsys):
    conn, token, _ = database
    answers = iter([NEW_PASSWORD, "something else entirely"])
    monkeypatch.setattr("getpass.getpass", lambda prompt="": next(answers))
    assert main(["reset-password", "kev"]) == 1
    assert password_works(conn, "kev", OLD_PASSWORD)
    assert store.session_user(conn, token) is not None
    assert "do not match" in capsys.readouterr().err


def test_generate_prints_a_working_password(database, capsys):
    conn, *_ = database
    assert main(["reset-password", "kev@example.com", "--generate"]) == 0
    out = capsys.readouterr().out
    password = out.split("New password: ")[1].split()[0]
    assert len(password) >= 20
    assert password_works(conn, "kev", password)


def test_password_from_stdin(database, monkeypatch):
    conn, *_ = database
    monkeypatch.setattr("sys.stdin", io.StringIO(NEW_PASSWORD + "\n"))
    assert main(["reset-password", "KEV", "--password-stdin"]) == 0
    assert password_works(conn, "kev", NEW_PASSWORD)


def test_weak_password_is_refused(database, monkeypatch, capsys):
    conn, *_ = database
    monkeypatch.setattr("sys.stdin", io.StringIO("short\n"))
    assert main(["reset-password", "kev", "--password-stdin"]) == 1
    assert password_works(conn, "kev", OLD_PASSWORD)
    assert "at least" in capsys.readouterr().err


def test_unknown_user(database, capsys):
    assert main(["reset-password", "nobody", "--generate"]) == 1
    assert "python -m studio users" in capsys.readouterr().err


def test_generate_and_stdin_are_exclusive(database):
    with pytest.raises(SystemExit):
        main(["reset-password", "kev", "--generate", "--password-stdin"])


def test_users_lists_accounts(database, capsys):
    assert main(["users"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("USERNAME")
    assert out[1].split()[:2] == ["kev", "kev@example.com"]
    assert out[2].split()[:2] == ["sam", "-"]
