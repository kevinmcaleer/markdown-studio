"""Google sign-in (OAuth 2.0) and the few Drive calls Google Docs sync needs.

Google Docs reads and writes Markdown itself: uploading ``text/markdown``
into a Google Doc converts it, and exporting a Doc as ``text/markdown``
converts it back. So sync never has to understand the Docs document model.

The scope is ``drive.file``: Markdown Studio can only see the Docs it created,
never the rest of someone's Drive. It also keeps Google's app review light.

Set ``GOOGLE_CLIENT_ID`` and ``GOOGLE_CLIENT_SECRET`` to turn this on (see the
README). Without them the Google options simply don't appear.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 (a URL)
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
DRIVE_URL = "https://www.googleapis.com/drive/v3/files"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
SCOPES = "openid email https://www.googleapis.com/auth/drive.file"
DOC_TYPE = "application/vnd.google-apps.document"
FIELDS = "id,name,version,webViewLink,trashed"
TIMEOUT = 30.0


class GoogleError(Exception):
    """A Google call failed. ``reconnect`` means the user must sign in to Google again."""

    def __init__(self, message: str, reconnect: bool = False, missing: bool = False) -> None:
        super().__init__(message)
        self.reconnect = reconnect
        self.missing = missing


@dataclass(frozen=True)
class Tokens:
    access_token: str
    expires_at: float
    refresh_token: str | None = None


@dataclass(frozen=True)
class RemoteDoc:
    id: str
    url: str
    version: str


class Google:
    """Talks to Google for one app (client id and secret).

    ``transport`` is for tests: an ``httpx.MockTransport`` stands in for Google.
    """

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self.transport, timeout=TIMEOUT)

    # ----------------------------------------------------------- sign in

    def authorize_url(self, redirect_uri: str, state: str) -> str:
        return (
            AUTH_URL
            + "?"
            + urlencode(
                {
                    "client_id": self.client_id,
                    "redirect_uri": redirect_uri,
                    "response_type": "code",
                    "scope": SCOPES,
                    "state": state,
                    # A refresh token, so sync keeps working while nobody is signed in.
                    "access_type": "offline",
                    "prompt": "consent",
                    "include_granted_scopes": "true",
                }
            )
        )

    async def exchange(self, code: str, redirect_uri: str) -> tuple[Tokens, str]:
        """Swap the code from the sign-in redirect for tokens, plus the account's email."""
        tokens = await self._token(
            {"code": code, "redirect_uri": redirect_uri, "grant_type": "authorization_code"}
        )
        if not tokens.refresh_token:
            raise GoogleError("Google didn't hand out offline access. Try connecting again.")
        async with self._client() as client:
            response = await client.get(
                USERINFO_URL, headers={"Authorization": f"Bearer {tokens.access_token}"}
            )
        email = response.json().get("email", "") if response.is_success else ""
        return tokens, email

    async def refresh(self, refresh_token: str) -> Tokens:
        return await self._token({"refresh_token": refresh_token, "grant_type": "refresh_token"})

    async def revoke(self, token: str) -> None:
        async with self._client() as client:
            # Best effort: the token may already be dead, which is fine.
            await client.post(REVOKE_URL, data={"token": token})

    async def _token(self, form: dict[str, str]) -> Tokens:
        form = {**form, "client_id": self.client_id, "client_secret": self.client_secret}
        async with self._client() as client:
            response = await client.post(TOKEN_URL, data=form)
        data = _json(response)
        if not response.is_success:
            # invalid_grant: revoked, expired, or the password changed.
            reconnect = data.get("error") in {"invalid_grant", "unauthorized_client"}
            raise GoogleError(
                "Google refused the sign-in. Reconnect your Google account."
                if reconnect
                else f"Google sign-in failed ({response.status_code}).",
                reconnect=reconnect,
            )
        return Tokens(
            access_token=data["access_token"],
            expires_at=time.time() + float(data.get("expires_in", 3600)),
            refresh_token=data.get("refresh_token"),
        )

    # ------------------------------------------------------------ Docs

    async def create_doc(self, token: str, name: str, markdown: str) -> RemoteDoc:
        """A new Google Doc holding ``markdown``."""
        boundary = "markdown-studio-boundary"
        metadata = json.dumps({"name": name, "mimeType": DOC_TYPE})
        body = (
            f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n"
            f"--{boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n{markdown}\r\n"
            f"--{boundary}--\r\n"
        ).encode()
        response = await self._call(
            token,
            "POST",
            UPLOAD_URL,
            params={"uploadType": "multipart", "fields": FIELDS},
            content=body,
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
        )
        return _doc(_json(response))

    async def update_doc(self, token: str, doc_id: str, markdown: str) -> RemoteDoc:
        """Replace the Doc's contents with ``markdown``."""
        response = await self._call(
            token,
            "PATCH",
            f"{UPLOAD_URL}/{doc_id}",
            params={"uploadType": "media", "fields": FIELDS},
            content=markdown.encode(),
            headers={"Content-Type": "text/markdown; charset=UTF-8"},
        )
        return _doc(_json(response))

    async def doc_info(self, token: str, doc_id: str) -> RemoteDoc:
        response = await self._call(
            token, "GET", f"{DRIVE_URL}/{doc_id}", params={"fields": FIELDS}
        )
        data = _json(response)
        if data.get("trashed"):
            raise GoogleError("The Google Doc is in the bin.", missing=True)
        return _doc(data)

    async def export_markdown(self, token: str, doc_id: str) -> str:
        response = await self._call(
            token, "GET", f"{DRIVE_URL}/{doc_id}/export", params={"mimeType": "text/markdown"}
        )
        return response.content.decode("utf-8", errors="replace")

    async def _call(self, token: str, method: str, url: str, **kwargs) -> httpx.Response:
        headers = {"Authorization": f"Bearer {token}", **kwargs.pop("headers", {})}
        try:
            async with self._client() as client:
                response = await client.request(method, url, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise GoogleError("Couldn't reach Google. Sync will try again later.") from exc
        if response.status_code == 401:
            raise GoogleError(
                "Google signed Markdown Studio out. Reconnect your Google account.", reconnect=True
            )
        if response.status_code == 404:
            raise GoogleError("The Google Doc was deleted, or you lost access to it.", missing=True)
        if not response.is_success:
            message = _json(response).get("error", {})
            detail = message.get("message", "") if isinstance(message, dict) else ""
            raise GoogleError(f"Google Docs said no ({response.status_code}). {detail}".strip())
        return response


def _json(response: httpx.Response) -> dict:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _doc(data: dict) -> RemoteDoc:
    doc_id = data.get("id", "")
    return RemoteDoc(
        id=doc_id,
        url=data.get("webViewLink") or f"https://docs.google.com/document/d/{doc_id}/edit",
        version=str(data.get("version", "")),
    )
