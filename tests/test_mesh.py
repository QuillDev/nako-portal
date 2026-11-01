"""Other machines in the portal's mesh: a hub portal and a machine's portal, each with its own
fake gateway, joined over the real mesh socket."""

from __future__ import annotations

import asyncio
import os
import re
import stat
import time

import aiohttp
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestServer

from conftest import LOCAL_TOKEN, ORIGIN, SERVER_CODE, FakeGateway, Gateway, next_message, until
from portal import mesh as mesh_module
from portal.hub import Hub
from portal.link import GatewayLink
from portal.mesh import Mesh, Node, add_node, mirror_skills, remove_node, skill_manifest
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

    async def start(self, url, token, name=MACHINE, skills_into=None):
        self.local = TestServer(self.portal.local_app(LOCAL_TOKEN, self.link))
        await self.local.start_server()
        self.gateway = Gateway(self.hermes, self.local, self.http)
        await self.gateway.start(self.hub)
        self.node = Node(url, name, token, self.hub, skills_into=skills_into)
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
    world.mesh = Mesh(data, world.hub, address="http://100.64.0.1:8799", plugin={"source": "https://example.test/portal.git", "ref": "a" * 40}, skills_dir=skills, skills_exclude=["work-only"], store=world.store)
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
    assert [(r["name"], r["online"], r["gateway"]) for r in rows] == [(MACHINE, True, True)]
    assert rows[0]["hostname"]


async def test_a_machine_with_a_wrong_token_is_refused(mesh):
    add_node(mesh.mesh_data, MACHINE)
    async with aiohttp.ClientSession() as http:
        with pytest.raises(aiohttp.WSServerHandshakeError) as refused:
            await http.ws_connect(mesh.mesh_url, params={"name": MACHINE}, headers={"Authorization": "Bearer nope"})
    assert refused.value.status == 401
    assert [(r["name"], r["online"]) for r in await _machines(mesh)] == [(MACHINE, False)]


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
    rows = await _machines(mesh)
    assert rows[0]["online"] is False and rows[0]["last_seen"]
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


async def test_the_hub_cant_take_its_own_name_for_a_machine(mesh):
    await mesh.sign_up()
    refused = await mesh.post("/api/mesh/machines", {"name": "hub"})
    assert refused.status == 400


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
    assert command.startswith(f"hermes mesh join http://100.64.0.1:8799 ") and command.endswith(f"--name {MACHINE}")
    token = command.split()[4]
    await mesh.machine.start(mesh.mesh_url, token)
    await until(lambda: MACHINE in mesh.mesh.peers)
    again = await mesh.post("/api/mesh/machines", {"name": MACHINE})
    assert again.status == 400


async def _setup(world, prompt):
    url = re.search(r"curl -fsSL (\S+)`", prompt).group(1)
    assert "curl.exe on Windows" in prompt
    # The hub's real mesh address isn't this test server's; same path, though.
    path = url.split("8799", 1)[1]
    return path, await world.http.get(str(world.mesh_server.make_url(path)))


async def test_one_line_setup_tells_a_stock_hermes_everything_and_the_machine_joins(mesh):
    await mesh.sign_up()
    prompt = (await (await mesh.post("/api/mesh/machines", {"name": MACHINE})).json())["prompt"]
    assert "\n" not in prompt and prompt.startswith(f'Set this machine up as "{MACHINE}"')
    path, page = await _setup(mesh, prompt)
    assert page.status == 200
    steps = await page.text()
    assert f"hermes plugins install https://example.test/portal.git --ref {'a' * 40} --enable --yes-deps --force" in steps
    join = re.search(rf"hermes mesh join http://100.64.0.1:8799 (\S+) --name {MACHINE}", steps)
    assert join and "hermes gateway install" in steps
    status = str(mesh.mesh_server.make_url(path + "/status"))
    assert (await (await mesh.http.get(status)).json())["online"] is False
    # Following the page: the machine joins with the token it gave.
    await mesh.machine.start(mesh.mesh_url, join.group(1))
    await until(lambda: MACHINE in mesh.mesh.peers)
    assert (await (await mesh.http.get(status)).json()) == {"machine": MACHINE, "online": True}
    # Once it's in, the page no longer gives the token out.
    again = await (await mesh.http.get(str(mesh.mesh_server.make_url(path)))).text()
    assert join.group(1) not in again and "already joined" in again


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
    assert await (await mesh.http.get(mesh.url("/api/mesh"))).json() == {"hub": True, "name": "hub", "address": "http://100.64.0.1:8799", "machines": []}


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
