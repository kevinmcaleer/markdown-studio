"""Application factory: API routes, middleware and the built front end."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import mimetypes
import sqlite3
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.routing import WebSocketRoute

from powertools_auth import Auth, AuthSettings, SmtpMailer
from powertools_auth.security import SECURITY_HEADERS

from . import __version__, collab, comments, db, files, sharing, suggestions, sync, user_state
from .config import Settings, load_settings_or_exit
from .gdocs import Google
from .logging_config import configure_logging
from .powertools import CURRENT_APP_ID, HOME_URL, PowerTools
from .tables import api as tables_api

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

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        task = None
        if app.state.syncer.google is not None and settings.google_sync_interval > 0:
            task = asyncio.create_task(app.state.syncer.run_forever(settings.google_sync_interval))
        yield
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(
        title="Markdown Studio",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(auth.verify_csrf)],
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.auth = auth
    app.state.powertools = PowerTools(settings.powertools_apps_url, hide=settings.powertools_hide)

    auth.install(app)
    app.include_router(auth.router)
    app.include_router(files.make_router(auth, get_db))
    rooms = collab.Rooms(settings.database_path)
    app.state.rooms = rooms
    app.state.content_listener = rooms.content_replaced
    # A plain Starlette route: FastAPI's app-wide CSRF dependency is HTTP-only.
    app.router.routes.append(WebSocketRoute(collab.PATH, collab.make_endpoint(auth, rooms)))
    app.include_router(sharing.make_router(auth, get_db))
    app.include_router(comments.make_router(auth, get_db))
    app.include_router(suggestions.make_router(auth, get_db))
    app.include_router(user_state.make_router(auth, get_db))
    google = None
    if settings.google_client_id:
        google = Google(settings.google_client_id, settings.google_client_secret)
    app.state.syncer = sync.Syncer(app.state, google)
    app.include_router(sync.make_router(auth, get_db, app.state.syncer))
    app.include_router(tables_api.make_router(auth, get_db))

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


# Each app installs as its own PWA: pages under its path link its manifest.
APP_PATHS = {"notes": "Notes", "tables": "Tables", "decks": "Decks"}
# Must never be cached, or browsers keep running an old service worker / manifest.
NO_CACHE_FILES = {"sw.js", "index.html"}

mimetypes.add_type("application/manifest+json", ".webmanifest")


def app_index(index_html: str, path: str) -> str:
    """index.html with the manifest and home-screen icon of the app at ``path``."""
    app = path.split("/", 1)[0]
    if app not in APP_PATHS:
        return index_html
    return (
        index_html.replace('href="/manifest.webmanifest"', f'href="/{app}.webmanifest"')
        .replace('href="/icons/studio-apple-180.png"', f'href="/icons/{app}-apple-180.png"')
        .replace('content="Markdown Studio"', f'content="{APP_PATHS[app]}"')
    )


def _mount_front_end(app: FastAPI, static_dir: Path | None) -> None:
    """Serve the built single-page app; every unknown non-API path gets index.html."""
    if static_dir is None or not (static_dir / "index.html").is_file():
        return
    root = static_dir.resolve()
    index_html = (root / "index.html").read_text(encoding="utf-8")
    if (root / "assets").is_dir():
        # Vite fingerprints these file names, so they can be cached for good.
        app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def front_end(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            no_cache = path in NO_CACHE_FILES or path.endswith(".webmanifest")
            return FileResponse(
                candidate, headers={"Cache-Control": "no-cache"} if no_cache else None
            )
        return HTMLResponse(app_index(index_html, path), headers={"Cache-Control": "no-cache"})
