import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_plugin():
    spec = importlib.util.spec_from_file_location("nako_portal_toolsets_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


@pytest.fixture
def hermes(monkeypatch):
    """Stand-ins shaped like Hermes's config, home override and toolset resolver, so CI covers
    the rule. `configs` maps a home to its config; `bundles` maps a home to what `hermes-portal`
    resolves to there (empty where the plugin isn't registered)."""
    state = {"home": "/root-home", "configs": {}, "bundles": {}}

    def module(name, **attrs):
        mod = type(sys)(name)
        mod.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, mod)
        return mod

    def set_override(path):
        previous, state["home"] = state["home"], path
        return previous

    def reset_override(token):
        state["home"] = token

    module("hermes_cli")
    module("hermes_cli.config", load_config=lambda: state["configs"].get(state["home"], {}))
    module("hermes_constants", set_hermes_home_override=set_override, reset_hermes_home_override=reset_override)
    module("toolsets", resolve_toolset=lambda name: list(state["bundles"].get(state["home"], [])) if name == "hermes-portal" else [])
    return state


def test_a_profile_without_the_plugin_gets_the_full_toolset(hermes):
    hermes["bundles"] = {"/root-home": ["terminal", "read_file"], "/profiles/other": []}
    plugin = load_plugin()
    assert plugin._fallback_toolsets("/profiles/other") == ["hermes-cli"]
    # The home override is put back afterwards.
    assert hermes["home"] == "/root-home"


def test_a_profile_with_the_plugin_keeps_hermes_own_toolset(hermes):
    hermes["bundles"] = {"/root-home": ["terminal", "read_file"]}
    assert load_plugin()._fallback_toolsets("/root-home") is None


def test_a_profile_that_picks_its_own_portal_tools_is_left_alone(hermes):
    hermes["configs"] = {"/profiles/other": {"platform_toolsets": {"portal": ["web"]}}}
    hermes["bundles"] = {"/profiles/other": []}
    assert load_plugin()._fallback_toolsets("/profiles/other") is None
