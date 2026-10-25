import asyncio
import importlib.util
from pathlib import Path

from conftest import ORIGIN, next_message

ROOT = Path(__file__).resolve().parents[1]


def plugin_hooks():
    spec = importlib.util.spec_from_file_location("nako_portal_live_tools_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)

    class Ctx:
        hooks = {}

        def register_hook(self, name, callback):
            self.hooks[name] = callback

        def register_platform(self, **entry):
            pass

    ctx = Ctx()
    plugin.register(ctx)
    return plugin, ctx.hooks


async def test_tool_calls_in_a_running_turn_reach_the_open_chat_live(world):
    sid = world.hermes.add_session("20261025_101010_cccccc", "flaky ci", messages=[("user", "why is shard 3 red")])
    plugin, hooks = plugin_hooks()
    plugin._LIVE_TOOLS.update(hub=world.hub, loop=asyncio.get_running_loop())
    release = asyncio.Event()

    async def turn(chat, session):
        await world.hub.turn_started(chat)
        # The agent runs tools on its own thread, like Hermes does.
        await asyncio.to_thread(hooks["pre_tool_call"], tool_name="terminal", args={"command": "gh run list"}, session_id=session, tool_call_id="call-1")
        await asyncio.to_thread(hooks["post_tool_call"], tool_name="terminal", args={"command": "gh run list"}, session_id=session, tool_call_id="call-1", status="error")
        await release.wait()
        await world.hub.turn_finished(chat, "success")

    world.hermes._turn = turn
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "look again"}, headers={"Origin": ORIGIN})

    started = await next_message(ws, lambda m: m.get("type") == "tool")
    ended = await next_message(ws, lambda m: m.get("type") == "tool")
    assert [(e["session"], e["payload"]["id"], e["payload"]["name"], e["payload"]["state"]) for e in (started, ended)] == [
        (sid, "call-1", "terminal", "running"),
        (sid, "call-1", "terminal", "failed"),
    ]
    release.set()
    await next_message(ws, lambda m: m.get("type") == "message.complete")

    # Outside a turn (another surface's agent, a finished chat) nothing is sent.
    await asyncio.to_thread(hooks["pre_tool_call"], tool_name="terminal", args={}, session_id=sid, tool_call_id="call-2")
    try:
        stray = await next_message(ws, lambda m: m.get("type") == "tool", timeout=0.3)
    except asyncio.TimeoutError:
        stray = None
    assert stray is None
    await ws.close()


async def test_a_finished_reply_gets_nakos_sign_off_and_a_failed_one_is_just_skipped(world):
    sid = world.hermes.add_session("20261025_111111_dddddd", "rename", messages=[("user", "rename the job")])
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)

    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "go"}, headers={"Origin": ORIGIN})
    await next_message(ws, lambda m: m.get("type") == "message.complete")
    said = await next_message(ws, lambda m: m.get("type") == "signoff")
    assert (said["session"], said["payload"]["text"]) == (sid, "proud of: hello from hermes")

    # The model being down costs only the line; the turn still finishes and nothing else is sent.
    world.hermes.sign_off_error = RuntimeError("provider down")
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "again"}, headers={"Origin": ORIGIN})
    await next_message(ws, lambda m: m.get("type") == "message.complete")
    try:
        stray = await next_message(ws, lambda m: m.get("type") == "signoff", timeout=0.3)
    except asyncio.TimeoutError:
        stray = None
    assert stray is None
    await ws.close()


async def test_the_sign_off_can_be_turned_off_and_moved_to_another_model_from_settings(world):
    sid = world.hermes.add_session("20261025_121212_eeeeee", "rename", messages=[("user", "rename the job")])
    await world.sign_up()
    shown = await (await world.http.get(world.url("/api/signoff"))).json()
    assert (shown["on"], shown["provider"], shown["model"]) == (True, "auto", "")
    assert shown["providers"] == [{"provider": "fast", "label": "Fast Co", "models": ["tiny", "small"]}]

    picked = await world.post("/api/signoff", {"provider": "fast", "model": "small"})
    assert (await picked.json())["model"] == "small"
    assert world.hermes.sign_off_route == {"provider": "fast", "model": "small"}
    refused = await world.post("/api/signoff", {"provider": "fast", "model": "huge"})
    assert refused.status == 400
    assert world.hermes.sign_off_route == {"provider": "fast", "model": "small"}

    await world.post("/api/signoff", {"on": False})
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "go"}, headers={"Origin": ORIGIN})
    await next_message(ws, lambda m: m.get("type") == "message.complete")
    try:
        stray = await next_message(ws, lambda m: m.get("type") == "signoff", timeout=0.3)
    except asyncio.TimeoutError:
        stray = None
    assert stray is None
    # Off stays off for every device and across restarts: the server keeps it.
    assert world.store.meta("signoff") == "off"
    assert (await (await world.http.get(world.url("/api/signoff"))).json())["on"] is False
    await ws.close()
