"""Sending email over SMTP, for password reset links.

Any SMTP server works: a mail provider's relay (Fastmail, Gmail with an app
password, SendGrid, Mailgun, Amazon SES...) or a relay on the home network.
"""

from __future__ import annotations

import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Protocol

SECURITY_MODES = ("starttls", "ssl", "none")


class Mailer(Protocol):
    def send(self, to: str, subject: str, body: str) -> None: ...


@dataclass(frozen=True)
class SmtpMailer:
    host: str
    sender: str  # "Markdown Studio <studio@example.com>" or a bare address
    port: int = 587
    username: str = ""
    password: str = ""
    # "starttls" (usually port 587), "ssl" (implicit TLS, usually 465) or "none"
    # (plain SMTP, only for a relay on a trusted network).
    security: str = "starttls"
    timeout: float = 15

    def __post_init__(self) -> None:
        if self.security not in SECURITY_MODES:
            raise ValueError(f"security must be one of {', '.join(SECURITY_MODES)}")

    def message(self, to: str, subject: str, body: str) -> EmailMessage:
        msg = EmailMessage()
        msg["From"] = self.sender
        msg["To"] = to
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=False)
        msg["Message-ID"] = make_msgid()
        msg.set_content(body)
        return msg

    def send(self, to: str, subject: str, body: str) -> None:
        msg = self.message(to, subject, body)
        context = ssl.create_default_context()
        if self.security == "ssl":
            smtp = smtplib.SMTP_SSL(self.host, self.port, timeout=self.timeout, context=context)
        else:
            smtp = smtplib.SMTP(self.host, self.port, timeout=self.timeout)
        with smtp:
            if self.security == "starttls":
                smtp.starttls(context=context)
            if self.username:
                smtp.login(self.username, self.password)
            smtp.send_message(msg)
