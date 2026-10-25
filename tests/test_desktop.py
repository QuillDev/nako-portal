import base64
import hashlib
import json
import secrets

import aiohttp
import pytest
from aiohttp.test_utils import TestServer

from conftest import ORIGIN, ROOT
from portal.server import Portal

pytestmark = pytest.mark.asyncio


def pkce():
    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
async def desktop(world, tmp_path):
    """The portal with a controllable clock and a desktop release dir, plus a cookie-less client playing the app."""
    clock = Clock()
    portal = Portal(world.hub, world.store, origin=ORIGIN, web_root=ROOT / "dashboard" / "web", desktop_release_dir=tmp_path, clock=clock)
    server = TestServer(portal.app())
    await server.start_server()
    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as app:
        yield server, clock, app
    await server.close()


async def link(world, url, challenge):
    """The signed-in browser approves the desktop app's sign-in."""
    return await world.http.post(url("/api/desktop/link"), json={"challenge": challenge}, headers={"Origin": ORIGIN})


async def test_the_desktop_app_signs_in_through_the_browser_and_keeps_the_session(world, desktop):
    server, clock, app = desktop
    url = lambda path: str(server.make_url(path))  # noqa: E731
    sid = world.hermes.add_session("20261024_070707_abcdef", "deploy")
    await world.sign_up()
    verifier, challenge = pkce()

    approved = await link(world, url, challenge)
    assert approved.status == 200
    code = (await approved.json())["code"]

    # The app's webview opens the hand-off with the code and its secret, and comes back signed in.
    finished = await app.get(url("/api/desktop/session"), params={"code": code, "verifier": verifier}, allow_redirects=False)
    assert (finished.status, finished.headers["Location"]) == (303, "/")
    listed = await app.get(url("/api/sessions"))
    assert listed.status == 200
    assert [s["id"] for s in await listed.json()] == [sid]

    # The code works once.
    other = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=other) as replay:
        again = await replay.get(url("/api/desktop/session"), params={"code": code, "verifier": verifier}, allow_redirects=False)
        assert (again.status, again.headers["Location"]) == (303, "/#signin=failed")
        assert (await replay.get(url("/api/sessions"))).status == 401


async def test_a_hand_off_is_refused_without_the_apps_secret_a_signed_in_browser_or_in_time(world, desktop):
    server, clock, app = desktop
    url = lambda path: str(server.make_url(path))  # noqa: E731

    async def signed_in_after(code, verifier):
        response = await app.get(url("/api/desktop/session"), params={"code": code, "verifier": verifier}, allow_redirects=False)
        assert response.status == 303
        return (await app.get(url("/api/sessions"))).status == 200

    verifier, challenge = pkce()
    # A browser that isn't signed in, or a page on another site, can't approve anything.
    assert (await link(world, url, challenge)).status == 401
    await world.sign_up()
    cross = await world.http.post(url("/api/desktop/link"), json={"challenge": challenge}, headers={"Origin": "https://evil.example"})
    assert cross.status == 403
    assert (await link(world, url, "not a challenge")).status == 400

    # Someone who saw the code but not the app's secret gets nothing, and the code is spent.
    code = (await (await link(world, url, challenge)).json())["code"]
    assert not await signed_in_after(code, pkce()[0])
    assert not await signed_in_after(code, verifier)

    # Codes expire after two minutes.
    code = (await (await link(world, url, challenge)).json())["code"]
    clock.now += 121
    assert not await signed_in_after(code, verifier)

    code = (await (await link(world, url, challenge)).json())["code"]
    clock.now += 119
    assert await signed_in_after(code, verifier)


async def test_the_desktop_app_updates_from_the_release_the_server_publishes(world, desktop, tmp_path):
    server, clock, app = desktop
    url = lambda path: str(server.make_url(path))  # noqa: E731
    await world.sign_up()

    assert (await world.http.get(url("/api/desktop/release"))).status == 404
    image = b"\x7fELF fake appimage"
    (tmp_path / "nako.AppImage").write_bytes(image)
    manifest = {"version": "0.2.0", "signature": "dW50cnVzdGVkIGNvbW1lbnQ=", "sizeBytes": len(image) + 1}
    (tmp_path / "desktop-release.json").write_text(json.dumps(manifest))
    # A manifest that doesn't match the file, or isn't a version the updater understands, isn't offered.
    assert (await world.http.get(url("/api/desktop/release"))).status == 404
    (tmp_path / "desktop-release.json").write_text(json.dumps({**manifest, "sizeBytes": len(image), "version": "latest"}))
    assert (await world.http.get(url("/api/desktop/release"))).status == 404

    (tmp_path / "desktop-release.json").write_text(json.dumps({**manifest, "sizeBytes": len(image)}))
    release = await (await world.http.get(url("/api/desktop/release"))).json()
    assert release["version"] == "0.2.0"
    assert release["platforms"]["linux-x86_64"] == {"url": f"{ORIGIN}/desktop/nako.AppImage", "signature": manifest["signature"]}
    assert await (await world.http.get(url("/desktop/nako.AppImage"))).read() == image

    # Only for the signed-in owner.
    assert (await app.get(url("/api/desktop/release"))).status == 401
    assert (await app.get(url("/desktop/nako.AppImage"))).status == 401
