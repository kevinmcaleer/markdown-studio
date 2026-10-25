from __future__ import annotations

import pytest
from conftest import Client


def put(client, file_id, state, token=None):
    headers = {"X-CSRF-Token": client.csrf}
    if token:
        headers["X-Share-Token"] = token
    return client.put(f"/api/files/{file_id}/my-state", json={"state": state}, headers=headers)


@pytest.fixture
def note(app_factory):
    """Kev's note, with Sam signed in and an anonymous visitor, plus a view link."""
    app = app_factory()
    with Client(app) as kev, Client(app) as sam, Client(app) as anon:
        kev.register("kev")
        sam.register("sam")
        anon.refresh()
        note = kev.post_json("/api/files", {"name": "Plan", "content": "Ship it"}).json()["file"]
        link = kev.post_json(f"/api/files/{note['id']}/shares", {"role": "view"}).json()["link"]
        yield kev, sam, anon, note, link["token"]


def test_state_starts_empty_and_round_trips(note):
    kev, sam, anon, note, token = note
    url = f"/api/files/{note['id']}/my-state"
    assert kev.get(url).json() == {"state": None, "updated_at": None}

    state = {"v": 1, "cursor": {"offset": 4}, "bookmarks": [{"id": "a", "offset": 0}]}
    response = put(kev, note["id"], state)
    assert response.status_code == 200, response.text
    saved = kev.get(url).json()
    assert saved["state"] == state and saved["updated_at"] == response.json()["updated_at"]

    put(kev, note["id"], {"v": 1, "view": "raw"})
    assert kev.get(url).json()["state"] == {"v": 1, "view": "raw"}


def test_state_is_private_to_each_person(note):
    kev, sam, anon, note, token = note
    put(kev, note["id"], {"view": "raw"})
    response = put(sam, note["id"], {"view": "read"}, token)
    assert response.status_code == 200, response.text

    sam_state = sam.get(f"/api/files/{note['id']}/my-state", headers={"X-Share-Token": token})
    assert sam_state.json()["state"] == {"view": "read"}
    assert kev.get(f"/api/files/{note['id']}/my-state").json()["state"] == {"view": "raw"}


def test_needs_access_to_the_file(note):
    kev, sam, anon, note, token = note
    assert sam.get(f"/api/files/{note['id']}/my-state").status_code == 404
    assert put(sam, note["id"], {"view": "raw"}).status_code == 404
    assert kev.get("/api/files/9999/my-state").status_code == 404


def test_anonymous_visitors_keep_theirs_in_the_browser(note):
    kev, sam, anon, note, token = note
    response = anon.get(f"/api/files/{note['id']}/my-state", headers={"X-Share-Token": token})
    assert response.status_code == 401
    assert put(anon, note["id"], {"view": "raw"}, token).status_code == 401


def test_rejects_oversized_or_non_object_state(note):
    kev, sam, anon, note, token = note
    assert put(kev, note["id"], {"blob": "x" * 70_000}).status_code == 400
    response = kev.put(
        f"/api/files/{note['id']}/my-state",
        json={"state": [1, 2]},
        headers={"X-CSRF-Token": kev.csrf},
    )
    assert response.status_code in (400, 422)


def test_deleting_the_file_drops_the_state(note):
    kev, sam, anon, note, token = note
    put(kev, note["id"], {"view": "raw"})
    headers = {"X-CSRF-Token": kev.csrf}
    assert kev.delete(f"/api/files/{note['id']}", headers=headers).status_code in (200, 204)
    assert kev.get(f"/api/files/{note['id']}/my-state").status_code == 404
