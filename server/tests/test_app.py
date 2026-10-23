from __future__ import annotations

import sqlite3

from conftest import Client

from studio import db


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["db"] == "ok"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_migrations_are_recorded_per_component(tmp_path):
    path = tmp_path / "studio.db"
    db.init_db(path)
    conn = sqlite3.connect(path)
    rows = conn.execute("SELECT component, version FROM schema_migrations").fetchall()
    assert ("auth", 1) in rows
    conn.close()
    conn = db.connect(path)
    assert db.migrate(conn) == []  # second run applies nothing
    conn.close()


def test_api_responses_are_not_cached(client):
    assert client.get("/api/auth/session").headers["Cache-Control"] == "no-store"


def test_powertools_list(client):
    data = client.get("/api/powertools").json()
    assert data["current"] == "markdown-studio"
    assert any(app["id"] == "mermaid-factory" for app in data["apps"])


def test_unknown_api_path_is_json_404(client):
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


def test_serves_single_page_app(app_factory, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Studio</title>")
    (dist / "assets" / "app-1234.js").write_text("console.log(1)")
    (dist / "manifest.webmanifest").write_text("{}")
    with Client(app_factory(STATIC_DIR=dist)) as c:
        assert "Studio" in c.get("/").text
        assert "Studio" in c.get("/notes/some/deep/link").text
        assert c.get("/assets/app-1234.js").text == "console.log(1)"
        assert c.get("/manifest.webmanifest").text == "{}"
        assert c.get("/../../etc/passwd").status_code in (200, 404)
        assert "root:" not in c.get("/../../etc/passwd").text
        assert c.get("/api/nope").status_code == 404
