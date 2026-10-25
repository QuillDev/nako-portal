"""The portal's web server: the app, its passkey login, a REST API for actions and a WebSocket for live events."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import WSMsgType, web

from . import webauthn
from .rpc import RpcError

log = logging.getLogger("hermes.portal")

CHALLENGE_TTL = 300
MEDIA = re.compile(r"(?m)^MEDIA:(/[^\r\n]+)$")
MAX_FILE = 25 * 1024 * 1024
MAX_BODY = 60 * 1024 * 1024
SESSION_ID = re.compile(r"^[\w.-]{1,120}$")
CSP = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)


class Portal:
    def __init__(self, hub, store, *, origin, web_root, rp_name="Hermes Portal", vapid=None, clock=time.time):
        self.vapid = vapid
        parsed = urlparse(origin)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("origin must be an http(s) URL")
        self.hub = hub
        self.store = store
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.rp_id = parsed.hostname
        self.rp_name = rp_name
        self.web_root = Path(web_root).resolve()
        self.clock = clock
        self.challenges = {}
        # __Host- cookies need https; plain http is only ever a local test.
        self.cookie = "__Host-portal" if parsed.scheme == "https" else "portal"
        self.secure = parsed.scheme == "https"

    # Plumbing

    def app(self):
        app = web.Application(client_max_size=MAX_BODY, middlewares=[self._guard])
        r = app.router
        r.add_get("/api/me", self.me)
        r.add_post("/api/register/options", self.register_options)
        r.add_post("/api/register/finish", self.register_finish)
        r.add_post("/api/login/options", self.login_options)
        r.add_post("/api/login/finish", self.login_finish)
        r.add_post("/api/logout", self.logout)
        r.add_get("/api/passkeys", self.passkeys)
        r.add_post("/api/passkeys/{id}/remove", self.remove_passkey)
        r.add_get("/api/sessions", self.sessions)
        r.add_post("/api/sessions", self.create)
        r.add_get("/api/sessions/{session}", self.open)
        r.add_post("/api/sessions/{session}/messages", self.send)
        r.add_post("/api/sessions/{session}/stop", self.stop)
        r.add_post("/api/sessions/{session}/archive", self.archive)
        r.add_post("/api/sessions/{session}/pin", self.pin)
        r.add_post("/api/sessions/{session}/title", self.title)
        r.add_post("/api/requests/{request}", self.answer)
        r.add_get("/api/file", self.file)
        r.add_get("/api/inbox", self.inbox)
        r.add_get("/api/push/key", self.push_key)
        r.add_post("/api/push/subscribe", self.push_subscribe)
        r.add_get("/ws", self.socket)
        r.add_get("/{path:.*}", self.static)
        return app

    @web.middleware
    async def _guard(self, request, handler):
        # Cross-site requests never reach an action: every write and the socket must come from our own page.
        unsafe = request.method not in {"GET", "HEAD"} or request.path == "/ws"
        if unsafe and request.headers.get("Origin") != self.origin:
            return web.json_response({"error": "bad origin"}, status=403)
        try:
            response = await handler(request)
        except web.HTTPException as error:
            self._secure(request, error)
            raise
        except (ValueError, RpcError) as error:
            response = web.json_response({"error": str(error)}, status=400)
        except ConnectionError:
            response = web.json_response({"error": "Hermes is offline right now"}, status=503)
        self._secure(request, response)
        return response

    @staticmethod
    def _secure(request, response):
        response.headers.setdefault("Content-Security-Policy", CSP)
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Robots-Tag", "noindex, nofollow, noarchive")
        if request.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")

    def _signed_in(self, request):
        return self.store.login(request.cookies.get(self.cookie))

    def _require(self, request):
        credential = self._signed_in(request)
        if credential is None:
            raise web.HTTPUnauthorized(text=json.dumps({"error": "sign in"}), content_type="application/json")
        return credential

    def _set_login(self, response, credential_id):
        token = self.store.start_login(credential_id)
        response.set_cookie(
            self.cookie, token, max_age=30 * 24 * 3600, path="/", secure=self.secure, httponly=True, samesite="Strict"
        )

    def _challenge(self, kind, **extra):
        now = self.clock()
        for key in [k for k, v in self.challenges.items() if v["expires"] < now]:
            self.challenges.pop(key, None)
        cid = secrets.token_urlsafe(16)
        challenge = secrets.token_bytes(32)
        self.challenges[cid] = {"kind": kind, "challenge": challenge, "expires": now + CHALLENGE_TTL, **extra}
        return cid, challenge

    def _take_challenge(self, cid, kind):
        entry = self.challenges.pop(str(cid or ""), None)
        if entry is None or entry["kind"] != kind or entry["expires"] < self.clock():
            raise ValueError("That sign-in attempt expired. Try again.")
        return entry

    @staticmethod
    def _session(request):
        session = request.match_info["session"]
        if not SESSION_ID.match(session):
            raise ValueError("bad session id")
        return session

    async def _hub(self):
        if not self.hub.connected:
            raise ConnectionError("offline")
        return self.hub

    # Sign-in

    async def me(self, request):
        signed_in = self._signed_in(request) is not None
        return web.json_response(
            {"signed_in": signed_in, "has_passkeys": self.store.has_credentials(), "connected": self.hub.connected}
        )

    async def register_options(self, request):
        body = await request.json()
        setup = body.get("setup")
        signed_in = self._signed_in(request)
        if signed_in is None and not self.store.setup_link_valid(setup):
            raise web.HTTPForbidden(text=json.dumps({"error": "This setup link is invalid or used up."}), content_type="application/json")
        user_id = self.store.meta("user_id")
        if user_id is None:
            user_id = webauthn.b64url(secrets.token_bytes(16))
            self.store.set_meta("user_id", user_id)
        cid, challenge = self._challenge("register", setup=None if signed_in else setup)
        existing = [{"type": "public-key", "id": webauthn.b64url(c["id"])} for c in self.store.credentials()]
        return web.json_response(
            {
                "challenge_id": cid,
                "publicKey": {
                    "challenge": webauthn.b64url(challenge),
                    "rp": {"id": self.rp_id, "name": self.rp_name},
                    "user": {"id": user_id, "name": "owner", "displayName": "Hermes Portal"},
                    "pubKeyCredParams": [{"type": "public-key", "alg": webauthn.ES256}, {"type": "public-key", "alg": webauthn.RS256}],
                    "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
                    "attestation": "none",
                    "excludeCredentials": existing,
                    "timeout": CHALLENGE_TTL * 1000,
                },
            }
        )

    async def register_finish(self, request):
        body = await request.json()
        entry = self._take_challenge(body.get("challenge_id"), "register")
        if entry["setup"] is None and self._signed_in(request) is None:
            raise web.HTTPForbidden()
        credential = body.get("credential") or {}
        registered = webauthn.verify_registration(
            client_data_json=webauthn.unb64url(credential.get("clientDataJSON", "")),
            attestation_object=webauthn.unb64url(credential.get("attestationObject", "")),
            challenge=entry["challenge"],
            origin=self.origin,
            rp_id=self.rp_id,
        )
        if entry["setup"] is not None and not self.store.use_setup_link(entry["setup"]):
            raise web.HTTPForbidden(text=json.dumps({"error": "This setup link was already used."}), content_type="application/json")
        label = str(body.get("label") or "passkey")[:60]
        self.store.add_credential(registered.credential_id, registered.cose_key, registered.sign_count, label)
        log.info("Hermes portal registered a passkey (%s)", label)
        response = web.json_response({"ok": True})
        self._set_login(response, registered.credential_id)
        return response

    async def login_options(self, request):
        cid, challenge = self._challenge("login")
        return web.json_response(
            {
                "challenge_id": cid,
                "publicKey": {
                    "challenge": webauthn.b64url(challenge),
                    "rpId": self.rp_id,
                    "userVerification": "required",
                    "allowCredentials": [],
                    "timeout": CHALLENGE_TTL * 1000,
                },
            }
        )

    async def login_finish(self, request):
        body = await request.json()
        entry = self._take_challenge(body.get("challenge_id"), "login")
        credential = body.get("credential") or {}
        credential_id = webauthn.unb64url(credential.get("id", ""))
        stored = self.store.credential(credential_id)
        if stored is None:
            raise web.HTTPForbidden(text=json.dumps({"error": "This passkey isn't registered here."}), content_type="application/json")
        count = webauthn.verify_assertion(
            client_data_json=webauthn.unb64url(credential.get("clientDataJSON", "")),
            authenticator_data=webauthn.unb64url(credential.get("authenticatorData", "")),
            signature=webauthn.unb64url(credential.get("signature", "")),
            challenge=entry["challenge"],
            origin=self.origin,
            rp_id=self.rp_id,
            cose_key=stored["cose_key"],
            stored_sign_count=stored["sign_count"],
        )
        self.store.used_credential(credential_id, count)
        response = web.json_response({"ok": True})
        self._set_login(response, credential_id)
        return response

    async def logout(self, request):
        self.store.end_login(request.cookies.get(self.cookie))
        response = web.json_response({"ok": True})
        response.del_cookie(self.cookie, path="/")
        return response

    async def passkeys(self, request):
        current = self._require(request)
        return web.json_response(
            [
                {"id": webauthn.b64url(c["id"]), "label": c["label"], "created_at": c["created_at"], "last_used_at": c["last_used_at"], "current": c["id"] == current}
                for c in self.store.credentials()
            ]
        )

    async def remove_passkey(self, request):
        current = self._require(request)
        target = webauthn.unb64url(request.match_info["id"])
        if target == current:
            raise ValueError("Sign in with another passkey to remove this one")
        self.store.remove_credential(target)
        return web.json_response({"ok": True})

    # Conversations

    async def sessions(self, request):
        self._require(request)
        hub = await self._hub()
        return web.json_response(await hub.sessions())

    async def open(self, request):
        self._require(request)
        hub = await self._hub()
        return web.json_response(await hub.open(self._session(request)))

    async def _message(self, request):
        form = await request.post()
        text = str(form.get("text") or "")
        files = []
        for part in form.getall("file", []):
            if not isinstance(part, web.FileField) or not part.filename:
                continue
            data = part.file.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                raise ValueError("Files must be under 25 MiB")
            content_type = part.content_type or mimetypes.guess_type(part.filename)[0]
            files.append({"filename": Path(part.filename).name, "content_type": content_type, "data": data})
        return text, files

    async def create(self, request):
        self._require(request)
        hub = await self._hub()
        text, files = await self._message(request)
        if not text.strip() and not files:
            raise ValueError("Write something first")
        return web.json_response(await hub.create(text, files))

    async def send(self, request):
        self._require(request)
        hub = await self._hub()
        text, files = await self._message(request)
        return web.json_response(await hub.send(self._session(request), text, files))

    async def stop(self, request):
        self._require(request)
        hub = await self._hub()
        return web.json_response(await hub.interrupt(self._session(request)))

    async def archive(self, request):
        self._require(request)
        hub = await self._hub()
        body = await request.json()
        return web.json_response(await hub.archive(self._session(request), bool(body.get("archived", True))))

    async def pin(self, request):
        self._require(request)
        hub = await self._hub()
        body = await request.json()
        await hub.pin(self._session(request), bool(body.get("pinned", True)))
        return web.json_response({"ok": True})

    async def title(self, request):
        self._require(request)
        hub = await self._hub()
        body = await request.json()
        title = str(body.get("title") or "").strip()[:200]
        if not title:
            raise ValueError("Give it a title")
        return web.json_response(await hub.rename(self._session(request), title))

    async def answer(self, request):
        self._require(request)
        hub = await self._hub()
        body = await request.json()
        return web.json_response(await hub.answer(request.match_info["request"], body.get("result") or {}))

    async def file(self, request):
        """A file the agent delivered with a MEDIA: line in that session, and nothing else."""
        self._require(request)
        hub = await self._hub()
        session = request.query.get("session", "")
        raw = request.query.get("path", "")
        if not SESSION_ID.match(session) or not raw.startswith("/"):
            raise web.HTTPNotFound()
        opened = await hub.open(session)
        delivered = {
            path
            for message in opened["messages"]
            if message.get("role") == "assistant"
            for path in MEDIA.findall(message.get("text") or "")
        }
        path = Path(raw)
        if raw not in delivered or not path.is_file() or path.stat().st_size > MAX_FILE:
            raise web.HTTPNotFound()
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        inline = kind.startswith("image/") or kind.startswith("audio/") or kind.startswith("video/") or kind == "application/pdf"
        disposition = "inline" if inline else "attachment"
        return web.FileResponse(
            path, headers={"Content-Type": kind, "Content-Disposition": f'{disposition}; filename="{path.name}"'}
        )

    async def inbox(self, request):
        self._require(request)
        return web.json_response(self.store.inbox())

    async def push_key(self, request):
        self._require(request)
        return web.json_response({"key": self.vapid.public_key if self.vapid else None})

    async def push_subscribe(self, request):
        self._require(request)
        body = await request.json()
        endpoint = str(body.get("endpoint") or "")
        keys = body.get("keys") or {}
        if urlparse(endpoint).scheme != "https" or not keys.get("p256dh") or not keys.get("auth"):
            raise ValueError("That isn't a push subscription")
        self.store.add_push(endpoint, {"p256dh": str(keys["p256dh"]), "auth": str(keys["auth"])})
        return web.json_response({"ok": True})

    async def socket(self, request):
        self._require(request)
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=1024 * 1024)
        await ws.prepare(request)
        client = _Client(ws)
        self.hub.join(client)
        try:
            await ws.send_json({"kind": "hub.connected" if self.hub.connected else "hub.disconnected"})
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(message.data)
                except ValueError:
                    continue
                session = str(data.get("watch") or "")
                if SESSION_ID.match(session):
                    self.hub.watch(client, session)
        finally:
            self.hub.leave(client)
        return ws

    async def static(self, request):
        rel = request.match_info["path"] or "index.html"
        path = (self.web_root / rel).resolve()
        if not path.is_relative_to(self.web_root) or not path.is_file():
            if "." in Path(rel).name:
                raise web.HTTPNotFound()
            path = self.web_root / "index.html"
        headers = {"Cache-Control": "no-cache"}
        if path.name == "sw.js":
            headers["Service-Worker-Allowed"] = "/"
        return web.FileResponse(path, headers=headers)


class _Client:
    def __init__(self, ws):
        self.ws = ws
        self.lock = asyncio.Lock()

    async def send(self, message):
        async with self.lock:
            await self.ws.send_json(message)
