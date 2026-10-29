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
    plugin._LIVE_TOOLS.update(link=world.client, loop=asyncio.get_running_loop())
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


# What Hermes puts before a request it restates after compacting a chat mid-turn.
RESTATED = "[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]"


async def test_a_chat_opened_after_a_mid_turn_compaction_keeps_the_conversation_and_the_turns_progress(world):
    sid = world.hermes.add_session(
        "20261025_121212_eeeeee", "premio", messages=[("user", "list the sftp folders"), ("assistant", "13 folders, mostly order files")]
    )
    plugin, hooks = plugin_hooks()
    plugin._LIVE_TOOLS.update(link=world.client, loop=asyncio.get_running_loop())
    compacted, release = asyncio.Event(), asyncio.Event()

    async def turn(chat, session):
        await world.hub.turn_started(chat)
        await world.hub.outgoing(chat, "progress-1", "pulling a few samples first")
        world.hermes._row(session, "assistant", "pulling a few samples first")
        await asyncio.to_thread(hooks["pre_tool_call"], tool_name="process", args={"action": "wait"}, session_id=session, tool_call_id="call-1")
        # Hermes compacts the context: the display read keeps every row and adds the restated request.
        world.hermes._row(session, "user", RESTATED + "\nyes, push it to the wms")
        compacted.set()
        await release.wait()
        await asyncio.to_thread(hooks["post_tool_call"], tool_name="process", args={}, session_id=session, tool_call_id="call-1")
        await asyncio.to_thread(hooks["pre_tool_call"], tool_name="terminal", args={"command": "bun test"}, session_id=session, tool_call_id="call-2")
        world.hermes._row(session, "assistant", "pushed")
        await world.hub.turn_finished(chat, "success")

    world.hermes._turn = turn
    await world.sign_up()
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "yes, push it to the wms"}, headers={"Origin": ORIGIN})
    await asyncio.wait_for(compacted.wait(), 5)

    # A tab that opens the chat now sees the whole conversation, the request once as sent, and
    # the turn's progress so far: the line it wrote and the call it's waiting on.
    async def opened_with_tool():
        while True:
            opened = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
            if opened.get("live", {}).get("tools"):
                return opened
            await asyncio.sleep(0.02)

    opened = await asyncio.wait_for(opened_with_tool(), 5)
    assert [(m["role"], m["text"]) for m in opened["messages"]] == [
        ("user", "list the sftp folders"),
        ("assistant", "13 folders, mostly order files"),
        ("user", "yes, push it to the wms"),
        ("assistant", "pulling a few samples first"),
    ]
    assert opened["running"] is True
    assert opened["live"]["messages"] == [{"id": "progress-1", "text": "pulling a few samples first", "after": 0}]
    assert [(t["id"], t["name"], t["state"]) for t in opened["live"]["tools"]] == [("call-1", "process", "running")]

    # And the rest of the turn keeps streaming to it.
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)
    release.set()
    calls = [await next_message(ws, lambda m: m.get("type") == "tool") for _ in range(2)]
    assert [(c["payload"]["id"], c["payload"]["state"]) for c in calls] == [("call-1", "done"), ("call-2", "running")]
    await next_message(ws, lambda m: m.get("type") == "message.complete")
    after = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
    assert "live" not in after and after["messages"][-1]["text"] == "pushed"
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


async def test_nakos_own_sign_off_is_shown_beside_her_and_hidden_from_the_reply(world):
    sid = world.hermes.add_session("20261025_121212_eeeeee", "fix", messages=[("user", "fix the importer")])
    world.hermes.reply = "fixed the blank-line bug in the importer.\n\n<signoff>one reader for both, finally</signoff>"
    world.hermes.sign_off_error = AssertionError("the small model must not run when she wrote her own")
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)

    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "go"}, headers={"Origin": ORIGIN})
    live = await next_message(ws, lambda m: m.get("type") == "gateway.message")
    assert live["payload"]["text"] == "fixed the blank-line bug in the importer."
    said = await next_message(ws, lambda m: m.get("type") == "signoff")
    assert said["payload"]["text"] == "one reader for both, finally"
    await ws.close()

    opened = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
    assert opened["messages"][-1]["text"] == "fixed the blank-line bug in the importer."
    assert world.alerts[-1][2] == "fixed the blank-line bug in the importer."


def test_a_sign_off_still_streaming_in_never_shows():
    from portal.hub import split_sign_off

    for partial in ("done.\n<", "done.\n<sign", "done.\n<signoff>", "done.\n<signoff>quietly pro"):
        assert split_sign_off(partial) == ("done.", None)
    assert split_sign_off("a < b and c") == ("a < b and c", None)


async def test_the_sign_off_is_about_the_saved_reply_even_when_its_send_lands_late(world):
    sid = world.hermes.add_session("20261025_131313_ffffff", "late", messages=[("user", "earlier"), ("assistant", "an older reply")])
    world.hermes.reply = "the new reply"
    world.hermes.send_late = True
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "go"}, headers={"Origin": ORIGIN})
    said = await next_message(ws, lambda m: m.get("type") == "signoff")
    assert said["payload"]["text"] == "proud of: the new reply"
    await ws.close()
