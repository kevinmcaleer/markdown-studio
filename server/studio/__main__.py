"""Run the server (``python -m studio``) or an admin command.

    python -m studio                                 # serve on HOST:PORT
    python -m studio users                           # list accounts
    python -m studio reset-password LOGIN            # set a new password (asks for it)
    python -m studio reset-password LOGIN --generate # make one up and print it
    echo "$PW" | python -m studio reset-password LOGIN --password-stdin

LOGIN is a username or an email address.
In Docker: ``docker compose exec -u app markdown-studio python -m studio reset-password kev``
"""

from __future__ import annotations

import argparse
import getpass
import secrets
import sqlite3
import sys

import uvicorn

from powertools_auth import store

from . import db
from .config import load_settings_or_exit

GENERATED_PASSWORD_BYTES = 15  # 20 URL-safe characters


def serve() -> None:
    settings = load_settings_or_exit()
    uvicorn.run(
        "studio.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
        proxy_headers=False,  # handled in-app when TRUST_PROXY=true
        server_header=False,
        access_log=False,
        log_config=None,
    )


def _open_db() -> sqlite3.Connection:
    settings = load_settings_or_exit()
    db.init_db(settings.database_path)
    return db.connect(settings.database_path)


def list_users() -> int:
    conn = _open_db()
    try:
        rows = conn.execute(
            "SELECT username, email, created_at FROM users ORDER BY username COLLATE NOCASE"
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        print("No accounts yet. The first person to sign up becomes the first user.")
        return 0
    width = max(len("USERNAME"), *(len(r["username"]) for r in rows))
    print(f"{'USERNAME':<{width}}  {'EMAIL':<30}  CREATED")
    for r in rows:
        print(f"{r['username']:<{width}}  {(r['email'] or '-'):<30}  {r['created_at'][:10]}")
    return 0


def _read_password(from_stdin: bool, generate: bool) -> str | None:
    """The new password, or None (after printing why) if there isn't a usable one."""
    if generate:
        return secrets.token_urlsafe(GENERATED_PASSWORD_BYTES)
    if from_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
        if not password:
            print("No password on standard input.", file=sys.stderr)
            return None
        return password
    password = getpass.getpass("New password: ")
    if password != getpass.getpass("Again: "):
        print("Passwords do not match.", file=sys.stderr)
        return None
    return password


def reset_password(login: str, *, generate: bool = False, from_stdin: bool = False) -> int:
    """For servers without email (or users without an address): whoever runs it resets.

    Ends all of the user's sessions and any reset link they were sent.
    """
    conn = _open_db()
    try:
        user = store.find_user_by_login(conn, login)
        if user is None:
            print(
                f"No user with the username or email {login!r}. "
                "Run `python -m studio users` to list accounts.",
                file=sys.stderr,
            )
            return 1
        password = _read_password(from_stdin, generate)
        if password is None:
            return 1
        try:
            with db.transaction(conn):
                store.set_password(conn, user["id"], password)
        except store.UserError as exc:
            print(exc, file=sys.stderr)
            return 1
    finally:
        conn.close()
    print(f"Password changed for {user['username']}; they have been signed out everywhere.")
    if generate:
        print(f"New password: {password}")
        print("Share it privately; they can change it on their Account page.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m studio")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("users", help="list accounts")
    reset = commands.add_parser(
        "reset-password",
        help="set a new password for a user",
        description="Set a new password for a user and sign them out everywhere.",
    )
    reset.add_argument("login", metavar="USERNAME_OR_EMAIL")
    source = reset.add_mutually_exclusive_group()
    source.add_argument(
        "--generate", action="store_true", help="make up a strong password and print it"
    )
    source.add_argument(
        "--password-stdin",
        action="store_true",
        help="read the new password from the first line of standard input",
    )
    args = parser.parse_args(argv)
    if args.command == "users":
        return list_users()
    if args.command == "reset-password":
        return reset_password(args.login, generate=args.generate, from_stdin=args.password_stdin)
    serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
