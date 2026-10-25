import asyncio
import base64
import importlib.util
import struct
import sys
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from portal import push
from portal.store import Store

pytestmark = pytest.mark.asyncio
ROOT = Path(__file__).resolve().parents[1]


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def decrypt_like_a_browser(body, receiver, auth):
    """RFC 8291 from the receiving side, written from the spec rather than the sender."""
    salt, record_size, key_len = body[:16], struct.unpack(">I", body[16:20])[0], body[20]
    sender_public = body[21 : 21 + key_len]
    ciphertext = body[21 + key_len :]
    assert record_size == 4096
    shared = receiver.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), sender_public))
    receiver_public = receiver.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)

    def hkdf(s, ikm, info, n):
        return HKDF(algorithm=hashes.SHA256(), length=n, salt=s, info=info).derive(ikm)

    ikm = hkdf(auth, shared, b"WebPush: info\x00" + receiver_public + sender_public, 32)
    plain = AESGCM(hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)).decrypt(hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12), ciphertext, None)
    assert plain.endswith(b"\x02")
    return plain[:-1]


async def test_a_push_reaches_the_browser_encrypted_and_dead_subscriptions_are_dropped(tmp_path):
    receiver = ec.generate_private_key(ec.SECP256R1())
    auth = b"0123456789abcdef"
    received = []

    async def service(request):
        received.append((request.match_info["id"], dict(request.headers), await request.read()))
        return web.Response(status=201 if request.match_info["id"] == "live" else 410)

    app = web.Application()
    app.router.add_post("/push/{id}", service)
    server = TestServer(app)
    await server.start_server()
    store = Store(tmp_path / "portal.db")
    keys = {"p256dh": b64(receiver.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)), "auth": b64(auth)}
    live_url = str(server.make_url("/push/live"))
    store.add_push(live_url, keys)
    store.add_push(str(server.make_url("/push/gone")), keys)
    vapid = push.Vapid(tmp_path / "vapid.pem", "mailto:owner@example.test")

    import aiohttp

    async with aiohttp.ClientSession() as http:
        delivered = await push.Pusher(http, store, vapid).notify("fix the build", "done", "20261024_020202_bbbbbb")
    await server.close()

    assert delivered == 1
    live = next(r for r in received if r[0] == "live")
    assert live[1]["Content-Encoding"] == "aes128gcm"
    assert live[1]["Authorization"].startswith("vapid t=") and f"k={vapid.public_key}" in live[1]["Authorization"]
    assert b"fix the build" not in live[2]
    assert decrypt_like_a_browser(live[2], receiver, auth) == b'{"title": "fix the build", "body": "done", "session": "20261024_020202_bbbbbb"}'
    assert [s["endpoint"] for s in store.pushes()] == [live_url]
    # The same identity survives a restart, or every existing subscription would break.
    assert push.Vapid(tmp_path / "vapid.pem", "mailto:x").public_key == vapid.public_key


async def test_cron_deliveries_to_the_portal_platform_land_in_its_inbox(tmp_path, monkeypatch):
    home = tmp_path / "home"
    fake_constants = type(sys)("hermes_constants")
    fake_constants.get_hermes_home = lambda: home
    monkeypatch.setitem(sys.modules, "hermes_constants", fake_constants)
    spec = importlib.util.spec_from_file_location("nako_portal_plugin", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)

    registered = {}

    class Ctx:
        def register_platform(self, **entry):
            registered.update(entry)

    plugin.register(Ctx())
    assert registered["name"] == "portal"
    sent = await registered["standalone_sender_fn"](None, "inbox", "daily digest: 3 new emails")
    assert sent["success"]
    rows = Store(home / "nako-portal" / "portal.db").inbox()
    assert [(r["chat"], r["text"]) for r in rows] == [("inbox", "daily digest: 3 new emails")]
    await asyncio.sleep(0)


async def test_the_portal_keeps_one_titled_chat_for_its_posts(monkeypatch):
    # Hermes's cron mirror appends each post to the open gateway session for portal:inbox, so
    # that session must exist before the first post, and every post must find the same one.
    gateway, config, session = (type(sys)(name) for name in ("gateway", "gateway.config", "gateway.session"))
    config.Platform = lambda name: f"platform:{name}"
    session.SessionSource = lambda **fields: tuple(sorted(fields.items()))
    for module in (gateway, config, session):
        monkeypatch.setitem(sys.modules, module.__name__, module)
    spec = importlib.util.spec_from_file_location("nako_portal_plugin_chat", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)

    class Db:
        titles = {}
        archived = set()

        def get_session(self, sid):
            return {"id": sid, "archived": int(sid in self.archived)}

        def set_session_archived(self, sid, archived):
            (self.archived.add if archived else self.archived.discard)(sid)

        def get_session_title(self, sid):
            return self.titles.get(sid)

        def set_session_title(self, sid, title):
            self.titles[sid] = title

    class Store:
        _db = Db()
        sessions = {}

        def get_or_create_session(self, source, touch_activity=True):
            entry = self.sessions.setdefault(source, type("Entry", (), {"session_id": f"s{len(self.sessions)}"})())
            return entry

    store = Store()
    first = plugin._ensure_chat(store)
    store._db.titles[first] = "renamed by hand"
    assert plugin._ensure_chat(store) == first
    (source,) = store.sessions
    assert dict(source)["platform"] == "platform:portal" and dict(source)["chat_id"] == "inbox"
    assert store._db.titles == {first: "renamed by hand"}
    # Archived from another surface, it comes back the next time the portal reaches for it.
    store._db.archived.add(first)
    assert plugin._ensure_chat(store) == first
    assert store._db.archived == set()
    assert plugin._ensure_chat(None) is None
