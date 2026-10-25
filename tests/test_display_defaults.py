import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_plugin():
    spec = importlib.util.spec_from_file_location("nako_portal_display_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


class Ctx:
    def register_hook(self, name, callback):
        pass

    def register_platform(self, **entry):
        self.entry = entry


def test_the_portal_gets_no_text_progress_or_interim_bubbles_but_keeps_streaming():
    # Runs against the real resolver where Hermes is installed; CI has no Hermes and skips.
    display_config = pytest.importorskip("gateway.display_config")
    display_config._PLATFORM_DEFAULTS.pop("portal", None)
    load_plugin().register(Ctx())

    def resolved(setting, config=None):
        return display_config.resolve_display_setting(config or {}, "portal", setting)

    assert resolved("tool_progress") == "off"
    assert resolved("interim_assistant_messages") is False
    high = display_config._TIERS["high"]
    for setting in ("streaming", "long_running_notifications", "busy_ack_detail"):
        assert resolved(setting) == high[setting]
    # An operator's config.yaml still wins.
    assert resolved("tool_progress", {"display": {"platforms": {"portal": {"tool_progress": "all"}}}}) == "all"


def test_the_portal_quiets_hermes_display_defaults_without_dropping_the_rest(monkeypatch):
    # The same contract against a stand-in shaped like Hermes's display_config, so CI covers it.
    gateway = type(sys)("gateway")
    display_config = type(sys)("gateway.display_config")
    display_config._TIERS = {"high": {"tool_progress": "all", "interim_assistant_messages": True, "streaming": None}}
    display_config._PLATFORM_DEFAULTS = {}
    gateway.display_config = display_config
    monkeypatch.setitem(sys.modules, "gateway", gateway)
    monkeypatch.setitem(sys.modules, "gateway.display_config", display_config)

    load_plugin().register(Ctx())

    assert display_config._PLATFORM_DEFAULTS["portal"] == {
        "tool_progress": "off",
        "interim_assistant_messages": False,
        "streaming": None,
    }
