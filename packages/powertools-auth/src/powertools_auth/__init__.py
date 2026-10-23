"""Shared login for Kev's Power Tools apps.

Lifted from mermaid-factory: argon2id passwords, server-side sessions stored
hashed in SQLite, HMAC CSRF tokens and a login rate limiter. The app owns the
database; apply :func:`migrations_dir` with its migration runner.
"""

from __future__ import annotations

from pathlib import Path

from .api import Auth, AuthSettings

__all__ = ["Auth", "AuthSettings", "migrations_dir"]
__version__ = "0.1.0"


def migrations_dir() -> Path:
    """Directory of ``NNNN_name.sql`` files that create the users and sessions tables."""
    return Path(__file__).parent / "migrations"
