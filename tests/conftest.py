"""A stateful fake of the gateway behind the portal adapter, and a software passkey."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
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
from portal.link import GatewayClient, GatewayLink  # noqa: E402
from portal.server import Portal  # noqa: E402
from portal.store import Store  # noqa: E402

ORIGIN = "http://portal.test"
LOCAL_TOKEN = "local-test-token"
SERVER_CODE = "test-code"


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


def validate_model_options(body):
    """Validate every field before any part of a selection is written."""
    if not isinstance(body, dict) or not body or set(body) - {"provider", "model", "effort", "speed", "reset", "confirm"}:
        raise ValueError("Invalid model settings")
    for key in ("provider", "model", "effort", "speed"):
        if key in body and not isinstance(body[key], str):
            raise ValueError(f"Invalid {key}")
    if ("model" in body) != ("provider" in body) or ("model" in body and (not body["model"] or not body["provider"])):
        raise ValueError("Pick a model and provider")
    if "effort" in body and body["effort"] not in ("", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"):
        raise ValueError("Unknown reasoning effort")
    if "speed" in body and body["speed"] not in ("", "normal", "fast", "auto", "cold", "ultrafast"):
        raise ValueError("Unknown speed")
    if "reset" in body and body["reset"] is not True:
        raise ValueError("Invalid reset")
    if body.get("reset") and len(body) != 1:
        raise ValueError("Reset cannot include other settings")


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
        # A turn that starts and keeps running (until the gateway goes away).
        self.hold = False
        self.ask_approval = False
        self.sign_off_error = None
        # The adapter's final send can reach the hub after the turn has ended.
        self.send_late = False
        self.sign_off_route = {"provider": "auto", "model": ""}
        self.image_dir = Path(tempfile.mkdtemp())
        self.hub = None
        # Hermes profiles the gateway serves; the portal shows one at a time.
        self.profile_names = ["default", "work", "research"]
        self.profile = "default"
        self.profile_models = {}
        self.model_controls = True
        # Background processes per thread, as the gateway's process registry lists them.
        self.procs = {}
        self.proc_logs = {}
        # What the agent-secrets plugin keeps, as the adapter reaches it; None: plugin not installed.
        self.vault = {}
        # Providers `hermes model` offers, as the backend lists them; None: too old to offer any.
        self.provider_list = None
        self.provider_keys = {}
        self.provider_accounts = {}
        self.signin_pending = {}
        self.signin_status = {}
        # MCP servers as `hermes mcp` keeps them (name -> config); None: a Hermes without MCP.
        self.mcp = {}
        self.mcp_plugins = {}
        self.mcp_live = {}
        self.mcp_tools = {}
        self.mcp_catalog_list = []
        self.mcp_env = {}
        self.mcp_flows = {}
        self.mcp_tokens = set()

    def add_session(self, sid, title, chat=None, messages=(), profile=None):
        self.sessions[sid] = {
            "id": sid,
            "title": title,
            "chat": chat or f"chat-{sid}",
            "rows": [],
            "started_at": time.time(),
            "pinned": False,
            "archived": False,
            "profile": profile or self.profile,
        }
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
            if not s["archived"] and s["profile"] == self.profile
        ]

    def archived_sessions(self):
        return [
            {"id": s["id"], "title": s["title"], "preview": _preview(s), "started_at": s["started_at"], "message_count": len(s["rows"]), "pinned": s["pinned"], "chat_id": s["chat"]}
            for s in self.sessions.values()
            if s["archived"] and s["profile"] == self.profile
        ]

    def _shown(self, sid):
        s = self.sessions.get(sid)
        return s if s and s["profile"] == self.profile else None

    def thread(self, sid):
        s = self._shown(sid)
        return None if s is None else {"title": s["title"], "messages": list(s["rows"])}

    def title_of(self, sid):
        s = self.sessions.get(sid) or self.elsewhere.get(sid)
        return s["title"] if s else None

    def chat_of(self, sid):
        s = self._shown(sid)
        return s["chat"] if s else None

    def profiles(self):
        return {"profile": self.profile, "profiles": list(self.profile_names)}

    def models(self):
        if not self.model_controls:
            return []
        return [{"provider": "fast", "label": "Fast Co", "models": ["tiny", "small"]}, {"provider": "big", "label": "Big Co", "models": ["large"]}]

    def usage(self):
        if not self.model_controls:
            return None
        return [{"provider": "big", "label": "Big Co", "accounts": [
            {"label": "home", "windows": [{"label": "Week", "used_percent": 100.0, "resets_at": "2026-11-05T16:00:00+00:00"}], "note": None},
            {"label": "spare", "windows": [], "note": "Signed out"}]}]

    def model(self):
        if not self.model_controls:
            return None
        return {"effort": "medium", "speed": "normal", "efforts": ["none", "low", "medium", "high", "max"],
                "speeds": ["normal", "fast", "auto", "cold"], **self.profile_models.get(self.profile, {"provider": "fast", "model": "tiny"})}

    def set_model(self, provider, model):
        if not any(p["provider"] == provider and model in p["models"] for p in self.models()):
            raise ValueError("Model not found for that provider")
        self.profile_models[self.profile] = {"provider": provider, "model": model}

    def set_model_options(self, body):
        validate_model_options(body)
        if "model" in body:
            self.set_model(body["provider"], body["model"])
        self.profile_models[self.profile] = {**(self.model() or {}), **{k: body[k] for k in ("effort", "speed") if k in body}}
        return self.model()

    def session_model(self, sid):
        if not self.model_controls:
            return None
        if not self._shown(sid):
            raise ValueError("No chat with that id")
        saved = self.sessions[sid].get("model_options", {})
        return {"effort": "medium", "speed": "normal", **(self.model() or {}), **saved,
                "overridden": bool(saved), "efforts": ["none", "low", "medium", "high", "max"], "speeds": ["normal", "fast", "auto", "cold"]}

    async def set_session_model(self, sid, body):
        validate_model_options(body)
        if not self._shown(sid):
            raise ValueError("No chat with that id")
        if "model" in body and not any(p["provider"] == body.get("provider") and body["model"] in p["models"] for p in self.models()):
            raise ValueError("Model not found for that provider")
        saved = self.sessions[sid].setdefault("model_options", {})
        if body.get("reset"):
            saved.clear()
        else:
            saved.update({k: v for k, v in body.items() if k != "reset"})
        return self.session_model(sid)

    def use_profile(self, name):
        if name not in self.profile_names:
            raise ValueError("That profile isn't served by this gateway")
        self.profile = name
        return self.profiles()

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
        self.sessions[sid] = {**self.elsewhere.pop(sid), "chat": chat, "profile": self.profile}
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
        if self.hold:
            return
        if self.ask_approval:
            request = {"id": "req-1", "method": "approval", "params": {"command": "rm -rf build", "description": "delete build", "choices": ["once", "session", "deny"]}, "private": {"session_key": f"key-{chat}"}}
            await self.hub.ask(chat, request)
            return
        if not self.send_late:
            await self.hub.outgoing(chat, "reply-1", self.reply)
        self._row(sid, "assistant", self.reply)
        await self.hub.turn_finished(chat, "success")

    async def resolve(self, request, result):
        self.answers.append({"id": request["id"], "private": request["private"], "result": result})

    def set_title(self, sid, title):
        self.sessions[sid]["title"] = title

    def set_archived(self, sid, archived):
        self.sessions[sid]["archived"] = archived

    def is_archived(self, sid):
        return bool(self.sessions.get(sid, {}).get("archived"))

    def set_pinned(self, sid, pinned):
        self.sessions[sid]["pinned"] = pinned

    def set_yolo(self, chat):
        self.yolo.add(chat)

    def sign_off(self, reply):
        if self.sign_off_error:
            raise self.sign_off_error
        return f"proud of: {reply}"

    def sign_off_models(self):
        return [{"provider": "fast", "label": "Fast Co", "models": ["tiny", "small"]}]

    def sign_off_model(self):
        return dict(self.sign_off_route)

    def set_sign_off_model(self, provider, model):
        self.sign_off_route = {"provider": provider, "model": model}

    def processes(self, sid):
        return list(self.procs.get(sid, [])) if self._shown(sid) else []

    def process_log(self, sid, proc_id, lines):
        if not any(p["id"] == proc_id for p in self.processes(sid)):
            return None
        out = self.proc_logs.get(proc_id, [])
        return {"lines": out[-lines:], "total_chars": sum(len(x) + 1 for x in out)}

    def secrets(self):
        if self.vault is None:
            return None
        return [{"name": n, "note": s["note"], "origin": s["origin"], "created_at": s.get("updated_at", 1.0), "updated_at": s.get("updated_at", 1.0)} for n, s in sorted(self.vault.items())]

    def secret(self, name):
        return None if self.vault is None or name not in self.vault else self.vault[name]["value"]

    def set_secret(self, name, value, note=None):
        if self.vault is None:
            raise ValueError("The agent-secrets plugin isn't installed")
        if not value:
            raise ValueError("The secret is empty")
        old = self.vault.get(name, {})
        self.vault[name] = {"value": value, "note": old.get("note", "") if note is None else note, "origin": "you", "updated_at": time.time()}

    def remove_secret(self, name):
        return self.vault.pop(name, None) is not None

    def providers(self):
        rows = []
        for row in self.provider_list or []:
            connected = bool(self.provider_keys.get(row["slug"])) if row["kind"] == "key" else self.provider_accounts.get(row["slug"], False)
            rows.append({**row, "connected": connected, "source": (row.get("env_var") or "") if connected else ""})
        return rows

    def set_provider_key(self, slug, value):
        row = next((r for r in self.provider_list or [] if r["slug"] == slug), None)
        if row is None or row["kind"] != "key":
            raise ValueError("That provider doesn't take an API key here")
        if not str(value or "").strip():
            raise ValueError("Paste a key first")
        self.provider_keys[slug] = value

    def remove_provider_key(self, slug):
        self.provider_keys.pop(slug, None)

    def start_provider_signin(self, slug):
        row = next((r for r in self.provider_list or [] if r["slug"] == slug), None)
        if row is None or row["kind"] != "signin":
            raise ValueError("That provider signs in from a terminal on this machine")
        self.signin_pending.setdefault(slug, []).append(slug)
        self.signin_status[slug] = "pending"
        return {"session_id": f"{slug}-session", "user_code": "K7QF-M2XD", "verification_url": "https://example.test/device",
                "expires_in": 900, "poll_interval": 5}

    def provider_signin(self, slug, session):
        if session != f"{slug}-session":
            raise ValueError("That sign-in expired. Start it again")
        return {"status": self.signin_status.get(slug, "pending"), "error": None}

    def mcp_servers(self):
        if self.mcp is None:
            return None
        rows = []
        for name, cfg in sorted({**self.mcp, **{n: c for n, (c, _p) in self.mcp_plugins.items()}}.items()):
            tools = cfg.get("tools") or {}
            rows.append({"name": name, "url": cfg.get("url", ""), "command": cfg.get("command", ""), "args": cfg.get("args", []),
                         "env": sorted(cfg.get("env") or {}), "auth": cfg.get("auth", "none"), "enabled": cfg.get("enabled", True),
                         "plugin": self.mcp_plugins.get(name, (None, ""))[1], "status": self.mcp_live.get(name, "connected" if cfg.get("enabled", True) else "disabled"),
                         "error": "", "signed_in": cfg.get("auth") != "oauth" or name in self.mcp_tokens,
                         "picked": bool(tools), "codex": "", "installing": False})
        return {"servers": rows, "codex": False}

    def mcp_catalog(self):
        return [{**row, "installed": row["name"] in self.mcp} for row in self.mcp_catalog_list]

    def mcp_install(self, name, env=None):
        row = next((r for r in self.mcp_catalog_list if r["name"] == name), None)
        if row is None:
            raise ValueError("That server isn't in the catalog")
        missing = [e["name"] for e in row["env"] if e["required"] and not (env or {}).get(e["name"])]
        if missing:
            raise ValueError(f"{name} needs {', '.join(missing)}")
        self.mcp_env.update(env or {})
        self.mcp[name] = {"url": row.get("url", ""), "command": row.get("command", ""), "auth": row.get("auth", "none")}
        return {"name": name}

    def mcp_add(self, spec):
        name = str(spec.get("name") or "").strip()
        if not name:
            raise ValueError("Server name is required")
        if name in self.mcp:
            raise ValueError(f"There's already a server named {name}")
        if bool(spec.get("url")) == bool(spec.get("command")):
            raise ValueError("Provide exactly one of URL (HTTP/SSE) or command (stdio)")
        cfg = {k: spec[k] for k in ("url", "command", "args", "env", "auth") if spec.get(k)}
        if spec.get("token"):
            self.mcp_env[f"MCP_{name.upper()}_API_KEY"] = spec["token"]
            cfg["auth"] = "header"
        self.mcp[name] = cfg
        return {"name": name}

    def _mcp_own(self, name):
        if name in self.mcp_plugins:
            raise ValueError(f"{name} comes from the {self.mcp_plugins[name][1]} plugin")
        if name not in self.mcp:
            raise ValueError(f"No server named {name}")

    def mcp_set_enabled(self, name, enabled):
        self._mcp_own(name)
        self.mcp[name]["enabled"] = bool(enabled)

    def mcp_remove(self, name):
        self._mcp_own(name)
        del self.mcp[name]

    def mcp_test(self, name):
        if name not in self.mcp and name not in self.mcp_plugins:
            raise ValueError(f"No server named {name}")
        if self.mcp.get(name, {}).get("auth") == "oauth" and name not in self.mcp_tokens:
            return {"ok": False, "error": "Sign in first", "tools": []}
        include = (self.mcp.get(name, {}).get("tools") or {}).get("include")
        tools = self.mcp_tools.get(name, [])
        return {"ok": True, "error": "", "tools": [{"name": t, "description": d, "on": include is None or t in include} for t, d in tools]}

    def mcp_set_tools(self, name, tools, chosen):
        self._mcp_own(name)
        if set(tools) == set(chosen):
            self.mcp[name].pop("tools", None)
        else:
            self.mcp[name]["tools"] = {"include": [t for t in tools if t in chosen]}

    def mcp_start_signin(self, name, redirect_uri):
        self._mcp_own(name)
        self.mcp_flows[f"{name}-flow"] = {"name": name, "redirect": redirect_uri, "status": "authorization_required"}
        return {"flow_id": f"{name}-flow", "server_name": name, "status": "authorization_required",
                "authorization_url": f"https://auth.example.test/authorize?redirect_uri={redirect_uri}", "error": None}

    def mcp_signin(self, flow):
        state = self.mcp_flows.get(flow)
        if state is None:
            raise ValueError("That sign-in expired. Start it again")
        return {"flow_id": flow, "server_name": state["name"], "status": state["status"], "authorization_url": None, "error": None}

    def mcp_cancel_signin(self, flow):
        if flow in self.mcp_flows:
            self.mcp_flows[flow]["status"] = "error"

    def mcp_oauth_callback(self, name, code=None, state=None, error=None, iss=None):
        flow = self.mcp_flows.get(f"{name}-flow")
        if flow is None or state != "good-state":
            return "expired"
        flow["status"] = "approved"
        self.mcp_tokens.add(name)
        return "ok"

    def commands(self):
        return [{"name": "/status", "description": "Show session status", "skill": False}, {"name": "/work", "description": "Do focused work", "skill": True}]


class Backend:
    """FakeGateway as the hub sees it: its `sessions` dict is the backend's `sessions()` list."""

    def __init__(self, fake):
        self.fake = fake

    def __getattr__(self, name):
        return getattr(self.fake, "sessions_list" if name == "sessions" else name)


class HubOverLink:
    """What the fake gateway tells the hub, sent over the link like the real adapter does."""

    def __init__(self, client):
        self.client = client

    def __getattr__(self, name):
        return lambda *args: self.client.call(name, *args)


class Gateway:
    """The gateway's end of the link, dialled in from the same loop the way the adapter does."""

    def __init__(self, hermes, local_server, http):
        self.hermes = hermes
        self.url = str(local_server.make_url("/gateway"))
        self.http = http
        self.client = None
        self.task = None

    async def start(self, hub, code=SERVER_CODE):
        self.client = GatewayClient(self.url, LOCAL_TOKEN, code, Backend(self.hermes))
        self.hermes.hub = HubOverLink(self.client)
        self.task = asyncio.get_running_loop().create_task(self.client.run(self.http))
        await until(lambda: hub.connected)

    async def stop(self, hub):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        await until(lambda: not hub.connected)


async def until(check, timeout=5):
    async def wait():
        while not check():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(wait(), timeout)


class World:
    def __init__(self, hermes, store, portal_server, http, hub):
        self.hermes = hermes
        self.store = store
        self.server = portal_server
        self.http = http
        self.hub = hub
        self.alerts = []
        self.gateway = None

    @property
    def client(self):
        return self.gateway.client

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
    # The portal server as it runs on its own, with the fake gateway dialled in over the link.
    link = GatewayLink(SERVER_CODE)
    hub = Hub(link, alert=lambda *a: alerts.append(a))
    link.serve(hub)
    portal = Portal(hub, store, origin=ORIGIN, web_root=ROOT / "dashboard" / "web")
    link.on_change = portal.gateway_changed
    portal_server = TestServer(portal.app())
    await portal_server.start_server()
    local_server = TestServer(portal.local_app(LOCAL_TOKEN, link))
    await local_server.start_server()
    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar) as http, aiohttp.ClientSession() as gateway_http:
        w = World(hermes, store, portal_server, http, hub)
        w.alerts = alerts
        w.portal = portal
        w.local = local_server
        w.link = link
        w.gateway = Gateway(hermes, local_server, gateway_http)
        await w.gateway.start(hub)
        yield w
        if w.gateway.task is not None:
            w.gateway.task.cancel()
            await asyncio.gather(w.gateway.task, return_exceptions=True)
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


def pytest_xdist_auto_num_workers(config):
    """`-n auto` (pyproject): the whole suite spreads over up to 8 workers, since most of its time
    is tests waiting on sockets; a run of chosen files or `-k` starts faster on its own."""
    if config.option.keyword or config.option.markexpr or config.args_source == pytest.Config.ArgsSource.ARGS:
        return 0
    return min(8, os.cpu_count() or 1)
