from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest
from conftest import Client
from pycrdt import Doc
from test_collab import join, receive_update, sync, text
from test_files import delete

from studio import db

GOOGLE = {"GOOGLE_CLIENT_ID": "client-id", "GOOGLE_CLIENT_SECRET": "client-secret"}
NOTE = "# Trip\n\n- passports\n- tickets\n\nLeave at nine.\n"


class FakeGoogle:
    """Just enough of Google's OAuth and Drive APIs.

    Like the real thing, exporting rewrites Markdown a little: bullets come
    back as ``*`` rather than ``-``.
    """

    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}
        self.revoked = False
        self.calls: list[str] = []

    def edit(self, doc_id: str, change) -> None:
        """Someone edits the Doc in Google Docs."""
        doc = self.docs[doc_id]
        doc["text"] = change(doc["text"])
        doc["version"] += 1

    @staticmethod
    def export(markdown: str) -> str:
        return "".join(
            "* " + line[2:] if line.startswith("- ") else line
            for line in markdown.splitlines(keepends=True)
        )

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        self.calls.append(f"{request.method} {url.path}")
        if url.host == "oauth2.googleapis.com" and url.path == "/token":
            form = parse_qs(request.content.decode())
            if form["grant_type"] == ["authorization_code"]:
                if form["code"] != ["good-code"]:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(
                    200, json={"access_token": "a1", "expires_in": 3600, "refresh_token": "r1"}
                )
            if self.revoked:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "a2", "expires_in": 3600})
        if url.path == "/revoke":
            return httpx.Response(200)
        if url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json={"email": "kev@example.com"})
        assert request.headers["authorization"].startswith("Bearer ")
        if request.method == "POST" and url.path == "/upload/drive/v3/files":
            parts = request.content.decode().split("\r\n\r\n")
            name = json.loads(parts[1].split("\r\n")[0])["name"]
            markdown = parts[2].rsplit("\r\n--", 1)[0]
            doc_id = f"doc{len(self.docs) + 1}"
            self.docs[doc_id] = {"name": name, "text": markdown, "version": 1}
            return self.info(doc_id)
        doc_id = url.path.split("/")[-2 if url.path.endswith("/export") else -1]
        if doc_id not in self.docs:
            return httpx.Response(404, json={"error": {"message": "File not found"}})
        if request.method == "PATCH":
            assert request.headers["content-type"].startswith("text/markdown")
            self.edit(doc_id, lambda _: request.content.decode())
            return self.info(doc_id)
        if url.path.endswith("/export"):
            assert url.params["mimeType"] == "text/markdown"
            return httpx.Response(200, content=self.export(self.docs[doc_id]["text"]).encode())
        return self.info(doc_id)

    def info(self, doc_id: str) -> httpx.Response:
        doc = self.docs[doc_id]
        return httpx.Response(
            200,
            json={
                "id": doc_id,
                "name": doc["name"],
                "version": str(doc["version"]),
                "webViewLink": f"https://docs.google.com/document/d/{doc_id}/edit",
                "trashed": False,
            },
        )


@pytest.fixture
def google(app_factory):
    """Kev, signed in, with Google connected; plus the fake Google."""
    app = app_factory(**GOOGLE, GOOGLE_SYNC_INTERVAL=0)
    fake = FakeGoogle()
    app.state.syncer.google.transport = httpx.MockTransport(fake)
    with Client(app) as kev:
        assert kev.register("kev").status_code == 200
        connect_google(kev)
        yield kev, fake


def connect_google(client: Client):
    start = client.get("/api/cloud/google/connect?next=/notes", follow_redirects=False)
    assert start.status_code == 303
    location = httpx.URL(start.headers["location"])
    assert location.host == "accounts.google.com"
    assert "drive.file" in location.params["scope"]
    assert location.params["access_type"] == "offline"
    state = location.params["state"]
    back = client.get(
        f"/api/cloud/google/callback?state={state}&code=good-code", follow_redirects=False
    )
    assert back.status_code == 303
    assert back.headers["location"] == "/notes?google=connected"


def new_note(client, content=NOTE, name="Trip.md"):
    return client.post_json("/api/files", {"name": name, "content": content}).json()["file"]


def content(client, file_id) -> str:
    return client.get(f"/api/files/{file_id}/content").text


def link(client, note) -> dict:
    response = client.post_json(f"/api/files/{note['id']}/sync/google")
    assert response.status_code == 200, response.text
    return response.json()["links"][0]


def sync_now(client, note) -> dict:
    response = client.post_json(f"/api/files/{note['id']}/sync/google/run")
    assert response.status_code == 200, response.text
    return response.json()


def save(client, note, text: str) -> None:
    response = client.put(
        f"/api/files/{note['id']}/content",
        content=text.encode(),
        headers={"X-CSRF-Token": client.csrf},
    )
    assert response.status_code == 200


# ------------------------------------------------------------------ setup


def test_google_is_hidden_until_configured(user_client):
    assert user_client.get("/api/cloud").json()["google"] == {
        "available": False,
        "connected": False,
        "email": None,
    }
    assert user_client.get("/api/cloud/google/connect").status_code == 404


def test_client_id_and_secret_go_together(app_factory):
    from studio.config import ConfigError

    with pytest.raises(ConfigError):
        app_factory(GOOGLE_CLIENT_ID="only-the-id")


def test_connect_and_disconnect(google):
    kev, fake = google
    assert kev.get("/api/cloud").json()["google"] == {
        "available": True,
        "connected": True,
        "email": "kev@example.com",
    }
    note = new_note(kev)
    link(kev, note)
    assert delete(kev, "/api/cloud/google").status_code == 200
    assert "POST /revoke" in fake.calls
    assert kev.get("/api/cloud").json()["google"]["connected"] is False
    assert kev.get(f"/api/files/{note['id']}/sync").json()["links"] == []
    # The Doc itself is left in Drive.
    assert len(fake.docs) == 1


def test_callback_checks_the_state(app_factory):
    app = app_factory(**GOOGLE)
    with Client(app) as kev:
        kev.register("kev")
        kev.get("/api/cloud/google/connect", follow_redirects=False)
        bad = kev.get("/api/cloud/google/callback?state=forged&code=good-code")
        assert bad.status_code == 400
        assert kev.get("/api/cloud").json()["google"]["connected"] is False


def test_connect_rejects_outside_redirects(app_factory):
    app = app_factory(**GOOGLE)
    app.state.syncer.google.transport = httpx.MockTransport(FakeGoogle())
    with Client(app) as kev:
        kev.register("kev")
        start = kev.get("/api/cloud/google/connect?next=//evil.example", follow_redirects=False)
        state = httpx.URL(start.headers["location"]).params["state"]
        back = kev.get(
            f"/api/cloud/google/callback?state={state}&code=good-code", follow_redirects=False
        )
        assert back.headers["location"] == "/account?google=connected"


def test_cancelled_consent(app_factory):
    app = app_factory(**GOOGLE)
    with Client(app) as kev:
        kev.register("kev")
        start = kev.get("/api/cloud/google/connect", follow_redirects=False)
        state = httpx.URL(start.headers["location"]).params["state"]
        back = kev.get(
            f"/api/cloud/google/callback?state={state}&error=access_denied", follow_redirects=False
        )
        assert back.headers["location"] == "/account?google=cancelled"


# ------------------------------------------------------------------- sync


def test_link_creates_a_google_doc(google):
    kev, fake = google
    note = new_note(kev)
    created = link(kev, note)
    assert created["provider"] == "google"
    assert created["status"] == "ok"
    assert created["remote_url"] == "https://docs.google.com/document/d/doc1/edit"
    assert fake.docs["doc1"] == {"name": "Trip", "text": NOTE, "version": 1}
    # Linking twice keeps the one Doc.
    link(kev, note)
    assert len(fake.docs) == 1


def test_only_the_owner_links(app_factory):
    app = app_factory(**GOOGLE)
    with Client(app) as kev, Client(app) as sam:
        kev.register("kev")
        sam.register("sam")
        note = new_note(kev)
        kev.post_json(f"/api/files/{note['id']}/members", {"username": "sam", "role": "edit"})
        assert sam.post_json(f"/api/files/{note['id']}/sync/google").status_code == 403


def test_nothing_to_do(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    assert sync_now(kev, note)["outcome"] == "unchanged"
    # Google's rewrite of the bullets is not an edit: the note keeps its own.
    assert content(kev, note["id"]) == NOTE


def test_note_edits_go_to_google(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    save(kev, note, NOTE + "\nBring snacks.\n")
    assert sync_now(kev, note)["outcome"] == "pushed"
    assert fake.docs["doc1"]["text"].endswith("Bring snacks.\n")


def test_google_edits_come_back_in_the_notes_own_style(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    fake.edit("doc1", lambda t: FakeGoogle.export(t).replace("nine", "ten"))
    assert sync_now(kev, note)["outcome"] == "pulled"
    assert content(kev, note["id"]) == NOTE.replace("nine", "ten")


def test_edits_on_both_sides_merge(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    save(kev, note, NOTE.replace("# Trip", "# Trip to Wales"))
    fake.edit("doc1", lambda t: FakeGoogle.export(t).replace("nine", "ten"))
    result = sync_now(kev, note)
    assert result["outcome"] == "merged"
    merged = NOTE.replace("# Trip", "# Trip to Wales").replace("nine", "ten")
    assert content(kev, note["id"]) == merged
    assert fake.docs["doc1"]["text"] == merged
    assert sync_now(kev, note)["outcome"] == "unchanged"


def conflicted(kev, fake):
    note = new_note(kev)
    link(kev, note)
    save(kev, note, NOTE.replace("nine", "eight"))
    fake.edit("doc1", lambda t: FakeGoogle.export(t).replace("nine", "ten"))
    result = sync_now(kev, note)
    assert result["outcome"] == "conflict"
    assert result["links"][0]["status"] == "conflict"
    # Nothing is overwritten while it waits.
    assert content(kev, note["id"]) == NOTE.replace("nine", "eight")
    assert "ten" in fake.docs["doc1"]["text"]
    return note


def resolve(kev, note, choice, provider="google"):
    response = kev.post_json(f"/api/files/{note['id']}/sync/{provider}/resolve", {"choice": choice})
    assert response.status_code == 200, response.text
    return response.json()


def test_conflict_keep_mine(google):
    kev, fake = google
    note = conflicted(kev, fake)
    assert resolve(kev, note, "mine")["links"][0]["status"] == "ok"
    assert fake.docs["doc1"]["text"] == NOTE.replace("nine", "eight")
    assert sync_now(kev, note)["outcome"] == "unchanged"


def test_conflict_keep_theirs(google):
    kev, fake = google
    note = conflicted(kev, fake)
    resolve(kev, note, "theirs")
    assert "Leave at ten." in content(kev, note["id"])
    assert sync_now(kev, note)["outcome"] == "unchanged"


def test_conflict_keep_both(google):
    kev, fake = google
    note = conflicted(kev, fake)
    copy = resolve(kev, note, "both")["copy"]
    assert copy["name"] == "Trip (Google Docs copy).md"
    assert "Leave at ten." in content(kev, copy["id"])
    assert fake.docs["doc1"]["text"] == NOTE.replace("nine", "eight")


def test_conflict_fix_by_hand(google):
    kev, fake = google
    note = conflicted(kev, fake)
    resolve(kev, note, "markers")
    marked = content(kev, note["id"])
    assert "<<<<<<< Markdown Studio\nLeave at eight.\n=======\n" in marked
    assert ">>>>>>> Google Docs\n" in marked
    save(kev, note, NOTE.replace("nine", "half eight"))
    assert sync_now(kev, note)["outcome"] == "pushed"
    assert "Leave at half eight." in fake.docs["doc1"]["text"]


def test_no_conflict_to_resolve(google):
    kev, _ = google
    note = new_note(kev)
    link(kev, note)
    response = kev.post_json(f"/api/files/{note['id']}/sync/google/resolve", {"choice": "mine"})
    assert response.status_code == 409


def test_revoked_access_asks_to_reconnect(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    fake.revoked = True
    # Force a token refresh.
    conn = db.connect(kev.app.state.settings.database_path)
    conn.execute("UPDATE cloud_accounts SET access_expires_at = 0")
    conn.close()
    response = kev.post_json(f"/api/files/{note['id']}/sync/google/run")
    assert response.status_code == 409
    assert "Reconnect" in response.json()["detail"]
    links = kev.get(f"/api/files/{note['id']}/sync").json()["links"]
    assert "Reconnect" in links[0]["last_error"]


def test_deleted_doc(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    del fake.docs["doc1"]
    response = kev.post_json(f"/api/files/{note['id']}/sync/google/run")
    assert response.status_code == 502
    assert "deleted" in response.json()["detail"]


def test_background_sync(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    fake.edit("doc1", lambda t: t + "\nAdded in Google Docs.\n")
    kev.portal.call(kev.app.state.syncer.sync_all)
    assert content(kev, note["id"]).endswith("Added in Google Docs.\n")


def test_pulled_changes_reach_live_editors(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    doc = Doc()
    with join(kev, note["id"]) as ws:
        sync(ws, doc)
        assert text(doc) == NOTE
        fake.edit("doc1", lambda t: FakeGoogle.export(t).replace("nine", "ten"))
        assert sync_now(kev, note)["outcome"] == "pulled"
        receive_update(ws, doc)
        assert text(doc) == NOTE.replace("nine", "ten")


def test_unlink(google):
    kev, fake = google
    note = new_note(kev)
    link(kev, note)
    response = delete(kev, f"/api/files/{note['id']}/sync/google")
    assert response.json()["links"] == []
    assert "doc1" in fake.docs


def test_only_notes_sync(google):
    kev, _ = google
    other = kev.post_json("/api/files", {"name": "data.json", "content": "{}"}).json()["file"]
    assert kev.post_json(f"/api/files/{other['id']}/sync/google").status_code == 415


# ------------------------------------------------------------------ iCloud


def icloud_saved(client, note):
    return client.post(
        f"/api/files/{note['id']}/sync/icloud/saved", headers={"X-CSRF-Token": client.csrf}
    )


def icloud_import(client, note, text: str):
    return client.post(
        f"/api/files/{note['id']}/sync/icloud/import",
        content=text.encode(),
        headers={"X-CSRF-Token": client.csrf},
    )


def test_icloud_round_trip(user_client):
    kev = user_client
    note = new_note(kev)
    saved = icloud_saved(kev, note)
    assert saved.json()["links"][0]["provider"] == "icloud"
    # Edited on an iPhone in the meantime, and in the browser too.
    save(kev, note, NOTE.replace("# Trip", "# Trip to Wales"))
    response = icloud_import(kev, note, NOTE.replace("nine", "ten"))
    assert response.json()["outcome"] == "merged"
    assert content(kev, note["id"]) == NOTE.replace("# Trip", "# Trip to Wales").replace(
        "nine", "ten"
    )
    # The same copy again changes nothing.
    assert icloud_import(kev, note, NOTE.replace("nine", "ten")).json()["outcome"] == "unchanged"


def test_icloud_save_records_the_text_that_was_saved(user_client):
    """The browser reports what it handed over, after the share sheet finished."""
    kev = user_client
    note = new_note(kev)
    shared = NOTE.replace("nine", "eight")
    response = kev.post(
        f"/api/files/{note['id']}/sync/icloud/saved",
        content=shared.encode(),
        headers={"X-CSRF-Token": kev.csrf},
    )
    assert response.status_code == 200
    # That copy coming back unchanged brings nothing new: the note stays as it is,
    # and the outcome says the iCloud copy is behind.
    assert icloud_import(kev, note, shared).json()["outcome"] == "pushed"
    assert content(kev, note["id"]) == NOTE


def test_icloud_conflict(user_client):
    kev = user_client
    note = new_note(kev)
    icloud_saved(kev, note)
    save(kev, note, NOTE.replace("nine", "eight"))
    assert icloud_import(kev, note, NOTE.replace("nine", "ten")).json()["outcome"] == "conflict"
    result = resolve(kev, note, "mine", provider="icloud")
    assert result["stale"] is True
    assert content(kev, note["id"]) == NOTE.replace("nine", "eight")


def test_icloud_import_without_a_save_asks_first(user_client):
    kev = user_client
    note = new_note(kev)
    assert icloud_import(kev, note, NOTE).json()["outcome"] == "unchanged"
    assert icloud_import(kev, note, "Something else\n").json()["outcome"] == "conflict"
    resolve(kev, note, "theirs", provider="icloud")
    assert content(kev, note["id"]) == "Something else\n"


def test_icloud_needs_edit_rights(app_factory):
    app = app_factory()
    with Client(app) as kev, Client(app) as sam:
        kev.register("kev")
        sam.register("sam")
        note = new_note(kev)
        kev.post_json(f"/api/files/{note['id']}/members", {"username": "sam", "role": "view"})
        assert icloud_saved(sam, note).status_code == 403
        assert icloud_import(sam, note, "x").status_code == 403
