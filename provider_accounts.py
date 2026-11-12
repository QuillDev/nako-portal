"""Several accounts per provider on the Providers page: list them, add one, refresh one.

One sign-in covers both cases. Whoever the provider says signed in decides what happens: an
account that is already linked gets its login refreshed in place, a new one is added. A row's
"sign in again" names that row as the target; the target takes the login only when nobody is
signed in to it or the same account came back, so it can never be overwritten by someone else.

Two kinds of source:

- A provider plugin whose profile has the account hooks (`account_logins`, `start_account_login`,
  `finish_account_login`, `cancel_account_login`). It signs in through a link and a pasted code.
- A Hermes OAuth provider with a credential pool and a device-code login (Codex). Hermes keeps
  every account as its own pool row; this reuses Hermes's own device-code steps and pool.
"""
import logging
import secrets
import threading
import time

log = logging.getLogger(__name__)

HOOKS = ("account_logins", "start_account_login", "finish_account_login", "cancel_account_login")
ATTEMPT_TTL = 20 * 60


def source_for(slug):
    """The account source for a provider, or None when it has a single login only."""
    if slug in CODEX_SLUGS:
        return CODEX
    try:
        from providers import get_provider_profile

        profile = get_provider_profile(slug)
    except Exception:
        return None
    if profile is not None and all(callable(getattr(profile, hook, None)) for hook in HOOKS):
        return PluginAccounts(profile)
    return None


class PluginAccounts:
    """A provider plugin that manages its own logins: a link to open, then the code it shows."""

    mode = "paste"

    def __init__(self, profile):
        self.profile = profile

    def list(self):
        return [{"id": str(row.get("id") or row.get("label") or ""), "label": str(row.get("label") or ""),
                 "email": str(row.get("email") or ""), "plan": str(row.get("plan") or ""),
                 "signed_in": bool(row.get("signed_in"))} for row in self.profile.account_logins()]

    def start(self, target, scope):
        started = self.profile.start_account_login(target or None)
        return {"attempt": started["id"], "mode": self.mode, "url": started["url"]}

    def finish(self, attempt, code):
        return _result(self.profile.finish_account_login(attempt, code))

    def status(self, attempt):
        raise ValueError("That sign-in takes a code")

    def cancel(self, attempt):
        self.profile.cancel_account_login(attempt)


def _result(raw):
    return {"outcome": raw["outcome"], "label": str(raw.get("label") or ""), "email": str(raw.get("email") or ""),
            "plan": str(raw.get("plan") or "")}


class CodexAccounts:
    """ChatGPT/Codex: one pool row per account, signed in with Hermes's device code."""

    mode = "code"
    provider = "openai-codex"

    def __init__(self):
        self._attempts = {}
        self._lock = threading.Lock()

    def _pool(self):
        from agent.credential_pool import load_pool

        return load_pool(self.provider)

    def list(self):
        from agent.credential_pool import STATUS_DEAD

        rows = []
        for entry in self._pool().entries():
            email, plan = _codex_who(entry.access_token)
            # Hermes names its own login's row after where it came from ("device_code"); the email says more.
            label = entry.label if entry.label and entry.label != entry.source else email
            rows.append({"id": entry.id, "label": label or entry.label, "email": email, "plan": plan,
                         "signed_in": bool(entry.access_token) and entry.last_status != STATUS_DEAD})
        return rows

    def start(self, target, scope):
        import httpx

        routes = _routes()
        device = routes._codex_request_user_code(httpx)
        key = secrets.token_urlsafe(12)
        state = {
            "device_auth_id": device["device_auth_id"], "user_code": device["user_code"], "interval": device["interval"],
            "expires_in": routes._CODEX_EXPIRES_IN, "status": "pending", "cancelled": False, "started": time.monotonic(),
        }
        with self._lock:
            self._sweep()
            self._attempts[key] = state
        threading.Thread(target=self._wait, args=(key, state, target, scope), daemon=True, name=f"portal-codex-{key[:6]}").start()
        return {"attempt": key, "mode": self.mode, "user_code": device["user_code"],
                "verification_url": f"{routes._CODEX_ISSUER}/codex/device", "poll_interval": int(device["interval"])}

    def _wait(self, key, state, target, scope):
        import httpx

        routes = _routes()
        try:
            code = routes._codex_poll_authorization(httpx, state, key)
            if code is None:
                state.update(status="expired", error="The code expired. Start again")
                return
            if code is routes._CANCELLED or state["cancelled"]:
                state["status"] = "cancelled"
                return
            tokens = routes._codex_exchange_tokens(httpx, code)
            with scope():
                result = self._link(tokens, target)
            state.update(status="done", result=result)
        except Exception as error:
            log.warning("portal: codex sign-in failed: %s", error)
            state.update(status="error", error=str(error) or "That sign-in failed")

    def _link(self, tokens, target):
        from agent.credential_pool import AUTH_TYPE_OAUTH, SOURCE_MANUAL_DEVICE_CODE, PooledCredential, _codex_principal_identity

        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        pool = self._pool()
        entries = pool.entries()
        identity = _codex_principal_identity(tokens["access_token"])
        email, plan = _codex_who(tokens["access_token"])
        match = None
        if target:
            row = next((e for e in entries if e.id == target), None)
            if row is not None and _codex_principal_identity(row.access_token) in (None, identity):
                match = row
        if match is None and identity is not None:
            match = next((e for e in entries if _codex_principal_identity(e.access_token) == identity), None)
        if match is not None:
            if match.source == "device_code":
                # The row Hermes seeds from its own Codex login: refresh it where Hermes keeps it.
                from hermes_cli.auth_codex import _save_codex_tokens

                _save_codex_tokens(tokens, last_refresh=now, set_active=False)
                pool = self._pool()
            else:
                pool._adopt(match, access_token=tokens["access_token"], refresh_token=tokens.get("refresh_token"), last_refresh=now)
            pool.reset_status(match.id)
            return {"outcome": "refreshed", "label": match.label or email, "email": email, "plan": plan}
        from hermes_cli.auth_codex import _codex_base_url

        entry = PooledCredential(
            provider=self.provider, id=secrets.token_hex(3), label=email or f"{self.provider}-oauth-{len(entries) + 1}",
            auth_type=AUTH_TYPE_OAUTH, priority=0, source=SOURCE_MANUAL_DEVICE_CODE, access_token=tokens["access_token"],
            refresh_token=tokens.get("refresh_token"), base_url=_codex_base_url(), last_refresh=now)
        entry = pool.add_entry(entry)
        return {"outcome": "added", "label": entry.label, "email": email, "plan": plan}

    def finish(self, attempt, code):
        raise ValueError("That sign-in finishes on the provider's page")

    def status(self, attempt):
        with self._lock:
            state = self._attempts.get(str(attempt))
        if state is None:
            raise ValueError("That sign-in expired. Start it again")
        out = {"status": state["status"]}
        if state["status"] == "done":
            out["result"] = state["result"]
        if state.get("error"):
            out["error"] = state["error"]
        return out

    def cancel(self, attempt):
        with self._lock:
            state = self._attempts.pop(str(attempt), None)
        if state is not None:
            state["cancelled"] = True

    def _sweep(self):
        now = time.monotonic()
        for key, state in list(self._attempts.items()):
            if now - state["started"] > ATTEMPT_TTL:
                state["cancelled"] = True
                self._attempts.pop(key, None)


def _codex_who(token):
    """`(email, plan)` from a Codex access token's own claims ("" when it doesn't say)."""
    from agent.credential_pool import _decode_jwt_claims

    claims = _decode_jwt_claims(token or "") or {}
    profile = claims.get("https://api.openai.com/profile") or {}
    auth = claims.get("https://api.openai.com/auth") or {}
    email = profile.get("email") if isinstance(profile, dict) else None
    plan = auth.get("chatgpt_plan_type") if isinstance(auth, dict) else None
    return (email if isinstance(email, str) else "") or str(claims.get("email") or ""), \
        (plan.replace("_", " ").title() if isinstance(plan, str) else "")


def _routes():
    from hermes_cli.web_routers import oauth

    return oauth


CODEX_SLUGS = ("openai-codex",)
CODEX = CodexAccounts()
