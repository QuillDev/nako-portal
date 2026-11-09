"""The Providers page reads keys the way a turn in the shown profile sees them.

Needs a real Hermes to import, so CI skips it; run it with Hermes's own interpreter.
"""

import importlib.util
import types
from pathlib import Path

import pytest

from conftest import ROOT

config = pytest.importorskip("hermes_cli.config")
secret_scope = pytest.importorskip("agent.secret_scope")


def _backend(home):
    spec = importlib.util.spec_from_file_location("nako_portal_scope_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    shown = types.SimpleNamespace(_home=lambda profile=None: home)
    shown._profile_scope = types.MethodType(plugin.HermesBackend._profile_scope, shown)
    return lambda: {row["slug"]: row for row in plugin.HermesBackend.providers(shown)}


def test_a_key_only_another_profile_has_does_not_count_as_set_up(tmp_path, monkeypatch):
    main, other = tmp_path / "main", tmp_path / "other"
    for home in (main, other):
        home.mkdir()
        (home / "config.yaml").write_text("model:\n  default: some-model\n")
    (main / ".env").write_text("OPENROUTER_API_KEY=sk-or-main-only\n")
    (other / ".env").write_text("")
    monkeypatch.setenv("HERMES_HOME", str(main))
    # The gateway process carries the main profile's keys, as it does when that profile starts it.
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-main-only")
    secret_scope.set_multiplex_active(True)
    try:
        assert _backend(main)()["openrouter"]["connected"] is True
        assert _backend(other)()["openrouter"]["connected"] is False
    finally:
        secret_scope.set_multiplex_active(False)
