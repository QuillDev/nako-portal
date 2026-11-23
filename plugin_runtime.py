"""Path-based sibling loading and optional Hermes APIs shared by the plugin modules.

Hermes can install this plugin in a directory containing hyphens. Private module
names keep sibling imports independent of that directory's Python package name.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).parent


def _load_sibling(name, filename):
    """Load a sibling once, publishing it before execution for recursive imports."""
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, ROOT / filename)
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot load plugin sibling {filename}")
        loaded = importlib.util.module_from_spec(spec)
        sys.modules[name] = loaded
        try:
            spec.loader.exec_module(loaded)
        except BaseException:
            sys.modules.pop(name, None)
            raise
    return sys.modules[name]


def _agent_name():
    """What the agent this plugin is loaded into calls itself (its command, its toolset prefix).

    A rebranded build renames its core modules together with those, so the name is read off one."""
    try:
        import hermes_constants as constants
    except ImportError:  # no agent on the path (tests)
        return "hermes"
    return constants.__name__.partition("_")[0]


def _secrets_api():
    """The agent-secrets plugin's API when that plugin is loaded (it publishes it under this name)."""
    return sys.modules.get("agent_secrets")


def _need_secrets():
    api = _secrets_api()
    if api is None:
        raise ValueError("The agent-secrets plugin isn't installed")
    return api


AGENT = _agent_name()
