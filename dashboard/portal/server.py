"""The portal's web server: the app, its passkey login, a REST API for actions and a WebSocket for live events."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
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
from .hub import page
from .media import shown_files

log = logging.getLogger("hermes.portal")

CHALLENGE_TTL = 300
MAX_FILE = 25 * 1024 * 1024
MAX_BODY = 60 * 1024 * 1024
SESSION_ID = re.compile(r"^[\w.-]{1,120}$")
ANDROID_APK_PATH = "/android/nako.apk"
ANDROID_PACKAGE = "moe.nakode.portal"
# How long the desktop app has to collect a sign-in the browser approved.
HANDOFF_TTL = 120
PKCE_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
# Tauri updater platform keys, and the release files they point at (no paths).
DESKTOP_PLATFORM = re.compile(r"^(linux|windows|darwin)-(x86_64|aarch64)$")
DESKTOP_FILE = re.compile(r"^nako[\w.-]*\.(AppImage|exe|tar\.gz)$")
# Scripts stay 'self' only. Inline styles are allowed because the UI components set them
# (Radix's scroll area, Shiki's token colors); blob: lets the composer read picked files.
CSP = (
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
    "connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)


def _index(raw):
    if not raw.isdigit():
        raise ValueError("bad transcript position")
    return int(raw)


class Portal:
    def __init__(
        self,
        hub,
        store,
        *,
        origin,
        web_root,
        rp_name="Nako",
        vapid=None,
        android_release_dir=None,
        android_cert_sha256=None,
        desktop_release_dir=None,
        clock=time.time,
    ):
        self.vapid = vapid
        self.android_release_dir = Path(android_release_dir) if android_release_dir else None
        # The release key's SHA-256 fingerprint; lets the Android app use passkeys for this site.
        self.android_cert_sha256 = android_cert_sha256
        self.desktop_release_dir = Path(desktop_release_dir) if desktop_release_dir else None
        # Desktop sign-ins the browser approved, waiting for the app: code -> challenge, passkey, expiry.
        self.handoffs = {}
        parsed = urlparse(origin)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("origin must be an http(s) URL")
        self.hub = hub
        self.store = store
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        # Passkey ceremonies from the Android app carry its signing-key origin, not the site's.
        self.origins = {self.origin}
        if android_cert_sha256:
            self.origins.add(webauthn.android_origin(android_cert_sha256))
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
        r.add_post("/api/me/name", self.set_name)
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
        r.add_post("/api/sessions/{session}/command", self.command)
        r.add_get("/api/commands", self.commands)
        r.add_post("/api/sessions/{session}/archive", self.archive)
        r.add_post("/api/sessions/{session}/pin", self.pin)
        r.add_post("/api/sessions/{session}/title", self.title)
        r.add_post("/api/requests/{request}", self.answer)
        r.add_get("/api/file", self.file)
        r.add_get("/api/inbox", self.inbox)
        r.add_get("/api/push/key", self.push_key)
        r.add_post("/api/push/subscribe", self.push_subscribe)
        r.add_get("/api/android/release", self.android_release)
        r.add_get(ANDROID_APK_PATH, self.android_apk)
        r.add_get("/.well-known/assetlinks.json", self.assetlinks)
        r.add_post("/api/desktop/link", self.desktop_link)
        r.add_get("/api/desktop/session", self.desktop_session)
        r.add_get("/api/desktop/release", self.desktop_release)
        r.add_get("/desktop/{file}", self.desktop_app)
        r.add_get("/ws", self.socket)
        r.add_get("/{path:.*}", self.static)
        return app

    def local_app(self, token):
        """Starts chats for scripts on this machine (an agent handing work to a new thread).

        Served on its own loopback port, never through the public origin, and every call
        carries the token from a 0600 file only this account can read.
        """
        expected = f"Bearer {token}".encode()

        @web.middleware
        async def guard(request, handler):
            if not secrets.compare_digest(request.headers.get("Authorization", "").encode(), expected):
                return web.json_response({"error": "bad token"}, status=401)
            try:
                return await handler(request)
            except ValueError as error:
                return web.json_response({"error": str(error)}, status=400)
            except ConnectionError:
                return web.json_response({"error": "Nako is offline right now"}, status=503)

        async def brief(request):
            body = await request.json()
            text = str(body.get("text") or "")
            if not text.strip():
                raise ValueError("Write something first")
            return body, text

        async def start(request):
            body, text = await brief(request)
            hub = await self._hub()
            started = await hub.create(text, title=body.get("title") or None, cwd=body.get("cwd") or None, yolo=bool(body.get("yolo")))
            return web.json_response(started)

        async def send(request):
            # Same turn lock as a typed message: a busy thread queues or steers it.
            _, text = await brief(request)
            hub = await self._hub()
            return web.json_response(await hub.send(self._session(request), text))

        async def handoff(request):
            hub = await self._hub()
            return web.json_response(await hub.adopt(self._session(request)))

        app = web.Application(client_max_size=MAX_BODY, middlewares=[guard])
        app.router.add_post("/sessions", start)
        app.router.add_post("/sessions/{session}/messages", send)
        app.router.add_post("/sessions/{session}/handoff", handoff)
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
        except ValueError as error:
            response = web.json_response({"error": str(error)}, status=400)
        except ConnectionError:
            response = web.json_response({"error": "Nako is offline right now"}, status=503)
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
        me = {"signed_in": signed_in, "has_passkeys": self.store.has_credentials(), "connected": self.hub.connected}
        if signed_in:
            me["name"] = self.store.meta("name", "")
        return web.json_response(me)

    async def set_name(self, request):
        """The name the new-chat greeting uses, kept here so every device says the same thing."""
        self._require(request)
        body = await request.json()
        name = " ".join(str(body.get("name") or "").split())[:40]
        self.store.set_meta("name", name)
        return web.json_response({"name": name})

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
                    "user": {"id": user_id, "name": "owner", "displayName": "Nako"},
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
            origin=self.origins,
            rp_id=self.rp_id,
        )
        if entry["setup"] is not None and not self.store.use_setup_link(entry["setup"]):
            raise web.HTTPForbidden(text=json.dumps({"error": "This setup link was already used."}), content_type="application/json")
        label = str(body.get("label") or "passkey")[:60]
        self.store.add_credential(registered.credential_id, registered.cose_key, registered.sign_count, label)
        log.info("Nako portal registered a passkey (%s)", label)
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
            origin=self.origins,
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
        rows = await hub.sessions()
        for row in rows:
            # A post nobody has opened the chat for since: the sidebar marks it.
            row["unread"] = row["notifications"] and row["message_count"] > self.store.meta(f"seen:{row['id']}", 0)
        return web.json_response(rows)

    async def open(self, request):
        self._require(request)
        hub = await self._hub()
        session = self._session(request)
        opened = await hub.open(session)
        listed = next((row for row in await hub.sessions() if row["id"] == session), None)
        if listed and listed["notifications"]:
            self.store.set_meta(f"seen:{session}", listed["message_count"])
        query = request.query
        window = {key: _index(query[key]) for key in ("before", "since") if key in query}
        opened["start"], opened["messages"] = page(opened["messages"], **window)
        return web.json_response(opened)

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

    async def commands(self, request):
        self._require(request)
        hub = await self._hub()
        return web.json_response(await hub.commands())

    async def command(self, request):
        self._require(request)
        hub = await self._hub()
        body = await request.json()
        return web.json_response(await hub.command(self._session(request), str(body.get("text") or "")))

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
        """A file shown in that session's transcript (a reply's MEDIA: tag or an image the user attached), and nothing else."""
        self._require(request)
        hub = await self._hub()
        session = request.query.get("session", "")
        raw = request.query.get("path", "")
        if not SESSION_ID.match(session) or not raw.startswith(("/", "~/")):
            raise web.HTTPNotFound()
        opened = await hub.open(session)
        path = Path(raw).expanduser()
        if raw not in shown_files(opened["messages"]) or not path.is_file() or path.stat().st_size > MAX_FILE:
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

    # Android app: self-updates from a signed release CI published, and passkeys via Digital Asset Links.

    def _published_release(self):
        if self.android_release_dir is None:
            return None
        try:
            manifest = json.loads((self.android_release_dir / "android-release.json").read_text())
            apk = self.android_release_dir / "nako.apk"
            code, name, sha, size = manifest["versionCode"], manifest["versionName"], manifest["sha256"], manifest["sizeBytes"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        valid = (
            isinstance(code, int) and code > 0 and isinstance(name, str) and name
            and isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{64}", sha)
            and isinstance(size, int) and apk.is_file() and apk.stat().st_size == size
        )
        if not valid:
            return None
        return {"versionCode": code, "versionName": name, "sha256": sha, "sizeBytes": size, "apkUrl": ANDROID_APK_PATH}

    async def android_release(self, request):
        self._require(request)
        release = self._published_release()
        if release is None:
            raise web.HTTPNotFound()
        return web.json_response(release)

    async def android_apk(self, request):
        self._require(request)
        if self._published_release() is None:
            raise web.HTTPNotFound()
        return web.FileResponse(
            self.android_release_dir / "nako.apk",
            headers={"Content-Type": "application/vnd.android.package-archive", "Cache-Control": "no-store"},
        )

    async def assetlinks(self, request):
        if not self.android_cert_sha256:
            raise web.HTTPNotFound()
        statement = {
            "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
            "target": {"namespace": "android_app", "package_name": ANDROID_PACKAGE, "sha256_cert_fingerprints": [self.android_cert_sha256]},
        }
        return web.json_response([statement])

    # Desktop app. Its webview can't use passkeys (WebKitGTK has no WebAuthn), so the browser signs
    # in and hands the session over: the app sends the browser here with a PKCE challenge and a
    # loopback port, the signed-in page approves and passes a one-time code to the loopback, and
    # the app's webview trades the code plus its secret verifier for its own login cookie.

    async def desktop_link(self, request):
        credential = self._require(request)
        body = await request.json()
        challenge = str(body.get("challenge") or "")
        if not PKCE_CHALLENGE.match(challenge):
            raise ValueError("That sign-in request is malformed")
        now = self.clock()
        for key in [k for k, v in self.handoffs.items() if v["expires"] < now]:
            self.handoffs.pop(key, None)
        code = secrets.token_urlsafe(32)
        self.handoffs[code] = {"challenge": challenge, "credential": credential, "expires": now + HANDOFF_TTL}
        return web.json_response({"code": code})

    async def desktop_session(self, request):
        entry = self.handoffs.pop(request.query.get("code", ""), None)
        verifier = request.query.get("verifier", "").encode()
        proof = webauthn.b64url(hashlib.sha256(verifier).digest())
        valid = (
            entry is not None
            and entry["expires"] >= self.clock()
            and hmac.compare_digest(proof, entry["challenge"])
            and self.store.credential(entry["credential"]) is not None
        )
        if not valid:
            return web.Response(status=303, headers={"Location": "/#signin=failed"})
        response = web.Response(status=303, headers={"Location": "/"})
        self._set_login(response, entry["credential"])
        return response

    def _published_desktop(self):
        """The published release: its version and, per platform, the file and its updater signature.
        A platform whose file is missing or doesn't match the manifest's size is left out."""
        if self.desktop_release_dir is None:
            return None
        try:
            manifest = json.loads((self.desktop_release_dir / "desktop-release.json").read_text())
            version, platforms = manifest["version"], manifest["platforms"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        if not isinstance(version, str) or not VERSION.match(version) or not isinstance(platforms, dict):
            return None
        files = {}
        for platform, entry in platforms.items():
            if not DESKTOP_PLATFORM.match(str(platform)) or not isinstance(entry, dict):
                continue
            name, signature, size = entry.get("file"), entry.get("signature"), entry.get("sizeBytes")
            if not isinstance(name, str) or not DESKTOP_FILE.match(name) or not isinstance(signature, str) or not signature:
                continue
            path = self.desktop_release_dir / name
            if isinstance(size, int) and path.is_file() and path.stat().st_size == size:
                files[platform] = (name, signature)
        return (version, files) if files else None

    async def desktop_release(self, request):
        self._require(request)
        release = self._published_desktop()
        if release is None:
            raise web.HTTPNotFound()
        version, files = release
        # Tauri's updater format; the app checks the signature against the key built into it.
        platforms = {p: {"url": f"{self.origin}/desktop/{name}", "signature": sig} for p, (name, sig) in files.items()}
        return web.json_response({"version": version, "platforms": platforms})

    async def desktop_app(self, request):
        self._require(request)
        release = self._published_desktop()
        name = request.match_info["file"]
        if release is None or name not in {n for n, _ in release[1].values()}:
            raise web.HTTPNotFound()
        return web.FileResponse(
            self.desktop_release_dir / name,
            headers={"Content-Type": "application/octet-stream", "Cache-Control": "no-store"},
        )

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
