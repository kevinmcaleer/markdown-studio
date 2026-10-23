"""Run the server (``python -m studio``) or an admin command.

    python -m studio                          # serve on HOST:PORT
    python -m studio reset-password USERNAME  # set a new password (asks for it)

In Docker: ``docker compose exec -u app markdown-studio python -m studio reset-password kev``
"""

from __future__ import annotations

import argparse
import getpass
import sys

import uvicorn

from powertools_auth import store

from . import db
from .config import load_settings_or_exit


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


def reset_password(username: str) -> int:
    """No email yet, so a forgotten password is reset by whoever runs the server."""
    settings = load_settings_or_exit()
    db.init_db(settings.database_path)
    conn = db.connect(settings.database_path)
    try:
        user = store.find_user(conn, username)
        if user is None:
            print(f"No user called {username!r}.", file=sys.stderr)
            return 1
        password = getpass.getpass("New password: ")
        if password != getpass.getpass("Again: "):
            print("Passwords do not match.", file=sys.stderr)
            return 1
        try:
            with db.transaction(conn):
                store.set_password(conn, user["id"], password)
        except store.UserError as exc:
            print(exc, file=sys.stderr)
            return 1
    finally:
        conn.close()
    print(f"Password changed for {user['username']}; their other sessions were signed out.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m studio")
    commands = parser.add_subparsers(dest="command")
    reset = commands.add_parser("reset-password", help="set a new password for a user")
    reset.add_argument("username")
    args = parser.parse_args(argv)
    if args.command == "reset-password":
        return reset_password(args.username)
    serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
