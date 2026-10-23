from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from studio.config import load_settings
from studio.main import create_app

PASSWORD = "correct horse battery"


def make_settings(tmp_path, **overrides):
    env = {
        "APP_ENV": "test",
        "SECRET_KEY": "test-secret-key-that-is-long-enough-0123456789",
        "DATABASE_PATH": str(tmp_path / "data" / "studio.db"),
        "LOG_LEVEL": "WARNING",
        "LOGIN_RATE_LIMIT": "1000",
        # Tests never reach the landing page; the switcher uses its bundled list.
        "POWERTOOLS_APPS_URL": "",
    }
    env.update({k: str(v) for k, v in overrides.items()})
    return load_settings(env)


class Client(TestClient):
    """A browser-like client that keeps the CSRF token the API hands out."""

    csrf: str = ""

    def refresh(self) -> dict:
        data = self.get("/api/auth/session").json()
        self.csrf = data["csrf_token"]
        return data

    def post_json(self, url: str, body: dict | None = None, **kwargs):
        response = self.post(url, json=body or {}, headers={"X-CSRF-Token": self.csrf}, **kwargs)
        token = response.json().get("csrf_token") if response.content else None
        if token:
            self.csrf = token
        return response

    def register(self, username="kev", password=PASSWORD, email=""):
        if not self.csrf:
            self.refresh()
        return self.post_json(
            "/api/auth/register", {"username": username, "password": password, "email": email}
        )

    def login(self, username="kev", password=PASSWORD, remember=False):
        if not self.csrf:
            self.refresh()
        return self.post_json(
            "/api/auth/login", {"username": username, "password": password, "remember": remember}
        )


@pytest.fixture
def app_factory(tmp_path):
    def factory(**overrides):
        return create_app(make_settings(tmp_path, **overrides))

    return factory


@pytest.fixture
def client(app_factory):
    with Client(app_factory()) as c:
        yield c


@pytest.fixture
def user_client(client):
    assert client.register().status_code == 200
    return client
