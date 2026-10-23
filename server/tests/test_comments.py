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
    """Kev's note with a comment link, a view link and an edit link."""
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


def start(client, note, body="Looks good", token=None, **extra):
    payload = {"body": body, "anchor_from": 0, "anchor_to": 4, "quote": "Ship", **extra}
    return send(client, "POST", f"/api/files/{note['id']}/comments", payload, token)


def test_owner_starts_a_thread_anchored_to_a_selection(shared_note):
    kev, sam, anon, note, links = shared_note
    response = start(kev, note, anchor='{"yjs":"abc"}')
    assert response.status_code == 200, response.text
    thread = response.json()["thread"]
    assert (thread["anchor_from"], thread["anchor_to"], thread["quote"]) == (0, 4, "Ship")
    assert thread["anchor"] == '{"yjs":"abc"}'
    assert thread["resolved"] is False
    [comment] = thread["comments"]
    assert comment["author"] == {"name": "kev", "user_id": comment["author"]["user_id"],
                                 "anonymous": False}  # fmt: skip
    assert comment["mine"] and comment["can_edit"] and comment["can_delete"]

    listing = kev.get(f"/api/files/{note['id']}/comments").json()
    assert listing["role"] == "owner" and listing["can_comment"]
    assert [t["id"] for t in listing["threads"]] == [thread["id"]]


def test_replies_build_a_thread(shared_note):
    kev, sam, anon, note, links = shared_note
    thread = start(kev, note).json()["thread"]
    url = f"/api/comment-threads/{thread['id']}/replies"
    r = send(sam, "POST", url, {"body": "Agreed"}, links["comment"])
    assert r.status_code == 200
    r = send(anon, "POST", url, {"body": "Me too", "author_name": "  Ada   L. "}, links["comment"])
    comments = r.json()["thread"]["comments"]
    assert [(c["author"]["name"], c["body"]) for c in comments] == [
        ("kev", "Looks good"),
        ("sam", "Agreed"),
        ("Ada L.", "Me too"),
    ]
    assert comments[2]["author"]["anonymous"] is True
    assert comments[2]["mine"] is True and comments[0]["mine"] is False
    # Blank replies are refused.
    assert send(kev, "POST", url, {"body": "   "}).status_code == 400


def test_view_links_can_read_but_not_comment(shared_note):
    kev, sam, anon, note, links = shared_note
    start(kev, note)
    listing = anon.get(
        f"/api/files/{note['id']}/comments", headers={"X-Share-Token": links["view"]}
    ).json()
    assert listing["can_comment"] is False
    assert listing["threads"][0]["can_reply"] is False
    assert start(anon, note, token=links["view"]).status_code == 403
    # Nobody gets in without a link.
    assert anon.get(f"/api/files/{note['id']}/comments").status_code == 401
    assert sam.get(f"/api/files/{note['id']}/comments").status_code == 404
    assert start(anon, note, token="not-a-token").status_code == 404


def test_only_authors_edit_and_owner_can_delete(shared_note):
    kev, sam, anon, note, links = shared_note
    thread = start(anon, note, token=links["comment"], author_name="Guest A").json()["thread"]
    anon_comment = thread["comments"][0]["id"]
    reply = send(
        sam, "POST", f"/api/comment-threads/{thread['id']}/replies", {"body": "hi"}, links["edit"]
    ).json()["thread"]["comments"][1]["id"]

    # Someone else can't edit it, even an editor.
    assert (
        send(
            sam, "PATCH", f"/api/comments/{anon_comment}", {"body": "x"}, links["edit"]
        ).status_code
        == 403
    )
    edited = send(
        anon, "PATCH", f"/api/comments/{anon_comment}", {"body": "Fixed"}, links["comment"]
    )
    assert edited.json()["thread"]["comments"][0]["body"] == "Fixed"
    assert edited.json()["thread"]["comments"][0]["edited_at"] is not None
    # Same browser, different anonymous visitor? A fresh client has a new cookie.
    with Client(kev.app) as stranger:
        stranger.refresh()
        assert send(stranger, "PATCH", f"/api/comments/{anon_comment}", {"body": "x"},
                    links["comment"]).status_code == 403  # fmt: skip
        assert send(stranger, "DELETE", f"/api/comments/{anon_comment}", None,
                    links["comment"]).status_code == 403  # fmt: skip

    # The owner can delete anyone's comment; the thread stays while a reply is left.
    deleted = send(kev, "DELETE", f"/api/comments/{anon_comment}").json()["thread"]
    assert deleted["comments"][0]["deleted"] and deleted["comments"][0]["body"] == ""
    # Deleting the last one removes the thread.
    gone = send(sam, "DELETE", f"/api/comments/{reply}", None, links["edit"]).json()
    assert gone == {"thread": None, "deleted_thread_id": thread["id"]}
    assert kev.get(f"/api/files/{note['id']}/comments").json()["threads"] == []


def test_resolve_and_reopen(shared_note):
    kev, sam, anon, note, links = shared_note
    thread = start(sam, note, token=links["comment"]).json()["thread"]
    tid = thread["id"]
    assert thread["can_resolve"] is True  # Sam started it
    # A commenter who didn't start it can't resolve it.
    with Client(kev.app) as other:
        other.refresh()
        assert send(other, "POST", f"/api/comment-threads/{tid}/resolve", None,
                    links["comment"]).status_code == 403  # fmt: skip
        # An editor can.
        r = send(other, "POST", f"/api/comment-threads/{tid}/resolve", None, links["edit"])
        assert r.status_code == 200
        assert r.json()["thread"]["resolved"] is True
        assert r.json()["thread"]["resolved_by"] == "Guest"

    reopened = send(sam, "POST", f"/api/comment-threads/{tid}/reopen", None, links["comment"])
    assert reopened.json()["thread"]["resolved"] is False
    assert reopened.json()["thread"]["resolved_by"] is None
    assert (
        send(kev, "POST", f"/api/comment-threads/{tid}/resolve").json()["thread"]["resolved_by"]
        == "kev"
    )


def test_revoking_the_link_ends_commenting(shared_note):
    kev, sam, anon, note, links = shared_note
    thread = start(anon, note, token=links["comment"]).json()["thread"]
    shares = kev.get(f"/api/files/{note['id']}/shares").json()["links"]
    comment_link = next(link for link in shares if link["token"] == links["comment"])
    send(kev, "DELETE", f"/api/files/{note['id']}/shares/{comment_link['id']}")
    r = send(anon, "POST", f"/api/comment-threads/{thread['id']}/replies", {"body": "x"},
             links["comment"])  # fmt: skip
    assert r.status_code == 404


def test_comments_need_csrf(shared_note):
    kev, sam, anon, note, links = shared_note
    r = anon.post(
        f"/api/files/{note['id']}/comments",
        json={"body": "x"},
        headers={"X-Share-Token": links["comment"]},
    )
    assert r.status_code == 403


def test_anonymous_commenting_is_rate_limited(shared_note):
    kev, sam, anon, note, links = shared_note
    codes = [start(anon, note, token=links["comment"]).status_code for _ in range(31)]
    assert codes[:30] == [200] * 30
    assert codes[30] == 429
