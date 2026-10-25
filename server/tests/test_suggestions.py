from __future__ import annotations

import pytest
from conftest import Client


def send(client, method, url, body=None, token=None):
    headers = {"X-CSRF-Token": client.csrf}
    if token:
        headers["X-Share-Token"] = token
    return client.request(method, url, json=body, headers=headers)


@pytest.fixture
def shared_note(app_factory):
    """Kev's note with a view, a comment and an edit link."""
    app = app_factory()
    with Client(app) as kev, Client(app) as sam, Client(app) as anon:
        kev.register("kev")
        sam.register("sam")
        anon.refresh()
        note = kev.post_json("/api/files", {"name": "Plan", "content": "Ship it soon"}).json()[
            "file"
        ]
        links = {
            role: kev.post_json(f"/api/files/{note['id']}/shares", {"role": role}).json()["link"][
                "token"
            ]
            for role in ("view", "comment", "edit")
        }
        yield kev, sam, anon, note, links


def suggest(client, note, token=None, **extra):
    payload = {"anchor_from": 8, "anchor_to": 12, "quote": "soon", "replacement": "today", **extra}
    return send(client, "POST", f"/api/files/{note['id']}/suggestions", payload, token)


def listing(client, note, token=None):
    headers = {"X-Share-Token": token} if token else {}
    return client.get(f"/api/files/{note['id']}/suggestions", headers=headers)


def test_a_commenter_suggests_and_the_owner_accepts(shared_note):
    kev, sam, anon, note, links = shared_note
    r = suggest(anon, note, links["comment"], author_name=" Ada ", anchor='{"y":{}}')
    assert r.status_code == 200, r.text
    s = r.json()["suggestion"]
    assert (s["quote"], s["replacement"], s["status"]) == ("soon", "today", "open")
    assert s["author"]["name"] == "Ada" and s["author"]["anonymous"] is True
    assert s["anchor"] == '{"y":{}}'
    assert s["mine"] and s["can_edit"] and s["can_delete"] and not s["can_decide"]

    data = listing(kev, note).json()
    assert data["can_suggest"] and data["can_decide"]
    [seen] = data["suggestions"]
    assert seen["can_decide"] and not seen["mine"]

    r = send(kev, "POST", f"/api/suggestions/{s['id']}/accept")
    assert r.status_code == 200, r.text
    done = r.json()["suggestion"]
    assert (done["status"], done["decided_by"]) == ("accepted", "kev")
    assert not done["can_decide"] and not done["can_edit"]
    # Accepting twice (say, two editors at once) is refused, so it's applied once.
    assert send(kev, "POST", f"/api/suggestions/{s['id']}/accept").status_code == 409
    # The note itself is untouched by the server: the editor applies the change.
    assert kev.get(f"/api/files/{note['id']}/content").text == "Ship it soon"


def test_only_editors_decide(shared_note):
    kev, sam, anon, note, links = shared_note
    s = suggest(kev, note).json()["suggestion"]
    url = f"/api/suggestions/{s['id']}"
    assert send(sam, "POST", f"{url}/reject", token=links["comment"]).status_code == 403
    r = send(sam, "POST", f"{url}/reject", token=links["edit"])
    assert r.status_code == 200
    assert r.json()["suggestion"]["status"] == "rejected"


def test_view_links_see_suggestions_but_cannot_make_them(shared_note):
    kev, sam, anon, note, links = shared_note
    suggest(kev, note)
    data = listing(anon, note, links["view"]).json()
    assert len(data["suggestions"]) == 1
    assert not data["can_suggest"] and not data["can_decide"]
    assert suggest(anon, note, links["view"]).status_code == 403
    # No link, no access at all.
    assert listing(sam, note).status_code == 404


def test_authors_change_and_withdraw_their_own(shared_note):
    kev, sam, anon, note, links = shared_note
    s = suggest(sam, note, links["comment"], replacement="t").json()["suggestion"]
    url = f"/api/suggestions/{s['id']}"
    body = {"anchor_from": 8, "anchor_to": 12, "quote": "soon", "replacement": "tomorrow"}
    r = send(sam, "PATCH", url, body, links["comment"])
    assert r.status_code == 200
    assert r.json()["suggestion"]["replacement"] == "tomorrow"
    # Someone else can't change it, even an owner.
    assert send(kev, "PATCH", url, body).status_code == 403
    assert send(anon, "DELETE", url, token=links["comment"]).status_code == 403
    assert send(sam, "DELETE", url, token=links["comment"]).status_code == 200
    assert listing(kev, note).json()["suggestions"] == []


def test_a_decided_suggestion_is_frozen(shared_note):
    kev, sam, anon, note, links = shared_note
    s = suggest(sam, note, links["comment"]).json()["suggestion"]
    url = f"/api/suggestions/{s['id']}"
    send(kev, "POST", f"{url}/reject")
    body = {"quote": "soon", "replacement": "now"}
    assert send(sam, "PATCH", url, body, links["comment"]).status_code == 403
    assert send(sam, "DELETE", url, token=links["comment"]).status_code == 403
    # The owner can still clear it away.
    assert send(kev, "DELETE", url).status_code == 200


def test_suggestions_must_change_something(shared_note):
    kev, sam, anon, note, links = shared_note
    assert suggest(kev, note, quote="", replacement="").status_code == 400
    insertion = suggest(kev, note, anchor_from=4, anchor_to=4, quote="", replacement=" now")
    assert insertion.status_code == 200
    deletion = suggest(kev, note, replacement="")
    assert deletion.status_code == 200
    assert suggest(kev, note, replacement="x" * 20_001).status_code == 400


def test_replies_go_into_one_comment_thread(shared_note):
    kev, sam, anon, note, links = shared_note
    s = suggest(sam, note, links["comment"], anchor='{"y":1}').json()["suggestion"]
    url = f"/api/suggestions/{s['id']}/replies"
    r = send(kev, "POST", url, {"body": "Why today?"})
    assert r.status_code == 200, r.text
    thread = r.json()["thread"]
    assert r.json()["suggestion"]["thread_id"] == thread["id"]
    assert (thread["quote"], thread["anchor"]) == ("soon", '{"y":1}')
    r = send(sam, "POST", url, {"body": "Deadline moved"}, links["comment"])
    assert r.json()["thread"]["id"] == thread["id"]
    assert [c["body"] for c in r.json()["thread"]["comments"]] == ["Why today?", "Deadline moved"]
    # It's a normal comment thread, so it shows with the others.
    threads = kev.get(f"/api/files/{note['id']}/comments").json()["threads"]
    assert [t["id"] for t in threads] == [thread["id"]]
    assert send(anon, "POST", url, {"body": "Hi"}, links["view"]).status_code == 403


def test_deleting_the_file_removes_its_suggestions(shared_note):
    kev, sam, anon, note, links = shared_note
    s = suggest(kev, note).json()["suggestion"]
    assert send(kev, "DELETE", f"/api/files/{note['id']}").status_code in (200, 204)
    assert send(kev, "POST", f"/api/suggestions/{s['id']}/accept").status_code == 404
