from __future__ import annotations

import pytest
from conftest import Client
from pycrdt import Doc, Text, create_sync_message, create_update_message, handle_sync_message
from starlette.websockets import WebSocketDisconnect

from studio import collab


def new_note(client, content="# Hello\n"):
    return client.post_json("/api/files", {"name": "live.md", "content": content}).json()["file"]


def join(client, file_id, **kwargs):
    return client.websocket_connect(f"/api/files/{file_id}/live", **kwargs)


def sync(ws, doc: Doc) -> None:
    """The y-websocket handshake, from the browser's side."""
    step1 = ws.receive_bytes()  # the server's state vector
    ws.send_bytes(handle_sync_message(step1[1:], doc))
    ws.send_bytes(create_sync_message(doc))
    while True:
        message = ws.receive_bytes()
        if message[0] == 0:
            handle_sync_message(message[1:], doc)
            if message[1] == 1:  # step 2: we're up to date
                return


def edit(ws, doc: Doc, change) -> None:
    before = doc.get_state()
    change(doc.get("content", type=Text))
    ws.send_bytes(create_update_message(doc.get_update(before)))


def receive_update(ws, doc: Doc) -> None:
    while True:
        message = ws.receive_bytes()
        if message[0] == 0:
            handle_sync_message(message[1:], doc)
            return


def text(doc: Doc) -> str:
    return str(doc.get("content", type=Text))


def test_replace_text_changes_only_the_difference():
    doc = Doc()
    t = doc.get("content", type=Text)
    t += "hello world"
    collab.replace_text(t, "hello brave world")
    assert str(t) == "hello brave world"
    collab.replace_text(t, "")
    assert str(t) == ""


def test_two_editors_converge_and_the_text_is_saved(user_client):
    note = new_note(user_client)
    a, b = Doc(), Doc()
    with join(user_client, note["id"]) as ws_a, join(user_client, note["id"]) as ws_b:
        sync(ws_a, a)
        sync(ws_b, b)
        assert text(a) == text(b) == "# Hello\n"
        edit(ws_a, a, lambda t: t.insert(len(t), "From A.\n"))
        receive_update(ws_b, b)
        edit(ws_b, b, lambda t: t.insert(0, "B: "))
        receive_update(ws_a, a)
        assert text(a) == text(b) == "B: # Hello\nFrom A.\n"
    # The last one out saves the plain text for downloads and exports.
    assert user_client.get(f"/api/files/{note['id']}/content").text == "B: # Hello\nFrom A.\n"

    # Coming back resumes the saved history rather than starting again.
    c = Doc()
    with join(user_client, note["id"]) as ws:
        sync(ws, c)
    assert text(c) == "B: # Hello\nFrom A.\n"


def test_http_saves_reach_open_editors(user_client):
    note = new_note(user_client, "one")
    doc = Doc()
    with join(user_client, note["id"]) as ws:
        sync(ws, doc)
        response = user_client.put(
            f"/api/files/{note['id']}/content",
            content=b"one two",
            headers={"X-CSRF-Token": user_client.csrf},
        )
        assert response.status_code == 200
        receive_update(ws, doc)
        assert text(doc) == "one two"


def test_text_changed_while_closed_is_picked_up(user_client):
    note = new_note(user_client, "first")
    with join(user_client, note["id"]) as ws:
        sync(ws, Doc())
    user_client.put(
        f"/api/files/{note['id']}/content",
        content=b"second",
        headers={"X-CSRF-Token": user_client.csrf},
    )
    doc = Doc()
    with join(user_client, note["id"]) as ws:
        sync(ws, doc)
    assert text(doc) == "second"


def test_awareness_is_relayed_and_cleared_on_leave(user_client):
    note = new_note(user_client)
    awareness = collab._awareness_update([(42, 1, '{"user":{"name":"kev"}}')])
    with join(user_client, note["id"]) as ws_a:
        sync(ws_a, Doc())
        with join(user_client, note["id"]) as ws_b:
            sync(ws_b, Doc())
            ws_b.send_bytes(bytes([1]) + collab.write_var_uint(len(awareness)) + awareness)
            message = ws_a.receive_bytes()
            assert message[0] == 1
            assert collab._awareness_entries(message[2:])[0][0] == 42
        gone = ws_a.receive_bytes()
        assert collab._awareness_entries(gone[2:]) == [(42, 2, "null")]


def test_read_only_editors_cannot_change_the_text(user_client, monkeypatch):
    note = new_note(user_client, "fixed")
    monkeypatch.setattr(collab, "file_access", lambda *args: "view")
    doc = Doc()
    with join(user_client, note["id"]) as ws:
        sync(ws, doc)
        edit(ws, doc, lambda t: t.insert(0, "changed "))
    assert user_client.get(f"/api/files/{note['id']}/content").text == "fixed"


def test_strangers_and_other_sites_are_refused(app_factory):
    app = app_factory()
    with Client(app) as kev, Client(app) as other:
        kev.register("kev")
        other.register("other")
        note = new_note(kev)
        with pytest.raises(WebSocketDisconnect) as refused, join(other, note["id"]) as ws:
            ws.receive_bytes()
        assert refused.value.code == collab.CLOSE_NOT_FOUND
        with (
            pytest.raises(WebSocketDisconnect) as refused,
            join(kev, note["id"], headers={"Origin": "https://evil.example"}) as ws,
        ):
            ws.receive_bytes()
        assert refused.value.code == collab.CLOSE_FORBIDDEN


def test_deleting_an_open_file_closes_the_room(user_client):
    note = new_note(user_client)
    doc = Doc()
    with join(user_client, note["id"]) as ws:
        sync(ws, doc)
        user_client.delete(f"/api/files/{note['id']}", headers={"X-CSRF-Token": user_client.csrf})
        edit(ws, doc, lambda t: t.insert(0, "x"))
    assert user_client.get(f"/api/files/{note['id']}").status_code == 404
