"""Runtime configuration, read once from environment variables.

Every setting the app uses lives here; nothing else reads ``os.environ``.
See ``.env.example`` for the documented list.
"""

from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path

TRUE_VALUES = {"1", "true", "yes", "on"}
# Generated next to the database when SECRET_KEY isn't set, so a fresh
# install works without any configuration and the key is backed up with ./data.
SECRET_KEY_FILE = ".secret_key"  # noqa: S105 (a file name, not a secret)


class ConfigError(RuntimeError):
    """Raised when the configuration is invalid."""


def _bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in TRUE_VALUES


def _int(name: str, value: str | None, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {value!r}") from exc


def _stored_secret_key(path: Path) -> str:
    """Read the generated key from ``path``, creating it on first run."""
    try:
        key = path.read_text(encoding="utf-8").strip()
        if key:
            return key
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise ConfigError(
            f"SECRET_KEY is not set and {path} can't be read ({exc}). "
            "Fix its permissions or set SECRET_KEY in your .env file."
        ) from exc
    key = secrets.token_urlsafe(48)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Another process created it first; use theirs.
        return path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ConfigError(
            f"SECRET_KEY is not set and {path} can't be created ({exc}). Either make "
            f"{path.parent} writable or set SECRET_KEY in your .env file."
        ) from exc
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(key + "\n")
    return key


@dataclass(frozen=True)
class Settings:
    app_env: str
    secret_key: str
    database_path: Path
    host: str
    port: int
    allow_registration: bool
    log_level: str
    https: bool
    trust_proxy: bool
    session_max_age: int
    remember_me_max_age: int
    login_rate_limit: int
    login_rate_window: int
    reload: bool = False
    # Parent domain for the login cookie (e.g. ".kevspowertools.com"); empty = this host only.
    cookie_domain: str = ""
    # Built front end (web/dist). Empty or missing means API only (e.g. under `vite dev`).
    static_dir: Path | None = None
    # The landing page's shared app list for the switcher; empty keeps the bundled copy.
    powertools_apps_url: str = "https://kevspowertools.com/apps.json"
    # Where users reach the app; reset links in emails point here.
    public_url: str = ""
    # Outgoing mail for password resets. No SMTP_HOST means no email resets
    # (the `reset-password` command still works).
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_security: str = "starttls"
    smtp_from: str = ""
    password_reset_max_age: int = 60 * 60

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


def load_settings(env: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    app_env = env.get("APP_ENV", "development").strip().lower()

    database_path = Path(env.get("DATABASE_PATH", "./data/studio.db"))
    secret_key = env.get("SECRET_KEY", "").strip()
    if not secret_key:
        secret_key = _stored_secret_key(database_path.parent / SECRET_KEY_FILE)
    elif app_env == "production" and len(secret_key) < 32:
        raise ConfigError("SECRET_KEY must be at least 32 characters long.")

    log_level = env.get("LOG_LEVEL", "INFO").strip().upper()
    if log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ConfigError(f"LOG_LEVEL must be one of DEBUG/INFO/WARNING/ERROR, got {log_level!r}")

    public_url = env.get("PUBLIC_URL", "").strip().rstrip("/")
    if public_url and not public_url.startswith(("http://", "https://")):
        raise ConfigError(f"PUBLIC_URL must start with http:// or https://, got {public_url!r}")
    smtp_host = env.get("SMTP_HOST", "").strip()
    smtp_security = env.get("SMTP_SECURITY", "starttls").strip().lower() or "starttls"
    if smtp_security not in {"starttls", "ssl", "none"}:
        raise ConfigError(f"SMTP_SECURITY must be starttls, ssl or none, got {smtp_security!r}")
    smtp_from = env.get("SMTP_FROM", "").strip()
    if smtp_host and not smtp_from:
        raise ConfigError("SMTP_FROM must be set when SMTP_HOST is (the address emails come from).")
    if smtp_host and not public_url:
        raise ConfigError(
            "PUBLIC_URL must be set when SMTP_HOST is, so reset emails can link back "
            "to the app (e.g. https://studio.example.com or http://pi.local:8000)."
        )

    return Settings(
        app_env=app_env,
        secret_key=secret_key,
        database_path=database_path,
        host=env.get("HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=_int("PORT", env.get("PORT"), 8000),
        allow_registration=_bool(env.get("ALLOW_REGISTRATION"), True),
        log_level=log_level,
        https=_bool(env.get("HTTPS"), False),
        trust_proxy=_bool(env.get("TRUST_PROXY"), False),
        session_max_age=_int("SESSION_MAX_AGE", env.get("SESSION_MAX_AGE"), 60 * 60 * 24),
        remember_me_max_age=_int(
            "REMEMBER_ME_MAX_AGE", env.get("REMEMBER_ME_MAX_AGE"), 60 * 60 * 24 * 30
        ),
        login_rate_limit=_int("LOGIN_RATE_LIMIT", env.get("LOGIN_RATE_LIMIT"), 5),
        login_rate_window=_int("LOGIN_RATE_WINDOW", env.get("LOGIN_RATE_WINDOW"), 60),
        reload=_bool(env.get("RELOAD"), False),
        cookie_domain=env.get("COOKIE_DOMAIN", "").strip(),
        static_dir=Path(env["STATIC_DIR"]) if env.get("STATIC_DIR", "").strip() else None,
        powertools_apps_url=env.get(
            "POWERTOOLS_APPS_URL", "https://kevspowertools.com/apps.json"
        ).strip(),
        public_url=public_url,
        smtp_host=smtp_host,
        smtp_port=_int("SMTP_PORT", env.get("SMTP_PORT"), 465 if smtp_security == "ssl" else 587),
        smtp_username=env.get("SMTP_USERNAME", "").strip(),
        smtp_password=env.get("SMTP_PASSWORD", ""),
        smtp_security=smtp_security,
        smtp_from=smtp_from,
        password_reset_max_age=_int(
            "PASSWORD_RESET_MAX_AGE", env.get("PASSWORD_RESET_MAX_AGE"), 60 * 60
        ),
    )


def load_settings_or_exit() -> Settings:
    """Load settings, printing a friendly message instead of a traceback."""
    try:
        return load_settings()
    except ConfigError as exc:
        print(f"\nConfiguration error: {exc}\n", file=sys.stderr)
        raise SystemExit(2) from None
