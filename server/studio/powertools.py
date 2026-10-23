"""The switcher to Kev's other Power Tools.

The landing page serves the one app list every app shares, at ``POWERTOOLS_APPS_URL``.
The server reads it at most every few minutes and falls back to the copy in
``powertools.json`` when it can't, so the switcher never needs the browser to fetch
anything and the Content-Security-Policy stays ``connect-src 'self'``.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

log = logging.getLogger("markdown_studio")

CURRENT_APP_ID = "markdown-studio"
HOME_URL = "https://kevspowertools.com/"
DEFAULT_APPS_URL = f"{HOME_URL}apps.json"
CACHE_SECONDS = 300
TIMEOUT_SECONDS = 2


@dataclass(frozen=True)
class PowerToolApp:
    id: str
    name: str
    url: str
    description: str = ""
    # "soon" for an app that isn't open yet: listed, but not a link.
    status: str = "live"


def _allowed_url(value: str) -> bool:
    """Only https addresses on kevspowertools.com, so a bad list can't send anyone elsewhere."""
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    host = parts.hostname or ""
    return parts.scheme == "https" and (
        host == "kevspowertools.com" or host.endswith(".kevspowertools.com")
    )


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_apps(data: Any) -> list[PowerToolApp]:
    """The well-formed entries of a list, with allowed addresses; empty when none are left."""
    entries = data.get("apps") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return []
    apps: list[PowerToolApp] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        app_id, name, url = (
            _text(entry.get("id")),
            _text(entry.get("name")),
            _text(entry.get("url")),
        )
        if not (app_id and name and url and _allowed_url(url)) or any(a.id == app_id for a in apps):
            continue
        # Anything but "soon" counts as live, so a status added later never hides an app.
        status = "soon" if entry.get("status") == "soon" else "live"
        apps.append(PowerToolApp(app_id, name, url, _text(entry.get("description")), status))
    return apps


BUNDLED_APPS = parse_apps(
    json.loads((Path(__file__).parent / "powertools.json").read_text(encoding="utf-8"))
)


def fetch_json(url: str) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})  # noqa: S310 (a fixed https URL from settings)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310
        return json.loads(response.read(64 * 1024))


class PowerTools:
    """The shared app list, cached; the bundled copy when it's off, unreachable or nonsense."""

    def __init__(
        self,
        url: str = DEFAULT_APPS_URL,
        fetch: Callable[[str], Any] = fetch_json,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.url = url
        self._fetch = fetch
        self._clock = clock
        self._lock = threading.Lock()
        self._apps = BUNDLED_APPS
        self._expires = float("-inf")

    def apps(self) -> list[PowerToolApp]:
        if not self.url:
            return BUNDLED_APPS
        with self._lock:
            if self._clock() < self._expires:
                return self._apps
            try:
                fetched = parse_apps(self._fetch(self.url))
            except Exception as exc:  # noqa: BLE001 (any failure means: use the copy we have)
                log.info("power tools list unavailable", extra={"error": str(exc)})
                fetched = []
            self._apps = fetched or BUNDLED_APPS
            # A failure is cached too, so a down landing page costs one timeout per period.
            self._expires = self._clock() + CACHE_SECONDS
            return self._apps
