"""Password hashing, session tokens, CSRF tokens, rate limiting and security headers.

Lifted unchanged from mermaid-factory's ``app/security.py``.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_PASSWORD_LENGTH = 12

_hasher = PasswordHasher()  # argon2id with the library's recommended parameters
# Used to keep login timing similar whether or not the username exists.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def password_problem(password: str) -> str | None:
    """Return a human-readable reason the password is unacceptable, or None."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > 1024:
        return "Password is too long."
    return None


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_digest(token: str) -> str:
    """Session tokens are stored hashed so a leaked DB cannot be replayed."""
    return hashlib.sha256(token.encode()).hexdigest()


def csrf_token(secret_key: str, binding: str) -> str:
    """CSRF token bound to the visitor's session (or anonymous) cookie."""
    return hmac.new(secret_key.encode(), f"csrf:{binding}".encode(), hashlib.sha256).hexdigest()


def csrf_valid(secret_key: str, binding: str | None, supplied: str | None) -> bool:
    if not binding or not supplied:
        return False
    return hmac.compare_digest(csrf_token(secret_key, binding), supplied)


class RateLimiter:
    """In-memory sliding-window limiter, keyed by e.g. client IP.

    Good enough for a single-process self-hosted app; it resets on restart.
    """

    def __init__(self, limit: int, window: float, clock=time.monotonic) -> None:
        self.limit = limit
        self.window = window
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str) -> tuple[bool, int]:
        """Record an attempt. Returns (allowed, seconds_until_retry)."""
        now = self._clock()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False, max(1, int(self.window - (now - hits[0])) + 1)
            hits.append(now)
            if len(self._hits) > 10_000:  # keep memory bounded
                for stale in [k for k, v in self._hits.items() if not v]:
                    del self._hits[stale]
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self'",
        # Mermaid injects <style> into each rendered SVG.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

SECURITY_HEADERS = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}
