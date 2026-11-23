"""Provider catalog, profile-scoped credentials, and account sign-in operations."""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

from nako_portal_runtime import _load_sibling

log = logging.getLogger("hermes.portal")
LOOPBACK = re.compile(r"^https?://(localhost|127\.|0\.0\.0\.0|\[::1\])", re.IGNORECASE)


def _provider_accounts():
    """Keep account sign-ins in one cached sibling module across plugin loads."""
    return _load_sibling("nako_portal_provider_accounts", "provider_accounts.py")


def _provider_catalog():
    """Every provider this Hermes offers, in `hermes model` order."""
    from hermes_cli.provider_catalog import provider_catalog

    return provider_catalog()


class _ScopedEnv:
    """A key's value as the current profile scope sees it: that profile's `.env`, and process
    variables only where Hermes treats them as shared (`get_env_value` holds the policy)."""

    def get(self, name, default=None):
        from hermes_cli.config import get_env_value

        return get_env_value(name) or default


def _account_status():
    """How each account provider signs in, and whether it has (`{"slug": {"flow", "cli_command", "status"}}`).

    Built the way Hermes's own Accounts page builds it, so the command shown is the one Hermes shows.
    """
    try:
        from hermes_cli.web_routers.oauth import (
            _build_oauth_catalog,
            _external_process_cli_command,
            _resolve_provider_status,
        )

        return {
            entry["id"]: {
                "flow": entry.get("flow") or "",
                "cli_command": _external_process_cli_command(entry["id"], entry.get("cli_command") or ""),
                "status": _resolve_provider_status(entry["id"], entry.get("status_fn")),
            }
            for entry in _build_oauth_catalog()
        }
    except Exception:  # an older Hermes: keys still work, the accounts tab just has nothing to say
        log.warning("portal: could not read provider sign-in status", exc_info=True)
        return {}


def _add_accounts(row):
    """Put a provider's accounts on its row, when it can have more than one."""
    try:
        source = _provider_accounts().source_for(row["slug"])
        if source is None:
            return
        accounts = source.list()
    except Exception:  # the page still shows the single sign-in it had before
        log.warning("portal: could not list %s accounts", row["slug"], exc_info=True)
        return
    row["accounts"] = accounts
    row["login"] = source.mode
    row["connected"] = any(a["signed_in"] for a in accounts)


def _oauth_routes():
    from hermes_cli.web_routers import oauth

    return oauth


def _default_endpoint(slug):
    """The address Hermes calls for a provider when nothing overrides it ("" when it has none)."""
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY

        config = PROVIDER_REGISTRY.get(slug)
    except ImportError:
        return None
    return None if config is None else str(getattr(config, "inference_base_url", "") or "")


def _provider_row(entry, env, accounts, endpoint=_default_endpoint):
    """One row for the Providers page, or None for a provider this page can't finish setting up.

    A single pasted key needs nothing else, and a provider with a device-code sign-in needs only
    the code. Most key providers also name a base-URL variable, but only as an optional override:
    Hermes already knows their address. Left out until they have a form of their own are the ones
    that can't run on a key alone: no key variable (Bedrock's AWS login, Vertex's service-account
    file), no built-in address (Azure Foundry), or an address on this machine (a local server).
    """
    if entry.auth_type in ("virtual",):
        return None
    account = accounts.get(entry.slug) or {}
    if entry.tab == "accounts" and account:
        return {
            "slug": entry.slug,
            "label": entry.label,
            "description": entry.description,
            "kind": "signin" if account.get("flow") == "device_code" else "cli",
            "command": account.get("cli_command") or "",
            "connected": bool((account.get("status") or {}).get("logged_in")),
            "source": (account.get("status") or {}).get("source_label") or "",
            "env_var": "",
            "env_vars": [],
            "signup_url": entry.signup_url or "",
        }
    key_vars = tuple(entry.api_key_env_vars or ())
    if not key_vars:
        return None
    address = endpoint(entry.slug)
    # No registry entry (OpenRouter): Hermes routes it by name, so the key is all it needs.
    if address is not None and (not address or LOOPBACK.match(address)):
        return None
    found = next((v for v in key_vars if env.get(v)), "")
    return {
        "slug": entry.slug,
        "label": entry.label,
        "description": entry.description,
        "kind": "key",
        "command": "",
        "connected": bool(found),
        "source": found,
        "env_var": key_vars[0],
        "env_vars": list(key_vars),
        "signup_url": entry.signup_url or "",
    }


class ProviderBackend:
    """Provider operations using the backend's profile and home scope."""

    def providers(self, *, home=None):
        """What the shown profile can run on and whether it's already set up. Read inside that
        profile's own scope, the way its turns see keys: another profile's key in the gateway's
        environment must not count. Nothing secret comes back."""
        with self._profile_scope(home):
            env = _ScopedEnv()
            accounts = _account_status()
            rows = [row for row in (_provider_row(entry, env, accounts) for entry in _provider_catalog()) if row is not None]
            for row in rows:
                if row["kind"] != "key":
                    _add_accounts(row)
            return rows


    def set_provider_key(self, slug, value):
        """Save an API key to the profile on screen, under the provider's own variable name."""
        home = self._home()
        from hermes_cli.config import save_env_value

        row = self._provider_for_key(slug, home=home)
        key = str(value or "").strip()
        if not key:
            raise ValueError("Paste a key first")
        self._scoped(lambda: save_env_value(row["env_var"], key), home=home)


    def remove_provider_key(self, slug):
        home = self._home()
        from hermes_cli.config import remove_env_value

        row = self._provider_for_key(slug, home=home)
        for name in row["env_vars"]:
            try:
                self._scoped(remove_env_value, name, home=home)
            except FileNotFoundError:  # a variable that was never set is already the goal
                log.debug("portal: provider %s: nothing to remove for %s", slug, name)


    def _provider_for_key(self, slug, *, home=None):
        row = next((r for r in self.providers(home=home) if r["slug"] == slug), None)
        if row is None:
            raise ValueError("That provider isn't one this page can set up")
        if row["kind"] != "key":
            raise ValueError("That provider doesn't take an API key here")
        return row


    def start_provider_signin(self, slug):
        """Begin a provider's device-code sign-in: the code and link to show, for polling after."""
        routes = _oauth_routes()
        if slug not in routes._DEVICE_CODE_STARTERS:
            raise ValueError("That provider signs in from a terminal on this machine")
        body = self._scoped(lambda: asyncio.run(routes._start_device_code_flow(slug)))
        return {k: body[k] for k in ("session_id", "user_code", "verification_url", "expires_in", "poll_interval")}


    def provider_signin(self, slug, session):
        """How a started sign-in is going: pending until the provider is approved, then done."""
        routes = _oauth_routes()
        with routes._oauth_sessions_lock:
            state = routes._oauth_sessions.get(str(session))
        if state is None or state.get("provider") != slug:
            raise ValueError("That sign-in expired. Start it again")
        status = "cancelled" if state.get("cancelled") else state.get("status")
        return {"status": status, "error": state.get("error_message")}


    def _account_source(self, slug):
        source = _provider_accounts().source_for(str(slug))
        if source is None:
            raise ValueError("That provider has a single sign-in")
        return source


    def start_account_signin(self, slug, target=None):
        """Begin a sign-in: a link and a code field (`paste`), or a code to enter (`code`)."""
        from gateway.run import _profile_runtime_scope

        source = self._account_source(slug)
        home = Path(self._home())
        with self._profile_scope():
            return source.start(str(target) if target else None, lambda: _profile_runtime_scope(home))


    def finish_account_signin(self, slug, attempt, code):
        """Redeem a pasted code: `{outcome: added | refreshed, label, email, plan}`."""
        source = self._account_source(slug)
        with self._profile_scope():
            return source.finish(str(attempt), str(code or ""))


    def account_signin(self, slug, attempt):
        """How a code sign-in is going: pending, then done with its outcome."""
        source = self._account_source(slug)
        with self._profile_scope():
            return source.status(str(attempt))


    def cancel_account_signin(self, slug, attempt):
        source = self._account_source(slug)
        with self._profile_scope():
            source.cancel(str(attempt))


    def remove_account(self, slug, account):
        """Remove one of a provider's accounts from the profile on screen."""
        source = self._account_source(slug)
        with self._profile_scope():
            source.remove(str(account))
