"""Other machines in the portal's mesh: a hub portal and a machine's portal, each with its own
fake gateway, joined over the real mesh socket."""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import stat
import sys
import time
from pathlib import Path

import aiohttp
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestServer

from conftest import LOCAL_TOKEN, ORIGIN, SERVER_CODE, FakeGateway, Gateway, next_message, until
from portal import mesh as mesh_module
from portal.hub import Hub
from portal.link import GatewayLink
from portal.machine_ops import MachineOps
from portal.mesh import Mesh, Node, add_node, mirror_skills, remove_node, skill_manifest
from portal.offline import Offline
from portal.server import Portal
from portal.store import Store

MACHINE = "laptop"


class Machine:
    """Another machine's portal: its own hub and fake gateway, dialing the hub's mesh."""

    def __init__(self, tmp_path, http):
        self.hermes = FakeGateway()
        self.link = GatewayLink(SERVER_CODE)
        self.hub = Hub(self.link)
        self.link.serve(self.hub)
        self.portal = Portal(self.hub, Store(tmp_path / "node" / "portal.db"), origin="http://127.0.0.1:1", web_root=tmp_path)
        self.link.on_change = self.portal.gateway_changed
        self.http = http
        self.node = None
        self.task = None

    async def start(self, url, token, name=MACHINE, skills_into=None, ops=None):
        self.local = TestServer(self.portal.local_app(LOCAL_TOKEN, self.link))
        await self.local.start_server()
        self.gateway = Gateway(self.hermes, self.local, self.http)
        await self.gateway.start(self.hub)
        self.portal.ops = ops
        self.node = Node(url, name, token, self.hub, skills_into=skills_into, ops=ops)
        self.node.RETRY = 0.05
        self.portal.node = self.node
        self.task = asyncio.get_running_loop().create_task(self.node.run(self.http))

    async def stop(self):
        for task in (self.task, self.gateway.task):
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self.local.close()


@pytest_asyncio.fixture
async def mesh(world, tmp_path):
    data = tmp_path / "hub-data"
    skills = tmp_path / "hub-skills"
    world.mesh = Mesh(data, world.hub, address="https://hub.example.test", plugin={"source": "https://example.test/portal.git", "ref": "a" * 40}, skills_dir=skills, skills_exclude=["work-only"], store=world.store)
    world.skills = skills
    world.mesh_data = data
    _portal_of(world).mesh = world.mesh
    world.mesh_server = TestServer(world.mesh.app())
    await world.mesh_server.start_server()
    world.mesh_url = str(world.mesh_server.make_url("/mesh"))
    async with aiohttp.ClientSession() as http:
        machine = Machine(tmp_path, http)
        world.machine = machine
        yield world
        if machine.task is not None:
            await machine.stop()
    await world.mesh_server.close()


def _portal_of(world):
    """The Portal behind the hub's test server (its routes are bound methods of it)."""
    for route in world.server.app.router.routes():
        owner = getattr(route.handler, "__self__", None)
        if isinstance(owner, Portal):
            return owner
    raise AssertionError("no portal")


async def _join(world, **kwargs):
    token = add_node(world.mesh_data, MACHINE)
    await world.machine.start(world.mesh_url, token, **kwargs)
    await until(lambda: MACHINE in world.mesh.peers and MACHINE in world.mesh.info)
    return token


def _local(world, path):
    return str(world.local.make_url(path))


AUTH = {"Authorization": f"Bearer {LOCAL_TOKEN}"}


async def _machines(world):
    return await (await world.http.get(_local(world, "/mesh/machines"), headers=AUTH)).json()


async def _run(world, text, **extra):
    response = await world.http.post(_local(world, f"/mesh/machines/{MACHINE}/sessions"), json={"text": text, **extra}, headers=AUTH)
    return response


async def test_a_machine_with_its_token_joins_and_shows_online(mesh):
    await _join(mesh)
    rows = await _machines(mesh)
    # The hub lists itself first, so its agent can compare versions with it.
    assert [(r["name"], r["online"], r["gateway"]) for r in rows] == [("hub", True, True), (MACHINE, True, True)]
    assert rows[0]["hub"] is True
    assert rows[1]["hostname"]


async def test_a_machine_with_a_wrong_token_is_refused(mesh):
    add_node(mesh.mesh_data, MACHINE)
    async with aiohttp.ClientSession() as http:
        with pytest.raises(aiohttp.WSServerHandshakeError) as refused:
            await http.ws_connect(mesh.mesh_url, params={"name": MACHINE}, headers={"Authorization": "Bearer nope"})
    assert refused.value.status == 401
    assert [(r["name"], r["online"]) for r in await _machines(mesh)] == [("hub", True), (MACHINE, False)]


async def test_a_revoked_machine_cant_rejoin(mesh):
    token = add_node(mesh.mesh_data, MACHINE)
    remove_node(mesh.mesh_data, MACHINE)
    async with aiohttp.ClientSession() as http:
        with pytest.raises(aiohttp.WSServerHandshakeError):
            await http.ws_connect(mesh.mesh_url, params={"name": MACHINE}, headers={"Authorization": f"Bearer {token}"})


async def test_the_hubs_agent_runs_a_task_on_a_machine_and_reads_the_reply(mesh):
    await _join(mesh)
    mesh.machine.hermes.reply = "the build passed on the laptop"
    sender = mesh.hermes.add_session("20261101_090000_aaaaaa", "Main thread")
    started = await _run(mesh, "run the build", title="Laptop build", **{"from": sender})
    assert started.status == 200, await started.text()
    session = (await started.json())["session"]
    machine, _, inner = session.removeprefix("mesh.").partition(".")
    assert machine == MACHINE
    on_machine = mesh.machine.hermes.sessions[inner]
    assert on_machine["title"] == "Laptop build"
    # Tasks from the hub run without approval prompts, and say which thread sent them.
    assert on_machine["chat"] in mesh.machine.hermes.yolo
    first = on_machine["rows"][0]["text"]
    # Named the way the machine reaches it, so its agent can answer back.
    assert first.startswith(f'[From another thread, not typed by the user: "Main thread on hub" (session mesh.hub.{sender})]')
    assert first.endswith("run the build")

    async def done():
        state = await (await mesh.http.get(_local(mesh, f"/sessions/{session}"), headers=AUTH)).json()
        return state

    await until(lambda: mesh.machine.hermes.sessions[inner]["rows"][-1]["role"] == "assistant")
    state = await done()
    assert state["running"] is False
    assert state["messages"][-1] == {"role": "assistant", "text": "the build passed on the laptop"}


async def test_a_follow_up_reaches_the_machines_chat(mesh):
    await _join(mesh)
    session = (await (await _run(mesh, "first")).json())["session"]
    inner = session.rsplit(".", 1)[1]
    sent = await mesh.http.post(_local(mesh, f"/sessions/{session}/messages"), json={"text": "and then this"}, headers=AUTH)
    assert sent.status == 200, await sent.text()
    texts = [r["text"] for r in mesh.machine.hermes.sessions[inner]["rows"] if r["role"] == "user"]
    assert texts == ["first", "and then this"]


async def test_the_machines_chats_show_in_the_hubs_sidebar_under_its_name(mesh):
    await mesh.sign_up()
    await _join(mesh)
    mesh.machine.hermes.add_session("20261101_100000_bbbbbb", "Notifications", chat="inbox")
    mesh.machine.hermes.add_session("20261101_100001_cccccc", "Fix the printer")
    mesh.hermes.add_session("20261101_100002_dddddd", "Here")
    rows = await (await mesh.http.get(mesh.url("/api/sessions"))).json()
    shown = {r["title"]: (r["id"], r.get("machine")) for r in rows}
    assert shown["Here"] == ("20261101_100002_dddddd", None)
    assert shown["Fix the printer"] == (f"mesh.{MACHINE}.20261101_100001_cccccc", MACHINE)
    assert [r for r in rows if r.get("machine") and r["title"] == "Notifications"] == []
    opened = await (await mesh.http.get(mesh.url(f"/api/sessions/mesh.{MACHINE}.20261101_100001_cccccc"))).json()
    assert opened["title"] == "Fix the printer"
    path = f"/api/sessions/mesh.{MACHINE}.20261101_100001_cccccc/model"
    selected = await mesh.post(path, {"provider": "big", "model": "large", "effort": "high"})
    assert selected.status == 200
    assert (await selected.json())["model"] == "large"
    assert mesh.machine.hermes.session_model("20261101_100001_cccccc")["effort"] == "high"
    assert mesh.machine.hermes.model()["model"] == "tiny"
    assert mesh.hermes.model()["model"] == "tiny"
    mesh.machine.hub.running.add("20261101_100001_cccccc")
    refused = await mesh.post(path, {"effort": "low"})
    assert refused.status == 400
    assert "finish" in (await refused.json())["error"]
    assert mesh.machine.hermes.session_model("20261101_100001_cccccc")["effort"] == "high"


async def test_a_machines_chat_streams_live_to_the_hubs_app(mesh):
    await mesh.sign_up()
    await _join(mesh)
    sid = mesh.machine.hermes.add_session("20261101_110000_eeeeee", "Live one")
    mesh.machine.hermes.reply = "streamed from afar"
    remote = f"mesh.{MACHINE}.{sid}"
    async with mesh.http.ws_connect(mesh.url("/ws"), headers={"Origin": ORIGIN}) as ws:
        await ws.send_json({"watch": remote})
        await asyncio.sleep(0.05)
        sent = await mesh.http.post(mesh.url(f"/api/sessions/{remote}/messages"), data={"text": "go"}, headers={"Origin": ORIGIN})
        assert sent.status == 200, await sent.text()
        message = await next_message(ws, lambda m: m.get("kind") == "event" and m.get("type") == "gateway.message")
        assert message["session"] == remote
        assert message["payload"]["text"] == "streamed from afar"
        status = await next_message(ws, lambda m: m.get("kind") == "status" and m.get("status") == "done")
        assert status["session"] == remote


async def test_a_question_on_a_machine_is_answered_from_the_hub(mesh):
    await mesh.sign_up()
    await _join(mesh)
    mesh.machine.hermes.ask_approval = True
    sid = mesh.machine.hermes.add_session("20261101_120000_ffffff", "Careful")
    remote = f"mesh.{MACHINE}.{sid}"
    await mesh.http.post(mesh.url(f"/api/sessions/{remote}/messages"), data={"text": "clean up"}, headers={"Origin": ORIGIN})
    await until(lambda: "req-1" in mesh.mesh.requests)
    state = await (await mesh.http.get(_local(mesh, f"/sessions/{remote}"), headers=AUTH)).json()
    assert [r["id"] for r in state["requests"]] == ["req-1"]
    answered = await mesh.post("/api/requests/req-1", {"result": {"choice": "once"}})
    assert answered.status == 200, await answered.text()
    assert mesh.machine.hermes.answers[0]["result"] == {"choice": "once"}


async def test_a_machine_that_leaves_goes_offline_and_its_chats_are_unreachable(mesh):
    await _join(mesh)
    session = (await (await _run(mesh, "hi")).json())["session"]
    await mesh.machine.stop()
    mesh.machine.task = None
    await until(lambda: MACHINE not in mesh.mesh.peers)
    laptop = next(r for r in await _machines(mesh) if r["name"] == MACHINE)
    assert laptop["online"] is False and laptop["last_seen"]
    refused = await mesh.http.post(_local(mesh, f"/sessions/{session}/messages"), json={"text": "still there?"}, headers=AUTH)
    assert refused.status == 503
    started = await _run(mesh, "anyone?")
    assert started.status == 503


async def test_an_unknown_machine_is_a_clear_error(mesh):
    response = await mesh.http.post(_local(mesh, "/mesh/machines/toaster/sessions"), json={"text": "hi"}, headers=AUTH)
    assert response.status == 400
    assert "toaster" in (await response.json())["error"]


# Machines driving each other (through the hub)


@pytest_asyncio.fixture
async def two(mesh, tmp_path):
    """The hub with two machines: laptop and desktop."""
    await _join(mesh)
    async with aiohttp.ClientSession() as http:
        desktop = Machine(tmp_path / "desktop", http)
        token = add_node(mesh.mesh_data, "desktop")
        await desktop.start(mesh.mesh_url, token, name="desktop")
        await until(lambda: "desktop" in mesh.mesh.peers and "desktop" in mesh.mesh.info)
        mesh.desktop = desktop
        yield mesh
        await desktop.stop()


def _on(machine, path):
    return str(machine.local.make_url(path))


async def test_a_machine_sees_the_hub_and_the_others_but_not_itself(two):
    rows = await (await two.http.get(_on(two.machine, "/mesh/machines"), headers=AUTH)).json()
    assert [(r["name"], r["online"], bool(r.get("hub"))) for r in rows] == [("hub", True, True), ("desktop", True, False)]


async def test_a_machine_hands_another_a_task_and_reads_the_reply(two):
    two.desktop.hermes.reply = "desktop did it"
    sender = two.machine.hermes.add_session("20261101_130000_aaaaaa", "Laptop thread")
    started = await two.http.post(_on(two.machine, "/mesh/machines/desktop/sessions"), json={"text": "render the video", "from": sender}, headers=AUTH)
    assert started.status == 200, await started.text()
    session = (await started.json())["session"]
    inner = session.removeprefix("mesh.desktop.")
    first = two.desktop.hermes.sessions[inner]["rows"][0]["text"]
    assert first.startswith(f'[From another thread, not typed by the user: "Laptop thread on laptop" (session mesh.laptop.{sender})]')
    await until(lambda: two.desktop.hermes.sessions[inner]["rows"][-1]["role"] == "assistant")
    state = await (await two.http.get(_on(two.machine, f"/sessions/{session}"), headers=AUTH)).json()
    assert state["messages"][-1] == {"role": "assistant", "text": "desktop did it"}


async def test_the_other_machine_answers_back_into_the_senders_thread(two):
    sender = two.machine.hermes.add_session("20261101_131000_bbbbbb", "Laptop thread")
    worker = two.desktop.hermes.add_session("20261101_131001_cccccc", "Desktop thread")
    sent = await two.http.post(
        _on(two.desktop, f"/sessions/mesh.laptop.{sender}/messages"), json={"text": "the render is at D:/out.mp4", "from": worker}, headers=AUTH
    )
    assert sent.status == 200, await sent.text()
    got = [r["text"] for r in two.machine.hermes.sessions[sender]["rows"] if r["role"] == "user"]
    assert got == [f'[From another thread, not typed by the user: "Desktop thread on desktop" (session mesh.desktop.{worker})]\n\nthe render is at D:/out.mp4']


async def test_a_machine_can_hand_the_hub_a_task(two):
    started = await two.http.post(_on(two.machine, "/mesh/machines/hub/sessions"), json={"text": "check the server disk"}, headers=AUTH)
    assert started.status == 200, await started.text()
    session = (await started.json())["session"]
    assert session.startswith("mesh.hub.")
    assert two.hermes.sessions[session.removeprefix("mesh.hub.")]["rows"][0]["text"] == "check the server disk"
    state = await (await two.http.get(_on(two.machine, f"/sessions/{session}"), headers=AUTH)).json()
    assert state["messages"][0]["text"] == "check the server disk"


async def test_a_machine_cant_route_to_itself_through_the_hub(two):
    refused = await two.http.post(_on(two.machine, f"/mesh/machines/{MACHINE}/sessions"), json={"text": "hi"}, headers=AUTH)
    assert refused.status == 400
    assert two.machine.hermes.sessions == {}


async def test_a_machine_lists_another_machines_threads(two):
    two.desktop.hermes.add_session("20261101_140000_dddddd", "Render the trailer")
    two.desktop.hermes.add_session("20261101_140001_eeeeee", "Notifications", chat="inbox")
    two.hermes.add_session("20261101_140002_ffffff", "Hub work")
    on_desktop = await (await two.http.get(_on(two.machine, "/mesh/machines/desktop/sessions"), headers=AUTH)).json()
    assert [(r["session"], r["title"]) for r in on_desktop] == [("mesh.desktop.20261101_140000_dddddd", "Render the trailer")]
    on_hub = await (await two.http.get(_on(two.machine, "/mesh/machines/hub/sessions"), headers=AUTH)).json()
    assert [r["session"] for r in on_hub] == ["mesh.hub.20261101_140002_ffffff"]
    # And from the hub's own agent.
    from_hub = await (await two.http.get(_local(two, "/mesh/machines/desktop/sessions"), headers=AUTH)).json()
    assert [r["session"] for r in from_hub] == ["mesh.desktop.20261101_140000_dddddd"]


async def test_a_machine_answers_a_question_another_machine_is_waiting_on(two):
    two.desktop.hermes.ask_approval = True
    started = await two.http.post(_on(two.machine, "/mesh/machines/desktop/sessions"), json={"text": "clean the build"}, headers=AUTH)
    session = (await started.json())["session"]

    async def waiting():
        return (await (await two.http.get(_on(two.machine, f"/sessions/{session}"), headers=AUTH)).json())["requests"]

    await until(lambda: any(r["id"] == "req-1" for r in two.desktop.hub.requests.values()))
    assert [r["id"] for r in await waiting()] == ["req-1"]
    answered = await two.http.post(_on(two.machine, f"/sessions/{session}/answer"), json={"request": "req-1", "result": {"choice": "deny"}}, headers=AUTH)
    assert answered.status == 200, await answered.text()
    assert two.desktop.hermes.answers[0]["result"] == {"choice": "deny"}
    assert await waiting() == []


async def test_the_hubs_agent_answers_a_machines_question(two):
    two.machine.hermes.ask_approval = True
    session = (await (await _run(two, "clean up")).json())["session"]
    await until(lambda: two.machine.hub.requests)
    answered = await two.http.post(_local(two, f"/sessions/{session}/answer"), json={"request": "req-1", "result": {"choice": "once"}}, headers=AUTH)
    assert answered.status == 200, await answered.text()
    assert two.machine.hermes.answers[0]["result"] == {"choice": "once"}


async def test_the_hub_cant_take_its_own_name_for_a_machine(mesh):
    await mesh.sign_up()
    refused = await mesh.post("/api/mesh/machines", {"name": "hub"})
    assert refused.status == 400


async def test_a_hub_without_a_reachable_plugin_source_says_how_to_set_one(mesh):
    await mesh.sign_up()
    mesh.mesh.plugin = {"source": None, "ref": None}
    refused = await mesh.post("/api/mesh/machines", {"name": MACHINE})
    assert refused.status == 400
    assert "plugin source on the Mesh page" in (await refused.json())["error"]
    assert MACHINE not in mesh_module.load_nodes(mesh.mesh_data)


async def test_the_plugin_source_set_on_the_mesh_page_is_what_new_machines_install(mesh):
    await mesh.sign_up()
    mesh.mesh.plugin = {"source": None, "ref": "b" * 40}
    assert (await (await mesh.http.get(mesh.url("/api/mesh"))).json())["plugin"] == {"source": None, "detected": None, "saved": False}
    bad = await mesh.post("/api/mesh/plugin-source", {"source": "https://x.test/$(id)"})
    assert bad.status == 400
    saved = await mesh.post("/api/mesh/plugin-source", {"source": "https://git.example.test/me/portal.git"})
    assert (await saved.json()) == {"source": "https://git.example.test/me/portal.git", "detected": None, "saved": True}
    lines = (await (await mesh.post("/api/mesh/machines", {"name": MACHINE})).json())["lines"]
    path = lines["unix"].split("hub.example.test", 1)[1].removesuffix(" | bash")
    script = await (await mesh.http.get(mesh.url(path))).text()
    assert f"hermes plugins install https://git.example.test/me/portal.git --ref {'b' * 40}" in script
    # Clearing it goes back to the detected source.
    mesh.mesh.plugin = {"source": "https://found.example.test/p.git", "ref": None}
    cleared = await (await mesh.post("/api/mesh/plugin-source", {"source": ""})).json()
    assert cleared == {"source": "https://found.example.test/p.git", "detected": "https://found.example.test/p.git", "saved": False}


async def test_only_a_signed_in_person_sets_the_plugin_source(mesh):
    assert (await mesh.post("/api/mesh/plugin-source", {"source": "https://evil.example.test/p.git"})).status == 401
    assert mesh.mesh.plugin_source() == "https://example.test/portal.git"


# Settings → Machines


async def test_settings_lists_the_machines_with_who_is_online(mesh):
    await mesh.sign_up()
    add_node(mesh.mesh_data, "desktop")
    await _join(mesh)
    shown = await (await mesh.http.get(mesh.url("/api/mesh"))).json()
    assert shown["hub"] is True
    assert [(m["name"], m["online"]) for m in shown["machines"]] == [("desktop", False), (MACHINE, True)]


async def test_a_portal_that_isnt_a_hub_says_so(world):
    await world.sign_up()
    assert await (await world.http.get(world.url("/api/mesh"))).json() == {"hub": False, "machines": []}


async def test_adding_a_machine_gives_a_join_command_that_works(mesh):
    await mesh.sign_up()
    added = await mesh.post("/api/mesh/machines", {"name": MACHINE})
    assert added.status == 200, await added.text()
    command = (await added.json())["command"]
    assert command.startswith("hermes mesh join https://hub.example.test ") and command.endswith(f"--name {MACHINE}")
    token = command.split()[4]
    await mesh.machine.start(mesh.mesh_url, token)
    await until(lambda: MACHINE in mesh.mesh.peers)
    again = await mesh.post("/api/mesh/machines", {"name": MACHINE})
    assert again.status == 400


async def _setup(world, prompt):
    url = re.search(r"curl -fsSL (\S+)`", prompt).group(1)
    assert "curl.exe on Windows" in prompt
    # The hub's real mesh address isn't this test server's; same path, though.
    path = url.split("hub.example.test", 1)[1]
    return path, await world.http.get(str(world.mesh_server.make_url(path)))


async def test_one_line_setup_tells_a_stock_hermes_everything_and_the_machine_joins(mesh):
    await mesh.sign_up()
    prompt = (await (await mesh.post("/api/mesh/machines", {"name": MACHINE})).json())["prompt"]
    assert "\n" not in prompt and prompt.startswith(f'Set this machine up as "{MACHINE}"')
    path, page = await _setup(mesh, prompt)
    assert page.status == 200
    steps = await page.text()
    assert f"hermes plugins install https://example.test/portal.git --ref {'a' * 40} --enable --yes-deps --force" in steps
    join = re.search(rf"hermes mesh join https://hub.example.test (\S+) --name {MACHINE}", steps)
    assert join and "hermes gateway install" in steps
    status = str(mesh.mesh_server.make_url(path + "/status"))
    assert (await (await mesh.http.get(status)).json())["online"] is False
    # Following the page: the machine joins with the token it gave.
    await mesh.machine.start(mesh.mesh_url, join.group(1))
    await until(lambda: MACHINE in mesh.mesh.peers and MACHINE in mesh.mesh.info)
    assert (await (await mesh.http.get(status)).json()) == {"machine": MACHINE, "online": True, "gateway": True}
    # Once it's in, the page no longer gives the token out.
    again = await (await mesh.http.get(str(mesh.mesh_server.make_url(path)))).text()
    assert join.group(1) not in again and "already joined" in again


async def test_the_setup_lines_fetch_a_script_for_each_os_that_joins_the_machine(mesh):
    await mesh.sign_up()
    lines = (await (await mesh.post("/api/mesh/machines", {"name": MACHINE})).json())["lines"]
    unix, windows = lines["unix"], lines["windows"]
    assert unix.startswith("curl -fsSL https://hub.example.test/mesh/setup/") and unix.endswith("/sh | bash")
    assert windows.startswith("iex (irm https://hub.example.test/mesh/setup/") and windows.endswith("/ps1)")
    base = unix.split("hub.example.test", 1)[1].removesuffix("/sh | bash")
    sh = await (await mesh.http.get(str(mesh.mesh_server.make_url(base + "/sh")))).text()
    ps1 = await (await mesh.http.get(str(mesh.mesh_server.make_url(base + "/ps1")))).text()
    for script in (sh, ps1):
        assert f"install https://example.test/portal.git --ref {'a' * 40} --enable --yes-deps --force" in script
        assert "hermes model" in script and "--if-missing --start-on-login" in script
    token = re.search(r"mesh join \S+ '([^']+)'", sh).group(1)
    assert re.search(rf"mesh join \$Hub '{token}'", ps1)
    await mesh.machine.start(mesh.mesh_url, token)
    await until(lambda: MACHINE in mesh.mesh.peers)
    again = await (await mesh.http.get(str(mesh.mesh_server.make_url(base + "/sh")))).text()
    assert token not in again and "already joined" in again


async def test_machines_join_and_set_up_through_the_portals_own_address(mesh):
    """No private network needed: the public portal app serves the mesh too."""
    await mesh.sign_up()
    lines = (await (await mesh.post("/api/mesh/machines", {"name": MACHINE})).json())["lines"]
    path = lines["unix"].split("hub.example.test", 1)[1].removesuffix(" | bash")
    script = await mesh.http.get(mesh.url(path))
    assert script.status == 200
    token = re.search(r"mesh join \S+ '([^']+)'", await script.text()).group(1)
    await mesh.machine.start(mesh.url("/mesh"), token)
    await until(lambda: MACHINE in mesh.mesh.peers)


async def test_a_portal_that_isnt_a_hub_has_no_mesh_door(world):
    async with aiohttp.ClientSession() as http:
        with pytest.raises(aiohttp.WSServerHandshakeError) as refused:
            await http.ws_connect(world.url("/mesh"), params={"name": MACHINE}, headers={"Authorization": "Bearer x"})
    assert refused.value.status == 404
    assert (await world.http.get(world.url("/mesh/setup/abc/sh"))).status == 404


def test_a_setup_script_refuses_values_that_could_break_out_of_its_quotes():
    from portal.mesh_setup import powershell_script, shell_script

    good = {"hub": "https://hub.example.test", "name": "laptop", "token": "a" * 30, "status": "https://hub.example.test/mesh/setup/x/status", "source": "https://example.test/p.git", "ref": ""}
    for script in (shell_script, powershell_script):
        script(**good)
        for key, bad in (("name", "x'; rm -rf ~; '"), ("token", "a" * 25 + "'$(id)'"), ("hub", "http://h/'`whoami`"), ("source", "https://x/$(id)")):
            with pytest.raises(ValueError):
                script(**{**good, key: bad})


async def test_a_setup_link_stops_working_after_a_day(mesh, monkeypatch):
    await mesh.sign_up()
    prompt = (await (await mesh.post("/api/mesh/machines", {"name": MACHINE})).json())["prompt"]
    later = time.time() + mesh_module.SETUP_TTL + 1
    monkeypatch.setattr(mesh.mesh, "clock", lambda: later)
    _, page = await _setup(mesh, prompt)
    assert page.status == 404
    assert "hermes mesh join" not in await page.text()


async def test_a_made_up_setup_code_gets_nothing(mesh):
    add_node(mesh.mesh_data, MACHINE)
    page = await mesh.http.get(str(mesh.mesh_server.make_url("/mesh/setup/not-a-code")))
    assert page.status == 404


async def test_a_bad_machine_name_is_refused(mesh):
    await mesh.sign_up()
    refused = await mesh.post("/api/mesh/machines", {"name": "My Laptop!"})
    assert refused.status == 400
    shown = await (await mesh.http.get(mesh.url("/api/mesh"))).json()
    assert (shown["hub"], shown["machines"]) == (True, [])


async def test_removing_a_machine_disconnects_it_and_keeps_it_out(mesh):
    await mesh.sign_up()
    await _join(mesh)
    removed = await mesh.post(f"/api/mesh/machines/{MACHINE}/remove")
    assert removed.status == 200, await removed.text()
    await until(lambda: MACHINE not in mesh.mesh.peers)
    await asyncio.sleep(0.3)  # the machine retries with its old token
    assert MACHINE not in mesh.mesh.peers
    assert (await (await mesh.http.get(mesh.url("/api/mesh"))).json())["machines"] == []


async def test_machine_settings_need_sign_in(mesh):
    assert (await mesh.http.get(mesh.url("/api/mesh"))).status == 401
    assert (await mesh.post("/api/mesh/machines", {"name": MACHINE})).status == 401
    assert MACHINE not in mesh_module.load_nodes(mesh.mesh_data)


# Skills


def _skill(root, rel, text="---\nname: x\n---\nbody\n"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


async def test_a_machine_mirrors_the_hubs_skills_except_excluded_ones(mesh, tmp_path, monkeypatch):
    monkeypatch.setattr(mesh_module, "SKILL_POLL", 0.05)
    _skill(mesh.skills, "tools/grep-fast/SKILL.md")
    _skill(mesh.skills, "tools/grep-fast/references/flags.md", "flags")
    _skill(mesh.skills, "tools/DESCRIPTION.md", "tool skills")
    _skill(mesh.skills, "work-only/SKILL.md")
    _skill(mesh.skills, "jobs/work-only/SKILL.md")
    _skill(mesh.skills, ".hub/cache.json", "{}")
    _skill(mesh.skills, "loose-notes.md", "not a skill")
    into = tmp_path / "mirror"
    await _join(mesh, skills_into=into)
    await until(lambda: (into / "tools/grep-fast/references/flags.md").exists())
    files = sorted(p.relative_to(into).as_posix() for p in into.rglob("*") if p.is_file() and p.name != ".mesh-manifest.json")
    assert files == ["tools/DESCRIPTION.md", "tools/grep-fast/SKILL.md", "tools/grep-fast/references/flags.md"]
    # The hub owns them: the copies are read-only, and an edit on the hub replaces them.
    assert not os.stat(into / "tools/grep-fast/SKILL.md").st_mode & stat.S_IWUSR
    _skill(mesh.skills, "tools/grep-fast/SKILL.md", "---\nname: x\n---\nnew body\n")
    await until(lambda: "new body" in (into / "tools/grep-fast/SKILL.md").read_text())
    (mesh.skills / "tools/grep-fast/references/flags.md").unlink()
    await until(lambda: not (into / "tools/grep-fast/references").exists())


async def test_the_mirror_leaves_the_machines_own_skills_alone(tmp_path):
    own = tmp_path / "mirror" / "../own-skill/SKILL.md"
    hub = tmp_path / "hub"
    _skill(hub, "a/SKILL.md")
    manifest = skill_manifest(hub)
    into = tmp_path / "mirror"

    async def fetch(paths):
        return mesh_module.read_skill_files(hub, paths)

    _skill(tmp_path, "own-skill/SKILL.md")
    await mirror_skills(into, {**manifest, "../escape/SKILL.md": "x"}, fetch)
    assert (into / "a/SKILL.md").exists()
    assert not (tmp_path / "escape").exists()
    assert own.resolve().exists()


# A machine whose gateway is down, restarted or updated from the hub


def _state_db(home, session, rows, *, title="Update Hermes", chat="chat-1"):
    """A Hermes session store with one portal chat, laid out like Hermes's own tables."""
    home.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(home / "state.db")
    db.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, chat_id TEXT, title TEXT,
            parent_session_id TEXT, started_at REAL NOT NULL);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
            active INTEGER NOT NULL DEFAULT 1, display_kind TEXT);
        """
    )
    db.execute("INSERT INTO sessions (id, source, chat_id, title, started_at) VALUES (?, 'portal', ?, ?, 1700000000)", (session, chat, title))
    for row in rows:
        db.execute(
            "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session, row["role"], row.get("content"), row.get("tool_call_id"), json.dumps(row["tool_calls"]) if row.get("tool_calls") else None, row.get("tool_name"), row["timestamp"]),
        )
    db.commit()
    db.close()


UPDATE_CHAT = [
    {"role": "user", "content": "run hermes update please", "timestamp": 1_700_000_100},
    {"role": "assistant", "content": "Updating now.", "timestamp": 1_700_000_101,
     "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": "hermes update"})}}]},
    {"role": "tool", "content": json.dumps({"output": "Updating Hermes Agent v0.22.2 -> v0.22.5\nStopping the gateway"}), "tool_call_id": "call-1", "timestamp": 1_700_000_160},
]


def _tools_module(world):
    """The agent's mesh tools, pointed at the hub's loopback API."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("mesh_tools_under_test", Path(__file__).resolve().parents[1] / "mesh_tools.py")
    tools = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tools)
    tools._api = lambda: (str(world.local.make_url("")).rstrip("/"), LOCAL_TOKEN)
    tools.POLL = 0.1
    return tools


async def test_the_hub_reads_a_machines_chat_while_its_gateway_is_down(mesh, tmp_path):
    session = "20261101_120000_aa11bb22"
    home = tmp_path / "laptop-home"
    _state_db(home, session, UPDATE_CHAT)
    mesh.machine.link.offline = Offline(home, projection=False)
    await _join(mesh)
    await mesh.machine.gateway.stop(mesh.machine.hub)
    await until(lambda: mesh.mesh.info[MACHINE]["gateway"] is False)

    remote = f"mesh.{MACHINE}.{session}"
    response = await mesh.http.get(_local(mesh, f"/sessions/{remote}?last=4&tools=5"), headers=AUTH)
    assert response.status == 200, await response.text()
    state = await response.json()
    assert state["gateway"] is False
    assert state["title"] == "Update Hermes"
    assert state["messages"] == [{"role": "user", "text": "run hermes update please"}, {"role": "assistant", "text": "Updating now."}]
    assert [(t["name"], t["context"]) for t in state["tools"]] == [("terminal", "hermes update")]
    assert "v0.22.2 -> v0.22.5" in state["tools"][0]["result"]
    assert state["last_active"] == 1_700_000_160

    # What the hub's agent gets from mesh_read: the gateway is down, and when the chat last moved.
    read = json.loads(await asyncio.to_thread(_tools_module(mesh).TOOL_HANDLERS["mesh_read"], {"session": remote}))
    assert read["gateway"] is False
    assert read["latest_reply"] == "Updating now."
    assert "gateway is down" in read["note"] and "2023-11-14 22:16:00 UTC" in read["note"]
    assert "v0.22.5" in read["tool_calls"][0]["result"]


async def test_the_app_on_the_hub_opens_a_machines_chat_while_its_gateway_is_down(mesh, tmp_path):
    session = "20261101_120000_aa11bb22"
    home = tmp_path / "laptop-home"
    _state_db(home, session, UPDATE_CHAT)
    mesh.machine.link.offline = Offline(home, projection=False)
    await mesh.sign_up()
    await _join(mesh)
    await mesh.machine.gateway.stop(mesh.machine.hub)
    await until(lambda: mesh.mesh.info[MACHINE]["gateway"] is False)
    opened = await mesh.http.get(mesh.url(f"/api/sessions/mesh.{MACHINE}.{session}"))
    assert opened.status == 200, await opened.text()
    shown = (await opened.json())["messages"]
    assert [(m["role"], m.get("text") or m.get("name")) for m in shown] == [("user", "run hermes update please"), ("assistant", "Updating now."), ("tool", "terminal")]
    # The app's rows stay small: tool results are only for agents that ask.
    assert "result" not in shown[-1]


async def test_a_machines_running_task_stops_counting_once_its_gateway_drops(mesh):
    await mesh.sign_up()
    await _join(mesh)
    mesh.machine.hermes.hold = True
    await _run(mesh, "a long job")
    await until(lambda: [r["working"] for r in mesh.mesh.machines()] == [1])
    async with mesh.http.ws_connect(mesh.url("/ws"), headers={"Origin": ORIGIN}) as sticker:
        working = await next_message(sticker, lambda m: m.get("kind") == "status" and m.get("status") == "working")
        # The hub's sticker counts the machine's task with its own chats.
        await next_message(sticker, lambda m: m.get("kind") == "sticker" and m["working"] == 1)
        await mesh.machine.gateway.stop(mesh.machine.hub)
        await until(lambda: mesh.mesh.info[MACHINE]["gateway"] is False)
        # The hub's apps hear the task is gone, so a sticker stops counting it.
        cleared = await next_message(sticker, lambda m: m.get("kind") == "status" and m.get("session") == working["session"])
        assert cleared["status"] is None
        await next_message(sticker, lambda m: m.get("kind") == "sticker" and (m["mood"], m["working"]) == ("idle", 0))
    laptop = next(r for r in await _machines(mesh) if r["name"] == MACHINE)
    assert (laptop["gateway"], laptop["working"]) == (False, 0)


async def test_a_machine_that_leaves_mid_task_stops_counting_on_the_hubs_apps(mesh):
    await mesh.sign_up()
    await _join(mesh)
    mesh.machine.hermes.hold = True
    await _run(mesh, "a long job")
    async with mesh.http.ws_connect(mesh.url("/ws"), headers={"Origin": ORIGIN}) as sticker:
        working = await next_message(sticker, lambda m: m.get("kind") == "status" and m.get("status") == "working")
        await mesh.machine.stop()
        cleared = await next_message(sticker, lambda m: m.get("kind") == "status" and m.get("session") == working["session"])
        assert cleared["status"] is None


@pytest.fixture
def fake_hermes(tmp_path, monkeypatch):
    """A machine's Hermes as the portal server drives it: v0.22.2 installed, v0.22.5 available."""
    state = tmp_path / "fake-hermes"
    state.mkdir()
    (state / "version").write_text(json.dumps({"version": "v0.22.2", "date": "2026.9.1", "channel": "stable", "commit": "1111aaaa2222"}))
    (state / "next").write_text(json.dumps({"version": "v0.22.5", "date": "2026.9.24", "channel": "stable", "commit": "3333bbbb4444"}))
    script = Path(__file__).with_name("fake_machine.py")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    schtasks = bin_dir / "schtasks"
    schtasks.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" schtasks "$@"\n')
    schtasks.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_HERMES_DIR", str(state))
    monkeypatch.setenv("FAKE_HERMES_TOKEN", LOCAL_TOKEN)
    monkeypatch.setenv("FAKE_HERMES_CODE", SERVER_CODE)
    yield {"state": state, "hermes": [sys.executable, str(script), "hermes"]}
    try:
        os.kill(int((state / "gateway.pid").read_text()), 15)
    except (OSError, ValueError):
        pass


async def _join_with_ops(world, fake, tmp_path, monkeypatch, **options):
    ops = MachineOps(tmp_path / "laptop-data", tmp_path / "laptop-home", fake["hermes"], world.machine.hub, python=sys.executable, **options)
    token = add_node(world.mesh_data, MACHINE)
    await world.machine.start(world.mesh_url, token, ops=ops)
    monkeypatch.setenv("FAKE_HERMES_LINK", str(world.machine.local.make_url("/gateway")))
    await until(lambda: MACHINE in world.mesh.peers and MACHINE in world.mesh.info)
    await ops.refresh()
    return ops


def _laptop(rows):
    return next(r for r in rows if r["name"] == MACHINE)


async def test_the_hub_updates_a_machines_hermes_and_its_gateway_comes_back(mesh, fake_hermes, tmp_path, monkeypatch):
    await _join_with_ops(mesh, fake_hermes, tmp_path, monkeypatch, platform="posix")
    await until(lambda: (_laptop(mesh.mesh.machines())["hermes"] or {}).get("version") == "v0.22.2")
    # The update stops the gateway on its way, like the gateway the user lost.
    await mesh.machine.gateway.stop(mesh.machine.hub)
    started = await mesh.http.post(_local(mesh, f"/mesh/machines/{MACHINE}/update"), json={}, headers=AUTH)
    assert started.status == 200, await started.text()

    async def finished():
        state = await (await mesh.http.get(_local(mesh, f"/mesh/machines/{MACHINE}/job"), headers=AUTH)).json()
        return state if state["job"]["status"] not in ("starting", "running") and state["gateway"] else None

    state = None
    for _ in range(300):
        state = await finished()
        if state:
            break
        await asyncio.sleep(0.05)
    assert state, "the update never finished with the gateway back"
    job = state["job"]
    assert job["status"] == "done"
    assert (job["old"]["version"], job["new"]["version"]) == ("v0.22.2", "v0.22.5")
    assert "Updating Hermes Agent v0.22.2 -> v0.22.5" in job["log_tail"]
    # The hub's machine list shows the new version once the machine reads it again.
    await until(lambda: (_laptop(mesh.mesh.machines())["hermes"] or {}).get("commit") == "3333bbbb4444")
    assert _laptop(mesh.mesh.machines())["gateway"] is True


async def test_mesh_restart_gateway_brings_a_dead_gateway_back_through_the_windows_task(mesh, fake_hermes, tmp_path, monkeypatch):
    # On Windows the gateway may only start through its scheduled task: a direct start fails here.
    monkeypatch.setenv("FAKE_HERMES_NO_DIRECT", "1")
    await _join_with_ops(mesh, fake_hermes, tmp_path, monkeypatch, platform="windows")
    await mesh.machine.gateway.stop(mesh.machine.hub)
    await until(lambda: _laptop(mesh.mesh.machines())["gateway"] is False)
    tools = _tools_module(mesh)
    result = json.loads(await asyncio.to_thread(tools.TOOL_HANDLERS["mesh_restart_gateway"], {"machine": MACHINE, "wait_seconds": 20}))
    assert result["gateway"] is True, result
    assert result["status"] == "done"
    assert result["hermes_now"].startswith("Hermes Agent v0.22.2")
    assert _laptop(mesh.mesh.machines())["gateway"] is True


async def test_a_machines_server_brings_its_gateway_back_when_it_stays_away(mesh, fake_hermes, tmp_path, monkeypatch):
    ops = await _join_with_ops(mesh, fake_hermes, tmp_path, monkeypatch, platform="posix", watchdog=True, grace=0.2)
    # `hermes update` run inside a chat there: the gateway stops and nothing restarts it.
    await mesh.machine.gateway.stop(mesh.machine.hub)
    await until(lambda: _laptop(mesh.mesh.machines())["gateway"] is False)
    await until(lambda: _laptop(mesh.mesh.machines())["gateway"] is True, timeout=15)
    assert ops.job()["job"]["kind"] == "start"


async def test_the_hub_cant_update_itself_or_a_machine_that_isnt_there(mesh):
    for machine, status in (("hub", 400), ("toaster", 400)):
        response = await mesh.http.post(_local(mesh, f"/mesh/machines/{machine}/update"), json={}, headers=AUTH)
        assert response.status == status, machine
    await _join(mesh)
    await mesh.machine.stop()
    mesh.machine.task = None
    await until(lambda: MACHINE not in mesh.mesh.peers)
    gone = await mesh.http.post(_local(mesh, f"/mesh/machines/{MACHINE}/gateway/restart"), json={}, headers=AUTH)
    assert gone.status == 503
