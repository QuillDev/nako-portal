"""A message typed in another profile's chat reaches that profile's agent, and its reply comes back.

The gateway only accepts a turn in a profile from the portal adapter that profile owns, so the
default adapter (the one linked to the server) hands such messages to the other profile's adapter,
which sends its replies back through the link. Runs against the real gateway where Hermes is
installed; CI has no Hermes and skips.
"""

import importlib.util
import weakref
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

pytest.importorskip("gateway.session_ingress_context")


def load_plugin():
    spec = importlib.util.spec_from_file_location("nako_portal_routing_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


class Ctx:
    def register_hook(self, name, callback):
        pass

    def register_platform(self, **entry):
        self.entry = entry


class Link:
    """The server's end, as the gateway half sees it: what was told, in order."""

    peer = object()

    def __init__(self):
        self.told = []

    def tell(self, *args):
        self.told.append(args)

    async def call(self, *args):
        self.told.append(args)


def _homes(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir(mode=0o700)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(root))
    import hermes_state

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", hermes_state._IMPORT_DEFAULT_DB_PATH)
    work = root / "profiles" / "work"
    work.mkdir(parents=True, mode=0o700)
    (work / "config.yaml").write_text("{}")
    return root, [("default", root), ("work", work)]


async def _gateway(tmp_path, monkeypatch):
    """A multiplexed gateway serving `default` and `work`, each with its own portal adapter."""
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry
    from gateway.run import GatewayRunner
    from gateway.run_runtime import initialize_gateway_runtime
    from gateway.runtime_ownership import process_ownership
    from gateway.session_ingress_context import register_transport_home

    root, homes = _homes(tmp_path, monkeypatch)
    plugin = load_plugin()
    ctx = Ctx()
    plugin.register(ctx)
    entry = {k: v for k, v in ctx.entry.items() if k in PlatformEntry.__dataclass_fields__}
    platform_registry.register(PlatformEntry(source="plugin", **entry))
    config = GatewayConfig()
    config.multiplex_profiles = True
    config._runtime_profile_homes = tuple(homes)
    runner = GatewayRunner(config)
    process_ownership.reserve([home for _, home in homes])
    await initialize_gateway_runtime(runner)
    primary = ctx.entry["adapter_factory"](PlatformConfig(enabled=True))
    secondary = ctx.entry["adapter_factory"](PlatformConfig(enabled=True))
    secondary.set_owner_profile("work")
    for adapter in (primary, secondary):
        adapter.gateway_runner = runner
    portal = Platform("portal")
    runner.adapters = {portal: primary}
    runner._profile_adapters = {"work": {portal: secondary}}
    register_transport_home(runner, None, root)
    register_transport_home(runner, "work", dict(homes)["work"])

    def close():
        for authority in list(getattr(runner, "session_authorities", []) or []):
            authority.db.close()
        for _, home in homes:
            process_ownership.release(home)

    return plugin, runner, primary, secondary, dict(homes), close


def _event(plugin, adapter, chat, profile):
    """The event `HermesBackend.inbound` builds for a message typed in ``profile``'s ``chat``."""
    import dataclasses

    from gateway.platforms.event import MessageEvent

    source = adapter.build_source(chat_id=chat, chat_type="dm", **plugin.PERSON)
    source = dataclasses.replace(source, profile=plugin._named(profile))
    source._transport_adapter_ref = weakref.ref(adapter)
    return MessageEvent(text="hi", source=source, message_id="m-1")


def _provenance(runner, event, adapter, homes):
    from gateway.session_ingress_context import capture_provenance, native_callback

    owner = getattr(adapter, "_owner_profile", None)
    with native_callback(runner, event, homes[owner or "default"], owner):
        return capture_provenance(runner, event)


@pytest.mark.asyncio
async def test_a_message_in_another_profile_goes_through_that_profiles_adapter(tmp_path, monkeypatch):
    plugin, runner, primary, secondary, homes, close = await _gateway(tmp_path, monkeypatch)
    try:
        backend = plugin.HermesBackend(primary, homes["default"])
        carrier = backend._carrier("work")
        assert carrier is secondary

        provenance = _provenance(runner, _event(plugin, carrier, "chat-w", "work"), carrier, homes)
        assert provenance["runtime_home"] == str(homes["work"])
    finally:
        close()


@pytest.mark.asyncio
async def test_the_linked_adapter_alone_is_refused_for_another_profile(tmp_path, monkeypatch):
    """Why the hand-off exists: the gateway won't take another profile's turn from the default adapter."""
    from hermes_state_runtime import RuntimeStoreError

    plugin, runner, primary, secondary, homes, close = await _gateway(tmp_path, monkeypatch)
    try:
        with pytest.raises(RuntimeStoreError, match="profile_mismatch"):
            _provenance(runner, _event(plugin, primary, "chat-w", "work"), primary, homes)
    finally:
        close()


@pytest.mark.asyncio
async def test_the_default_profile_stays_on_the_linked_adapter(tmp_path, monkeypatch):
    plugin, runner, primary, secondary, homes, close = await _gateway(tmp_path, monkeypatch)
    try:
        backend = plugin.HermesBackend(primary, homes["default"])
        assert backend._carrier(None) is primary
        provenance = _provenance(runner, _event(plugin, primary, "chat-d", None), primary, homes)
        assert provenance["runtime_home"] == str(homes["default"])
    finally:
        close()


@pytest.mark.asyncio
async def test_the_other_profiles_adapter_never_dials_and_its_replies_reach_the_server(tmp_path, monkeypatch):
    plugin, runner, primary, secondary, homes, close = await _gateway(tmp_path, monkeypatch)
    try:
        assert await secondary.connect() is True
        assert secondary.link is None  # no second link to the server, so no refused handshake

        primary.link = Link()
        sent = await secondary.send("chat-w", "here you go")
        assert sent.success
        assert [(kind, chat, text) for kind, chat, _id, text in primary.link.told] == [("outgoing", "chat-w", "here you go")]

        await secondary.edit_message("chat-w", "msg-1", "here you go, edited")
        assert primary.link.told[-1] == ("outgoing", "chat-w", "msg-1", "here you go, edited")

        # Closing the other profile's adapter leaves the link in place for everyone else.
        await secondary.disconnect()
        assert primary.link is not None
    finally:
        close()
