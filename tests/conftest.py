"""A stateful fake Hermes backend (the `/api/ws` JSON-RPC Desktop speaks) and a software passkey."""

from __future__ import annotations

import asyncio
import hashlib
import json
import struct
import sys
import time
from pathlib import Path

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboard"))

from portal import webauthn  # noqa: E402
from portal.hub import Hub  # noqa: E402
from portal.rpc import Rpc  # noqa: E402
from portal.server import Portal  # noqa: E402
from portal.store import Store  # noqa: E402

ORIGIN = "http://portal.test"


# --- CBOR encoding, just enough to play an authenticator ---


def cbor(value) -> bytes:
    def head(major, n):
        if n < 24:
            return bytes([major << 5 | n])
        for info, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
            if n < 1 << (8 * size):
                return bytes([major << 5 | info]) + n.to_bytes(size, "big")
        raise ValueError(n)

    if isinstance(value, bool):
        return bytes([0xF5 if value else 0xF4])
    if isinstance(value, int):
        return head(0, value) if value >= 0 else head(1, -1 - value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode()
        return head(3, len(raw)) + raw
    if isinstance(value, list):
        return head(4, len(value)) + b"".join(cbor(v) for v in value)
    if isinstance(value, dict):
        return head(5, len(value)) + b"".join(cbor(k) + cbor(v) for k, v in value.items())
    raise TypeError(type(value))


class Authenticator:
    """A platform passkey: one ES256 key, user verification on, an incrementing counter."""

    def __init__(self, rp_id="portal.test", origin=ORIGIN):
        self.rp_id = rp_id
        self.origin = origin
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = b"cred-" + struct.pack(">d", time.time())
        self.count = 0

    def _auth_data(self, flags, attested=b""):
        self.count += 1
        rp_hash = hashlib.sha256(self.rp_id.encode()).digest()
        return rp_hash + bytes([flags]) + self.count.to_bytes(4, "big") + attested

    def _client_data(self, kind, challenge, origin=None):
        return json.dumps({"type": kind, "challenge": challenge, "origin": origin or self.origin}).encode()

    def create(self, options, *, origin=None):
        numbers = self.key.public_key().public_numbers()
        cose = cbor({1: 2, 3: -7, -1: 1, -2: numbers.x.to_bytes(32, "big"), -3: numbers.y.to_bytes(32, "big")})
        attested = b"\x00" * 16 + len(self.credential_id).to_bytes(2, "big") + self.credential_id + cose
        auth_data = self._auth_data(0x01 | 0x04 | 0x40, attested)
        client = self._client_data("webauthn.create", options["publicKey"]["challenge"], origin)
        return {
            "id": webauthn.b64url(self.credential_id),
            "clientDataJSON": webauthn.b64url(client),
            "attestationObject": webauthn.b64url(cbor({"fmt": "none", "attStmt": {}, "authData": auth_data})),
        }

    def get(self, options, *, count=None):
        if count is not None:
            self.count = count - 1
        auth_data = self._auth_data(0x01 | 0x04)
        client = self._client_data("webauthn.get", options["publicKey"]["challenge"])
        signature = self.key.sign(auth_data + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        return {
            "id": webauthn.b64url(self.credential_id),
            "clientDataJSON": webauthn.b64url(client),
            "authenticatorData": webauthn.b64url(auth_data),
            "signature": webauthn.b64url(signature),
        }


# --- the fake backend ---


class FakeHermes:
    """Sessions, transcripts, turns and approvals, served over the backend's JSON-RPC shape."""

    def __init__(self):
        self.sessions = {}
        self.sockets = []
        self.answers = []
        self.seq = 0
        self.next_row = 1
        self.reply = "hello from hermes"
        self.ask_approval = False

    def add_session(self, sid, title, source="desktop", messages=()):
        self.sessions[sid] = {"id": sid, "title": title, "source": source, "rows": [], "started_at": time.time()}
        for role, text in messages:
            self._row(sid, role, text)
        return sid

    def _row(self, sid, role, text, **extra):
        row = {"role": role, "text": text, "row_id": self.next_row, **extra}
        self.next_row += 1
        self.sessions[sid]["rows"].append(row)
        return row

    def runtime(self, sid):
        return f"rt-{sid}"

    def stored(self, runtime):
        return runtime.removeprefix("rt-")

    async def emit(self, sid, kind, payload=None):
        self.seq += 1
        frame = {"jsonrpc": "2.0", "method": "event", "params": {"type": kind, "session_id": self.runtime(sid), "payload": payload or {}, "seq": self.seq}}
        for ws in list(self.sockets):
            await ws.send_json(frame)

    async def desktop_turn(self, sid, text):
        """Someone types in Desktop: a user row, a streamed reply, a finished turn."""
        self._row(sid, "user", text)
        await self.emit(sid, "message.start")
        await self.emit(sid, "message.delta", {"text": self.reply})
        self._row(sid, "assistant", self.reply)
        await self.emit(sid, "message.complete", {"status": "complete", "text": self.reply})

    async def _turn(self, sid, text):
        await self.emit(sid, "message.start")
        if self.ask_approval:
            frame = {"jsonrpc": "2.0", "id": "req-1", "method": "approval", "params": {"session_id": self.runtime(sid), "request_id": "req-1", "command": "rm -rf build", "description": "delete build", "choices": ["once", "session", "deny"]}}
            for ws in list(self.sockets):
                await ws.send_json(frame)
            return
        await self.emit(sid, "message.delta", {"text": self.reply})
        self._row(sid, "assistant", self.reply)
        await self.emit(sid, "message.complete", {"status": "complete", "text": self.reply})

    async def handle(self, method, params):
        if method in {"client.capabilities", "gateway.ping"}:
            return {}
        if method == "session.list":
            rows = [{"id": s["id"], "title": s["title"], "source": s["source"], "started_at": s["started_at"], "preview": ""} for s in self.sessions.values() if not s.get("archived")]
            return {"sessions": rows}
        if method == "session.resume":
            sid = params["session_id"]
            if sid not in self.sessions:
                raise KeyError("no such session")
            return {"session_id": self.runtime(sid), "message_count": 0, "messages": [], "info": {}}
        if method == "session.create":
            sid = f"20261024_000000_{len(self.sessions):06x}"
            self.add_session(sid, params.get("title") or "", source=params.get("source") or "")
            return {"session_id": self.runtime(sid), "stored_session_id": sid, "message_count": 0, "messages": [], "info": {}}
        if method == "session.history":
            rows = self.sessions[self.stored(params["session_id"])]["rows"]
            return {"count": len(rows), "messages": rows}
        if method == "session.status":
            return {"running": False}
        if method == "prompt.submit":
            sid = self.stored(params["session_id"])
            row = self._row(sid, "user", params["text"])
            asyncio.get_running_loop().create_task(self._turn(sid, params["text"]))
            return {"status": "streaming", "user_row_id": row["row_id"]}
        if method == "request.answer":
            self.answers.append(params)
            return {"status": "answered"}
        if method == "session.archive":
            self.sessions[self.stored(params["session_id"])]["archived"] = params.get("archived", True)
            return {"archived": params.get("archived", True), "session_key": params["session_id"]}
        if method == "session.interrupt":
            return {"status": "interrupted"}
        if method == "session.title":
            self.sessions[self.stored(params["session_id"])]["title"] = params["title"]
            return {"title": params["title"]}
        raise KeyError(f"unknown method {method}")

    def app(self):
        async def ws_handler(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            self.sockets.append(ws)
            try:
                async for message in ws:
                    frame = json.loads(message.data)
                    try:
                        result = await self.handle(frame["method"], frame.get("params") or {})
                        await ws.send_json({"jsonrpc": "2.0", "id": frame["id"], "result": result})
                    except KeyError as error:
                        await ws.send_json({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": 4004, "message": str(error)}})
            finally:
                self.sockets.remove(ws)
            return ws

        app = web.Application()
        app.router.add_get("/api/ws", ws_handler)
        return app


class Pins:
    def __init__(self):
        self.on = set()

    def pinned(self):
        return set(self.on)

    def set(self, session, pinned):
        (self.on.add if pinned else self.on.discard)(session)


class World:
    def __init__(self, hermes, store, portal_server, http, hub, pins):
        self.hermes = hermes
        self.store = store
        self.server = portal_server
        self.http = http
        self.hub = hub
        self.pins = pins
        self.alerts = []

    def url(self, path):
        return str(self.server.make_url(path))

    async def post(self, path, payload=None, *, origin=ORIGIN, cookies=None):
        headers = {"Origin": origin} if origin else {}
        return await self.http.post(self.url(path), json=payload or {}, headers=headers)

    async def sign_up(self, authenticator=None):
        authenticator = authenticator or Authenticator()
        setup = self.store.new_setup_link()
        options = await (await self.post("/api/register/options", {"setup": setup})).json()
        response = await self.post("/api/register/finish", {"challenge_id": options["challenge_id"], "credential": authenticator.create(options), "label": "phone"})
        assert response.status == 200, await response.text()
        return authenticator


@pytest_asyncio.fixture
async def world(tmp_path):
    hermes = FakeHermes()
    backend = TestServer(hermes.app())
    await backend.start_server()
    async with aiohttp.ClientSession() as rpc_http:
        store = Store(tmp_path / "portal" / "portal.db")
        pins = Pins()
        alerts = []
        hub = Hub(Rpc(rpc_http, str(backend.make_url("/api/ws"))), pins=pins, alert=lambda *a: alerts.append(a))
        portal = Portal(hub, store, origin=ORIGIN, web_root=ROOT / "dashboard" / "web")
        portal_server = TestServer(portal.app())
        await portal_server.start_server()
        serving = asyncio.create_task(hub.serve())
        await asyncio.wait_for(hub.ready.wait(), 5)
        jar = aiohttp.CookieJar(unsafe=True)
        async with aiohttp.ClientSession(cookie_jar=jar) as http:
            w = World(hermes, store, portal_server, http, hub, pins)
            w.alerts = alerts
            yield w
        serving.cancel()
        await portal_server.close()
    await backend.close()


async def next_message(ws, predicate, timeout=5):
    async def wait():
        while True:
            message = await ws.receive_json()
            if predicate(message):
                return message

    return await asyncio.wait_for(wait(), timeout)
