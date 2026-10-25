"""Proofing and language tools for the Notes editor.

Spelling is checked in the browser (Hunspell dictionaries ship with the web
app), so it works offline. This module adds what can't live in the browser:

- Lookup: definitions from a local WordNet (see wordnet.py). Always on when
  the WordNet files are installed, which the Docker image does.
- Grammar: a LanguageTool server, when LANGUAGETOOL_URL is set.
- Translate: a LibreTranslate server, when LIBRETRANSLATE_URL is set.

Both remote services can run on the same home network, so nothing has to
leave it. Grammar and Translate need an account, so a public install can't be
used as a free proxy to them.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from powertools_auth import Auth

from .config import Settings
from .wordnet import WordNet

log = logging.getLogger(__name__)

LANGUAGES = {"en-GB", "en-US"}
MAX_CHECK = 20_000
MAX_TRANSLATE = 5_000
TIMEOUT = 20.0
# LanguageTool's spelling is left to the editor's own (Hunspell) check, and its
# style hints to the writing lint, so the two don't underline the same words.
DISABLED_CATEGORIES = "TYPOS,STYLE"
SKIPPED_ISSUES = {"misspelling", "style"}


class Segment(BaseModel):
    text: str | None = None
    markup: str | None = None
    interpretAs: str | None = None  # noqa: N815 (LanguageTool's own name)


class CheckRequest(BaseModel):
    language: str = "en-GB"
    # Prose and Markdown in order, so offsets in the answer match the note.
    annotation: list[Segment] = Field(default_factory=list)


class TranslateRequest(BaseModel):
    text: str
    target: str
    source: str = "auto"


class Language:
    """The services this server has, and the clients that reach them."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.languagetool_url = settings.languagetool_url
        self.libretranslate_url = settings.libretranslate_url
        self.libretranslate_key = settings.libretranslate_api_key
        self.wordnet = WordNet.open(settings.wordnet_dir)
        self.transport = transport
        self._languages: tuple[float, list[dict]] | None = None
        if settings.wordnet_dir and self.wordnet is None:
            log.warning("WordNet isn't at %s, so Lookup is off", settings.wordnet_dir)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=TIMEOUT, transport=self.transport)

    def features(self) -> dict[str, bool]:
        return {
            "lookup": self.wordnet is not None,
            "grammar": bool(self.languagetool_url),
            "translate": bool(self.libretranslate_url),
        }

    async def check(self, body: CheckRequest) -> list[dict]:
        data = {"annotation": [s.model_dump(exclude_none=True) for s in body.annotation]}
        async with self.client() as client:
            response = await client.post(
                f"{self.languagetool_url}/v2/check",
                data={
                    "language": body.language,
                    "data": json.dumps(data),
                    "disabledCategories": DISABLED_CATEGORIES,
                },
            )
        response.raise_for_status()
        matches = []
        for m in response.json().get("matches", []):
            rule = m.get("rule") or {}
            if rule.get("issueType") in SKIPPED_ISSUES:
                continue
            matches.append(
                {
                    "offset": m["offset"],
                    "length": m["length"],
                    "message": m.get("message", ""),
                    "short": m.get("shortMessage", ""),
                    "replacements": [r["value"] for r in m.get("replacements", [])[:5]],
                    "rule": rule.get("id", ""),
                }
            )
        return matches

    async def languages(self) -> list[dict]:
        # They only change when the LibreTranslate server's models do.
        if self._languages and time.monotonic() - self._languages[0] < 3600:
            return self._languages[1]
        async with self.client() as client:
            response = await client.get(f"{self.libretranslate_url}/languages")
        response.raise_for_status()
        languages = [{"code": lang["code"], "name": lang["name"]} for lang in response.json()]
        self._languages = (time.monotonic(), languages)
        return languages

    async def translate(self, body: TranslateRequest) -> dict:
        payload: dict[str, Any] = {
            "q": body.text,
            "source": body.source,
            "target": body.target,
            "format": "text",
        }
        if self.libretranslate_key:
            payload["api_key"] = self.libretranslate_key
        async with self.client() as client:
            response = await client.post(f"{self.libretranslate_url}/translate", json=payload)
        if response.status_code == 400:
            detail = response.json().get("error", "That translation isn't available.")
            raise HTTPException(status_code=400, detail=detail)
        response.raise_for_status()
        data = response.json()
        detected = data.get("detectedLanguage") or {}
        return {"text": data.get("translatedText", ""), "detected": detected.get("language")}


def make_router(auth: Auth, language: Language) -> APIRouter:
    router = APIRouter(tags=["language"])

    def unavailable(name: str) -> HTTPException:
        return HTTPException(status_code=503, detail=f"{name} isn't set up on this server.")

    async def upstream(call, name: str):
        try:
            return await call
        except httpx.HTTPError as exc:
            log.warning("%s request failed: %s", name, exc)
            detail = f"Couldn't reach the {name} server."
            raise HTTPException(status_code=502, detail=detail) from exc

    @router.get("/api/language")
    def features():
        """What the editor can offer here, besides spelling (which is always on)."""
        return language.features()

    @router.get("/api/language/define")
    def define(word: str):
        if language.wordnet is None:
            raise unavailable("The dictionary")
        entry = language.wordnet.define(word)
        if entry is None:
            raise HTTPException(status_code=404, detail="No definition found.")
        return entry

    @router.post("/api/language/check")
    async def check(body: CheckRequest, user=Depends(auth.require_user)):
        if not language.languagetool_url:
            raise unavailable("Grammar checking")
        if body.language not in LANGUAGES:
            raise HTTPException(status_code=400, detail="Unsupported language.")
        size = sum(len(s.text or "") + len(s.markup or "") for s in body.annotation)
        if size > MAX_CHECK:
            raise HTTPException(status_code=400, detail="That's too much text to check at once.")
        return {"matches": await upstream(language.check(body), "grammar")}

    @router.get("/api/language/translate/languages")
    async def languages(user=Depends(auth.require_user)):
        if not language.libretranslate_url:
            raise unavailable("Translation")
        return {"languages": await upstream(language.languages(), "translation")}

    @router.post("/api/language/translate")
    async def translate(body: TranslateRequest, user=Depends(auth.require_user)):
        if not language.libretranslate_url:
            raise unavailable("Translation")
        if not body.text.strip():
            return {"text": "", "detected": None}
        if len(body.text) > MAX_TRANSLATE:
            detail = "That's too much text to translate at once."
            raise HTTPException(status_code=400, detail=detail)
        return await upstream(language.translate(body), "translation")

    return router
