"""Real-time co-editing over WebSockets, speaking the y-websocket protocol.

Each open text file is a *room* holding a Yjs document (via pycrdt) whose
shared text ``content`` is the file. Browsers connect to
``/api/files/{id}/live``, sync with the room, and from then on every edit is
relayed to the others. Yjs merges concurrent edits without conflicts, and a
browser that was offline merges its changes when it reconnects.

The room saves a moment after edits stop, and when the last person leaves:
the Yjs state goes in ``doc_states`` and the plain text in ``files.content``,
so downloads, exports and backups always see the latest text.

Awareness messages (cursors, selections, who is here) are relayed as they
are; the server only reads the client ids so it can tell the others when
someone disconnects.

One room per file lives in this process. Run one server process (the
SQLite setup already requires that) and every editor of a file meets here.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect
from pycrdt import (
    Decoder,
    Doc,
    Text,
    YMessageType,
    YSyncMessageType,
    create_awareness_message,
    create_sync_message,
    create_update_message,
    handle_sync_message,
    read_message,
    write_var_uint,
)

from powertools_auth import store

from . import db
from .access import allows, file_access
from .files import is_text, save_content

log = logging.getLogger(__name__)

TEXT_NAME = "content"
SAVE_DELAY = 1.0
QUERY_AWARENESS = 3
# WebSocket close codes in the application range.
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_GONE = 4410


def replace_text(text: Text, new: str) -> None:
    """Make ``text`` equal ``new`` by changing only the part that differs.

    Keeps everyone's cursors and the CRDT history where the text didn't change.
    """
    old = str(text)
    if old == new:
        return
    start = 0
    limit = min(len(old), len(new))
    while start < limit and old[start] == new[start]:
        start += 1
    end_old, end_new = len(old), len(new)
    while end_old > start and end_new > start and old[end_old - 1] == new[end_new - 1]:
        end_old -= 1
        end_new -= 1
    with text.doc.transaction():
        if end_old > start:
            del text[start:end_old]
        if end_new > start:
            text.insert(start, new[start:end_new])


def _awareness_entries(update: bytes) -> list[tuple[int, int, str]]:
    """(client id, clock, state JSON) for each client in an awareness update."""
    decoder = Decoder(update)
    entries = []
    for _ in range(decoder.read_var_uint()):
        client = decoder.read_var_uint()
        clock = decoder.read_var_uint()
        entries.append((client, clock, decoder.read_var_string()))
    return entries


def _awareness_update(entries: list[tuple[int, int, str]]) -> bytes:
    out = bytearray(write_var_uint(len(entries)))
    for client, clock, state in entries:
        encoded = state.encode()
        out += write_var_uint(client) + write_var_uint(clock)
        out += write_var_uint(len(encoded)) + encoded
    return bytes(out)


class Room:
    def __init__(self, rooms: Rooms, file_id: int) -> None:
        self.rooms = rooms
        self.file_id = file_id
        self.doc = Doc()
        self.text = self.doc.get(TEXT_NAME, type=Text)
        # Each connection, and whether it may change the document.
        self.clients: dict[WebSocket, bool] = {}
        # Awareness: client id -> (clock, state JSON), and which socket owns which ids.
        self.awareness: dict[int, tuple[int, str]] = {}
        self.owners: dict[WebSocket, set[int]] = {}
        self._save_task: asyncio.Task | None = None
        self.dirty = False

    # ------------------------------------------------------------ storage

    def load(self) -> bool:
        """Load the saved state, or start from the file's text. False if the file is gone."""
        conn = db.connect(self.rooms.database_path)
        try:
            file = conn.execute(
                "SELECT content FROM files WHERE id = ?", (self.file_id,)
            ).fetchone()
            if file is None:
                return False
            saved = conn.execute(
                "SELECT state FROM doc_states WHERE file_id = ?", (self.file_id,)
            ).fetchone()
            if saved is not None:
                self.doc.apply_update(saved["state"])
            # The text may have changed without the room (an upload or a PUT):
            # apply the difference so saved history and the new text agree.
            before = str(self.text)
            replace_text(self.text, bytes(file["content"]).decode("utf-8", errors="replace"))
            if saved is None or str(self.text) != before:
                # Save at once: a browser may keep this history offline, and it
                # must be the history the server continues from.
                self._write(conn)
            return True
        finally:
            conn.close()

    def _write(self, conn: sqlite3.Connection) -> None:
        text = str(self.text).encode()
        now = db.utcnow()
        with db.transaction(conn):
            exists = conn.execute("SELECT 1 FROM files WHERE id = ?", (self.file_id,)).fetchone()
            if exists is None:
                raise LookupError(self.file_id)
            save_content(conn, self.file_id, text)
            conn.execute(
                "INSERT INTO doc_states (file_id, state, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT (file_id) DO UPDATE SET state = excluded.state,"
                " updated_at = excluded.updated_at",
                (self.file_id, self.doc.get_update(), now),
            )

    async def save(self) -> None:
        if not self.dirty:
            return
        self.dirty = False
        conn = db.connect(self.rooms.database_path)
        try:
            self._write(conn)
        except LookupError:
            log.info("file deleted while open", extra={"file_id": self.file_id})
            await self.close(CLOSE_GONE)
        except sqlite3.Error:
            self.dirty = True
            log.exception("couldn't save a live document", extra={"file_id": self.file_id})
        finally:
            conn.close()

    def _schedule_save(self) -> None:
        self.dirty = True
        if self._save_task is None or self._save_task.done():
            self._save_task = asyncio.get_running_loop().create_task(self._save_soon())

    async def _save_soon(self) -> None:
        await asyncio.sleep(SAVE_DELAY)
        await self.save()

    # ------------------------------------------------------------ clients

    def add(self, ws: WebSocket, can_edit: bool) -> None:
        self.clients[ws] = can_edit
        self.owners[ws] = set()

    async def greet(self, ws: WebSocket) -> None:
        await ws.send_bytes(create_sync_message(self.doc))
        if self.awareness:
            await ws.send_bytes(self._awareness_message())

    async def leave(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)
        gone = self.owners.pop(ws, set())
        removed = []
        for client in gone:
            clock, _ = self.awareness.pop(client, (0, "null"))
            removed.append((client, clock + 1, "null"))
        if removed:
            await self.broadcast(create_awareness_message(_awareness_update(removed)))
        if not self.clients:
            if self._save_task is not None:
                self._save_task.cancel()
            await self.save()
            self.rooms.discard(self)

    async def receive(self, ws: WebSocket, message: bytes) -> None:
        if not message:
            return
        kind = message[0]
        if kind == YMessageType.SYNC:
            await self._sync(ws, message[1:])
        elif kind == YMessageType.AWARENESS:
            update = read_message(message[1:])
            for client, clock, state in _awareness_entries(update):
                self.owners[ws].add(client)
                if state == "null":
                    self.awareness.pop(client, None)
                else:
                    self.awareness[client] = (clock, state)
            await self.broadcast(message, skip=ws)
        elif kind == QUERY_AWARENESS:
            await ws.send_bytes(self._awareness_message())

    async def _sync(self, ws: WebSocket, message: bytes) -> None:
        sync_type = message[0]
        changes = sync_type in (YSyncMessageType.SYNC_STEP2, YSyncMessageType.SYNC_UPDATE)
        if changes and not self.clients.get(ws, False):
            return  # read-only: ignore edits
        reply = handle_sync_message(message, self.doc)
        if reply is not None:
            await ws.send_bytes(reply)
        if changes:
            update = read_message(message[1:])
            if update != b"\x00\x00":
                await self.broadcast(create_update_message(update), skip=ws)
                self._schedule_save()

    async def set_text(self, new: str) -> None:
        """Replace the text from outside (an HTTP save) and tell everyone."""
        before = self.doc.get_state()
        replace_text(self.text, new)
        update = self.doc.get_update(before)
        await self.broadcast(create_update_message(update))
        self._schedule_save()

    async def broadcast(self, message: bytes, skip: WebSocket | None = None) -> None:
        for ws in list(self.clients):
            if ws is not skip:
                with contextlib.suppress(Exception):
                    await ws.send_bytes(message)

    async def close(self, code: int) -> None:
        for ws in list(self.clients):
            with contextlib.suppress(Exception):
                await ws.close(code)
        self.clients.clear()
        self.rooms.discard(self)

    def _awareness_message(self) -> bytes:
        entries = [(client, clock, state) for client, (clock, state) in self.awareness.items()]
        return create_awareness_message(_awareness_update(entries))


class Rooms:
    """The open rooms, one per file being edited."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.rooms: dict[int, Room] = {}

    def get(self, file_id: int) -> Room | None:
        room = self.rooms.get(file_id)
        if room is None:
            room = Room(self, file_id)
            if not room.load():
                return None
            self.rooms[file_id] = room
        return room

    def discard(self, room: Room) -> None:
        if self.rooms.get(room.file_id) is room:
            del self.rooms[room.file_id]

    def content_replaced(self, file_id: int, text: str) -> None:
        """Called after an HTTP save, so open editors see the new text."""
        room = self.rooms.get(file_id)
        if room is not None:
            asyncio.get_running_loop().create_task(room.set_text(text))

    async def save_all(self) -> None:
        for room in list(self.rooms.values()):
            await room.save()


def _same_origin(ws: WebSocket) -> bool:
    """Browsers always send Origin on WebSockets; refuse other sites' pages."""
    origin = ws.headers.get("origin")
    if origin is None:
        return True  # not a browser
    host = ws.headers.get("x-forwarded-host") or ws.headers.get("host", "")
    return origin.split("://", 1)[-1] == host


PATH = "/api/files/{file_id:int}/live"


def make_endpoint(auth, rooms: Rooms):
    """The WebSocket endpoint, mounted as a Starlette ``WebSocketRoute`` at ``PATH``.

    The app-wide CSRF check only understands HTTP requests; the Origin check
    below does that job here.
    """

    async def live(ws: WebSocket):
        file_id: int = ws.path_params["file_id"]
        if not _same_origin(ws):
            await ws.close(CLOSE_FORBIDDEN)
            return
        conn = db.connect(rooms.database_path)
        try:
            user = store.session_user(conn, ws.cookies.get(auth.session_cookie))
            role = file_access(conn, file_id, user, ws.query_params.get("share") or None)
            row = conn.execute("SELECT mime_type FROM files WHERE id = ?", (file_id,)).fetchone()
        finally:
            conn.close()
        if role is None or row is None or not is_text(row["mime_type"]):
            await ws.close(CLOSE_NOT_FOUND)
            return
        await ws.accept()
        # No awaits between finding the room and joining it, so the room can't
        # close in between (it closes when its last client leaves).
        room = rooms.get(file_id)
        if room is None:
            await ws.close(CLOSE_NOT_FOUND)
            return
        room.add(ws, allows(role, "edit"))
        try:
            await room.greet(ws)
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes"):
                    await room.receive(ws, message["bytes"])
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("live editing connection failed", extra={"file_id": file_id})
        finally:
            await room.leave(ws)

    return live
