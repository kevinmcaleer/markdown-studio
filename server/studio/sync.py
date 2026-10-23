"""Cloud sync for notes: two-way with Google Docs, and save/restore with iCloud Drive.

A *link* (``sync_links``) ties a note to its copy elsewhere and remembers what
both sides looked like when they last agreed, so every sync is a three-way
merge (see :mod:`studio.merge`):

- only the note changed: the copy is updated (Google) or flagged as stale (iCloud)
- only the copy changed: the note is updated, live editors included
- both changed different lines: both are merged
- both changed the same lines: the link goes into *conflict*, keeps the
  copy's text, and waits for someone to choose: keep the note, keep the copy,
  keep both (the copy becomes a new note), or edit the merge by hand.

Google Docs syncs on demand and every ``GOOGLE_SYNC_INTERVAL`` seconds, using
the linking user's Google account. iCloud has no web API, so the browser
saves copies through the share sheet ("Save to Files") and brings them back
through the file picker; the server only keeps the merge bookkeeping.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import sqlite3
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from . import db
from .access import allows
from .files import file_json, is_markdown, save_content, share_token, unique_name
from .gdocs import Google, GoogleError
from .merge import merge3, plan

log = logging.getLogger(__name__)

LABELS = {"google": "Google Docs", "icloud": "iCloud"}
STATE_COOKIE = "ms_google_state"
STATE_MAX_AGE = 10 * 60
# Refresh access tokens a little before Google expires them.
TOKEN_SLACK = 60
LINK_COLUMNS = (
    "id, file_id, provider, user_id, remote_id, remote_url, remote_version, base, remote_base,"
    " status, conflict_remote, conflict_version, last_error, synced_at, created_at"
)


class NoteChanged(Exception):
    """Someone edited the note in a way that clashes with the sync while it ran."""


class Resolution(BaseModel):
    choice: Literal["mine", "theirs", "both", "markers"]


def link_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "file_id": row["file_id"],
        "provider": row["provider"],
        "remote_url": row["remote_url"],
        "status": row["status"],
        "last_error": row["last_error"],
        "synced_at": row["synced_at"],
        "created_at": row["created_at"],
    }


class Syncer:
    """Runs syncs. One per app; holds the Google client and a lock per note."""

    def __init__(self, app_state, google: Google | None) -> None:
        self.state = app_state
        self.google = google
        self._locks: dict[int, asyncio.Lock] = {}

    @property
    def database_path(self):
        return self.state.settings.database_path

    def lock(self, file_id: int) -> asyncio.Lock:
        return self._locks.setdefault(file_id, asyncio.Lock())

    # ------------------------------------------------------- note text

    async def read_note(self, conn: sqlite3.Connection, file_id: int) -> str:
        """The note's latest text, including edits a live room hasn't saved yet."""
        room = self.state.rooms.rooms.get(file_id)
        if room is not None:
            return str(room.text)
        row = conn.execute("SELECT content FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="File not found")
        return bytes(row["content"]).decode("utf-8", errors="replace")

    async def write_note(self, conn: sqlite3.Connection, file_id: int, read: str, new: str) -> str:
        """Change the note from ``read`` to ``new``, keeping edits made since it was read.

        Returns the text the note now has. Raises :class:`NoteChanged` if
        those edits touch the same lines.
        """
        current = await self.read_note(conn, file_id)
        if current != read:
            merged = merge3(read, current, new)
            if not merged.clean:
                raise NoteChanged
            new = merged.text
        if new == current:
            return new
        room = self.state.rooms.rooms.get(file_id)
        if room is not None:
            # Everyone editing sees the change at once; the room saves it.
            await room.set_text(new)
        else:
            save_content(conn, file_id, new.encode())
        return new

    # ---------------------------------------------------------- Google

    def google_or_404(self) -> Google:
        if self.google is None:
            raise HTTPException(
                status_code=404, detail="Google Docs sync isn't set up on this server."
            )
        return self.google

    async def access_token(self, conn: sqlite3.Connection, user_id: int) -> str:
        google = self.google_or_404()
        row = conn.execute(
            "SELECT refresh_token, access_token, access_expires_at FROM cloud_accounts"
            " WHERE user_id = ? AND provider = 'google'",
            (user_id,),
        ).fetchone()
        if row is None:
            raise GoogleError("Connect a Google account first.", reconnect=True)
        if row["access_token"] and (row["access_expires_at"] or 0) > time.time() + TOKEN_SLACK:
            return row["access_token"]
        tokens = await google.refresh(row["refresh_token"])
        conn.execute(
            "UPDATE cloud_accounts SET access_token = ?, access_expires_at = ?, updated_at = ?"
            " WHERE user_id = ? AND provider = 'google'",
            (tokens.access_token, tokens.expires_at, db.utcnow(), user_id),
        )
        return tokens.access_token

    async def link_google(
        self, conn: sqlite3.Connection, file_id: int, user_id: int
    ) -> sqlite3.Row:
        """Create a Google Doc from the note and link the two."""
        google = self.google_or_404()
        async with self.lock(file_id):
            existing = get_link(conn, file_id, "google")
            if existing is not None:
                return existing
            token = await self.access_token(conn, user_id)
            name = conn.execute("SELECT name FROM files WHERE id = ?", (file_id,)).fetchone()[0]
            text = await self.read_note(conn, file_id)
            doc = await google.create_doc(token, name.rsplit(".", 1)[0], text)
            # Google rewrites some Markdown on the way in; remember its version.
            remote = await google.export_markdown(token, doc.id)
            now = db.utcnow()
            conn.execute(
                "INSERT INTO sync_links (file_id, provider, user_id, remote_id, remote_url,"
                " remote_version, base, remote_base, synced_at, created_at)"
                " VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?, ?)",
                (file_id, user_id, doc.id, doc.url, doc.version, text, remote, now, now),
            )
            return get_link(conn, file_id, "google")

    async def sync_google(self, conn: sqlite3.Connection, file_id: int) -> str:
        """Bring the note and its Google Doc together. Returns the outcome."""
        google = self.google_or_404()
        async with self.lock(file_id):
            link = get_link(conn, file_id, "google")
            if link is None:
                raise HTTPException(
                    status_code=404, detail="This note isn't linked to Google Docs."
                )
            try:
                token = await self.access_token(conn, link["user_id"])
                info = await google.doc_info(token, link["remote_id"])
                if info.version == link["remote_version"]:
                    remote = link["remote_base"]
                else:
                    remote = await google.export_markdown(token, link["remote_id"])
                if link["status"] == "conflict":
                    # Still waiting on a choice; just keep their latest side.
                    _store_conflict(conn, link["id"], remote, info.version)
                    return "conflict"
                local = await self.read_note(conn, file_id)
                decision = plan(link["base"], link["remote_base"], local, remote, LABELS["google"])
                if decision.outcome == "conflict":
                    _store_conflict(conn, link["id"], remote, info.version)
                    return "conflict"
                new = local
                if decision.local != local:
                    new = await self.write_note(conn, file_id, local, decision.local)
                version = info.version
                if decision.push or new != decision.local:
                    pushed = await google.update_doc(token, link["remote_id"], new)
                    remote = await google.export_markdown(token, link["remote_id"])
                    version = pushed.version
                _store_synced(conn, link["id"], new, remote, version)
                return decision.outcome
            except GoogleError as exc:
                _store_error(conn, link["id"], str(exc))
                raise
            except NoteChanged:
                _store_error(conn, link["id"], "The note changed while syncing. Try again.")
                raise

    async def sync_all(self) -> None:
        """Every Google link: run from the background loop."""
        conn = db.connect(self.database_path)
        try:
            ids = [
                r[0]
                for r in conn.execute(
                    "SELECT file_id FROM sync_links WHERE provider = 'google' AND status = 'ok'"
                )
            ]
            for file_id in ids:
                try:
                    await self.sync_google(conn, file_id)
                except (GoogleError, NoteChanged, HTTPException) as exc:
                    log.info("background sync skipped a note: %s", exc, extra={"file_id": file_id})
                except Exception:
                    log.exception("background sync failed", extra={"file_id": file_id})
        finally:
            conn.close()

    async def run_forever(self, interval: int) -> None:
        while True:
            await asyncio.sleep(interval)
            await self.sync_all()

    # ---------------------------------------------------------- iCloud

    async def icloud_saved(
        self, conn: sqlite3.Connection, file_id: int, user_id: int, text: str | None = None
    ) -> str:
        """The browser saved ``text`` (by default, the note as it is now) to iCloud.

        Remembered as what the copy says, to merge against when it comes back.
        """
        async with self.lock(file_id):
            if text is None:
                text = await self.read_note(conn, file_id)
            now = db.utcnow()
            conn.execute(
                "INSERT INTO sync_links (file_id, provider, user_id, base, remote_base,"
                " synced_at, created_at) VALUES (?, 'icloud', ?, ?, ?, ?, ?)"
                " ON CONFLICT (file_id, provider) DO UPDATE SET user_id = excluded.user_id,"
                " base = excluded.base, remote_base = excluded.remote_base, status = 'ok',"
                " conflict_remote = NULL, conflict_version = NULL, last_error = NULL,"
                " synced_at = excluded.synced_at",
                (file_id, user_id, text, text, now, now),
            )
            return text

    async def icloud_import(
        self, conn: sqlite3.Connection, file_id: int, user_id: int, incoming: str
    ) -> str:
        """A copy came back from iCloud: merge it into the note."""
        async with self.lock(file_id):
            link = get_link(conn, file_id, "icloud")
            local = await self.read_note(conn, file_id)
            if link is None:
                if incoming == local:
                    return "unchanged"
                # Never saved from here, so there's nothing to merge against.
                now = db.utcnow()
                conn.execute(
                    "INSERT INTO sync_links (file_id, provider, user_id, base, remote_base,"
                    " status, conflict_remote, created_at)"
                    " VALUES (?, 'icloud', ?, ?, ?, 'conflict', ?, ?)",
                    (file_id, user_id, local, local, incoming, now),
                )
                return "conflict"
            decision = plan(link["base"], link["remote_base"], local, incoming, LABELS["icloud"])
            if decision.outcome == "conflict":
                _store_conflict(conn, link["id"], incoming, "")
                return "conflict"
            new = await self.write_note(conn, file_id, local, decision.local)
            _store_synced(conn, link["id"], new, incoming, "")
            return decision.outcome

    # --------------------------------------------------------- conflicts

    async def resolve(
        self, conn: sqlite3.Connection, file_id: int, provider: str, choice: str
    ) -> dict:
        async with self.lock(file_id):
            link = get_link(conn, file_id, provider)
            if link is None or link["status"] != "conflict":
                raise HTTPException(status_code=409, detail="There's no conflict to resolve.")
            theirs = link["conflict_remote"] or ""
            version = link["conflict_version"] or ""
            local = await self.read_note(conn, file_id)
            result: dict = {}
            if choice == "both":
                result["copy"] = _copy_note(conn, file_id, theirs, LABELS[provider])
            if choice in ("mine", "both"):
                if provider == "google":
                    google = self.google_or_404()
                    token = await self.access_token(conn, link["user_id"])
                    pushed = await google.update_doc(token, link["remote_id"], local)
                    remote = await google.export_markdown(token, link["remote_id"])
                    _store_synced(conn, link["id"], local, remote, pushed.version)
                else:
                    # The iCloud copy is now out of date; the browser offers to save again.
                    _store_synced(conn, link["id"], local, theirs, "")
                    result["stale"] = True
            elif choice == "theirs":
                new = await self.write_note(conn, file_id, local, theirs)
                _store_synced(conn, link["id"], new, theirs, version)
            else:  # markers: the merge with conflicts marked, to fix by hand
                decision = plan(link["base"], link["remote_base"], local, theirs, LABELS[provider])
                new = await self.write_note(conn, file_id, local, decision.local)
                # The note now differs from the copy, so the next sync sends the fix.
                _store_synced(conn, link["id"], new, theirs, version)
            return result


def get_link(conn: sqlite3.Connection, file_id: int, provider: str) -> sqlite3.Row | None:
    return conn.execute(
        f"SELECT {LINK_COLUMNS} FROM sync_links WHERE file_id = ? AND provider = ?",
        (file_id, provider),
    ).fetchone()


def _store_synced(conn, link_id: int, base: str, remote: str, version: str) -> None:
    conn.execute(
        "UPDATE sync_links SET base = ?, remote_base = ?, remote_version = ?, status = 'ok',"
        " conflict_remote = NULL, conflict_version = NULL, last_error = NULL, synced_at = ?"
        " WHERE id = ?",
        (base, remote, version, db.utcnow(), link_id),
    )


def _store_conflict(conn, link_id: int, remote: str, version: str) -> None:
    conn.execute(
        "UPDATE sync_links SET status = 'conflict', conflict_remote = ?, conflict_version = ?,"
        " last_error = NULL WHERE id = ?",
        (remote, version, link_id),
    )


def _store_error(conn, link_id: int, message: str) -> None:
    conn.execute("UPDATE sync_links SET last_error = ? WHERE id = ?", (message, link_id))


def _copy_note(conn: sqlite3.Connection, file_id: int, text: str, label: str) -> dict:
    """Their side as a new note next to this one."""
    row = conn.execute(
        "SELECT owner_id, folder_id, name, mime_type FROM files WHERE id = ?", (file_id,)
    ).fetchone()
    stem, dot, ext = row["name"].rpartition(".")
    name = f"{stem} ({label} copy).{ext}" if dot and stem else f"{row['name']} ({label} copy)"
    content = text.encode()
    now = db.utcnow()
    with db.transaction(conn):
        name = unique_name(conn, row["owner_id"], row["folder_id"], name)
        cur = conn.execute(
            "INSERT INTO files (owner_id, folder_id, name, mime_type, size, content,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row["owner_id"],
                row["folder_id"],
                name,
                row["mime_type"],
                len(content),
                content,
                now,
                now,
            ),
        )
    copy = conn.execute(
        "SELECT id, owner_id, folder_id, name, mime_type, size, created_at, updated_at"
        " FROM files WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    return file_json(copy)


# ------------------------------------------------------------------ routes


def _redirect_uri(request: Request) -> str:
    base = request.app.state.settings.public_url or str(request.base_url).rstrip("/")
    return f"{base}/api/cloud/google/callback"


def _safe_next(value: str | None) -> str:
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/account"
    return value


def _with_param(url: str, key: str, value: str) -> str:
    return f"{url}{'&' if '?' in url else '?'}{key}={value}"


def make_router(auth, get_db, syncer: Syncer) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["sync"])
    require_user = auth.require_user
    current_user = auth.current_user

    def note_role(request: Request, conn, file_id: int, user, needed: str) -> sqlite3.Row:
        from .access import file_access

        role = file_access(conn, file_id, user, share_token(request))
        if role is None:
            raise HTTPException(status_code=404, detail="File not found")
        if not allows(role, needed):
            raise HTTPException(status_code=403, detail="You can't do that with this file")
        row = conn.execute("SELECT mime_type FROM files WHERE id = ?", (file_id,)).fetchone()
        if not is_markdown(row["mime_type"]):
            raise HTTPException(status_code=415, detail="Only Markdown notes can be synced.")
        return row

    def links(conn, file_id: int) -> list[dict]:
        rows = conn.execute(
            f"SELECT {LINK_COLUMNS} FROM sync_links WHERE file_id = ? ORDER BY provider",
            (file_id,),
        ).fetchall()
        return [link_json(r) for r in rows]

    def failed(exc: GoogleError) -> HTTPException:
        return HTTPException(status_code=409 if exc.reconnect else 502, detail=str(exc))

    # ------------------------------------------------------- accounts

    @router.get("/cloud")
    def cloud(conn=Depends(get_db), user=Depends(require_user)):
        """Which cloud services this server offers, and which the user has connected."""
        row = conn.execute(
            "SELECT account_email FROM cloud_accounts WHERE user_id = ? AND provider = 'google'",
            (user["id"],),
        ).fetchone()
        return {
            "google": {
                "available": syncer.google is not None,
                "connected": row is not None,
                "email": row["account_email"] if row else None,
            },
        }

    @router.get("/cloud/google/connect")
    def google_connect(request: Request, next: str | None = None, user=Depends(require_user)):
        """Off to Google's consent screen; Google sends the browser back to the callback."""
        google = syncer.google_or_404()
        state = secrets.token_urlsafe(24)
        response = RedirectResponse(google.authorize_url(_redirect_uri(request), state), 303)
        response.set_cookie(
            STATE_COOKIE,
            f"{state}|{_safe_next(next)}",
            max_age=STATE_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=request.app.state.settings.https or request.url.scheme == "https",
            path="/api/cloud/google",
        )
        return response

    @router.get("/cloud/google/callback")
    async def google_callback(
        request: Request,
        state: str = "",
        code: str = "",
        error: str = "",
        conn=Depends(get_db),
        user=Depends(require_user),
    ):
        google = syncer.google_or_404()
        expected, _, next_url = request.cookies.get(STATE_COOKIE, "").partition("|")
        next_url = _safe_next(next_url)
        if not expected or not secrets.compare_digest(expected, state):
            raise HTTPException(status_code=400, detail="That sign-in link has expired. Try again.")
        outcome = "connected"
        if error or not code:
            outcome = "cancelled"
        else:
            try:
                tokens, email = await google.exchange(code, _redirect_uri(request))
            except GoogleError:
                log.warning("google sign-in failed", exc_info=True)
                outcome = "failed"
            else:
                now = db.utcnow()
                conn.execute(
                    "INSERT INTO cloud_accounts (user_id, provider, account_email, refresh_token,"
                    " access_token, access_expires_at, created_at, updated_at)"
                    " VALUES (?, 'google', ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT (user_id, provider) DO UPDATE SET"
                    " account_email = excluded.account_email,"
                    " refresh_token = excluded.refresh_token, access_token = excluded.access_token,"
                    " access_expires_at = excluded.access_expires_at,"
                    " updated_at = excluded.updated_at",
                    (
                        user["id"],
                        email,
                        tokens.refresh_token,
                        tokens.access_token,
                        tokens.expires_at,
                        now,
                        now,
                    ),
                )
        response = RedirectResponse(_with_param(next_url, "google", outcome), 303)
        response.delete_cookie(STATE_COOKIE, path="/api/cloud/google")
        return response

    @router.delete("/cloud/google")
    async def google_disconnect(conn=Depends(get_db), user=Depends(require_user)):
        """Forget the Google account and unlink its notes. The Google Docs stay in Drive."""
        row = conn.execute(
            "SELECT refresh_token FROM cloud_accounts WHERE user_id = ? AND provider = 'google'",
            (user["id"],),
        ).fetchone()
        if row is not None and syncer.google is not None:
            with contextlib.suppress(Exception):
                await syncer.google.revoke(row["refresh_token"])
        with db.transaction(conn):
            conn.execute(
                "DELETE FROM sync_links WHERE user_id = ? AND provider = 'google'", (user["id"],)
            )
            conn.execute(
                "DELETE FROM cloud_accounts WHERE user_id = ? AND provider = 'google'",
                (user["id"],),
            )
        return {"ok": True}

    # ----------------------------------------------------------- notes

    @router.get("/files/{file_id}/sync")
    def file_links(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(current_user)
    ):
        note_role(request, conn, file_id, user, "edit")
        return {"links": links(conn, file_id)}

    @router.post("/files/{file_id}/sync/google")
    async def google_link(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(require_user)
    ):
        """Create a Google Doc from the note, and keep the two in step."""
        note_role(request, conn, file_id, user, "owner")
        try:
            await syncer.link_google(conn, file_id, user["id"])
        except GoogleError as exc:
            raise failed(exc) from None
        return {"links": links(conn, file_id), "outcome": "pushed"}

    @router.post("/files/{file_id}/sync/google/run")
    async def google_sync(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(current_user)
    ):
        """Sync now, rather than waiting for the next background round."""
        note_role(request, conn, file_id, user, "edit")
        try:
            outcome = await syncer.sync_google(conn, file_id)
        except GoogleError as exc:
            raise failed(exc) from None
        except NoteChanged:
            raise HTTPException(
                status_code=409, detail="The note changed while syncing. Try again."
            ) from None
        return {"links": links(conn, file_id), "outcome": outcome}

    @router.post("/files/{file_id}/sync/icloud/saved")
    async def icloud_saved(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(require_user)
    ):
        """The browser saved a copy. The body is the text it saved; empty means the note as is."""
        note_role(request, conn, file_id, user, "edit")
        body = await request.body()
        if len(body) > request.app.state.settings.max_upload_bytes:
            raise HTTPException(status_code=413, detail="That file is too big.")
        text = body.decode("utf-8", errors="replace") if body else None
        await syncer.icloud_saved(conn, file_id, user["id"], text)
        return {"links": links(conn, file_id)}

    @router.post("/files/{file_id}/sync/icloud/import")
    async def icloud_import(
        file_id: int, request: Request, conn=Depends(get_db), user=Depends(require_user)
    ):
        """The raw text of a copy picked from iCloud Drive (or anywhere), merged into the note."""
        note_role(request, conn, file_id, user, "edit")
        limit = request.app.state.settings.max_upload_bytes
        body = await request.body()
        if len(body) > limit:
            raise HTTPException(status_code=413, detail="That file is too big.")
        try:
            outcome = await syncer.icloud_import(
                conn, file_id, user["id"], body.decode("utf-8", errors="replace")
            )
        except NoteChanged:
            raise HTTPException(
                status_code=409, detail="The note changed while merging. Try again."
            ) from None
        return {"links": links(conn, file_id), "outcome": outcome}

    @router.post("/files/{file_id}/sync/{provider}/resolve")
    async def resolve(
        file_id: int,
        provider: str,
        body: Resolution,
        request: Request,
        conn=Depends(get_db),
        user=Depends(require_user),
    ):
        """Settle a conflict: keep mine, keep theirs, keep both, or merge by hand."""
        if provider not in LABELS:
            raise HTTPException(status_code=404, detail="Not found")
        note_role(request, conn, file_id, user, "edit")
        try:
            result = await syncer.resolve(conn, file_id, provider, body.choice)
        except GoogleError as exc:
            raise failed(exc) from None
        except NoteChanged:
            raise HTTPException(
                status_code=409, detail="The note changed while resolving. Try again."
            ) from None
        return {"links": links(conn, file_id), **result}

    @router.delete("/files/{file_id}/sync/{provider}")
    def unlink(
        file_id: int,
        provider: str,
        request: Request,
        conn=Depends(get_db),
        user=Depends(require_user),
    ):
        """Stop syncing. The copy itself is left alone."""
        if provider not in LABELS:
            raise HTTPException(status_code=404, detail="Not found")
        note_role(request, conn, file_id, user, "owner" if provider == "google" else "edit")
        conn.execute(
            "DELETE FROM sync_links WHERE file_id = ? AND provider = ?", (file_id, provider)
        )
        return {"links": links(conn, file_id)}

    return router
