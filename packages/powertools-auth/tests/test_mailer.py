from __future__ import annotations

import pytest

from powertools_auth import mailer as mailer_module
from powertools_auth.mailer import SmtpMailer


class FakeSMTP:
    instances: list[FakeSMTP] = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.context = host, port, context
        self.calls: list[str] = []
        self.sent = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.calls.append("quit")

    def starttls(self, context=None):
        self.calls.append("starttls")

    def login(self, username, password):
        self.calls.append(f"login:{username}")

    def send_message(self, msg):
        self.calls.append("send")
        self.sent.append(msg)


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSMTP.instances = []
    monkeypatch.setattr(mailer_module.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(mailer_module.smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP.instances


def test_starttls_with_login(fake_smtp):
    m = SmtpMailer(host="smtp.example.com", sender="Studio <s@example.com>", username="u")
    m.send("kev@example.com", "Hello", "Body text")
    (smtp,) = fake_smtp
    assert (smtp.host, smtp.port) == ("smtp.example.com", 587)
    assert smtp.calls == ["starttls", "login:u", "send", "quit"]
    msg = smtp.sent[0]
    assert msg["To"] == "kev@example.com" and msg["From"] == "Studio <s@example.com>"
    assert msg["Subject"] == "Hello" and "Body text" in msg.get_content()


def test_implicit_tls(fake_smtp):
    SmtpMailer(host="h", sender="s@example.com", port=465, security="ssl").send("a@b.c", "s", "b")
    assert fake_smtp[0].context is not None
    assert fake_smtp[0].calls == ["send", "quit"]


def test_plain_relay_without_login(fake_smtp):
    SmtpMailer(host="relay.lan", sender="s@example.com", port=25, security="none").send(
        "a@b.c", "s", "b"
    )
    assert fake_smtp[0].calls == ["send", "quit"]


def test_rejects_unknown_security():
    with pytest.raises(ValueError, match="security"):
        SmtpMailer(host="h", sender="s@example.com", security="tls")
