from __future__ import annotations

import re

import pytest
from conftest import PASSWORD, Client, make_settings

from studio.config import ConfigError, load_settings
from studio.main import create_app

NEW_PASSWORD = "a brand new passphrase"
SMTP = {
    "SMTP_HOST": "smtp.example.com",
    "SMTP_FROM": "Markdown Studio <studio@example.com>",
    "PUBLIC_URL": "https://studio.example.com/",
}


class Outbox:
    def __init__(self):
        self.messages: list[tuple[str, str, str]] = []

    def send(self, to, subject, body):
        self.messages.append((to, subject, body))

    def token(self) -> str:
        return re.search(r"#token=(\S+)", self.messages[-1][2]).group(1)


@pytest.fixture
def mail_app(tmp_path):
    app = create_app(make_settings(tmp_path, **SMTP))
    app.state.outbox = app.state.auth.mailer = Outbox()
    return app


def forgot(client: Client, login: str):
    if not client.csrf:
        client.refresh()
    return client.post_json("/api/auth/forgot-password", {"login": login})


def test_disabled_without_smtp(client):
    assert client.refresh()["password_reset"] is False
    response = forgot(client, "kev")
    assert response.status_code == 404
    assert "reset your password" in response.json()["detail"]


def test_full_reset_flow(mail_app):
    outbox = mail_app.state.outbox
    with Client(mail_app) as laptop, Client(mail_app) as phone:
        laptop.register(email="kev@example.com")
        assert laptop.refresh()["password_reset"] is True

        assert forgot(phone, "kev@example.com").json() == {"ok": True}
        to, subject, body = outbox.messages[0]
        assert to == "kev@example.com"
        assert subject == "Reset your Markdown Studio password"
        assert "https://studio.example.com/reset-password#token=" in body
        assert "Hi kev" in body and "60 minutes" in body

        response = phone.post_json(
            "/api/auth/reset-password", {"token": outbox.token(), "password": NEW_PASSWORD}
        )
        assert response.status_code == 200
        assert response.json()["user"]["username"] == "kev"
        assert phone.refresh()["user"]["username"] == "kev"
        assert laptop.refresh()["user"] is None  # every other session ended

        again = phone.post_json(
            "/api/auth/reset-password", {"token": outbox.token(), "password": "yet another pass"}
        )
        assert again.status_code == 400
        assert "expired" in again.json()["detail"]
        assert phone.login(password=NEW_PASSWORD).status_code == 200


def test_unknown_account_gets_same_answer_and_no_email(mail_app):
    with Client(mail_app) as c:
        c.register()  # no email address
        assert forgot(c, "kev").json() == {"ok": True}
        assert forgot(c, "nobody").json() == {"ok": True}
        assert forgot(c, "nobody@example.com").json() == {"ok": True}
        assert forgot(c, "").json() == {"ok": True}
    assert mail_app.state.outbox.messages == []


def test_one_email_per_minute_per_user(mail_app):
    with Client(mail_app) as c:
        c.register(email="kev@example.com")
        forgot(c, "kev")
        forgot(c, "kev")
    assert len(mail_app.state.outbox.messages) == 1


def test_reset_validates_password_and_token(mail_app):
    with Client(mail_app) as c:
        c.register(email="kev@example.com")
        forgot(c, "kev")
        short = c.post_json(
            "/api/auth/reset-password", {"token": mail_app.state.outbox.token(), "password": "x"}
        )
        assert short.status_code == 400 and "at least" in short.json()["detail"]
        bogus = c.post_json("/api/auth/reset-password", {"token": "nope", "password": NEW_PASSWORD})
        assert bogus.status_code == 400


def test_reset_is_rate_limited(tmp_path):
    app = create_app(make_settings(tmp_path, LOGIN_RATE_LIMIT=2, **SMTP))
    app.state.auth.mailer = Outbox()
    with Client(app) as c:
        assert forgot(c, "a").status_code == 200
        assert forgot(c, "b").status_code == 200
        assert forgot(c, "c").status_code == 429


def test_mail_failure_is_logged_not_raised(mail_app, caplog):
    class Broken:
        def send(self, *args):
            raise OSError("connection refused")

    mail_app.state.auth.mailer = Broken()
    with Client(mail_app) as c:
        c.register(email="kev@example.com")
        assert forgot(c, "kev").status_code == 200
    assert "couldn't send the password reset email" in caplog.text


def test_change_email_needs_password(user_client):
    bad = user_client.post_json(
        "/api/auth/email", {"email": "kev@example.com", "current_password": "wrong password!"}
    )
    assert bad.status_code == 400
    ok = user_client.post_json(
        "/api/auth/email", {"email": "kev@example.com", "current_password": PASSWORD}
    )
    assert ok.status_code == 200
    assert ok.json()["user"]["email"] == "kev@example.com"
    assert user_client.refresh()["user"]["email"] == "kev@example.com"


def base_env(tmp_path, **extra):
    env = {"DATABASE_PATH": str(tmp_path / "studio.db"), "SECRET_KEY": "x" * 40}
    env.update(extra)
    return env


def test_smtp_settings(tmp_path):
    s = load_settings(base_env(tmp_path, **SMTP, SMTP_SECURITY="SSL"))
    assert (s.smtp_host, s.smtp_port, s.smtp_security) == ("smtp.example.com", 465, "ssl")
    assert s.public_url == "https://studio.example.com"
    assert load_settings(base_env(tmp_path, **SMTP)).smtp_port == 587


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ({"SMTP_HOST": "h", "PUBLIC_URL": "https://x"}, "SMTP_FROM"),
        ({"SMTP_HOST": "h", "SMTP_FROM": "a@b.c"}, "PUBLIC_URL"),
        ({"PUBLIC_URL": "studio.local"}, "PUBLIC_URL"),
        ({**SMTP, "SMTP_SECURITY": "tls"}, "SMTP_SECURITY"),
    ],
)
def test_smtp_config_errors(tmp_path, extra, message):
    with pytest.raises(ConfigError, match=message):
        load_settings(base_env(tmp_path, **extra))
