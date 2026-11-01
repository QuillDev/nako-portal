"""A background process that finishes in a portal thread wakes that thread's agent.

Runs against the real gateway where Hermes is installed; CI has no Hermes and skips.
"""

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_plugin():
    spec = importlib.util.spec_from_file_location("nako_portal_wake_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


class Ctx:
    def register_hook(self, name, callback):
        pass

    def register_platform(self, **entry):
        self.entry = entry


async def gateway(tmp_path, monkeypatch):
    """A real gateway runner and session authority with the portal platform registered."""
    pytest.importorskip("gateway.session_authority")
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry
    from gateway.run import GatewayRunner
    from gateway.session_authority import SessionAuthority, initialize_session_authority
    from gateway.session_ingress_context import register_transport_home
    from hermes_state import SessionDB

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(SessionAuthority, "_schedule", lambda self, ref: None)
    plugin = load_plugin()
    ctx = Ctx()
    plugin.register(ctx)
    entry = {k: v for k, v in ctx.entry.items() if k in PlatformEntry.__dataclass_fields__}
    platform_registry.register(PlatformEntry(source="plugin", **entry))
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / "sessions"))
    db = SessionDB(tmp_path / "state.db")
    runner.session_store._db = db
    runner._session_db = db
    authority = await initialize_session_authority(runner, profile_id="default", instance_id="wake-test", db=db)
    adapter = ctx.entry["adapter_factory"](PlatformConfig(enabled=True))
    runner.adapters = {Platform("portal"): adapter}
    runner._wire_adapter_handlers(adapter)
    register_transport_home(runner, None, tmp_path)
    return plugin, runner, authority, adapter


async def say(runner, authority, adapter, chat, text):
    """What the portal's inbound path hands the gateway when its person types in ``chat``."""
    from gateway.platforms.event import MessageEvent
    from gateway.session_ingress_context import native_callback

    # The portal's own inbound identity, as of the releases before PERSON existed.
    source = adapter.build_source(chat_id=chat, chat_name="Nako", chat_type="dm", user_id="owner", user_name="you")
    event = MessageEvent(text=text, source=source, message_id="m-" + text)
    with native_callback(runner, event, runner.session_store.sessions_dir.parent):
        await authority.admit_native(event)


async def wake(runner, authority, adapter, plugin, chat, process="proc_1"):
    """Admit what the process watcher sends when a background process in ``chat`` finishes: it
    rebuilds the thread's source from the stored session, as it does after a gateway restart."""
    from gateway.platforms.event import MessageEvent

    key = runner.session_store._generate_session_key(plugin._source(chat))
    source = runner._build_process_event_source({"session_key": key})
    metadata = {"gateway_session_key": key, "gateway_session_id": runner.session_store.peek_session_id(key)}
    event = MessageEvent(text=f"[IMPORTANT: Background process {process} completed]", source=source,
                         internal=True, metadata=metadata)
    return await authority.admit_automation(adapter, event, process)


@pytest.mark.asyncio
async def test_a_finished_background_process_wakes_a_thread_opened_before_its_first_message(tmp_path, monkeypatch):
    plugin, runner, authority, adapter = await gateway(tmp_path, monkeypatch)
    try:
        # A new portal chat, nako-spawn thread or Notifications exists before anything is said in it.
        plugin._ensure_chat(runner.session_store, "thread1", "watch ci")
        await say(runner, authority, adapter, "thread1", "watch ci for me")
        assert (await wake(runner, authority, adapter, plugin, "thread1")).admission_id
    finally:
        authority.db.close()


@pytest.mark.asyncio
async def test_a_thread_stored_by_an_older_release_is_woken_after_the_portal_connects(tmp_path, monkeypatch):
    plugin, runner, authority, adapter = await gateway(tmp_path, monkeypatch)
    from gateway.session import SessionSource

    try:
        old = SessionSource(platform=plugin._source("old").platform, chat_id="old", chat_type="dm", chat_name="Nako")
        runner.session_store.get_or_create_session(old, touch_activity=False)
        await say(runner, authority, adapter, "old", "watch ci for me")
        plugin._own_origins(runner.session_store)
        assert (await wake(runner, authority, adapter, plugin, "old")).admission_id
        # The repair is saved, so a restarted gateway reads the same thread back.
        runner.session_store._entries.clear()
        runner.session_store._loaded = False
        assert (await wake(runner, authority, adapter, plugin, "old", "proc_2")).admission_id
    finally:
        authority.db.close()
