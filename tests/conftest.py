"""A stateful fake of the gateway behind the portal adapter, and a software passkey."""

from __future__ import annotations

import asyncio
import hashlib
import json
import struct
import sys
import tempfile
import time
from pathlib import Path

import aiohttp
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestServer
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboard"))

from portal import webauthn  # noqa: E402
from portal import hub as hub_module  # noqa: E402
from portal.hub import Hub  # noqa: E402
from portal.server import Portal  # noqa: E402
from portal.store import Store  # noqa: E402

ORIGIN = "http://portal.test"
LOCAL_TOKEN = "local-test-token"


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


# --- the fake gateway ---


class FakeGateway:
    """Portal threads, transcripts and turns, behind the backend interface the hub uses.

    A message in starts a turn the way the gateway does: the hub hears the turn start, the reply
    arrives as an adapter send, then the turn ends. `hub` is set once the world is built."""

    def __init__(self):
        self.sessions = {}
        self.received = []
        self.answers = []
        self.yolo = set()
        self.elsewhere = {}
        self.next_row = 1
        self.reply = "hello from hermes"
        self.ask_approval = False
        self.image_dir = Path(tempfile.mkdtemp())
        self.hub = None

    def add_session(self, sid, title, chat=None, messages=()):
        self.sessions[sid] = {"id": sid, "title": title, "chat": chat or f"chat-{sid}", "rows": [], "started_at": time.time(), "pinned": False, "archived": False}
        for role, text in messages:
            self._row(sid, role, text)
        return sid

    def _row(self, sid, role, text, **extra):
        # Hermes stamps each row with its authoring time; a counter keeps the fake's order exact.
        row = {"role": role, "text": text, "row_id": self.next_row, "timestamp": 1_700_000_000 + self.next_row, **extra}
        self.next_row += 1
        self.sessions[sid]["rows"].append(row)
        return row

    async def post(self, sid, text):
        """A delivery outside a turn (a cron post): the adapter's send, then the mirrored row."""
        message_id = f"m{self.next_row}"
        sending = asyncio.get_running_loop().create_task(self.hub.outgoing(self.sessions[sid]["chat"], message_id, text))
        self._row(sid, "user", text)
        await sending

    # backend interface

    def sessions_list(self):
        return [
            {"id": s["id"], "title": s["title"], "preview": _preview(s), "started_at": s["started_at"], "message_count": len(s["rows"]), "pinned": s["pinned"], "chat_id": s["chat"]}
            for s in self.sessions.values()
            if not s["archived"]
        ]

    def thread(self, sid):
        s = self.sessions.get(sid)
        return None if s is None else {"title": s["title"], "messages": list(s["rows"])}

    def chat_of(self, sid):
        s = self.sessions.get(sid)
        return s["chat"] if s else None

    def session_of(self, chat):
        return next((s["id"] for s in self.sessions.values() if s["chat"] == chat), None)

    async def new_thread(self, chat, title):
        sid = f"20261024_000000_{len(self.sessions):06x}"
        self.add_session(sid, title or "", chat=chat)
        return sid

    async def adopt(self, chat, sid):
        if sid in self.sessions:
            raise ValueError("That chat is already in the portal")
        if sid not in self.elsewhere:
            raise ValueError("No chat with that id")
        self.sessions[sid] = {**self.elsewhere.pop(sid), "chat": chat}
        return sid

    async def inbound(self, chat, text, files):
        sid = self.session_of(chat)
        paths = []
        for upload in files:
            path = self.image_dir / f"upload_{len(paths) + 1}_{upload['filename']}"
            path.write_bytes(upload["data"])
            paths.append(path)
        self.received.append((chat, text, [p.name for p in paths]))
        hints = "".join(f"\n\n[Image attached at: {p}]" if i == 0 else f"\n[Image attached at: {p}]" for i, p in enumerate(paths))
        self._row(sid, "user", text + hints + ("\n[screenshot]" * len(paths)))
        asyncio.get_running_loop().create_task(self._turn(chat, sid))

    async def _turn(self, chat, sid):
        await self.hub.turn_started(chat)
        if self.ask_approval:
            request = {"id": "req-1", "method": "approval", "params": {"command": "rm -rf build", "description": "delete build", "choices": ["once", "session", "deny"]}, "private": {"session_key": f"key-{chat}"}}
            await self.hub.ask(chat, request)
            return
        await self.hub.outgoing(chat, "reply-1", self.reply)
        self._row(sid, "assistant", self.reply)
        await self.hub.turn_finished(chat, "success")

    async def resolve(self, request, result):
        self.answers.append({"id": request["id"], "private": request["private"], "result": result})

    def set_title(self, sid, title):
        self.sessions[sid]["title"] = title

    def set_archived(self, sid, archived):
        self.sessions[sid]["archived"] = archived

    def set_pinned(self, sid, pinned):
        self.sessions[sid]["pinned"] = pinned

    def set_yolo(self, chat):
        self.yolo.add(chat)

    def commands(self):
        return [{"name": "/status", "description": "Show session status", "skill": False}, {"name": "/work", "description": "Do focused work", "skill": True}]


class Backend:
    """FakeGateway as the hub sees it: its `sessions` dict is the backend's `sessions()` list."""

    def __init__(self, fake):
        self.fake = fake

    def __getattr__(self, name):
        return getattr(self.fake, "sessions_list" if name == "sessions" else name)


class World:
    def __init__(self, hermes, store, portal_server, http, hub):
        self.hermes = hermes
        self.store = store
        self.server = portal_server
        self.http = http
        self.hub = hub
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
async def world(tmp_path, monkeypatch):
    monkeypatch.setattr(hub_module, "MIRROR_SETTLE", 0)
    hermes = FakeGateway()
    store = Store(tmp_path / "portal" / "portal.db")
    alerts = []
    hub = Hub(Backend(hermes), alert=lambda *a: alerts.append(a))
    hermes.hub = hub
    portal = Portal(hub, store, origin=ORIGIN, web_root=ROOT / "dashboard" / "web")
    portal_server = TestServer(portal.app())
    await portal_server.start_server()
    local_server = TestServer(portal.local_app(LOCAL_TOKEN))
    await local_server.start_server()
    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar) as http:
        w = World(hermes, store, portal_server, http, hub)
        w.alerts = alerts
        w.local = local_server
        yield w
    await local_server.close()
    await portal_server.close()


async def next_message(ws, predicate, timeout=5):
    async def wait():
        while True:
            message = await ws.receive_json()
            if predicate(message):
                return message

    return await asyncio.wait_for(wait(), timeout)


def _preview(session):
    """Hermes's list preview: the first user message on one line, cut at 60 characters."""
    first = next((row["text"] for row in session["rows"] if row["role"] == "user"), "")
    text = first.strip().replace("\n", " ")
    return text[:60] + "..." if len(text) > 60 else text
