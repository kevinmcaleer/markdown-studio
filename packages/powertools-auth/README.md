# powertools-auth

The login from [mermaid-factory](https://github.com/kevinmcaleer/mermaid-factory), as a
package any Power Tools app can use: argon2id passwords, server-side sessions (only a
SHA-256 of the cookie token is stored), HMAC CSRF tokens, and a per-IP login rate limiter,
on SQLite and FastAPI.

```python
from fastapi import Depends, FastAPI
from powertools_auth import Auth, AuthSettings, migrations_dir

auth = Auth(AuthSettings(secret_key=SECRET), get_db)  # get_db yields a sqlite3 connection
app = FastAPI(dependencies=[Depends(auth.verify_csrf)])
auth.install(app)  # anonymous cookie so CSRF works before sign-in
app.include_router(auth.router)


@app.get("/api/me")
def me(user=Depends(auth.require_user)):
    return {"username": user["username"]}
```

Run the SQL files in `migrations_dir()` with your app's migration runner.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/auth/session` | | `user` (or null), `csrf_token`, `registration_open`, `first_user` |
| POST | `/api/auth/register` | `username`, `email`, `password` | `user`, `csrf_token` |
| POST | `/api/auth/login` | `username`, `password`, `remember` | `user`, `csrf_token` |
| POST | `/api/auth/logout` | | `csrf_token` |
| POST | `/api/auth/password` | `current_password`, `new_password` | `user`, `csrf_token` (other sessions end) |
| POST | `/api/auth/email` | `email`, `current_password` | `user` (pending reset links stop working) |
| POST | `/api/auth/forgot-password` | `login` (username or email) | `ok` (always, so it can't be used to find accounts) |
| POST | `/api/auth/reset-password` | `token`, `password` | `user`, `csrf_token` (other sessions end) |
| POST | `/api/auth/delete-account` | `confirm_username` | |

Every POST needs the current `csrf_token` in an `X-CSRF-Token` header. Signing in or out
changes the token, so use the one each response returns.

## Password reset by email

Pass a mailer and set `public_url`, and `/api/auth/session` reports `password_reset: true`:

```python
from powertools_auth import SmtpMailer

mailer = SmtpMailer(
    host="smtp.example.com",
    sender="App <app@example.com>",
    username="...",
    password="...",
    security="starttls",
)
auth = Auth(
    AuthSettings(secret_key=SECRET, app_name="My App", public_url="https://app.example.com"),
    get_db,
    mailer,
)
```

The email links to `{public_url}{reset_path}#token=...`; the token is in the fragment so it
stays out of server and proxy logs. Your front end reads it and posts it to
`/api/auth/reset-password`. Links last `reset_max_age` seconds (an hour), work once, and are
stored hashed. Each user gets at most one email per `reset_min_interval` seconds. The link is
built from `public_url` rather than the request's Host header, which a client can forge.
Any object with a `send(to, subject, body)` method works as the mailer.

## Single sign-on later

Setting `cookie_domain=".kevspowertools.com"` lets apps on sibling subdomains read the same
session cookie. They also need to share the users and sessions tables, which is the point
where this package becomes a small auth service of its own.
