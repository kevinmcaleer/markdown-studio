from __future__ import annotations

from conftest import Client


def put(client, url, data: bytes, **kwargs):
    return client.put(url, content=data, headers={"X-CSRF-Token": client.csrf}, **kwargs)


def patch(client, url, body):
    return client.patch(url, json=body, headers={"X-CSRF-Token": client.csrf})


def delete(client, url):
    return client.delete(url, headers={"X-CSRF-Token": client.csrf})


def upload(client, name, data: bytes, folder_id=None):
    params = {"name": name}
    if folder_id is not None:
        params["folder_id"] = folder_id
    return client.post(
        "/api/files/upload", params=params, content=data, headers={"X-CSRF-Token": client.csrf}
    )


def test_files_need_sign_in(client):
    assert client.get("/api/files").status_code == 401
    assert client.get("/api/files/1").status_code == 401


def test_create_note_and_read_it_back(user_client):
    c = user_client
    response = c.post_json("/api/files", {"name": "Ideas", "content": "# Hello"})
    assert response.status_code == 200
    file = response.json()["file"]
    assert file["name"] == "Ideas.md"
    assert file["mime_type"] == "text/markdown"
    assert file["size"] == 7
    content = c.get(f"/api/files/{file['id']}/content")
    assert content.text == "# Hello"
    assert content.headers["content-type"].startswith("text/markdown")
    info = c.get(f"/api/files/{file['id']}").json()
    assert info["role"] == "owner"


def test_folders_tree_rename_move_and_delete(user_client):
    c = user_client
    work = c.post_json("/api/folders", {"name": "Work"}).json()["folder"]
    sub = c.post_json("/api/folders", {"name": "Plans", "parent_id": work["id"]}).json()["folder"]
    note = c.post_json("/api/files", {"name": "a.md", "folder_id": sub["id"]}).json()["file"]

    tree = c.get("/api/files").json()
    assert {f["name"] for f in tree["folders"]} == {"Work", "Plans"}
    assert tree["files"][0]["folder_id"] == sub["id"]
    assert "content" not in tree["files"][0]

    # A folder can't move inside itself or its own children.
    assert (
        patch(c, f"/api/folders/{work['id']}", {"parent_id": sub["id"], "move": True}).status_code
        == 422
    )
    moved = patch(
        c, f"/api/folders/{sub['id']}", {"parent_id": None, "move": True, "name": "Later"}
    )
    assert moved.status_code == 200
    assert moved.json()["folder"] == {**moved.json()["folder"], "parent_id": None, "name": "Later"}

    renamed = patch(
        c, f"/api/files/{note['id']}", {"name": "b.txt", "folder_id": work["id"], "move": True}
    )
    assert renamed.json()["file"]["mime_type"] == "text/plain"
    assert renamed.json()["file"]["folder_id"] == work["id"]

    assert delete(c, f"/api/folders/{work['id']}").status_code == 200
    tree = c.get("/api/files").json()
    assert [f["name"] for f in tree["folders"]] == ["Later"]
    assert tree["files"] == []


def test_names_are_unique_per_folder(user_client):
    c = user_client
    assert c.post_json("/api/folders", {"name": "Work"}).status_code == 200
    assert c.post_json("/api/folders", {"name": "work"}).status_code == 409
    first = c.post_json("/api/files", {"name": "note.md"}).json()["file"]
    second = c.post_json("/api/files", {"name": "Note.md"}).json()["file"]
    assert second["name"] == "Note (2).md"
    assert patch(c, f"/api/files/{second['id']}", {"name": "NOTE.md"}).status_code == 409
    assert patch(c, f"/api/files/{first['id']}", {"name": "a/b"}).status_code == 422
    assert c.post_json("/api/folders", {"name": "  "}).status_code == 422


def test_upload_download_and_replace(user_client):
    c = user_client
    png = b"\x89PNG\r\n\x1a\n" + bytes(range(256))
    file = upload(c, "pic.png", png).json()["file"]
    assert file["mime_type"] == "image/png"
    assert file["size"] == len(png)
    got = c.get(f"/api/files/{file['id']}/content?download=1")
    assert got.content == png
    assert got.headers["content-disposition"] == "attachment; filename*=UTF-8''pic.png"
    assert "sandbox" in got.headers["content-security-policy"]

    note = upload(c, "draft.md", b"one").json()["file"]
    assert put(c, f"/api/files/{note['id']}/content", b"two").json()["file"]["size"] == 3
    assert c.get(f"/api/files/{note['id']}/content").text == "two"


def test_upload_limit(app_factory):
    with Client(app_factory(MAX_UPLOAD_MB=1)) as c:
        c.register()
        assert upload(c, "big.bin", b"x" * (1024 * 1024 + 1)).status_code == 413


def test_other_users_cannot_see_files(app_factory):
    app = app_factory()
    with Client(app) as kev, Client(app) as other:
        kev.register("kev")
        other.register("other")
        note = kev.post_json("/api/files", {"name": "secret.md", "content": "shh"}).json()["file"]
        folder = kev.post_json("/api/folders", {"name": "Private"}).json()["folder"]
        assert other.get(f"/api/files/{note['id']}").status_code == 404
        assert other.get(f"/api/files/{note['id']}/content").status_code == 404
        assert put(other, f"/api/files/{note['id']}/content", b"x").status_code == 404
        assert delete(other, f"/api/files/{note['id']}").status_code == 404
        assert delete(other, f"/api/folders/{folder['id']}").status_code == 404
        assert (
            other.post_json("/api/files", {"name": "x", "folder_id": folder["id"]}).status_code
            == 404
        )
        assert other.get("/api/files").json() == {"folders": [], "files": []}


def test_writes_need_csrf(user_client):
    response = user_client.post("/api/files", json={"name": "x"})
    assert response.status_code == 403
