"""The plugin loads by file path, even outside sys.path and Python package names."""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_siblings_load_from_hyphenated_plugin_directory(tmp_path):
    installed = tmp_path / "plugins" / "nako-portal"
    installed.mkdir(parents=True)
    for path in [ROOT / "__init__.py", *ROOT.glob("plugin_*.py"),
                 *(ROOT / name for name in ("provider_accounts.py", "mesh_tools.py", "groups_tools.py"))]:
        shutil.copyfile(path, installed / path.name)
    # A fresh interpreter prevents earlier plugin imports from masking a broken path loader.
    code = '''
import importlib.util
import sys
from pathlib import Path

path = Path(sys.argv[1])
assert str(path.parent) not in sys.path

def load(name):
    spec = importlib.util.spec_from_file_location(name, path)
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin

first = load("hermes_plugin_first")
accounts = first._provider_accounts()
mesh = first._mesh_tools()
groups = first._groups_tools()
assert callable(accounts.source_for)
assert callable(groups.CALL)
assert callable(first.register)
assert callable(first.SecretSurface)
assert callable(first.HermesBackend.providers)
assert callable(first.HermesBackend.mcp_servers)
assert mesh.PORTAL is first._portal
first._LIVE_TOOLS["first_only"] = True

second = load("hermes_plugin_second")
assert second._provider_accounts() is accounts
assert second._mesh_tools() is mesh
assert second._groups_tools() is groups
assert mesh.PORTAL is first._portal
assert not second._LIVE_TOOLS
'''
    done = subprocess.run([sys.executable, "-I", "-c", code, str(installed / "__init__.py")],
                          cwd=tmp_path, capture_output=True, text=True, timeout=10, check=False)
    assert done.returncode == 0, done.stderr


def test_failed_sibling_load_can_be_retried(tmp_path, monkeypatch):
    import importlib.util

    import pytest

    spec = importlib.util.spec_from_file_location("portal_loader_test", ROOT / "plugin_runtime.py")
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    monkeypatch.setattr(runtime, "ROOT", tmp_path)
    name = "portal_retry_test"
    monkeypatch.delitem(sys.modules, name, raising=False)
    sibling = tmp_path / "sibling.py"
    sibling.write_text("raise RuntimeError('incomplete load')\n")
    with pytest.raises(RuntimeError, match="incomplete load"):
        runtime._load_sibling(name, sibling.name)
    assert name not in sys.modules
    sibling.write_text("ready = True\n")
    try:
        loaded = runtime._load_sibling(name, sibling.name)
        assert loaded.ready
        assert runtime._load_sibling(name, sibling.name) is loaded
    finally:
        sys.modules.pop(name, None)
