"""SQLite access and a tiny forward-only migration runner.

Migrations are plain ``.sql`` files named ``NNNN_description.sql``, grouped by
component: ``auth`` (shipped with the powertools-auth package) runs first, then
``studio`` (``studio/migrations``). Each file is applied once, in order, and
recorded in ``schema_migrations`` under its component. To change the schema,
add a new file; never edit one that has already shipped.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import powertools_auth

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
# Order matters: app tables reference users(id).
COMPONENTS: list[tuple[str, Path]] = [
    ("auth", powertools_auth.migrations_dir()),
    ("studio", MIGRATIONS_DIR),
]
_MIGRATION_RE = re.compile(r"^(\d{4})_[\w-]+\.sql$")


def utcnow() -> str:
    """Current UTC time as an ISO-8601 string with millisecond precision."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect(path: Path | str) -> sqlite3.Connection:
    """Open a connection with WAL mode and foreign keys enabled."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=15, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Run a block inside ``BEGIN IMMEDIATE`` ... ``COMMIT`` (rollback on error)."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def discover_migrations(directory: Path = MIGRATIONS_DIR) -> list[tuple[int, str, Path]]:
    found = []
    for file in sorted(directory.glob("*.sql")):
        match = _MIGRATION_RE.match(file.name)
        if not match:
            raise RuntimeError(f"Badly named migration file: {file.name}")
        found.append((int(match.group(1)), file.stem, file))
    versions = [v for v, _, _ in found]
    if len(versions) != len(set(versions)):
        raise RuntimeError("Two migration files share the same number")
    return found


def applied_migrations(conn: sqlite3.Connection, component: str) -> set[int]:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " component TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,"
        " applied_at TEXT NOT NULL, PRIMARY KEY (component, version))"
    )
    return {
        row[0]
        for row in conn.execute(
            "SELECT version FROM schema_migrations WHERE component = ?", (component,)
        )
    }


def migrate(
    conn: sqlite3.Connection, components: list[tuple[str, Path]] | None = None
) -> list[str]:
    """Apply pending migrations. Returns the ``component/name`` of those applied."""
    applied = []
    for component, directory in components or COMPONENTS:
        done = applied_migrations(conn, component)
        for version, name, file in discover_migrations(directory):
            if version in done:
                continue
            sql = file.read_text(encoding="utf-8")
            log.info("applying migration %s/%s", component, name)
            # executescript() commits any open transaction, so wrap explicitly.
            try:
                conn.executescript(
                    "BEGIN;\n"
                    + sql
                    + "\nINSERT INTO schema_migrations (component, version, name, applied_at)"
                    + f" VALUES ('{component}', {version}, '{name}', '{utcnow()}');\nCOMMIT;"
                )
            except sqlite3.Error:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            applied.append(f"{component}/{name}")
    return applied


def init_db(path: Path | str) -> None:
    """Create the database file if needed and bring the schema up to date."""
    conn = connect(path)
    try:
        migrate(conn)
    finally:
        conn.close()


def check_db(path: Path | str) -> bool:
    try:
        conn = sqlite3.connect(f"file:{Path(path)}?mode=rw", uri=True, timeout=2)
        try:
            conn.execute("SELECT 1 FROM schema_migrations LIMIT 1").fetchall()
        finally:
            conn.close()
        return True
    except sqlite3.Error:
        return False
