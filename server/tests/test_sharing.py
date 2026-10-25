from __future__ import annotations

import sqlite3

import pytest
from conftest import Client


def patch(client, url, body, **headers):
    return client.patch(url, json=body, headers={"X-CSRF-Token": client.csrf, **headers})


def delete(client, url):
    return client.delete(url, headers={"X-CSRF-Token": client.csrf})


@pytest.fixture
def two_users(app_factory):
    """Kev owns a note; Sam is another signed-in user; anon has no account."""
    app = app_factory()
    with Client(app) as kev, Client(app) as sam, Client(app) as anon:
        assert kev.register("kev").status_code == 200
        assert sam.register("sam").status_code == 200
        anon.refresh()
        note = kev.post_json("/api/files", {"name": "Plan", "content": "# Plan"}).json()["file"]
        yield kev, sam, anon, note


def make_link(kev, note, **body):
    response = kev.post_json(f"/api/files/{note['id']}/shares", body)
    assert response.status_code == 200, response.text
    return response.json()["link"]


def test_nobody_else_sees_an_unshared_file(two_users):
    kev, sam, anon, note = two_users
    assert sam.get(f"/api/files/{note['id']}").status_code == 404
    assert anon.get(f"/api/files/{note['id']}").status_code == 401
    assert sam.get(f"/api/files/{note['id']}/shares").status_code == 404


def test_links_use_public_url(app_factory):
    app = app_factory(PUBLIC_URL="https://studio.example.com/")
    with Client(app) as kev:
        assert kev.register("kev").status_code == 200
        note = kev.post_json("/api/files", {"name": "Plan", "content": "# Plan"}).json()["file"]
        link = make_link(kev, note, role="view")
        assert link["url"] == f"https://studio.example.com/s/{link['token']}"
        listed = kev.get(f"/api/files/{note['id']}/shares").json()["links"]
        assert [entry["url"] for entry in listed] == [link["url"]]


def test_anonymous_view_link(two_users):
    kev, sam, anon, note = two_users
    link = make_link(kev, note, role="view")
    assert link["path"] == f"/s/{link['token']}" and link["active"]
    assert link["url"] is None  # no PUBLIC_URL: the browser adds its own origin

    opened = anon.get(f"/api/s/{link['token']}").json()
    assert opened["role"] == "view"
    assert opened["file"] == {
        "id": note["id"],
        "name": "Plan.md",
        "owner": "kev",
        "updated_at": note["updated_at"],
    }

    headers = {"X-Share-Token": link["token"]}
    assert anon.get(f"/api/files/{note['id']}/content", headers=headers).text == "# Plan"
    assert anon.get(f"/api/files/{note['id']}/content?share={link['token']}").status_code == 200
    # View doesn't allow writing.
    response = anon.put(
        f"/api/files/{note['id']}/content",
        content=b"hacked",
        headers={**headers, "X-CSRF-Token": anon.csrf},
    )
    assert response.status_code == 403
    # A token for one file says nothing about another.
    other = kev.post_json("/api/files", {"name": "Secret"}).json()["file"]
    assert anon.get(f"/api/files/{other['id']}", headers=headers).status_code == 404


def test_edit_link_lets_visitors_write(two_users):
    kev, sam, anon, note = two_users
    link = make_link(kev, note, role="edit")
    headers = {"X-Share-Token": link["token"], "X-CSRF-Token": anon.csrf}
    response = anon.put(f"/api/files/{note['id']}/content", content=b"# New", headers=headers)
    assert response.status_code == 200
    assert kev.get(f"/api/files/{note['id']}/content").text == "# New"
    # But only the owner renames or deletes.
    assert patch(anon, f"/api/files/{note['id']}", {"name": "x"}, **headers).status_code in {
        401,
        403,
    }


def test_signed_in_only_link(two_users):
    kev, sam, anon, note = two_users
    link = make_link(kev, note, role="comment", anonymous=False)
    assert anon.get(f"/api/s/{link['token']}").status_code == 401
    headers = {"X-Share-Token": link["token"]}
    assert anon.get(f"/api/files/{note['id']}", headers=headers).status_code == 404
    assert sam.get(f"/api/s/{link['token']}").json()["role"] == "comment"


def test_opened_links_show_in_shared_with_me_until_revoked(two_users):
    kev, sam, anon, note = two_users
    link = make_link(kev, note, role="view")
    assert sam.get("/api/shared-with-me").json()["files"] == []
    sam.get(f"/api/s/{link['token']}")
    shared = sam.get("/api/shared-with-me").json()["files"]
    assert [(f["id"], f["role"], f["owner"]) for f in shared] == [(note["id"], "view", "kev")]
    # Sam can come back without the token.
    assert sam.get(f"/api/files/{note['id']}").json()["role"] == "view"
    # The owner opening their own link doesn't add it to anything.
    kev.get(f"/api/s/{link['token']}")
    assert kev.get("/api/shared-with-me").json()["files"] == []

    assert delete(kev, f"/api/files/{note['id']}/shares/{link['id']}").status_code == 200
    assert sam.get("/api/shared-with-me").json()["files"] == []
    assert sam.get(f"/api/files/{note['id']}").status_code == 404
    assert anon.get(f"/api/s/{link['token']}").status_code == 404
    assert kev.get(f"/api/files/{note['id']}/shares").json()["links"] == []


def test_change_link_role(two_users):
    kev, sam, anon, note = two_users
    link = make_link(kev, note, role="view")
    url = f"/api/files/{note['id']}/shares/{link['id']}"
    updated = patch(kev, url, {"role": "edit", "anonymous": False}).json()["link"]
    assert updated["role"] == "edit" and updated["anonymous"] is False
    assert anon.get(f"/api/s/{link['token']}").status_code == 401
    assert patch(sam, url, {"role": "view"}).status_code == 404
    assert patch(kev, url, {"role": "owner"}).status_code == 422


def test_link_expiry(two_users):
    kev, sam, anon, note = two_users
    assert (
        kev.post_json(f"/api/files/{note['id']}/shares", {"expires_in_days": 0}).status_code == 400
    )
    link = make_link(kev, note, role="view", expires_in_days=7)
    assert link["expires_at"] is not None
    assert anon.get(f"/api/s/{link['token']}").status_code == 200
    # Expire it in the database and the link stops working.
    db = sqlite3.connect(kev.app.state.settings.database_path)
    db.execute("UPDATE share_links SET expires_at = '2000-01-01T00:00:00.000Z'")
    db.commit()
    db.close()
    assert anon.get(f"/api/s/{link['token']}").status_code == 404
    assert (
        anon.get(f"/api/files/{note['id']}", headers={"X-Share-Token": link["token"]}).status_code
        == 404
    )
    listed = kev.get(f"/api/files/{note['id']}/shares").json()["links"]
    assert listed[0]["active"] is False


def test_share_with_a_named_user(two_users):
    kev, sam, anon, note = two_users
    url = f"/api/files/{note['id']}/members"
    assert kev.post_json(url, {"username": "nobody"}).status_code == 404
    assert kev.post_json(url, {"username": "kev"}).status_code == 400
    shares = kev.post_json(url, {"username": "SAM", "role": "edit"}).json()
    assert [(m["username"], m["role"]) for m in shares["members"]] == [("sam", "edit")]
    assert sam.get(f"/api/files/{note['id']}").json()["role"] == "edit"
    assert sam.get("/api/shared-with-me").json()["files"][0]["role"] == "edit"
    # Changing the role replaces it.
    kev.post_json(url, {"username": "sam", "role": "view"})
    assert sam.get(f"/api/files/{note['id']}").json()["role"] == "view"
    # A link with a higher role wins while it's used.
    link = make_link(kev, note, role="comment")
    role = sam.get(f"/api/files/{note['id']}", headers={"X-Share-Token": link["token"]})
    assert role.json()["role"] == "comment"

    sam_id = shares["members"][0]["user_id"]
    assert delete(kev, f"{url}/{sam_id}").json()["members"] == []
    assert sam.get(f"/api/files/{note['id']}").status_code == 404
    # Only the owner manages members.
    assert sam.post_json(url, {"username": "sam", "role": "edit"}).status_code == 404


def test_deleting_the_file_removes_its_links(two_users):
    kev, sam, anon, note = two_users
    link = make_link(kev, note)
    assert delete(kev, f"/api/files/{note['id']}").status_code == 200
    assert anon.get(f"/api/s/{link['token']}").status_code == 404
