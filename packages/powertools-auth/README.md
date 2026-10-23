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
| POST | `/api/auth/delete-account` | `confirm_username` | |

Every POST needs the current `csrf_token` in an `X-CSRF-Token` header. Signing in or out
changes the token, so use the one each response returns.

## Single sign-on later

Setting `cookie_domain=".kevspowertools.com"` lets apps on sibling subdomains read the same
session cookie. They also need to share the users and sessions tables, which is the point
where this package becomes a small auth service of its own.
