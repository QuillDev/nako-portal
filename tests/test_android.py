import asyncio
import hashlib
import json

import pytest
from aiohttp.test_utils import TestServer

from conftest import ORIGIN, ROOT, Authenticator, next_message
from portal import webauthn
from portal.server import Portal

pytestmark = pytest.mark.asyncio
CERT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"


async def test_the_app_hears_alerts_on_its_socket_without_watching_a_chat(world):
    sid = world.hermes.add_session("20261024_070707_abcdef", "deploy")
    await world.sign_up()
    phone = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await world.http.get(world.url(f"/api/sessions/{sid}"))
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "ship"}, headers={"Origin": ORIGIN})
    alert = await next_message(phone, lambda m: m.get("kind") == "alert")
    assert (alert["title"], alert["body"], alert["session"]) == ("deploy", "done", sid)
    await phone.close()

    # A socket that isn't signed in hears nothing.
    world.http.cookie_jar.clear()
    stranger = await world.http.get(world.url("/ws"), headers={"Origin": ORIGIN})
    assert stranger.status == 401


async def test_the_android_app_signs_in_with_a_passkey_bound_to_its_signing_key(world, tmp_path):
    portal = Portal(world.hub, world.store, origin=ORIGIN, web_root=ROOT / "dashboard" / "web", android_cert_sha256=CERT, android_release_dir=tmp_path)
    server = TestServer(portal.app())
    await server.start_server()
    url = lambda path: str(server.make_url(path))  # noqa: E731
    try:
        links = await (await world.http.get(url("/.well-known/assetlinks.json"))).json()
        assert links[0]["target"] == {"namespace": "android_app", "package_name": "moe.nakode.hermes", "sha256_cert_fingerprints": [CERT]}
        assert "delegate_permission/common.get_login_creds" in links[0]["relation"]

        app_origin = "android:apk-key-hash:" + webauthn.b64url(bytes.fromhex(CERT.replace(":", "")))
        phone = Authenticator(origin=app_origin)
        setup = world.store.new_setup_link()
        headers = {"Origin": ORIGIN}
        options = await (await world.http.post(url("/api/register/options"), json={"setup": setup}, headers=headers)).json()
        made = await world.http.post(url("/api/register/finish"), json={"challenge_id": options["challenge_id"], "credential": phone.create(options)}, headers=headers)
        assert made.status == 200

        # Some other app's key hash is still refused.
        options = await (await world.http.post(url("/api/login/options"), headers=headers)).json()
        other = Authenticator(origin="android:apk-key-hash:" + webauthn.b64url(b"\x01" * 32))
        other.key, other.credential_id, other.count = phone.key, phone.credential_id, phone.count
        refused = await world.http.post(url("/api/login/finish"), json={"challenge_id": options["challenge_id"], "credential": other.get(options)}, headers=headers)
        assert refused.status == 400

        # Nothing published yet; then a published release is served only when it matches its manifest.
        assert (await world.http.get(url("/api/android/release"))).status == 404
        apk = b"PK fake apk bytes"
        (tmp_path / "hermes.apk").write_bytes(apk)
        manifest = {"versionCode": 7, "versionName": "0.2.0", "sha256": hashlib.sha256(apk).hexdigest(), "sizeBytes": len(apk) + 1}
        (tmp_path / "android-release.json").write_text(json.dumps(manifest))
        assert (await world.http.get(url("/api/android/release"))).status == 404
        manifest["sizeBytes"] = len(apk)
        (tmp_path / "android-release.json").write_text(json.dumps(manifest))
        release = await (await world.http.get(url("/api/android/release"))).json()
        assert release == {**manifest, "apkUrl": "/android/hermes.apk"}
        assert await (await world.http.get(url("/android/hermes.apk"))).read() == apk

        world.http.cookie_jar.clear()
        assert (await world.http.get(url("/android/hermes.apk"))).status == 401
    finally:
        await server.close()
    await asyncio.sleep(0)
