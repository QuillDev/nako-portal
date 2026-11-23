"""MCP configuration, catalog installs, tool selection, and browser sign-in."""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from nako_portal_runtime import AGENT

log = logging.getLogger("hermes.portal")
# The agent names a sign-in flow's home field after itself.
FLOW_HOME = f"{AGENT}_home"
MCP_SIGNIN_TTL = 15 * 60


def _flow_home(flow):
    return getattr(flow, FLOW_HOME)


def _mcp_configs():
    """``(servers, plugins)``: every server the current profile has, config and plugin ones
    alike, and the plugin that brings each (None for ones in config.yaml)."""
    from hermes_cli.mcp_config import _get_mcp_servers
    from tui_gateway.mcp_rpc_helpers import server_configs_with_sources

    return server_configs_with_sources(_get_mcp_servers())


def _codex_runtime():
    """Whether Codex runs the profile's turns itself, from its own copy of the server list."""
    try:
        from hermes_cli.codex_runtime_switch import get_current_runtime
        from hermes_cli.config import load_config

        return get_current_runtime(load_config()) == "codex_app_server"
    except Exception:  # noqa: BLE001 - Optional runtime discovery must not prevent MCP management.
        return False


def _mcp_redact(error):
    """An error's text with anything key-shaped masked, as `hermes mcp test` prints it."""
    try:
        from hermes_cli.mcp_config import redact_mcp_probe_text

        return str(redact_mcp_probe_text(error) or "").strip()
    except Exception:  # noqa: BLE001 - Fail closed if redaction fails; never expose the raw error.
        return ""


def _mcp_tool_filters(cfg):
    """``(include, exclude)`` from a server's ``tools:`` block; None where a list isn't set."""
    tools = cfg.get("tools") if isinstance(cfg, dict) else None
    if not isinstance(tools, dict):
        return None, None
    include, exclude = tools.get("include"), tools.get("exclude")
    return (include if isinstance(include, list) else None, exclude if isinstance(exclude, list) else None)


def _mcp_tool_on(tool, include, exclude):
    from tools.mcp_tool_schema import matches_name_filter

    if include is not None:
        return matches_name_filter(tool, {str(p) for p in include})
    if exclude:
        return not matches_name_filter(tool, {str(p) for p in exclude})
    return True


def _mcp_row(name, cfg, plugin, live, codex):
    """One row of Settings > MCP servers. Header and env values never leave: only their names."""
    from hermes_cli.mcp_config import _oauth_tokens_present
    from tools.mcp_tool_common import mcp_server_enabled

    include, exclude = _mcp_tool_filters(cfg)
    auth = cfg.get("auth") or ("header" if any(str(k).lower() == "authorization" for k in (cfg.get("headers") or {})) else None)
    enabled = mcp_server_enabled(cfg)
    status = live.get("status") or ("configured" if enabled else "disabled")
    note = ""
    if codex and auth == "oauth":
        note = "Codex runs can't sign in to this server"
    elif codex and (include is not None or exclude):
        note = "Codex runs get all of this server's tools"
    return {
        "name": name,
        "url": cfg.get("url") or "",
        "command": cfg.get("command") or "",
        "args": [str(a) for a in cfg.get("args") or []],
        "env": sorted(str(k) for k in (cfg.get("env") or {})),
        "auth": auth or "none",
        "enabled": enabled,
        "plugin": plugin or "",
        "status": status,
        "error": _mcp_redact(live.get("error")) if live.get("error") else "",
        "signed_in": auth != "oauth" or _oauth_tokens_present(name),
        "picked": include is not None or bool(exclude),
        "codex": note,
        "installing": False,
    }


def _mcp_pending_row(name, state):
    """A catalog install that hasn't reached config yet (still running, or failed)."""
    return {"name": name, "url": "", "command": "", "args": [], "env": [], "auth": "none", "enabled": False, "plugin": "",
            "status": "failed" if state["status"] == "failed" else "installing", "error": state.get("error") or "",
            "signed_in": True, "picked": False, "codex": "", "installing": state["status"] == "installing"}


class MCPBackend:
    """MCP operations using the backend's scope, install state, and change hook."""

    def mcp_servers(self):
        """The shown profile's servers and how each is doing; None on a Hermes without MCP."""
        try:
            from tools.mcp_tool_discovery import get_mcp_status
        except ImportError:
            return None
        home = str(self._home())
        with self._profile_scope():
            servers, plugins = _mcp_configs()
            live = {row["name"]: row for row in get_mcp_status(servers)}
            codex = _codex_runtime()
            rows = [_mcp_row(name, cfg, plugins.get(name), live.get(name) or {}, codex) for name, cfg in sorted(servers.items())]
        with self.mcp_lock:
            pending = {name: dict(state) for (where, name), state in self.mcp_installs.items() if where == home}
        for row in rows:
            state = pending.pop(row["name"], None)
            if state and state["status"] == "installing":
                row["installing"] = True
        rows += [_mcp_pending_row(name, state) for name, state in sorted(pending.items())]
        return {"servers": rows, "codex": codex}


    def mcp_catalog(self):
        """The servers Hermes's catalog offers, with what each needs before it can run."""
        from hermes_cli import mcp_catalog
        from hermes_cli.config import get_env_value

        with self._profile_scope():
            rows = []
            for entry in mcp_catalog.list_catalog():
                rows.append({
                    "name": entry.name,
                    "description": entry.description or "",
                    "transport": entry.transport.type,
                    "url": entry.transport.url or "",
                    "command": entry.transport.command or "",
                    "args": list(entry.transport.args or []),
                    "auth": getattr(entry.auth, "type", "none") or "none",
                    "env": [{"name": spec.name, "prompt": spec.prompt, "required": spec.required, "secret": spec.secret,
                             "saved": bool(spec.secret and get_env_value(spec.name))} for spec in entry.auth.env or []],
                    "source": entry.install.url if entry.install else "",
                    "post_install": (entry.post_install or "").strip(),
                    "installed": mcp_catalog.is_installed(entry.name),
                })
            return rows


    def mcp_install(self, name, env=None):
        """Install a catalog server for the shown profile. Keys it declares are saved first (secrets
        to `.env`); the install itself (a clone and build for some) runs on in the background."""
        from hermes_cli import mcp_catalog
        from hermes_cli.config import get_env_value, save_env_value, validate_env_var_name_for_write

        entry = mcp_catalog.get_entry(str(name or ""))
        if entry is None:
            raise ValueError("That server isn't in the catalog")
        specs = {spec.name: spec for spec in entry.auth.env or []}
        values = {str(k): str(v).strip() for k, v in (env or {}).items() if str(v or "").strip()}
        unknown = sorted(set(values) - set(specs))
        if unknown:
            raise ValueError(f"{entry.name} doesn't use {', '.join(unknown)}")
        for key in values:
            validate_env_var_name_for_write(key)
        home = self._home()
        with self._profile_scope():
            missing = [s.name for s in specs.values() if s.required and s.name not in values and not (s.secret and get_env_value(s.name))]
            if missing:
                raise ValueError(f"{entry.name} needs {', '.join(missing)}")
            for key, value in values.items():
                if specs[key].secret:
                    save_env_value(key, value)
        key = (str(home), entry.name)
        with self.mcp_lock:
            if (self.mcp_installs.get(key) or {}).get("status") == "installing":
                raise ValueError(f"{entry.name} is already installing")
            self.mcp_installs[key] = {"status": "installing", "error": ""}
        threading.Thread(target=self._mcp_install_run, args=(home, entry, values), daemon=True, name=f"portal-mcp-install-{entry.name}").start()
        return {"name": entry.name}


    def _mcp_install_run(self, home, entry, values):
        from gateway.run import _profile_runtime_scope
        from hermes_cli import mcp_catalog
        from tools.mcp_oauth import suppress_interactive_oauth

        key = (str(home), entry.name)
        try:
            with _profile_runtime_scope(Path(home)), suppress_interactive_oauth():
                mcp_catalog.install_entry(entry, enable=True, preloaded_env=values or None)
            with self.mcp_lock:
                self.mcp_installs.pop(key, None)
            self._mcp_apply(home)
        except Exception as error:  # noqa: BLE001 - MCP installers can fail with plugin-defined exceptions.
            log.warning("portal: MCP install of %s failed: %s", entry.name, error)
            with self.mcp_lock:
                self.mcp_installs[key] = {"status": "failed", "error": _mcp_redact(error) or "The install failed"}
        self._mcp_changed()


    def mcp_add(self, spec):
        """Add a server by hand: a URL (with an optional token or browser sign-in) or a command
        with its arguments and environment, checked the way `hermes mcp add` checks it."""
        from hermes_cli.mcp_config import _save_bearer_auth_token, _save_mcp_server
        from hermes_cli.web_models import MCPServerCreate
        from hermes_cli.web_server_mcp import _normalize_mcp_server_create
        from pydantic import SecretStr

        spec = dict(spec or {})
        token = str(spec.pop("token", "") or "").strip()
        body = MCPServerCreate(
            name=str(spec.get("name") or ""), url=spec.get("url") or None, command=spec.get("command") or None,
            args=[str(a) for a in spec.get("args") or []], env={str(k): str(v) for k, v in (spec.get("env") or {}).items()},
            auth=spec.get("auth") or ("header" if token else None), bearer_token=SecretStr(token) if token else None)
        name, server_config, bearer = _normalize_mcp_server_create(body)
        with self._profile_scope():
            servers, _plugins = _mcp_configs()
            if name in servers:
                raise ValueError(f"There's already a server named {name}")
            if bearer is not None:
                server_config["headers"] = _save_bearer_auth_token(name, bearer)
            if not _save_mcp_server(name, server_config):
                raise ValueError(f"{name} was refused: its command looks unsafe")
        self._mcp_apply()
        return {"name": name}


    def mcp_set_enabled(self, name, enabled):
        from hermes_cli.config import load_config, save_config

        with self._profile_scope():
            self._mcp_own(name)
            config = load_config()
            config["mcp_servers"][name]["enabled"] = bool(enabled)
            save_config(config)
        self._mcp_apply()


    def mcp_remove(self, name):
        from hermes_cli.mcp_config import _remove_mcp_server

        home = str(self._home())
        with self.mcp_lock:
            failed = self.mcp_installs.get((home, name), {}).get("status") == "failed"
            if failed:
                self.mcp_installs.pop((home, name), None)
        if failed:
            return
        with self._profile_scope():
            self._mcp_own(name)
            _remove_mcp_server(name)
            try:  # its sign-in goes with it, as `hermes mcp remove` does
                from tools.mcp_oauth_manager import get_manager

                get_manager().remove(name)
            except Exception:
                log.debug("portal: no MCP sign-in to clean up for %s", name, exc_info=True)
        self._mcp_apply()


    def mcp_test(self, name):
        """Connect to one server, list its tools, disconnect: whether it works, and which tools the
        profile has switched on."""
        from hermes_cli.mcp_config import _oauth_tokens_present, _probe_single_server
        from tools.mcp_oauth import suppress_interactive_oauth

        with self._profile_scope():
            servers, _plugins = _mcp_configs()
            cfg = servers.get(name)
            if cfg is None:
                raise ValueError(f"No server named {name}")
            try:
                with suppress_interactive_oauth():
                    tools = _probe_single_server(name, cfg)
            except Exception as error:  # noqa: BLE001 - A failed third-party probe becomes a result for the UI.
                return {"ok": False, "error": _mcp_redact(error) or "It didn't connect", "tools": []}
            if cfg.get("auth") == "oauth" and not _oauth_tokens_present(name):
                return {"ok": False, "error": "Sign in first", "tools": []}
        include, exclude = _mcp_tool_filters(cfg)
        return {"ok": True, "error": "", "tools": [{"name": t, "description": d or "", "on": _mcp_tool_on(t, include, exclude)} for t, d in tools]}


    def mcp_set_tools(self, name, tools, chosen):
        """Switch a server's tools on and off, the way `hermes mcp configure` saves the checklist."""
        from hermes_cli.config import load_config, save_config
        from hermes_cli.mcp_config import _rebuild_exclude_list
        from tools.mcp_tool_schema import matches_name_filter

        names = [str(t) for t in tools or []]
        picked = {str(t) for t in chosen or []}
        if not names or not picked <= set(names):
            raise ValueError("Test the server first, then pick its tools")
        with self._profile_scope():
            self._mcp_own(name)
            config = load_config()
            entry = config["mcp_servers"][name]
            include, exclude = _mcp_tool_filters(entry)
            exclude_mode = bool(exclude) and include is None
            chosen_at = {i for i, t in enumerate(names) if t in picked}
            if len(picked) == len(names) and not exclude_mode:
                entry.pop("tools", None)
            elif exclude_mode:
                rebuilt = _rebuild_exclude_list(name, exclude, names, chosen_at, matches_name_filter)
                if rebuilt:
                    entry.setdefault("tools", {})["exclude"] = rebuilt
                    entry["tools"].pop("include", None)
                else:
                    entry.pop("tools", None)
            else:
                entry.setdefault("tools", {})["include"] = [t for t in names if t in picked]
                entry["tools"].pop("exclude", None)
            save_config(config)
        # A live server keeps the tools it registered: reconnect it so the new choice applies.
        self._mcp_apply(restart={name})


    def mcp_start_signin(self, name, redirect_uri):
        """Start a server's browser sign-in. The provider sends the browser back to the portal's
        own callback, which hands the code to the waiting flow (`mcp_oauth_callback`)."""
        from hermes_cli.web_server_mcp import _run_dashboard_mcp_oauth
        from tools.mcp_dashboard_oauth import DashboardOAuthFlow, exception_message

        home = str(Path(self._home()).expanduser().resolve(strict=False))
        with self._profile_scope():
            servers, plugins = _mcp_configs()
        cfg = dict(servers.get(name) or {})
        if not cfg:
            raise ValueError(f"No server named {name}")
        if plugins.get(name):
            raise ValueError(f"{name} comes from the {plugins[name]} plugin")
        if not cfg.get("url"):
            raise ValueError("Servers run by a command sign in with keys, not a browser")
        if cfg.get("headers") and cfg.get("auth") != "oauth":
            raise ValueError("This server signs in with a token")
        cfg["auth"] = "oauth"
        self._mcp_gc_flows()
        with self.mcp_lock:
            if any(f.server_name == name and _flow_home(f) == home and not f.worker_done for f in self.mcp_flows.values()):
                raise ValueError(f"A sign-in for {name} is already open")
            # Older Hermes builds still require profile even though hermes_home carries the scope.
            legacy: dict[str, Any] = {}
            if any(f.name == "profile" for f in dataclasses.fields(DashboardOAuthFlow)):
                legacy["profile"] = None
            flow = DashboardOAuthFlow(
                flow_id=secrets.token_urlsafe(24), server_name=name, **{FLOW_HOME: home},
                redirect_uri=(cfg.get("oauth") or {}).get("redirect_uri") or redirect_uri,
                reconnect_live=False, **legacy,
            )
            self.mcp_flows[flow.flow_id] = flow
        threading.Thread(target=_run_dashboard_mcp_oauth, args=(flow, cfg), daemon=True, name=f"portal-mcp-oauth-{name}").start()
        try:
            asyncio.run(flow.wait_for_authorization_url(timeout=30))
        except (TimeoutError, RuntimeError) as error:
            flow.mark_error(exception_message(error))
        return flow.snapshot()


    def mcp_signin(self, flow_id):
        """How a started sign-in is going; once it's approved the server is brought live."""
        with self.mcp_lock:
            flow = self.mcp_flows.get(str(flow_id))
        if flow is None:
            raise ValueError("That sign-in expired. Start it again")
        snapshot = flow.snapshot()
        if snapshot["status"] == "approved" and flow.worker_done and not getattr(flow, "portal_applied", False):
            flow.portal_applied = True
            self._mcp_apply(_flow_home(flow), restart={flow.server_name})
        return snapshot


    def mcp_cancel_signin(self, flow_id):
        with self.mcp_lock:
            flow = self.mcp_flows.get(str(flow_id))
        if flow is not None:
            flow.mark_error("Cancelled", cancelled=True)


    def mcp_oauth_callback(self, name, code=None, state=None, error=None, iss=None):
        """The provider's redirect back: the flow whose state matches takes it. Returns what the
        browser tab should say."""
        with self.mcp_lock:
            flows = [f for f in self.mcp_flows.values() if f.server_name == name and f.status == "authorization_required"]
        flow = next((f for f in flows if f.expected_state and state and secrets.compare_digest(f.expected_state, str(state))), None)
        if flow is None:
            return "expired"
        try:
            flow.deliver_callback(code=code, state=state, error=error, iss=iss)
        except ValueError:
            return "rejected"
        return "failed" if error else "ok"


    def _mcp_gc_flows(self):
        cutoff = time.time() - MCP_SIGNIN_TTL
        with self.mcp_lock:
            for flow_id in [k for k, f in self.mcp_flows.items() if f.created_at < cutoff]:
                self.mcp_flows.pop(flow_id, None)


    def _mcp_own(self, name):
        """Refuse a server this page can't change: unknown, or one a plugin brings."""
        servers, plugins = _mcp_configs()
        if name not in servers:
            raise ValueError(f"No server named {name}")
        if plugins.get(name):
            raise ValueError(f"{name} comes from the {plugins[name]} plugin")


    def _mcp_apply(self, home=None, restart=()):
        """Bring the running gateway in step with the config just written: connect what's new or
        switched on, drop what's gone or off, reconnect ``restart``, refresh the profile's cached
        agents, and recopy the list for Codex. Best effort: the gateway's own housekeeping
        reconciles on its next tick anyway."""
        from gateway.run import _profile_runtime_scope

        home = home or self._home()
        profile = next((name for name, h in self.homes().items() if Path(h).resolve() == Path(home).resolve()), self.profile)
        try:
            from tools import mcp_tool_discovery as discovery
            from tools.mcp_oauth import suppress_interactive_oauth
            from tools.mcp_tool_lifecycle import shutdown_mcp_servers

            with _profile_runtime_scope(Path(home)), suppress_interactive_oauth():
                if restart:
                    shutdown_mcp_servers(scope=discovery._core._mcp_registry_scope(), names=set(restart))
                discovery.reconcile_mcp_servers_with_config()
                runner = getattr(self.adapter, "gateway_runner", None)
                if runner is not None and hasattr(runner, "_mcp_reload_refresh_cached_agents"):
                    runner._mcp_reload_refresh_cached_agents(bool(getattr(runner.config, "multiplex_profiles", False)), profile)
                if _codex_runtime():
                    from hermes_cli.codex_runtime_plugin_migration import migrate
                    from hermes_cli.config import load_config

                    migrate(load_config())
        except Exception:
            log.warning("portal: could not apply MCP changes live; the gateway picks them up on its next pass", exc_info=True)
        self._mcp_changed()
