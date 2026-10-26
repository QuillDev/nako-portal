"""The portal server runs on its own; the gateway dials in and can come and go."""

import asyncio
import json
import socket
import subprocess
import sys

import aiohttp

from conftest import LOCAL_TOKEN, ORIGIN, ROOT, SERVER_CODE, Backend, FakeGateway, next_message, until
from portal.link import GatewayClient


async def test_the_site_stays_up_while_the_gateway_restarts(world):
    sid = world.hermes.add_session("20261025_141414_aaaaaa", "plans", messages=[("user", "plan the week")])
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})

    await world.gateway.stop(world.hub)
    await next_message(ws, lambda m: m.get("kind") == "hub.disconnected")
    page = await world.http.get(world.url("/"))
    assert page.status == 200 and "<html" in (await page.text()).lower()
    assert (await (await world.http.get(world.url("/api/me"))).json())["connected"] is False
    listed = await world.http.get(world.url("/api/sessions"))
    assert (listed.status, (await listed.json())["error"]) == (503, "Nako is offline right now")
    sent = await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "hello?"}, headers={"Origin": ORIGIN})
    assert sent.status == 503
    assert world.hermes.received == []

    await world.gateway.start(world.hub)
    await next_message(ws, lambda m: m.get("kind") == "hub.connected")
    assert [row["id"] for row in await (await world.http.get(world.url("/api/sessions"))).json()] == [sid]
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "back"}, headers={"Origin": ORIGIN})
    assert world.hermes.received[-1][:2] == (f"chat-{sid}", "back")
    await ws.close()


async def test_a_turn_and_its_question_end_when_the_gateway_goes_away(world):
    sid = world.hermes.add_session("20261025_151515_bbbbbb", "cleanup", messages=[("user", "tidy the build dir")])
    world.hermes.ask_approval = True
    await world.sign_up()
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "go"}, headers={"Origin": ORIGIN})
    await until(lambda: world.hub.requests)
    opened = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
    assert (opened["running"], len(opened["requests"])) == (True, 1)

    await world.gateway.stop(world.hub)
    await world.gateway.start(world.hub)
    opened = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
    assert (opened["running"], opened["requests"], opened["status"]) == (False, [], None)


async def test_a_gateway_on_other_code_is_told_to_start_a_fresh_server(world):
    stale = []
    world.link.on_stale = lambda: stale.append(True)
    async with aiohttp.ClientSession() as http:
        refused = await http.get(world.local.make_url("/gateway"), params={"code": "newer"}, headers={"Authorization": f"Bearer {LOCAL_TOKEN}"})
        assert refused.status == 409
    await until(lambda: stale)
    assert world.hub.connected


async def test_only_the_local_token_opens_the_gateway_link(world):
    async with aiohttp.ClientSession() as http:
        for token in (None, "wrong"):
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            refused = await http.get(world.local.make_url("/gateway"), params={"code": SERVER_CODE}, headers=headers)
            assert refused.status == 401


async def test_the_gateway_starts_the_server_when_nothing_answers():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    missing = asyncio.Event()

    async def start_server():
        missing.set()

    client = GatewayClient(f"http://127.0.0.1:{port}/gateway", LOCAL_TOKEN, SERVER_CODE, Backend(FakeGateway()), on_missing=start_server)
    async with aiohttp.ClientSession() as http:
        task = asyncio.get_running_loop().create_task(client.run(http))
        await asyncio.wait_for(missing.wait(), 5)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def free_pair():
    """A free port whose next one is free too: the server listens on both (site, then gateway link)."""
    while True:
        with socket.socket() as first, socket.socket() as second:
            first.bind(("127.0.0.1", 0))
            port = first.getsockname()[1]
            try:
                second.bind(("127.0.0.1", port + 1))
            except OSError:
                continue
            return port


async def test_the_standalone_server_serves_and_takes_a_gateway(tmp_path):
    port = free_pair()
    data = tmp_path / "nako-portal"
    data.mkdir()
    (data / "local-token").write_text(LOCAL_TOKEN + "\n")
    config = tmp_path / "server.json"
    origin = f"http://127.0.0.1:{port}"
    config.write_text(json.dumps({"data": str(data), "origin": origin, "port": port, "contact": "mailto:owner@localhost", "code": SERVER_CODE}))
    server = subprocess.Popen([sys.executable, str(ROOT / "dashboard" / "serve.py"), str(config)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        async with aiohttp.ClientSession() as http:

            async def me():
                try:
                    return await (await http.get(f"{origin}/api/me")).json()
                except aiohttp.ClientError:
                    return None

            async def wait_for(check):
                for _ in range(200):
                    if check(await me()):
                        return
                    await asyncio.sleep(0.05)
                raise AssertionError("the server never got there")

            # It answers as soon as it listens and writes the first setup link just after.
            link = data / "setup-link"
            await wait_for(lambda m: m is not None and m["connected"] is False and link.exists() and link.read_text().startswith(f"{origin}/#setup="))

            hermes = FakeGateway()
            client = GatewayClient(f"http://127.0.0.1:{port + 1}/gateway", LOCAL_TOKEN, SERVER_CODE, Backend(hermes))
            task = asyncio.get_running_loop().create_task(client.run(http))
            await wait_for(lambda m: m is not None and m["connected"] is True)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await wait_for(lambda m: m is not None and m["connected"] is False)
        server.terminate()
        assert server.wait(10) == 0
    finally:
        if server.poll() is None:
            server.kill()
