import aiohttp
import pytest

from conftest import ORIGIN, next_message

pytestmark = pytest.mark.asyncio


async def ids(world):
    return {row["id"] for row in await (await world.http.get(world.url("/api/sessions"))).json()}


async def test_switching_profiles_shows_only_that_profiles_chats(world):
    await world.sign_up()
    world.hermes.add_session("work", "work chat", profile="default")
    world.hermes.add_session("home", "home chat", profile="work")

    shown = await (await world.http.get(world.url("/api/profile"))).json()
    assert shown == {"profile": "default", "profiles": ["default", "work", "research"]}
    assert await ids(world) == {"work"}

    switched = await world.post("/api/profile", {"profile": "work"})
    assert (await switched.json())["profile"] == "work"
    assert await ids(world) == {"home"}
    # The other profile's chats can't be opened or written to either.
    assert (await world.http.get(world.url("/api/sessions/work"))).status != 200
    sent = await world.http.post(world.url("/api/sessions/work/messages"), data=aiohttp.FormData({"text": "hi"}), headers={"Origin": ORIGIN})
    assert sent.status != 200
    assert world.hermes.received == []

    await world.post("/api/profile", {"profile": "default"})
    assert await ids(world) == {"work"}


async def test_a_new_chat_belongs_to_the_profile_on_screen(world):
    await world.sign_up()
    await world.post("/api/profile", {"profile": "work"})
    form = aiohttp.FormData({"text": "plan my weekend"})
    created = await (await world.http.post(world.url("/api/sessions"), data=form, headers={"Origin": ORIGIN})).json()
    assert await ids(world) == {created["session"]}

    await world.post("/api/profile", {"profile": "default"})
    assert created["session"] not in await ids(world)


async def test_an_unknown_profile_is_refused_and_nothing_changes(world):
    await world.sign_up()
    world.hermes.add_session("work", "work chat", profile="default")
    refused = await world.post("/api/profile", {"profile": "nope"})
    assert refused.status == 400
    assert (await (await world.http.get(world.url("/api/profile"))).json())["profile"] == "default"
    assert await ids(world) == {"work"}


async def test_the_chosen_profile_survives_a_gateway_restart(world):
    await world.sign_up()
    await world.post("/api/profile", {"profile": "work"})

    await world.gateway.stop(world.hub)
    world.hermes.profile = "default"  # a fresh gateway starts on the default profile
    await world.gateway.start(world.hub)
    assert world.hermes.profile == "work"


async def test_every_open_tab_hears_about_a_switch(world):
    await world.sign_up()
    async with world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN}) as ws:
        await world.post("/api/profile", {"profile": "work"})
        frame = await next_message(ws, lambda m: m.get("kind") == "profile.changed")
        assert frame["profile"] == "work"


async def test_switching_needs_a_signed_in_person(world):
    async with aiohttp.ClientSession() as stranger:
        refused = await stranger.post(world.url("/api/profile"), json={"profile": "work"}, headers={"Origin": ORIGIN})
        assert refused.status == 401
    assert world.hermes.profile == "default"


async def test_each_profile_keeps_its_own_model(world):
    await world.sign_up()
    picked = await world.post("/api/model", {"provider": "big", "model": "large"})
    assert picked.status == 200
    assert {k: (await picked.json())[k] for k in ("provider", "model")} == {"provider": "big", "model": "large"}

    await world.post("/api/profile", {"profile": "work"})
    work = await (await world.http.get(world.url("/api/model"))).json()
    assert (work["provider"], work["model"]) == ("fast", "tiny")
    assert work["providers"][1]["models"] == ["large"]

    await world.post("/api/profile", {"profile": "default"})
    back = await (await world.http.get(world.url("/api/model"))).json()
    assert (back["provider"], back["model"]) == ("big", "large")
    tuned = await world.post("/api/model", {"effort": "high", "speed": "normal"})
    assert tuned.status == 200
    assert ((await tuned.json())["effort"], (await tuned.json())["speed"]) == ("high", "normal")


async def test_a_model_hermes_refuses_changes_nothing(world):
    await world.sign_up()
    refused = await world.post("/api/model", {"provider": "fast", "model": "imaginary"})
    assert refused.status == 400
    assert "not found" in (await refused.json())["error"]
    current = await (await world.http.get(world.url("/api/model"))).json()
    assert (current["provider"], current["model"]) == ("fast", "tiny")


async def test_changing_a_model_needs_a_signed_in_person(world):
    async with aiohttp.ClientSession() as stranger:
        refused = await stranger.post(world.url("/api/model"), json={"provider": "big", "model": "large"}, headers={"Origin": ORIGIN})
        assert refused.status == 401
    assert world.hermes.profile_models == {}


async def test_chat_selection_never_changes_the_default_or_another_chat(world):
    await world.sign_up()
    world.hermes.add_session("one", "one")
    world.hermes.add_session("two", "two")
    path = "/api/sessions/one/model"
    picked = await world.post(path, {"provider": "big", "model": "large", "effort": "high", "speed": "fast"})
    assert picked.status == 200
    assert (await picked.json())["overridden"] is True
    default = await (await world.http.get(world.url("/api/model"))).json()
    other = await (await world.http.get(world.url("/api/sessions/two/model"))).json()
    assert (default["provider"], default["model"]) == ("fast", "tiny")
    assert (other["provider"], other["model"], other["overridden"]) == ("fast", "tiny", False)
    await world.post("/api/model", {"provider": "fast", "model": "small"})
    current = await (await world.http.get(world.url(path))).json()
    assert (current["model"], current["effort"], current["speed"]) == ("large", "high", "fast")
    reset = await world.post(path, {"reset": True})
    assert reset.status == 200
    assert ((await reset.json())["model"], (await reset.json())["overridden"]) == ("small", False)


async def test_a_new_chats_first_message_uses_its_selection_without_changing_defaults(world):
    import json

    await world.sign_up()
    first_turn_models = []
    inbound = world.hermes.inbound

    async def receive(chat, text, files):
        first_turn_models.append(world.hermes.session_model(world.hermes.session_of(chat)))
        await inbound(chat, text, files)

    world.hermes.inbound = receive
    chosen = {"provider": "big", "model": "large", "effort": "high", "speed": "fast"}
    created = await world.http.post(world.url("/api/sessions"), data={"text": "plan my weekend", "model": json.dumps(chosen)}, headers={"Origin": ORIGIN})
    assert created.status == 200
    sid = (await created.json())["session"]
    selected = await (await world.http.get(world.url(f"/api/sessions/{sid}/model"))).json()
    assert {k: selected[k] for k in chosen} == chosen
    assert {k: first_turn_models[0][k] for k in chosen} == chosen
    assert world.hermes.sessions[sid]["rows"][0]["text"] == "plan my weekend"
    default = await (await world.http.get(world.url("/api/model"))).json()
    assert (default["provider"], default["model"]) == ("fast", "tiny")

    # Bad picks must never start a turn on a different model.
    refused = await world.http.post(world.url("/api/sessions"), data={"text": "do not send", "model": json.dumps({"provider": "big", "model": "imaginary"})}, headers={"Origin": ORIGIN})
    assert refused.status == 400
    assert len(world.hermes.received) == 1


async def test_chat_settings_reject_invalid_busy_foreign_and_unsigned_writes(world):
    await world.sign_up()
    world.hermes.add_session("one", "one")
    world.hermes.add_session("foreign", "foreign", profile="work")
    path = "/api/sessions/one/model"
    for body in ({"effort": "imaginary"}, {"speed": "warp"}, {"provider": "fast", "model": "imaginary"}):
        assert (await world.post(path, body)).status == 400
    world.hub.running.add("one")
    assert (await world.post(path, {"effort": "high"})).status == 409
    world.hub.running.discard("one")
    assert (await world.post("/api/sessions/foreign/model", {"effort": "high"})).status == 404
    async with aiohttp.ClientSession() as stranger:
        assert (await stranger.post(world.url(path), json={"effort": "high"}, headers={"Origin": ORIGIN})).status == 401
    current = await (await world.http.get(world.url(path))).json()
    assert current["overridden"] is False


async def test_real_gateway_keeps_chat_model_and_tuning_after_reload(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from test_process_wake import gateway
    pytest.importorskip("gateway.run")
    import hermes_cli.model_switch as switching
    import importlib.util
    import os
    import sys
    from pathlib import Path

    root = Path(os.environ.get("MODEL_CONTROLS_SOURCE", ""))
    if not (root / "plugin.yaml").is_file():
        pytest.skip("Set MODEL_CONTROLS_SOURCE to exercise the standalone plugin")
    spec = importlib.util.spec_from_file_location("model_controls_test", root / "__init__.py", submodule_search_locations=[str(root)])
    assert spec is not None and spec.loader is not None
    controls = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = controls
    spec.loader.exec_module(controls)
    monkeypatch.setitem(sys.modules, "model_controls", controls.api)

    plugin, runner, authority, adapter = await gateway(tmp_path, monkeypatch)
    try:
        (tmp_path / "config.yaml").write_text("model:\n  provider: openai\n  default: gpt-5\nagent:\n  reasoning_effort: medium\n  service_tier: fast\n")
        backend = plugin.HermesBackend(adapter, tmp_path)
        adapter.backend = backend
        adapter.gateway_runner = runner
        # Only model-provider resolution is substituted; all session routing and persistence are real.
        monkeypatch.setattr(switching, "switch_model", lambda **kw: switching.ModelSwitchResult(success=True,
            new_model=kw["raw_input"], target_provider="openai", api_key="test-provider-key", base_url="https://api.openai.com/v1",
            api_mode="chat_completions", request_overrides={}, runtime_capabilities={}, provider_label="OpenAI"))
        sid = backend.ensure_chat("one", "one")
        other = backend.ensure_chat("two", "two")
        before = (tmp_path / "config.yaml").read_bytes()
        selected = await backend.set_session_model(sid, {"provider": "openai", "model": "gpt-5-mini", "effort": "high", "speed": "normal"})
        assert (selected["model"], selected["effort"], selected["speed"]) == ("gpt-5-mini", "high", "normal")
        assert backend.session_model(other)["model"] == "gpt-5"
        assert (tmp_path / "config.yaml").read_bytes() == before
        key = runner._session_key_for_source(plugin._source("one"))
        runner._session_state(key).conversation.model_override = None
        runner._set_session_reasoning_override(key, None)
        runner._set_session_service_tier_override(key, None, clear=True)
        await adapter.on_processing_start(SimpleNamespace(source=plugin._source("one")))
        assert backend.session_model(sid)["model"] == "gpt-5-mini"
        with backend._profile_scope():
            assert runner._resolve_session_reasoning_config(session_key=key, model="gpt-5-mini")["effort"] == "high"
            assert runner._resolve_session_service_tier(session_key=key) is None
        backend.set_model_options({"provider": "openai", "model": "gpt-5-nano"})
        assert backend.model()["model"] == "gpt-5-nano"
        assert backend.session_model(sid)["model"] == "gpt-5-mini"
        assert backend.session_model(other)["model"] == "gpt-5-nano"
        # This is the actual next-turn route resolver, not just what the picker displays.
        import gateway.run as runtime
        monkeypatch.setattr(runtime, "_resolve_runtime_agent_kwargs", lambda: {
            "provider": "openai", "api_key": "test-provider-key", "base_url": "https://api.openai.com/v1"})
        monkeypatch.setattr(runtime, "_resolve_runtime_agent_kwargs_for_provider", lambda *a, **kw: {
            "provider": "openai", "api_key": "test-provider-key", "base_url": "https://api.openai.com/v1"})
        with backend._profile_scope():
            from hermes_cli.config import load_config
            pinned_model, _ = runner._resolve_session_agent_runtime(source=plugin._source("one"), user_config=load_config())
            following_model, _ = runner._resolve_session_agent_runtime(source=plugin._source("two"), user_config=load_config())
        assert (pinned_model, following_model) == ("gpt-5-mini", "gpt-5-nano")
        backend.set_model_options({"provider": "openai", "model": "gpt-5"})
        before = (tmp_path / "config.yaml").read_bytes()
        await backend.set_session_model(sid, {"reset": True})
        assert backend.session_model(sid)["model"] == "gpt-5"
        assert backend.session_model(sid)["overridden"] is False
        assert backend.session_model(sid)["speed"] == "fast"
        assert (tmp_path / "config.yaml").read_bytes() == before
        changed = backend.set_model_options({"effort": "low", "speed": "normal"})
        assert (changed["effort"], changed["speed"]) == ("low", "normal")
        assert backend.session_model(sid)["effort"] == "low"
        import hermes_cli.model_selection_guards as guards
        monkeypatch.setattr(guards, "selection_warnings", lambda *a, **kw: [guards.SelectionWarning(
            "cost", "Cost", "gpt-5-mini", "openai", "This selection costs more.")])
        request = {"provider": "openai", "model": "gpt-5-mini"}
        warning = await backend.set_session_model(sid, request)
        assert warning["message"] == "This selection costs more."
        assert backend.session_model(sid)["model"] == "gpt-5"
        confirmed = await backend.set_session_model(sid, {**request, "confirm": warning["confirmation"]})
        assert confirmed["model"] == "gpt-5-mini"
        monkeypatch.delitem(sys.modules, "model_controls")
        assert backend.model() is None
        assert backend.session_model(sid) is None
        assert backend.models() == []
        await adapter.on_processing_start(SimpleNamespace(source=plugin._source("one")))
        assert backend.thread(sid) is not None
    finally:
        authority.db.close()


async def test_portal_keeps_working_without_model_controls(world):
    await world.sign_up()
    world.hermes.add_session("one", "one")
    world.hermes.model_controls = False
    for path in ("/api/model", "/api/sessions/one/model"):
        assert (await world.http.get(world.url(path))).status == 404
        assert (await world.post(path, {"provider": "big", "model": "large"})).status == 404
    assert world.hermes.profile_models == {}
    assert (await world.http.get(world.url("/api/sessions/one"))).status == 200
    assert (await world.http.get(world.url("/api/profile"))).status == 200
    response = await world.http.post(world.url("/api/sessions/one/messages"), data={"text": "hello"}, headers={"Origin": ORIGIN})
    assert response.status == 200
    assert world.hermes.received[-1][1] == "hello"
