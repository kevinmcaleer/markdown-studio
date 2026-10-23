"""FastAPI glue: JSON login API, the current-user dependencies and CSRF checks.

The flow is mermaid-factory's, reshaped for a single-page front end:

* ``GET /api/auth/session`` tells the browser who is signed in and hands it a
  CSRF token. Every state-changing request sends that token back in the
  ``X-CSRF-Token`` header.
* The token is an HMAC of the session cookie (or, before login, of an
  anonymous cookie), so signing in or out returns a fresh one.
* Sessions are rows in SQLite; the cookie holds a random token whose SHA-256
  is the row id, so logout and password changes really end a session.

Usage::

    auth = Auth(AuthSettings(secret_key=...), get_db)
    app = FastAPI(dependencies=[Depends(auth.verify_csrf)])
    auth.install(app)
    app.include_router(auth.router)

    @app.get("/api/things")
    def things(user=Depends(auth.require_user)): ...
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

from . import store
from .security import RateLimiter, csrf_token, csrf_valid, new_token

SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}

GetDb = Callable[..., Iterator[sqlite3.Connection]]


@dataclass(frozen=True)
class AuthSettings:
    secret_key: str
    allow_registration: bool = True
    https: bool = False
    session_max_age: int = 60 * 60 * 24
    remember_me_max_age: int = 60 * 60 * 24 * 30
    login_rate_limit: int = 5
    login_rate_window: int = 60
    cookie_prefix: str = "pt"
    # Set to a parent domain such as ".kevspowertools.com" to share the login
    # cookie between apps on sibling subdomains (they must share the database).
    cookie_domain: str | None = None


class RegisterBody(BaseModel):
    username: str = ""
    email: str = ""
    password: str = ""


class LoginBody(BaseModel):
    username: str = ""
    password: str = ""
    remember: bool = False


class PasswordBody(BaseModel):
    current_password: str = ""
    new_password: str = ""


class DeleteBody(BaseModel):
    confirm_username: str = ""


class Auth:
    def __init__(self, settings: AuthSettings, get_db: GetDb) -> None:
        self.settings = settings
        self.get_db = get_db
        self.session_cookie = f"{settings.cookie_prefix}_session"
        self.anon_cookie = f"{settings.cookie_prefix}_anon"
        self.limiter = RateLimiter(settings.login_rate_limit, settings.login_rate_window)
        self.current_user = self._make_current_user()
        self.require_user = self._make_require_user()
        self.router = self._make_router()

    # ------------------------------------------------------------- dependencies

    def _make_current_user(self):
        def current_user(
            request: Request, conn: sqlite3.Connection = Depends(self.get_db)
        ) -> sqlite3.Row | None:
            """The signed-in user, or None (cached on request.state)."""
            if not hasattr(request.state, "user"):
                user = store.session_user(conn, request.cookies.get(self.session_cookie))
                request.state.user = user
                request.state.user_id = user["id"] if user else None
            return request.state.user

        return current_user

    def _make_require_user(self):
        def require_user(user: sqlite3.Row | None = Depends(self.current_user)) -> sqlite3.Row:
            if user is None:
                raise HTTPException(status_code=401, detail="Sign in required")
            return user

        return require_user

    def csrf_binding(self, request: Request) -> str:
        return request.cookies.get(self.session_cookie) or getattr(request.state, "anon_id", "")

    def csrf_token_for(self, request: Request, session_token: str | None = None) -> str:
        binding = session_token if session_token is not None else self.csrf_binding(request)
        return csrf_token(self.settings.secret_key, binding)

    async def verify_csrf(self, request: Request) -> None:
        """Apply app-wide: every state-changing request needs a valid X-CSRF-Token."""
        if request.method in SAFE_METHODS:
            return
        supplied = request.headers.get("x-csrf-token")
        if not csrf_valid(self.settings.secret_key, self.csrf_binding(request), supplied):
            raise HTTPException(status_code=403, detail="Invalid or missing CSRF token")

    # ---------------------------------------------------------------- cookies

    def install(self, app: FastAPI) -> None:
        """Give every visitor an anonymous id cookie, so CSRF works before login."""

        @app.middleware("http")
        async def anon_cookie(request: Request, call_next):
            existing = request.cookies.get(self.anon_cookie)
            request.state.anon_id = existing or new_token(16)
            response = await call_next(request)
            if not existing:
                self._set_cookie(request, response, self.anon_cookie, request.state.anon_id)
            return response

    def _secure(self, request: Request) -> bool:
        return self.settings.https or request.url.scheme == "https"

    def _set_cookie(
        self, request: Request, response: Response, name: str, value: str, max_age=None
    ) -> None:
        response.set_cookie(
            name,
            value,
            max_age=max_age,
            httponly=True,
            samesite="lax",
            secure=self._secure(request),
            path="/",
            domain=self.settings.cookie_domain,
        )

    def start_session(
        self, request: Request, response: Response, conn, user_id: int, remember: bool
    ) -> str:
        s = self.settings
        max_age = s.remember_me_max_age if remember else s.session_max_age
        token = store.create_session(conn, user_id, max_age, request.headers.get("user-agent", ""))
        self._set_cookie(
            request, response, self.session_cookie, token, max_age if remember else None
        )
        return token

    def end_session(self, request: Request, response: Response, conn) -> None:
        store.delete_session(conn, request.cookies.get(self.session_cookie))
        response.delete_cookie(
            self.session_cookie,
            path="/",
            domain=self.settings.cookie_domain,
            httponly=True,
            samesite="lax",
        )

    def _rate_limit(self, request: Request, bucket: str) -> None:
        ip = request.client.host if request.client else "unknown"
        allowed, retry_after = self.limiter.hit(f"{bucket}:{ip}")
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"Too many attempts. Please wait {retry_after} seconds and try again.",
                headers={"Retry-After": str(retry_after)},
            )

    # ----------------------------------------------------------------- routes

    def _make_router(self) -> APIRouter:
        router = APIRouter(prefix="/api/auth", tags=["auth"])
        get_db = self.get_db
        current_user = self.current_user
        require_user = self.require_user

        def signed_in(user: sqlite3.Row, token: str) -> dict:
            return {"user": store.public_user(user), "csrf_token": self.csrf_token_for(None, token)}

        @router.get("/session")
        def session(request: Request, conn=Depends(get_db), user=Depends(current_user)):
            return {
                "user": store.public_user(user) if user else None,
                "csrf_token": self.csrf_token_for(request),
                "registration_open": store.registration_open(
                    conn, self.settings.allow_registration
                ),
                "first_user": store.user_count(conn) == 0,
            }

        @router.post("/register")
        def register(
            body: RegisterBody, request: Request, response: Response, conn=Depends(get_db)
        ):
            self._rate_limit(request, "register")
            try:
                conn.execute("BEGIN IMMEDIATE")
                # Checked inside the write lock so two racing first sign-ups
                # cannot both slip through a closed registration.
                if not store.registration_open(conn, self.settings.allow_registration):
                    raise HTTPException(status_code=403, detail="Registration is closed.")
                user_id = store.create_user(conn, body.username, body.password, body.email)
                store.delete_session(conn, request.cookies.get(self.session_cookie))
                token = self.start_session(request, response, conn, user_id, remember=False)
                conn.execute("COMMIT")
            except store.UserError as exc:
                conn.execute("ROLLBACK")
                raise HTTPException(status_code=400, detail=str(exc)) from None
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            return signed_in(store.get_user(conn, user_id), token)

        @router.post("/login")
        def login(body: LoginBody, request: Request, response: Response, conn=Depends(get_db)):
            self._rate_limit(request, "login")
            user = store.authenticate(conn, body.username, body.password)
            if user is None:
                raise HTTPException(status_code=401, detail="Invalid username or password.")
            store.delete_session(conn, request.cookies.get(self.session_cookie))
            token = self.start_session(request, response, conn, user["id"], body.remember)
            return signed_in(user, token)

        @router.post("/logout")
        def logout(request: Request, response: Response, conn=Depends(get_db)):
            self.end_session(request, response, conn)
            return {"user": None, "csrf_token": self.csrf_token_for(None, request.state.anon_id)}

        @router.post("/password")
        def change_password(
            body: PasswordBody,
            request: Request,
            response: Response,
            user=Depends(require_user),
            conn=Depends(get_db),
        ):
            if not store.check_password(user, body.current_password):
                raise HTTPException(status_code=400, detail="Your current password is incorrect.")
            try:
                conn.execute("BEGIN IMMEDIATE")
                # Ends every session (other devices too), then starts a fresh one here.
                store.set_password(conn, user["id"], body.new_password)
                token = self.start_session(request, response, conn, user["id"], remember=False)
                conn.execute("COMMIT")
            except store.UserError as exc:
                conn.execute("ROLLBACK")
                raise HTTPException(status_code=400, detail=str(exc)) from None
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            return signed_in(user, token)

        @router.post("/delete-account")
        def delete_account(
            body: DeleteBody,
            request: Request,
            response: Response,
            user=Depends(require_user),
            conn=Depends(get_db),
        ):
            if body.confirm_username.strip().lower() != user["username"].lower():
                raise HTTPException(
                    status_code=400, detail="Type your username exactly to confirm."
                )
            store.delete_user(conn, user["id"])
            self.end_session(request, response, conn)
            return {"user": None, "csrf_token": self.csrf_token_for(None, request.state.anon_id)}

        return router
