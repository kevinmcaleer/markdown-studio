"""Application factory: API routes, middleware and the built front end."""

from __future__ import annotations

import logging
import sqlite3
import time
import uuid
from collections.abc import Iterator
from dataclasses import asdict
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from powertools_auth import Auth, AuthSettings, SmtpMailer
from powertools_auth.security import SECURITY_HEADERS

from . import __version__, db
from .config import Settings, load_settings_or_exit
from .logging_config import configure_logging
from .powertools import CURRENT_APP_ID, HOME_URL, PowerTools

access_log = logging.getLogger("markdown_studio.access")
log = logging.getLogger("markdown_studio")


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    """One connection per request, shared by every dependency that asks for it."""
    conn = getattr(request.state, "db", None)
    if conn is not None:
        yield conn
        return
    conn = db.connect(request.app.state.settings.database_path)
    request.state.db = conn
    try:
        yield conn
    finally:
        request.state.db = None
        conn.close()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings_or_exit()
    configure_logging(settings.log_level)
    db.init_db(settings.database_path)

    auth = Auth(
        AuthSettings(
            secret_key=settings.secret_key,
            allow_registration=settings.allow_registration,
            https=settings.https,
            session_max_age=settings.session_max_age,
            remember_me_max_age=settings.remember_me_max_age,
            login_rate_limit=settings.login_rate_limit,
            login_rate_window=settings.login_rate_window,
            cookie_prefix="ms",
            cookie_domain=settings.cookie_domain or None,
            app_name="Markdown Studio",
            public_url=settings.public_url,
            reset_max_age=settings.password_reset_max_age,
        ),
        get_db,
        _mailer(settings),
    )

    app = FastAPI(
        title="Markdown Studio",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(auth.verify_csrf)],
    )
    app.state.settings = settings
    app.state.auth = auth
    app.state.powertools = PowerTools(settings.powertools_apps_url)

    auth.install(app)
    app.include_router(auth.router)

    @app.get("/health")
    def health():
        status = "ok" if db.check_db(settings.database_path) else "error"
        return JSONResponse(
            {"status": status, "db": status, "version": __version__},
            status_code=200 if status == "ok" else 503,
        )

    @app.get("/api/powertools")
    def powertools(request: Request):
        """The other Power Tools apps, for the switcher in the top bar."""
        return {
            "current": CURRENT_APP_ID,
            "home": HOME_URL,
            "apps": [asdict(a) for a in request.app.state.powertools.apps()],
        }

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        start = time.perf_counter()
        request_id = request.headers.get("x-request-id", "")[:64] or uuid.uuid4().hex[:16]
        request.state.request_id = request_id
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled error", extra={"request_id": request_id})
            raise
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        response.headers["X-Request-ID"] = request_id
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        if request.url.path != "/health" or response.status_code != 200:
            access_log.info(
                "%s %s %s",
                request.method,
                request.url.path,
                response.status_code,
                extra={
                    "request_id": request_id,
                    "user_id": getattr(request.state, "user_id", None),
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                    "client": request.client.host if request.client else None,
                },
            )
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(request: Request, exc: StarletteHTTPException):
        return JSONResponse(
            {"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        first = errors[0] if errors else {"loc": [], "msg": "Invalid request"}
        field = ".".join(str(p) for p in first["loc"] if p != "body")
        message = f"{field}: {first['msg']}" if field else first["msg"]
        return JSONResponse({"detail": message}, status_code=422)

    _mount_front_end(app, settings.static_dir)

    if settings.trust_proxy:
        from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

    log.info(
        "Markdown Studio %s started",
        __version__,
        extra={"database_path": str(settings.database_path), "env": settings.app_env},
    )
    return app


def _mailer(settings: Settings) -> SmtpMailer | None:
    if not settings.smtp_host:
        return None
    return SmtpMailer(
        host=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_username,
        password=settings.smtp_password,
        security=settings.smtp_security,
        sender=settings.smtp_from,
    )


def _mount_front_end(app: FastAPI, static_dir: Path | None) -> None:
    """Serve the built single-page app; every unknown non-API path gets index.html."""
    if static_dir is None or not (static_dir / "index.html").is_file():
        return
    root = static_dir.resolve()
    index = root / "index.html"
    if (root / "assets").is_dir():
        # Vite fingerprints these file names, so they can be cached for good.
        app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def front_end(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
