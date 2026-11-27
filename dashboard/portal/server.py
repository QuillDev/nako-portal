"""The portal's web server: the app, its passkey login, a REST API for actions and a WebSocket for live events."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import quote, urlparse

from aiohttp import WSMsgType, web

from . import webauthn
from .auth_routes import CHALLENGE_TTL as CHALLENGE_TTL
from .auth_routes import HANDOFF_TTL as HANDOFF_TTL
from .auth_routes import PKCE_CHALLENGE as PKCE_CHALLENGE
from .auth_routes import AuthRoutes
from .environments import EnvironmentsError
from .group_overview import (
    STATUS_DONE,
    STATUS_IDLE,
    STATUS_NEEDS_YOU,
    STATUS_WAITING,
    STATUS_WORKING,
    clean_snippet,
    is_background_thread,
    sort_threads,
    summarize_counts,
)
from .hub import NEEDS_YOU, WORKING, for_app, page
from .local_api import MAX_BODY, SESSION_ID, LocalAPI
from .local_api import TOOL_RESULT_CHARS as TOOL_RESULT_CHARS
from .media import media_paths, shown_files
from .mesh import parse as remote
from .prs import parse_pr_ref, review_chat_prompt
from .restart_panel import RestartPanel

log = logging.getLogger("hermes.portal")

MAX_FILE = 25 * 1024 * 1024
ANDROID_APK_PATH = "/android/nako.apk"
ANDROID_PACKAGE = "moe.nakode.portal"
# Built files carry their content hash in the name, so a browser can keep them for good.
IMMUTABLE = "public, max-age=31536000, immutable"
# What the browser tab says after an MCP server's sign-in page sends it back: title, line, status.
MCP_CALLBACK_PAGES = {
    "ok": ("Signed in", "You can close this tab and go back to Nako.", 200),
    "failed": ("Sign-in didn't finish", "The server said no. Go back to Nako and try again.", 400),
    "rejected": ("Sign-in already used", "This link was already used. Go back to Nako and try again.", 409),
    "expired": ("Sign-in expired", "Go back to Nako and start it again.", 404),
}
# The page's head waits on these two small scripts before the app can run. A browser runs the copy
# it has and checks for a new one in the background, so a load doesn't wait a round trip on them.
HEAD_SCRIPTS = {"theme.js", "early.js"}
CHECK_IN_BACKGROUND = "max-age=0, stale-while-revalidate=604800"
# A file shown in a chat rarely changes at its path; the browser keeps it a day instead of
# reading it (and the transcript that allows it) again every time the chat opens.
SHOWN_FILE_CACHE = "private, max-age=86400"
# How long the files a transcript shows are remembered before it's read again to check one.
SHOWN_FILES_TTL = 30
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
# Tauri updater platform keys, and the release files they point at (no paths).
DESKTOP_PLATFORM = re.compile(r"^(linux|windows|darwin)-(x86_64|aarch64)$")
DESKTOP_FILE = re.compile(r"^nako[\w.-]*\.(AppImage|exe|tar\.gz)$")
# Scripts stay 'self' only. Inline styles are allowed because the UI components set them
# (Radix's scroll area, Shiki's token colors); blob: lets the composer read picked files.
CSP = (
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
    "connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)


def _index(raw):
    if not raw.isdigit():
        raise ValueError("bad transcript position")
    return int(raw)


class Portal(AuthRoutes, LocalAPI):
    def __init__(
        self,
        hub,
        store,
        *,
        origin,
        web_root,
        rp_name="Nako",
        vapid=None,
        android_release_dir=None,
        android_cert_sha256=None,
        desktop_release_dir=None,
        environments=None,
        machine_load=None,
        inspector=None,
        read_only=False,
        prs=None,
        clock=time.time,
    ):
        self.vapid = vapid
        self.android_release_dir = Path(android_release_dir) if android_release_dir else None
        # The release key's SHA-256 fingerprint; lets the Android app use passkeys for this site.
        self.android_cert_sha256 = android_cert_sha256
        self.desktop_release_dir = Path(desktop_release_dir) if desktop_release_dir else None
        # What runs on this machine, from the owner's own command (`environments.Environments`), else None.
        self.environments = environments
        # Memory and CPU use of this machine (`machine_load.MachineLoad`), else None (no /proc to read).
        self.machine_load = machine_load
        # Read-only transcript inspector for group overviews (`group_overview.GroupInspector`), else None.
        self.inspector = inspector
        # Preview mode: never dispatch live turns; spawn/broadcast return dry-run previews.
        self.read_only = bool(read_only)
        # GitHub PR tracker (`prs.PRService`), else None.
        self.prs = prs
        # Desktop sign-ins the browser approved, waiting for the app: code -> challenge, passkey, expiry.
        self.handoffs = {}
        parsed = urlparse(origin)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("origin must be an http(s) URL")
        self.hub = hub
        self.store = store
        hub.sign_off_on = store.meta("signoff", "on") != "off"
        self._scheme = parsed.scheme
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        # Passkey ceremonies from the Android app carry its signing-key origin, not the site's.
        self.origins = {self.origin}
        if android_cert_sha256:
            self.origins.add(webauthn.android_origin(android_cert_sha256))
        self.rp_id = parsed.hostname
        self.rp_name = rp_name
        self.web_root = Path(web_root).resolve()
        self.clock = clock
        self.challenges = {}
        # Keep every open socket, including ones the hub dropped after a send timeout.
        self._clients = set()
        # __Host- cookies need https; plain http is only ever a local test.
        self.cookie = "__Host-portal" if parsed.scheme == "https" else "portal"
        self.secure = parsed.scheme == "https"
        # session -> (expires, files its transcript shows), so a chat's images don't each reread it.
        self.shown = {}
        self._shown_locks = {}
        # Other machines' Hermes when this portal is a mesh hub (`mesh.Mesh`), else None.
        self.mesh = None
        # This portal's link to its hub when it's a machine in someone's mesh (`mesh.Node`), else None.
        self.node = None
        # This machine's Hermes as the server looks after it (`machine_ops.MachineOps`), else None.
        self.ops = None
        self.restart_panel = RestartPanel(self)

    async def gateway_restart(self, request):
        self._require(request)
        if self.ops is None:
            raise ValueError('Gateway management is not available here')
        body = await request.json() if request.method == 'POST' else None
        return web.json_response(await self.restart_panel.request(body))

    def _reset_backend_readers(self):
        if self.inspector is not None and hasattr(self.inspector, "reset"):
            self.inspector.reset()
        if self.prs is not None and hasattr(self.prs, "invalidate_home"):
            self.prs.invalidate_home()

    async def gateway_changed(self, connected):
        """A gateway connected (show the saved profile, then say so) or went away. Turns and
        questions die with the gateway, so the chats stop showing them as running."""
        self._reset_backend_readers()
        if self.ops is not None:
            self.ops.gateway_changed(connected)
        if connected:
            saved = self.store.meta("profile", None)
            if saved:
                try:
                    await asyncio.to_thread(self.hub.backend.use_profile, saved)
                except Exception:
                    log.warning("portal: can't show saved profile %r; showing the default", saved, exc_info=True)
            self.hub.invalidate_models()
            self.hub.connected = True
            await self.hub.broadcast(self._gateway_frame())
            return
        self.hub.connected = False
        self.hub.invalidate_models()
        self.hub.running.clear()
        self.hub._turn_sessions.clear()
        self.hub._command_turns.clear()
        self.hub.progress.clear()
        self.hub.requests.clear()
        # Nothing says what runs elsewhere without a gateway; it says again once one is back.
        await self.hub.outside({"sources": self.hub.outside_now["sources"], "running": []})
        for session, status in list(self.hub.status.items()):
            if status in (WORKING, NEEDS_YOU):
                del self.hub.status[session]
                await self.hub.broadcast({"kind": "status", "session": session, "status": None, "unread": False})
        await self.hub.broadcast({"kind": "hub.disconnected"})

    def _gateway_frame(self):
        if not self.hub.connected:
            return {"kind": "hub.disconnected"}
        return {"kind": "hub.connected", "hermes": self.hub.hermes_build}

    # Plumbing

    def app(self):
        app = web.Application(client_max_size=MAX_BODY, middlewares=[self._guard])
        r = app.router
        app.cleanup_ctx.append(self.restart_panel.lifecycle)
        r.add_get('/api/gateway/restart', self.gateway_restart)
        r.add_post('/api/gateway/restart', self.gateway_restart)
        r.add_get("/api/me", self.me)
        r.add_post("/api/me/name", self.set_name)
        r.add_get("/api/signoff", self.sign_off)
        r.add_post("/api/signoff", self.set_sign_off)
        r.add_get("/api/profile", self.profile)
        r.add_get("/api/backend", self.backend)
        r.add_post("/api/backend", self.set_backend)
        r.add_post("/api/profile", self.set_profile)
        r.add_get("/api/model/options", self.model_options)
        r.add_get("/api/model", self.model)
        r.add_post("/api/model", self.set_model)
        r.add_get("/api/usage", self.usage)
        r.add_post("/api/usage/reset", self.use_reset)
        r.add_get("/api/model-picks", self.model_picks)
        r.add_post("/api/model-picks/presets", self.put_model_preset)
        r.add_post("/api/model-picks/presets/{id}/remove", self.remove_model_preset)
        r.add_post("/api/model-picks/favorites", self.toggle_model_favorite)
        r.add_get("/api/environments", self._auth(self.list_environments))
        r.add_post("/api/environments/{name}/stop", self._auth(self.stop_environment))
        r.add_get("/api/prs", self._auth(self.list_prs))
        r.add_get("/api/sessions/{session}/prs", self._auth(self.session_prs))
        r.add_post("/api/prs/review-chat", self._auth(self.start_review_chat))
        r.add_get("/api/machine-load", self._auth(self.read_machine_load))
        r.add_post("/api/register/options", self.register_options)
        r.add_post("/api/register/finish", self.register_finish)
        r.add_post("/api/login/options", self.login_options)
        r.add_post("/api/login/finish", self.login_finish)
        r.add_post("/api/logout", self.logout)
        r.add_get("/api/passkeys", self.passkeys)
        r.add_post("/api/passkeys/{id}/remove", self.remove_passkey)
        r.add_get("/api/sessions", self.sessions)
        r.add_get("/api/search", self.search)
        r.add_post("/api/sessions", self.create)
        r.add_get("/api/sessions/{session}", self.open)
        r.add_get("/api/outside", self.outside)
        r.add_get("/api/sessions/{session}/model", self.session_model)
        r.add_post("/api/sessions/{session}/model", self.set_session_model)
        r.add_post("/api/sessions/{session}/messages", self.send)
        r.add_post("/api/sessions/{session}/stop", self.stop)
        r.add_post("/api/sessions/{session}/command", self.command)
        r.add_get("/api/sessions/{session}/processes", self.processes)
        r.add_get("/api/sessions/{session}/processes/{process}/log", self.process_log)
        r.add_get("/api/commands", self.commands)
        r.add_post("/api/sessions/{session}/archive", self.archive)
        r.add_post("/api/sessions/{session}/pin", self.pin)
        r.add_post("/api/sessions/{session}/title", self.title)
        r.add_post("/api/sessions/{session}/group", self._auth(self.set_group))
        r.add_post("/api/sessions/{session}/meta", self._auth(self.set_thread_meta))
        r.add_get("/api/groups", self._auth(self.groups))
        r.add_post("/api/groups", self._auth(self.create_group))
        r.add_get("/api/groups/{group}", self._auth(self.group_overview))
        r.add_get("/api/groups/{group}/overview", self._auth(self.group_overview))
        r.add_post("/api/groups/{group}/spawn", self._auth(self.group_spawn))
        r.add_post("/api/groups/{group}/broadcast", self._auth(self.group_broadcast))
        r.add_post("/api/groups/{group}/archive-idle", self._auth(self.group_archive_idle))
        r.add_post("/api/groups/{group}", self._auth(self.update_group))
        r.add_post("/api/groups/{group}/remove", self._auth(self.delete_group))
        r.add_post("/api/requests/{request}", self.answer)
        r.add_get("/api/secrets", self.secrets)
        r.add_get("/api/secrets/{name}", self.secret)
        r.add_post("/api/secrets/{name}", self.set_secret)
        r.add_post("/api/secrets/{name}/remove", self.remove_secret)
        r.add_get("/api/providers", self.providers)
        r.add_post("/api/providers/{slug}/key", self.set_provider_key)
        r.add_post("/api/providers/{slug}/remove", self.remove_provider_key)
        r.add_post("/api/providers/{slug}/signin", self.start_provider_signin)
        r.add_get("/api/providers/{slug}/signin/{session}", self.provider_signin)
        r.add_post("/api/providers/{slug}/accounts/signin", self.start_account_signin)
        r.add_get("/api/providers/{slug}/accounts/signin/{attempt}", self.account_signin)
        r.add_post("/api/providers/{slug}/accounts/signin/{attempt}/code", self.finish_account_signin)
        r.add_post("/api/providers/{slug}/accounts/signin/{attempt}/cancel", self.cancel_account_signin)
        r.add_post("/api/providers/{slug}/accounts/{account}/remove", self.remove_account)
        r.add_get("/api/mcp", self.mcp_servers)
        r.add_get("/api/mcp/catalog", self.mcp_catalog)
        r.add_post("/api/mcp/catalog/{name}/install", self.mcp_install)
        r.add_post("/api/mcp/servers", self.mcp_add)
        r.add_post("/api/mcp/servers/{name}/enabled", self.mcp_set_enabled)
        r.add_post("/api/mcp/servers/{name}/remove", self.mcp_remove)
        r.add_post("/api/mcp/servers/{name}/test", self.mcp_test)
        r.add_post("/api/mcp/servers/{name}/tools", self.mcp_set_tools)
        r.add_post("/api/mcp/servers/{name}/signin", self.mcp_start_signin)
        r.add_get("/api/mcp/signin/{flow}", self.mcp_signin)
        r.add_post("/api/mcp/signin/{flow}/cancel", self.mcp_cancel_signin)
        r.add_get("/api/mcp/oauth/callback/{name}", self.mcp_oauth_callback)
        r.add_get("/api/file", self.file)
        r.add_get("/api/inbox", self.inbox)
        r.add_get("/api/mesh", self.machines)
        r.add_post("/api/mesh/machines", self.add_machine)
        r.add_post("/api/mesh/plugin-source", self.set_plugin_source)
        r.add_post("/api/mesh/machines/{machine}/remove", self.remove_machine)
        r.add_get("/api/push/key", self.push_key)
        r.add_post("/api/push/subscribe", self.push_subscribe)
        r.add_get("/api/android/release", self.android_release)
        r.add_get(ANDROID_APK_PATH, self.android_apk)
        r.add_get("/.well-known/assetlinks.json", self.assetlinks)
        r.add_post("/api/desktop/link", self.desktop_link)
        r.add_get("/api/desktop/session", self.desktop_session)
        r.add_get("/api/desktop/release", self.desktop_release)
        r.add_get("/desktop/{file}", self.desktop_app)
        r.add_get("/ws", self.socket)
        # Other machines in this portal's mesh dial in and fetch their setup here, by token or
        # setup code rather than sign-in (`mesh.Mesh`); a portal with no mesh answers 404.
        r.add_get("/mesh", self._mesh_route("handle"))
        r.add_get("/mesh/setup/{code}", self._mesh_route("setup"))
        r.add_get("/mesh/setup/{code}/status", self._mesh_route("setup_status"))
        r.add_get("/mesh/setup/{code}/{kind:sh|ps1}", self._mesh_route("script"))
        r.add_get("/{path:.*}", self.static)
        return app

    def _mesh_route(self, name):
        async def route(request):
            if self.mesh is None:
                raise web.HTTPNotFound()
            return await getattr(self.mesh, name)(request)

        return route


    def _same_host_origin(self, request):
        """True when Origin matches the host this request arrived on (same-origin on a moved/alias domain)."""
        origin = request.headers.get("Origin")
        if not origin or not request.host:
            return False
        parsed = urlparse(origin)
        if parsed.scheme.lower() != self._scheme or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            return False
        default_port = 443 if self._scheme == "https" else 80
        host = urlparse(f"{self._scheme}://{request.host}")
        return (
            parsed.hostname is not None
            and host.hostname is not None
            and parsed.hostname.lower() == host.hostname.lower()
            and (parsed.port or default_port) == (host.port or default_port)
        )

    @web.middleware
    async def _guard(self, request, handler):
        # Cross-site requests never reach an action: every write and the socket must come from our own page.
        unsafe = request.method not in {"GET", "HEAD"} or request.path == "/ws"
        if unsafe and request.headers.get("Origin") != self.origin:
            same_host = self._same_host_origin(request)
            if not (request.method == "POST" and request.path == "/api/logout" and same_host):
                if same_host:
                    return web.json_response(
                        {"error": f"This portal moved to {self.origin}", "origin": self.origin},
                        status=403,
                    )
                return web.json_response({"error": "bad origin"}, status=403)
        try:
            response = await handler(request)
        except web.HTTPException as error:
            self._secure(request, error)
            raise
        except ValueError as error:
            response = web.json_response({"error": str(error)}, status=400)
        except ConnectionError:
            response = web.json_response({"error": "Nako is offline right now"}, status=503)
        self._secure(request, response)
        return response

    @staticmethod
    def _secure(request, response):
        response.headers.setdefault("Content-Security-Policy", CSP)
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Robots-Tag", "noindex, nofollow, noarchive")
        if request.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")


    @staticmethod
    def _session(request):
        session = request.match_info["session"]
        if not SESSION_ID.match(session):
            raise ValueError("bad session id")
        return session

    async def _hub(self):
        if not self.hub.connected:
            raise ConnectionError("offline")
        return self.hub

    async def _target(self, session):
        """The hub holding a chat (this one, or a mesh machine's) and the chat's id there."""
        if self.mesh is not None and remote(session):
            return self.mesh.target(session)
        if self.node is not None and remote(session):
            return self.node.remote(session), session
        return await self._hub(), session

    @property
    def mesh_name(self):
        return self.mesh.name if self.mesh is not None else self.node.name if self.node is not None else None


    async def list_environments(self, request):
        """What the owner's environments command says runs here; 404 when none is set."""
        if self.environments is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "no environments command is set"}), content_type="application/json")
        try:
            listed = await self.environments.read()
        except EnvironmentsError as error:
            log.warning("portal: environments: %s", error)
            return web.json_response({"error": str(error)}, status=502)
        return web.json_response({**listed, "can_stop": self.environments.stop_args is not None})

    async def stop_environment(self, request):
        """Run the owner's stop command for one running environment."""
        if self.environments is None or self.environments.stop_args is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "no stop command is set"}), content_type="application/json")
        name = request.match_info["name"]
        try:
            await self.environments.stop(name)
        except LookupError:
            raise web.HTTPNotFound(text=json.dumps({"error": f"{name} isn't running"}), content_type="application/json") from None
        except EnvironmentsError as error:
            log.warning("portal: stopping %s: %s", name, error)
            return web.json_response({"error": str(error)}, status=502)
        log.info("portal: stopped environment %s", name)
        return web.json_response({"stopped": name})

    async def list_prs(self, request):
        """GitHub PRs, stacks, and owning chats; 404 when PR tracking is disabled."""
        if self.prs is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "PR tracking is not enabled"}), content_type="application/json")
        refresh = request.query.get("refresh") in ("1", "true", "yes")
        passive = request.query.get("passive") in ("1", "true", "yes")
        include_older = request.query.get("include_older") in ("1", "true", "yes")
        response = web.json_response(
            await self.prs.snapshot(refresh=refresh, passive=passive, include_older=include_older)
        )
        response.enable_compression()
        return response

    async def session_prs(self, request):
        """PRs owned by or attached to one chat session."""
        if self.prs is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "PR tracking is not enabled"}), content_type="application/json")
        session = self._session(request)
        refresh = request.query.get("refresh") in ("1", "true", "yes")
        return web.json_response(
            {"session": session, "prs": await self.prs.for_session(session, refresh=refresh, passive=not refresh)}
        )

    async def start_review_chat(self, request):
        """Start a review chat for a PR (or return a preview plan in read-only mode)."""
        if self.prs is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "PR tracking is not enabled"}), content_type="application/json")
        body = await request.json()
        repo, number, url = parse_pr_ref(body)
        view = await self.prs.snapshot()
        key = f"{repo}#{number}"
        pr = next((p for p in view["prs"] if p["key"] == key), None)
        if pr is None:
            pr = {
                "key": key,
                "repo": repo,
                "number": number,
                "url": url,
                "title": str(body.get("title") or key),
                "author": str(body.get("author") or ""),
                "base": str(body.get("base") or "main"),
                "head": str(body.get("head") or ""),
            }
        title, prompt = review_chat_prompt(pr)
        custom_prompt = str(body.get("prompt") or "").strip()
        action_label = str(body.get("action_label") or "").strip()
        if custom_prompt:
            prompt = custom_prompt
            short_repo = pr["repo"].split("/")[-1]
            prefix = f"{action_label}: " if action_label else ""
            title = f"{prefix}{short_repo}#{pr['number']} {pr['title']}"[:120]
        if self.prs.readonly:
            return web.json_response({
                "preview": True,
                "pr": key,
                "title": title,
                "prompt": prompt,
                "url": pr["url"],
            })
        hub = await self._hub()
        created = await hub.create(prompt, title=title)
        sid = created.get("session")
        if sid:
            self.store.attach_session_pr(
                sid,
                repo=pr["repo"],
                number=pr["number"],
                url=pr["url"],
                title=pr["title"],
                branch=pr.get("head") or "",
                base=pr.get("base") or "",
                state="open",
            )
            await self.hub.broadcast({"kind": "prs.changed"})
        return web.json_response({"preview": False, "session": sid, "title": title, "pr": key})

    async def local_session_prs(self, request):
        """Loopback API: list explicit PRs attached to a chat session."""
        session = self._session(request)
        return web.json_response(self.store.session_prs(session))

    async def local_attach_pr(self, request):
        """Loopback API: attach/update a GitHub PR on a chat session."""
        session = self._session(request)
        body = await request.json()
        repo, number, url = parse_pr_ref(body)
        attached = self.store.attach_session_pr(
            session,
            repo=repo,
            number=number,
            url=url,
            title=str(body.get("title") or "").strip(),
            branch=str(body.get("branch") or "").strip(),
            base=str(body.get("base") or "").strip(),
            state=str(body.get("state") or "open").strip().lower(),
        )
        await self.hub.broadcast({"kind": "prs.changed"})
        return web.json_response(attached)

    async def local_detach_pr(self, request):
        """Loopback API: detach a GitHub PR from a chat session."""
        session = self._session(request)
        repo, number, _ = parse_pr_ref({
            "repo": f"{request.match_info['owner']}/{request.match_info['repo']}",
            "number": request.match_info["number"],
        })
        removed = self.store.detach_session_pr(session, repo, number)
        if removed:
            await self.hub.broadcast({"kind": "prs.changed"})
        return web.json_response({"removed": removed, "session": session, "pr": f"{repo}#{number}"})

    async def read_machine_load(self, request):
        """Memory in use now and CPU over the last minute; 404 where there's nothing to read."""
        if self.machine_load is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "machine load isn't available here"}), content_type="application/json")
        return web.json_response(await asyncio.to_thread(self.machine_load.read))

    async def set_name(self, request):
        """The name the new-chat greeting uses, kept here so every device says the same thing."""
        self._require(request)
        body = await request.json()
        name = " ".join(str(body.get("name") or "").split())[:40]
        self.store.set_meta("name", name)
        return web.json_response({"name": name})

    async def sign_off(self, request):
        """Settings for Nako's line after a turn: on or off, the model it uses, the models it could."""
        self._require(request)
        backend = self.hub.backend
        current, providers = await asyncio.gather(asyncio.to_thread(backend.sign_off_model), self.hub.sign_off_models())
        return web.json_response({"on": self.hub.sign_off_on, **current, "providers": providers})

    async def set_sign_off(self, request):
        self._require(request)
        body = await request.json()
        if "on" in body:
            self.hub.sign_off_on = bool(body["on"])
            self.store.set_meta("signoff", "on" if self.hub.sign_off_on else "off")
        if body.get("model"):
            provider, model = str(body.get("provider") or ""), str(body["model"])
            offered = await self.hub.sign_off_models()
            if not any(p["provider"] == provider and model in p["models"] for p in offered):
                raise web.HTTPBadRequest(text=json.dumps({"error": "That model isn't available"}), content_type="application/json")
            await asyncio.to_thread(self.hub.backend.set_sign_off_model, provider, model)
        return await self.sign_off(request)

    async def model_picks(self, request):
        """The model picker's saved presets and starred models."""
        self._require(request)
        return web.json_response(self.store.model_picks())

    async def put_model_preset(self, request):
        self._require(request)
        return web.json_response(self.store.put_model_preset(await request.json()))

    async def remove_model_preset(self, request):
        self._require(request)
        return web.json_response(self.store.remove_model_preset(request.match_info["id"]))

    async def toggle_model_favorite(self, request):
        self._require(request)
        return web.json_response(self.store.toggle_model_favorite(await request.json()))

    async def profile(self, request):
        """The Hermes profile the portal shows, and the ones it could."""
        self._require(request)
        return web.json_response(await asyncio.to_thread(self.hub.backend.profiles))

    async def set_profile(self, request):
        """Show another profile: every chat, history and new thread is that profile's from now on."""
        self._require(request)
        body = await request.json()
        try:
            shown = await asyncio.to_thread(self.hub.backend.use_profile, str(body.get("profile") or ""))
        except ValueError as error:
            raise web.HTTPBadRequest(text=json.dumps({"error": str(error)}), content_type="application/json") from error
        self.store.set_meta("profile", shown["profile"])
        self.hub.inboxes = None
        self.hub.invalidate_models()
        self.shown.clear()
        for key, lock in list(self._shown_locks.items()):
            if not lock.locked():
                self._shown_locks.pop(key, None)
        await self.hub.broadcast({"kind": "profile.changed", "profile": shown["profile"]})
        return web.json_response(shown)

    def _backends(self):
        if not hasattr(self.hub.backend, "backend_state"):
            raise web.HTTPNotFound(text=json.dumps({"error": "this portal has one backend"}), content_type="application/json")
        return self.hub.backend

    async def backend(self, request):
        """The agent the portal talks to now, and every agent that could be connected."""
        self._require(request)
        return web.json_response(self._backends().backend_state())

    async def set_backend(self, request):
        """Talk to another connected agent from now on; every app reloads its chats."""
        self._require(request)
        body = await request.json()
        state = await self._backends().set_active_backend(str(body.get("backend") or ""))
        self.shown.clear()
        self._reset_backend_readers()
        return web.json_response(state)

    async def model(self, request):
        """The model the shown profile's turns run on, and the ones it could."""
        self._require(request)
        backend = self.hub.backend
        current, providers = await asyncio.gather(asyncio.to_thread(backend.model), self.hub.models())
        if current is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "model-controls is not enabled"}), content_type="application/json")
        return web.json_response({**current, "providers": providers})

    async def usage(self, request):
        """How much of each signed-in account's plan the shown profile has used."""
        self._require(request)
        providers = await asyncio.to_thread(self.hub.backend.usage)
        if providers is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "model-controls is not enabled"}), content_type="application/json")
        return web.json_response({"providers": providers})

    async def use_reset(self, request):
        """Redeem a banked usage reset credit and return the refreshed limits."""
        self._require(request)
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("provider"), str) or not body["provider"].strip():
            raise web.HTTPBadRequest(text=json.dumps({"error": "Pick a provider"}), content_type="application/json")
        account = body.get("account") if isinstance(body.get("account"), str) else ""
        force = bool(body.get("force"))
        grant = body.get("grant") if isinstance(body.get("grant"), str) else ""
        try:
            args = (body["provider"].strip(), account, force, grant) if grant else (body["provider"].strip(), account, force)
            result = await asyncio.to_thread(self.hub.backend.use_reset, *args)
        except ValueError as error:
            raise web.HTTPBadRequest(text=json.dumps({"error": str(error)}), content_type="application/json") from error
        if result is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "usage resets are not supported"}), content_type="application/json")
        if not result.get("redeemed"):
            raise web.HTTPBadRequest(text=json.dumps({"error": str(result.get("message") or "Could not redeem reset")}), content_type="application/json")
        providers = await asyncio.to_thread(self.hub.backend.usage)
        return web.json_response({"message": str(result.get("message") or ""), "providers": providers or []})

    async def model_options(self, request):
        self._require(request)
        provider, model = (request.query.get(key, "") for key in ("provider", "model"))
        if not provider or not model:
            raise web.HTTPBadRequest(text="Pick a provider and model")
        try:
            options = await asyncio.to_thread(self.hub.backend.model_options, provider, model)
        except ValueError as error:
            raise web.HTTPBadRequest(text=json.dumps({"error": str(error)}), content_type="application/json") from error
        return web.json_response(options)

    async def set_model(self, request):
        self._require(request)
        await self.model(request)
        body = await request.json()
        try:
            await asyncio.to_thread(self.hub.backend.set_model_options, body)
        except ValueError as error:
            raise web.HTTPBadRequest(text=json.dumps({"error": str(error)}), content_type="application/json") from error
        return await self.model(request)

    async def session_model(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        try:
            return web.json_response(await hub.session_model(session))
        except ValueError:
            raise web.HTTPNotFound() from None

    async def set_session_model(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        await self.session_model(request)
        if hub is self.hub and session in self.hub.running:
            raise web.HTTPConflict(text=json.dumps({"error": "Wait for this turn to finish"}), content_type="application/json")
        try:
            return web.json_response(await hub.set_session_model(session, await request.json()))
        except ValueError as error:
            raise web.HTTPBadRequest(text=json.dumps({"error": str(error)}), content_type="application/json") from error


    async def search(self, request):
        self._require(request)
        return web.json_response(await self.hub.search_sessions(request.query.get("q", "")))

    async def sessions(self, request):
        self._require(request)
        hub = await self._hub()
        if request.query.get("archived") == "only":
            return web.json_response(await hub.archived())
        if self.mesh is not None:
            rows, mesh_rows = await asyncio.gather(hub.sessions(), self.mesh.sessions())
        else:
            rows, mesh_rows = await hub.sessions(), []
        member = self.store.chat_groups()
        grouped_chats = {row.get("chat") for row in rows if row.get("chat") in member}
        inspected = await self._inspect_chats(grouped_chats) if grouped_chats else {}
        thread_meta = self.store.thread_meta_map() if grouped_chats else {}
        for row in rows:
            chat = row.pop("chat", None)
            row["group"] = member.get(chat)
            if row["group"]:
                info = inspected.get(row["id"])
                if info:
                    row["group_status"] = info["status"]
                else:
                    meta = thread_meta.get(chat) or {}
                    row["group_status"] = self._fallback_status(row, meta.get("task_state"))
            # A post nobody has opened the chat for since: the sidebar marks it.
            row["unread"] = (row["notifications"] or row["reviews"]) and row["message_count"] > self.store.meta(f"seen:{row['id']}", 0)
        if mesh_rows:
            rows = [*rows, *mesh_rows]
        return web.json_response(rows)

    async def outside(self, request):
        """Sessions that came in another way (Slack, cron, the CLI...), a page at a time, latest
        first; `source` keeps one way in, `offset` skips the pages already shown."""
        self._require(request)
        hub = await self._hub()
        query = request.query
        offset = _index(query.get("offset", "0"))
        return web.json_response(await hub.outside_sessions(query.get("source") or None, offset))

    async def open(self, request):
        self._require(request)
        session = self._session(request)
        hub, inner = await self._target(session) if remote(session) else (self.hub, session)
        opened = await hub.open(inner)
        if hub is self.hub:
            self._remember_shown(session, opened["messages"])
        # Only the Notifications and Reviews chats keep a read mark, so other chats skip relisting every chat.
        if hub is self.hub and hub.connected and (hub.inboxes is None or session in hub.inboxes):
            listed = next((row for row in await hub.sessions() if row["id"] == session), None)
            if listed and (listed["notifications"] or listed["reviews"]):
                self.store.set_meta(f"seen:{session}", listed["message_count"])
        query = request.query
        window = {key: _index(query[key]) for key in ("before", "since") if key in query}
        opened["start"], shown = page(opened["messages"], **window)
        opened["messages"] = [for_app(m) for m in shown]
        return web.json_response(opened)

    async def _message(self, request):
        form = await request.post()
        text = str(form.get("text") or "")
        files = []
        for part in form.getall("file", []):
            if not isinstance(part, web.FileField) or not part.filename:
                continue
            data = part.file.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                raise ValueError("Files must be under 25 MiB")
            content_type = part.content_type or mimetypes.guess_type(part.filename)[0]
            files.append({"filename": Path(part.filename).name, "content_type": content_type, "data": data})
        return text, files

    async def create(self, request):
        self._require(request)
        hub = await self._hub()
        text, files = await self._message(request)
        if not text.strip() and not files:
            raise ValueError("Write something first")
        form = await request.post()
        model = json.loads(str(form["model"])) if "model" in form else None
        if model is not None and not isinstance(model, dict):
            raise ValueError("Pick model settings")
        return web.json_response(await hub.create(text, files, model=model))

    async def send(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        text, files = await self._message(request)
        return web.json_response(await hub.send(session, text, files))

    async def commands(self, request):
        self._require(request)
        hub = await self._hub()
        return web.json_response(await hub.commands())

    async def processes(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        return web.json_response(await hub.processes(session))

    async def process_log(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        proc = request.match_info["process"]
        if not re.fullmatch(r"proc_[0-9a-f]{1,32}", proc):
            raise ValueError("bad process id")
        log = await hub.process_log(session, proc, 200)
        if log is None:
            raise web.HTTPNotFound()
        return web.json_response(log)

    async def command(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        body = await request.json()
        return web.json_response(await hub.command(session, str(body.get("text") or "")))

    async def stop(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        return web.json_response(await hub.interrupt(session))

    async def archive(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        body = await request.json()
        return web.json_response(await hub.archive(session, bool(body.get("archived", True))))

    async def pin(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        body = await request.json()
        await hub.pin(session, bool(body.get("pinned", True)))
        return web.json_response({"ok": True})

    async def title(self, request):
        self._require(request)
        hub, session = await self._target(self._session(request))
        body = await request.json()
        title = str(body.get("title") or "").strip()[:200]
        if not title:
            raise ValueError("Give it a title")
        return web.json_response(await hub.rename(session, title))

    # Chat groups. The same handlers serve the app (signed in) and the loopback API, which is how
    # the agent's group tools reach them.

    def _request_sessions(self):
        return {req["session"] for req in self.hub.requests.values() if req.get("session")}

    def _fallback_status(self, row, explicit_state=None, *, archived=False):
        sid = row["id"]
        if sid in self._request_sessions() or self.hub.status.get(sid) == NEEDS_YOU:
            return STATUS_NEEDS_YOU
        if sid in self.hub.running or self.hub.status.get(sid) == WORKING:
            return STATUS_WORKING
        if explicit_state:
            return explicit_state
        if archived:
            return STATUS_DONE
        return STATUS_IDLE

    async def _inspect_chats(self, chats):
        if not chats or self.inspector is None or not self.inspector.available:
            return {}
        try:
            return await asyncio.to_thread(
                self.inspector.inspect_chats,
                set(chats),
                hub_status=dict(self.hub.status),
                request_sessions=self._request_sessions(),
                thread_meta=self.store.thread_meta_map(),
            )
        except sqlite3.Error as error:
            log.warning("portal: group inspector read failed: %s", error)
            return {}

    async def _group_threads(self, group):
        """All threads belonging to `group` (active and archived), enriched and thoughtfully sorted."""
        chats = set(self.store.group_chats(group["id"]))
        if not chats:
            return []
        meta_map = self.store.thread_meta_map()
        inspected = await self._inspect_chats(chats)
        if inspected:
            return sort_threads(list(inspected.values()))

        # Fallback when no read-only state.db inspector is configured (e.g. fake gateway in tests).
        hub = await self._hub()
        active_rows, archived_raw = await asyncio.gather(
            hub.sessions(),
            asyncio.to_thread(hub.backend.archived_sessions),
        )
        threads = []
        seen = set()
        for row in active_rows:
            chat = row.get("chat")
            if chat not in chats:
                continue
            seen.add(row["id"])
            meta = meta_map.get(chat) or {}
            status = self._fallback_status(row, meta.get("task_state"), archived=False)
            threads.append(
                {
                    "id": row["id"],
                    "chat": chat,
                    "title": row["title"],
                    "status": status,
                    "task_state": meta.get("task_state"),
                    "reason": "Needs approval" if status == STATUS_NEEDS_YOU and row["id"] in self._request_sessions() else "",
                    "activity": "",
                    "summary": meta.get("summary") or clean_snippet(row.get("preview") or ""),
                    "last_active": row.get("started_at") or 0.0,
                    "started_at": row.get("started_at") or 0.0,
                    "message_count": row.get("message_count") or 0,
                    "pinned": bool(row.get("pinned")),
                    "archived": False,
                    "background": is_background_thread(archived=False, title=row["title"], parent=None, chat_id=chat),
                    "prs": [],
                    "previews": [],
                    "branch": None,
                    "links": list(meta.get("links") or []),
                    "parent": None,
                }
            )
        for row in archived_raw:
            chat = row.get("chat_id")
            if chat not in chats or row["id"] in seen:
                continue
            meta = meta_map.get(chat) or {}
            status = self._fallback_status(row, meta.get("task_state"), archived=True)
            title = row.get("title") or row.get("preview") or "untitled"
            threads.append(
                {
                    "id": row["id"],
                    "chat": chat,
                    "title": title,
                    "status": status,
                    "task_state": meta.get("task_state"),
                    "reason": "Archived" if status == STATUS_DONE else "",
                    "activity": "",
                    "summary": meta.get("summary") or clean_snippet(row.get("preview") or ""),
                    "last_active": row.get("started_at") or 0.0,
                    "started_at": row.get("started_at") or 0.0,
                    "message_count": row.get("message_count") or 0,
                    "pinned": bool(row.get("pinned")),
                    "archived": True,
                    "background": True,
                    "prs": [],
                    "previews": [],
                    "branch": None,
                    "links": list(meta.get("links") or []),
                    "parent": None,
                }
            )
        return sort_threads(threads)

    async def _grouped(self):
        """This machine's chats with their group, and the groups."""
        hub = await self._hub()
        rows = await hub.sessions()
        member = self.store.chat_groups()
        return rows, member

    async def groups(self, request):
        """Every group, each with its goal, status counts, and chats (newest first). A group can be empty."""
        try:
            rows, member = await self._grouped()
        except ConnectionError:
            rows, member = [], {}
        grouped_chats = {row.get("chat") for row in rows if row.get("chat") in member}
        inspected = await self._inspect_chats(grouped_chats) if grouped_chats else {}
        meta_map = self.store.thread_meta_map() if grouped_chats else {}
        out = [
            {
                **group,
                "chats": [],
                "counts": {"total": 0, STATUS_WORKING: 0, STATUS_NEEDS_YOU: 0, STATUS_WAITING: 0, STATUS_IDLE: 0, STATUS_DONE: 0},
            }
            for group in self.store.groups()
        ]
        by_id = {group["id"]: group for group in out}
        for row in rows:
            chat = row.get("chat")
            group = member.get(chat)
            if group:
                info = inspected.get(row["id"])
                meta = meta_map.get(chat) or {}
                status = info["status"] if info else self._fallback_status(row, meta.get("task_state"))
                summary = info["summary"] if info else (meta.get("summary") or "")
                entry = by_id[group["id"]]
                entry["chats"].append(
                    {
                        "session": row["id"],
                        "title": row["title"],
                        "status": status,
                        "task_state": meta.get("task_state"),
                        "summary": summary,
                        "is_lead": row["id"] == entry.get("lead_session"),
                    }
                )
                entry["counts"]["total"] += 1
                if status in entry["counts"]:
                    entry["counts"][status] += 1
        return web.json_response(out)

    async def _changed(self):
        await self.hub.broadcast({"kind": "sessions.changed"})

    async def _ensure_lead_member(self, group):
        lead = group.get("lead_session")
        if not lead or remote(lead):
            return
        try:
            hub = await self._hub()
        except ConnectionError:
            return
        chat = await asyncio.to_thread(hub.backend.chat_of, lead)
        if chat:
            self.store.set_chat_group(chat, group["id"])
            self.store.clear_lead_session(lead, keep_group_id=group["id"])

    async def create_group(self, request):
        body = await request.json()
        group = self.store.create_group(
            body.get("name"),
            body.get("color") or None,
            body.get("goal") or "",
            lead_session=body.get("lead_session"),
        )
        await self._ensure_lead_member(group)
        await self._changed()
        return web.json_response(group)

    async def update_group(self, request):
        body = await request.json()
        kwargs = {}
        if "goal" in body:
            kwargs["goal"] = body.get("goal")
        if "lead_session" in body:
            kwargs["lead_session"] = body.get("lead_session")
        group = self.store.update_group(
            request.match_info["group"],
            body.get("name"),
            body.get("color") or None,
            **kwargs,
        )
        if "lead_session" in body and group.get("lead_session"):
            await self._ensure_lead_member(group)
        await self._changed()
        return web.json_response(group)

    async def delete_group(self, request):
        group = self.store.delete_group(request.match_info["group"])
        await self._changed()
        return web.json_response(group)

    async def set_group(self, request):
        """Put a chat in a group (`group`: id or name), or take it out (`group`: null)."""
        session = self._session(request)
        if remote(session):
            raise ValueError("Groups hold this machine's chats only")
        body = await request.json()
        hub = await self._hub()
        chat = await asyncio.to_thread(hub.backend.chat_of, session)
        if not chat:
            raise ValueError("Only portal chats can be grouped")
        group = self.store.set_chat_group(chat, body.get("group") or None)
        self.store.clear_lead_session(session, keep_group_id=group["id"] if group else None)
        await self._changed()
        return web.json_response({"session": session, "group": group})

    async def set_thread_meta(self, request):
        """Update a portal thread's explicit task_state, short summary, or artifact links."""
        session = self._session(request)
        if remote(session):
            raise ValueError("Thread metadata is for this machine's chats only")
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("Send a JSON object")  # noqa: TRY004 - The request guard maps validation ValueError to HTTP 400.
        hub = await self._hub()
        chat = await asyncio.to_thread(hub.backend.chat_of, session)
        if not chat:
            raise ValueError("Only portal chats support group thread metadata")
        kwargs = {}
        for key in ("task_state", "summary", "links"):
            if key in body:
                kwargs[key] = body[key]
        saved = self.store.set_thread_meta(chat, **kwargs)
        await self._changed()
        return web.json_response({"session": session, **saved})

    async def group_overview(self, request):
        """Live group state: lead chat, child/worker threads, status counts, and extracted artifacts."""
        group = self.store.group(request.match_info["group"])
        threads = await self._group_threads(group)
        lead_session = group.get("lead_session")
        public_threads = [
            {**{k: v for k, v in t.items() if k != "chat"}, "is_lead": t["id"] == lead_session}
            for t in threads
        ]
        lead = next((t for t in public_threads if t["is_lead"]), None)
        children = [t for t in public_threads if not t["is_lead"]]
        return web.json_response(
            {
                "group": group,
                "lead_session": lead_session,
                "lead": lead,
                "children": children,
                "now": self.clock(),
                "read_only": self.read_only,
                "counts": summarize_counts(threads),
                "child_counts": summarize_counts(children),
                "threads": public_threads,
            }
        )

    async def group_spawn(self, request):
        """Start a new thread inside this group, optionally inheriting its shared goal."""
        group = self.store.group(request.match_info["group"])
        body = await request.json()
        text = str(body.get("text") or "").strip()
        if not text:
            raise ValueError("Write a prompt first")
        title = str(body.get("title") or "").strip()[:200] or None
        inherit_goal = body.get("inherit_goal", True) is not False
        dry_run = bool(body.get("dry_run")) or self.read_only
        composed = f"[Group goal: {group['name']}]\n{group['goal']}\n\n{text}" if inherit_goal and group["goal"] else text
        if dry_run:
            return web.json_response(
                {
                    "dry_run": True,
                    "read_only": self.read_only,
                    "group": group,
                    "title": title,
                    "composed_text": composed,
                }
            )
        hub = await self._hub()
        created = await hub.create(composed, title=title, sender=body.get("from") or None)
        chat = await asyncio.to_thread(hub.backend.chat_of, created["session"])
        if chat:
            self.store.set_chat_group(chat, group["id"])
        await self._changed()
        return web.json_response({"dry_run": False, "read_only": False, "group": group, **created})

    async def group_broadcast(self, request):
        """Send a follow-up message to selected or active threads in a group (or preview via dry_run)."""
        group = self.store.group(request.match_info["group"])
        body = await request.json()
        text = str(body.get("text") or "").strip()
        if not text:
            raise ValueError("Write a follow-up message first")
        scope = str(body.get("scope") or "active")
        selected = body.get("sessions")
        if selected is not None and not isinstance(selected, list):
            raise ValueError("sessions must be a list of session ids")
        threads = [t for t in await self._group_threads(group) if not t["archived"]]
        if selected is not None:
            wanted = {str(s) for s in selected}
            targets = [t for t in threads if t["id"] in wanted]
        elif scope == STATUS_NEEDS_YOU:
            targets = [t for t in threads if t["status"] == STATUS_NEEDS_YOU]
        elif scope == STATUS_WORKING:
            targets = [t for t in threads if t["status"] == STATUS_WORKING]
        elif scope == "active":
            targets = [t for t in threads if not t["background"]]
        else:
            raise ValueError("Pick a scope from active, needs_you, working, or pass sessions")
        dry_run = bool(body.get("dry_run")) or self.read_only
        summary_targets = [{"id": t["id"], "title": t["title"], "status": t["status"]} for t in targets]
        if dry_run:
            return web.json_response(
                {
                    "dry_run": True,
                    "read_only": self.read_only,
                    "group": group,
                    "text": text,
                    "targets": summary_targets,
                    "sent": [],
                    "failed": [],
                }
            )
        hub = await self._hub()
        sender = body.get("from") or None
        sent, failed = [], []
        for target in targets:
            try:
                await hub.send(target["id"], text, sender=sender)
                sent.append(target["id"])
            except Exception as error:  # noqa: BLE001 - Per-thread failure must not hide other deliveries.
                failed.append({"id": target["id"], "error": str(error)})
        await self._changed()
        return web.json_response(
            {
                "dry_run": False,
                "read_only": False,
                "group": group,
                "text": text,
                "targets": summary_targets,
                "sent": sent,
                "failed": failed,
            }
        )

    async def group_archive_idle(self, request):
        """Bulk-archive idle/finished threads in a group (or preview with dry_run)."""
        group = self.store.group(request.match_info["group"])
        body = await request.json() if request.can_read_body else {}
        selected = body.get("sessions")
        if selected is not None and not isinstance(selected, list):
            raise ValueError("sessions must be a list of session ids")
        threads = [t for t in await self._group_threads(group) if not t["archived"]]
        if selected is not None:
            wanted = {str(s) for s in selected}
            targets = [t for t in threads if t["id"] in wanted]
        else:
            lead_session = group.get("lead_session")
            targets = [
                t
                for t in threads
                if t["id"] != lead_session and not t["pinned"] and t["status"] in (STATUS_IDLE, STATUS_DONE)
            ]
        summary_targets = [{"id": t["id"], "title": t["title"], "status": t["status"]} for t in targets]
        if bool(body.get("dry_run")) or self.read_only:
            return web.json_response(
                {
                    "dry_run": True,
                    "read_only": self.read_only,
                    "group": group,
                    "targets": summary_targets,
                    "archived": [],
                }
            )
        hub = await self._hub()
        archived = []
        for target in targets:
            await hub.archive(target["id"], True)
            archived.append(target["id"])
        await self._changed()
        return web.json_response(
            {
                "dry_run": False,
                "read_only": self.read_only,
                "group": group,
                "targets": summary_targets,
                "archived": archived,
            }
        )

    async def answer(self, request):
        self._require(request)
        body = await request.json()
        request_id = request.match_info["request"]
        if self.mesh is not None and request_id in self.mesh.requests:
            return web.json_response(await self.mesh.answer(request_id, body.get("result") or {}))
        hub = await self._hub()
        return web.json_response(await hub.answer(request_id, body.get("result") or {}))

    # Secrets live in the agent-secrets plugin; without it these answer 404 and the app hides them.

    async def _secrets(self):
        hub = await self._hub()
        if await hub.secrets() is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "The agent-secrets plugin isn't installed"}), content_type="application/json")
        return hub

    async def secrets(self, request):
        """The stored secrets' names, notes and dates; values only come one at a time."""
        self._require(request)
        hub = await self._hub()
        listed = await hub.secrets()
        if listed is None:
            return web.json_response({"error": "The agent-secrets plugin isn't installed"}, status=404)
        return web.json_response(listed)

    async def secret(self, request):
        self._require(request)
        hub = await self._secrets()
        name = request.match_info["name"]
        value = await hub.secret(name)
        if value is None:
            return web.json_response({"error": f"No secret named {name}"}, status=404)
        return web.json_response({"name": name, "value": value})

    async def set_secret(self, request):
        self._require(request)
        hub = await self._secrets()
        body = await request.json()
        await hub.set_secret(request.match_info["name"], body.get("value"), body.get("note"))
        return web.json_response({"ok": True})

    async def remove_secret(self, request):
        self._require(request)
        hub = await self._secrets()
        return web.json_response({"removed": await hub.remove_secret(request.match_info["name"])})

    # Providers: the same list `hermes model` offers, read and changed here.

    async def providers(self, request):
        """Accounts already signed in and API keys already saved, grouped as Hermes lists them."""
        self._require(request)
        hub = await self._hub()
        return web.json_response(await hub.providers())

    async def set_provider_key(self, request):
        self._require(request)
        hub = await self._hub()
        body = await request.json()
        try:
            await hub.set_provider_key(request.match_info["slug"], body.get("value"))
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=400)
        return web.json_response({"ok": True})

    async def remove_provider_key(self, request):
        self._require(request)
        hub = await self._hub()
        try:
            await hub.remove_provider_key(request.match_info["slug"])
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=400)
        return web.json_response({"ok": True})

    async def start_provider_signin(self, request):
        self._require(request)
        hub = await self._hub()
        try:
            return web.json_response(await hub.start_provider_signin(request.match_info["slug"]))
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=400)
        except Exception as error:  # noqa: BLE001 - Provider exceptions become a 502 response.
            log.warning("portal: provider sign-in failed: %s", error)
            return web.json_response({"error": str(error) or "That sign-in didn't start"}, status=502)

    async def provider_signin(self, request):
        self._require(request)
        hub = await self._hub()
        try:
            return web.json_response(await hub.provider_signin(request.match_info["slug"], request.match_info["session"]))
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=404)

    async def start_account_signin(self, request):
        """Sign in to one more account, or again to one already here: whoever signs in decides which."""
        self._require(request)
        hub = await self._hub()
        body = await request.json() if request.can_read_body else {}
        try:
            return web.json_response(await hub.start_account_signin(request.match_info["slug"], (body or {}).get("target")))
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=400)
        except Exception as error:  # noqa: BLE001 - Provider exceptions become a 502 response.
            log.warning("portal: account sign-in failed to start: %s", error)
            return web.json_response({"error": str(error) or "That sign-in didn't start"}, status=502)

    async def finish_account_signin(self, request):
        self._require(request)
        hub = await self._hub()
        body = await request.json()
        try:
            return web.json_response(await hub.finish_account_signin(request.match_info["slug"], request.match_info["attempt"], body.get("code")))
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=400)
        except Exception as error:  # noqa: BLE001 - Provider exceptions become a 502 response.
            log.warning("portal: account sign-in failed: %s", error)
            return web.json_response({"error": str(error) or "That sign-in failed"}, status=502)

    async def account_signin(self, request):
        self._require(request)
        hub = await self._hub()
        try:
            return web.json_response(await hub.account_signin(request.match_info["slug"], request.match_info["attempt"]))
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=404)

    async def cancel_account_signin(self, request):
        self._require(request)
        hub = await self._hub()
        try:
            await hub.cancel_account_signin(request.match_info["slug"], request.match_info["attempt"])
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=400)
        return web.json_response({"ok": True})

    async def remove_account(self, request):
        self._require(request)
        hub = await self._hub()
        try:
            await hub.remove_account(request.match_info["slug"], request.match_info["account"])
        except ValueError as error:
            return web.json_response({"error": str(error)}, status=400)
        return web.json_response({"ok": True})

    # MCP servers: the list `hermes mcp` keeps for the shown profile, read and changed here.

    async def mcp_servers(self, request):
        self._require(request)
        listed = await (await self._hub()).mcp_servers()
        if listed is None:
            return web.json_response({"error": "This Hermes can't run MCP servers"}, status=404)
        return web.json_response(listed)

    async def mcp_catalog(self, request):
        self._require(request)
        return web.json_response(await (await self._hub()).mcp_catalog())

    async def mcp_install(self, request):
        self._require(request)
        body = await request.json()
        env = body.get("env") if isinstance(body.get("env"), dict) else {}
        return web.json_response(await (await self._hub()).mcp_change("mcp_install", request.match_info["name"], env))

    async def mcp_add(self, request):
        self._require(request)
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("bad server")  # noqa: TRY004 - The request guard maps validation ValueError to HTTP 400.
        return web.json_response(await (await self._hub()).mcp_change("mcp_add", body))

    async def mcp_set_enabled(self, request):
        self._require(request)
        body = await request.json()
        await (await self._hub()).mcp_change("mcp_set_enabled", request.match_info["name"], bool(body.get("enabled")))
        return web.json_response({"ok": True})

    async def mcp_remove(self, request):
        self._require(request)
        await (await self._hub()).mcp_change("mcp_remove", request.match_info["name"])
        return web.json_response({"ok": True})

    async def mcp_test(self, request):
        self._require(request)
        return web.json_response(await (await self._hub()).mcp_test(request.match_info["name"]))

    async def mcp_set_tools(self, request):
        self._require(request)
        body = await request.json()
        tools, on = body.get("tools"), body.get("on")
        if not isinstance(tools, list) or not isinstance(on, list):
            raise ValueError("bad tool list")  # noqa: TRY004 - The request guard maps validation ValueError to HTTP 400.
        await (await self._hub()).mcp_change("mcp_set_tools", request.match_info["name"], [str(t) for t in tools], [str(t) for t in on])
        return web.json_response({"ok": True})

    async def mcp_start_signin(self, request):
        """Begin a server's browser sign-in; the provider comes back to `mcp_oauth_callback`."""
        self._require(request)
        name = request.match_info["name"]
        redirect = f"{self.origin}/api/mcp/oauth/callback/{quote(name, safe='')}"
        return web.json_response(await (await self._hub()).mcp_change("mcp_start_signin", name, redirect))

    async def mcp_signin(self, request):
        self._require(request)
        return web.json_response(await (await self._hub()).mcp_signin(request.match_info["flow"]))

    async def mcp_cancel_signin(self, request):
        self._require(request)
        await (await self._hub()).mcp_change("mcp_cancel_signin", request.match_info["flow"])
        return web.json_response({"ok": True})

    async def mcp_oauth_callback(self, request):
        """Where a server's sign-in page sends the browser back. It arrives from another site, so
        the login cookie (SameSite=Strict) isn't sent: the flow's own one-time state is the check."""
        q = request.query
        outcome = await (await self._hub()).mcp_oauth_callback(request.match_info["name"], q.get("code"), q.get("state"), q.get("error"), q.get("iss"))
        title, line, status = MCP_CALLBACK_PAGES.get(outcome, MCP_CALLBACK_PAGES["expired"])
        page = f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>{title}</title><body style='font:15px system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem'><h1 style='font-size:20px'>{title}</h1><p>{line}</p>"
        return web.Response(text=page, content_type="text/html", status=status)

    async def file(self, request):
        """A file shown in that session's transcript (a reply's MEDIA: tag or an image the user attached), and nothing else."""
        self._require(request)
        session = request.query.get("session", "")
        raw = request.query.get("path", "")
        if not SESSION_ID.fullmatch(session):
            raise web.HTTPNotFound()
        if remote(session):
            path = await asyncio.to_thread(self.mesh.attachments.file, session, raw) if self.mesh is not None else None
            if path is None:
                raise web.HTTPNotFound()
            return self._file_response(path, raw, request.query.get("download") == "1")
        hub = await self._hub()
        if not raw.startswith(("/", "~/")):
            raise web.HTTPNotFound()
        path = Path(raw).expanduser()
        if raw not in await self._shown_files(hub, session, raw):
            raise web.HTTPNotFound()

        def readable(target):
            try:
                return target.is_file() and target.stat().st_size <= MAX_FILE
            except OSError:
                return False

        if not await asyncio.to_thread(readable, path):
            raise web.HTTPNotFound()
        return self._file_response(path, raw, request.query.get("download") == "1")

    def _file_response(self, path, raw, download=False):
        """Pictures, sound, PDFs and HTML open in place; `download` saves any of them under its own name."""
        from pathlib import PureWindowsPath
        from urllib.parse import quote

        name = PureWindowsPath(raw).name
        kind = mimetypes.guess_type(name)[0] or "application/octet-stream"
        inline = kind.startswith(("image/", "audio/", "video/")) or kind in {"application/pdf", "text/html"}
        disposition = "inline" if inline and not download else "attachment"
        content_type = "text/html; charset=utf-8" if kind == "text/html" else kind
        csp = (
            "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'"
            if kind == "text/html" and not download
            else "sandbox"
        )
        # A plain ASCII name first for clients that don't read `filename*` (some Android versions).
        plain = "".join(c if 32 <= ord(c) < 127 and c not in '"\\' else "_" for c in name)
        return web.FileResponse(
            path,
            headers={
                "Content-Type": content_type,
                "Content-Disposition": f"{disposition}; filename=\"{plain}\"; filename*=UTF-8''{quote(name, safe='')}",
                "Cache-Control": SHOWN_FILE_CACHE,
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": csp,
            },
        )

    def _remember_shown(self, session, messages):
        now = self.clock()
        files = shown_files(messages)
        if self.mesh is not None and any(message.get("sender") for message in messages):
            received = self.mesh.attachments.delivered(session)
            for message in messages:
                if message.get("sender"):
                    files.update(path for path in media_paths(message.get("text") or "") if path in received)
        files = frozenset(files)
        for stale in [key for key, (until, _) in self.shown.items() if until < now]:
            del self.shown[stale]
            lock = self._shown_locks.get(stale)
            if lock is not None and not lock.locked():
                self._shown_locks.pop(stale, None)
        self.shown[session] = (now + SHOWN_FILES_TTL, files)
        return files

    async def _shown_files(self, hub, session, wanted):
        """The files a session's transcript shows. Remembered for a short while; a file that isn't
        among them rereads the transcript, so one a newer reply delivered still opens."""
        now = self.clock()
        expires, files = self.shown.get(session, (0, frozenset()))
        if expires >= now and wanted in files:
            return files
        lock = self._shown_locks.setdefault(session, asyncio.Lock())
        try:
            async with lock:
                now = self.clock()
                expires, files = self.shown.get(session, (0, frozenset()))
                if expires >= now and wanted in files:
                    return files
                messages = (await hub.open(session))["messages"]
                return self._remember_shown(session, messages)
        finally:
            if session not in self.shown and not lock.locked():
                self._shown_locks.pop(session, None)

    # Other machines (mesh)

    def _mesh(self):
        if self.mesh is None:
            raise ValueError("This portal isn't a mesh hub")
        return self.mesh

    async def machines(self, request):
        self._require(request)
        if self.mesh is None:
            return web.json_response({"hub": False, "machines": []})
        return web.json_response(
            {"hub": True, "name": self.mesh.name, "address": self.mesh.address, "plugin": self.mesh.source_view(), "machines": self.mesh.machines()}
        )

    async def set_plugin_source(self, request):
        self._require(request)
        body = await request.json()
        return web.json_response(self._mesh().set_source(body.get("source")))

    async def add_machine(self, request):
        self._require(request)
        body = await request.json()
        name = str(body.get("name") or "").strip().lower()
        if name in {m["name"] for m in self._mesh().machines()}:
            raise ValueError(f"There's already a machine called {name}")
        return web.json_response(self._mesh().add(name))

    async def remove_machine(self, request):
        self._require(request)
        return web.json_response(await self._mesh().remove(request.match_info["machine"]))

    async def inbox(self, request):
        self._require(request)
        return web.json_response(self.store.inbox())

    async def push_key(self, request):
        self._require(request)
        return web.json_response({"key": self.vapid.public_key if self.vapid else None})

    async def push_subscribe(self, request):
        self._require(request)
        body = await request.json()
        endpoint = str(body.get("endpoint") or "")
        keys = body.get("keys") or {}
        if urlparse(endpoint).scheme != "https" or not keys.get("p256dh") or not keys.get("auth"):
            raise ValueError("That isn't a push subscription")
        self.store.add_push(endpoint, {"p256dh": str(keys["p256dh"]), "auth": str(keys["auth"])})
        return web.json_response({"ok": True})

    # Android app: self-updates from a signed release CI published, and passkeys via Digital Asset Links.

    def _published_release(self):
        if self.android_release_dir is None:
            return None
        try:
            manifest = json.loads((self.android_release_dir / "android-release.json").read_text())
            apk = self.android_release_dir / "nako.apk"
            code, name, sha, size = manifest["versionCode"], manifest["versionName"], manifest["sha256"], manifest["sizeBytes"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        valid = (
            isinstance(code, int) and code > 0 and isinstance(name, str) and name
            and isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{64}", sha)
            and isinstance(size, int) and apk.is_file() and apk.stat().st_size == size
        )
        if not valid:
            return None
        return {"versionCode": code, "versionName": name, "sha256": sha, "sizeBytes": size, "apkUrl": ANDROID_APK_PATH}

    async def android_release(self, request):
        self._require(request)
        release = self._published_release()
        if release is None:
            raise web.HTTPNotFound()
        return web.json_response(release)

    async def android_apk(self, request):
        self._require(request)
        if self._published_release() is None:
            raise web.HTTPNotFound()
        return web.FileResponse(
            self.android_release_dir / "nako.apk",
            headers={"Content-Type": "application/vnd.android.package-archive", "Cache-Control": "no-store"},
        )

    async def assetlinks(self, request):
        if not self.android_cert_sha256:
            raise web.HTTPNotFound()
        statement = {
            "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
            "target": {"namespace": "android_app", "package_name": ANDROID_PACKAGE, "sha256_cert_fingerprints": [self.android_cert_sha256]},
        }
        return web.json_response([statement])

    # Desktop app. It can't use the portal's passkeys (they live in the browser), so the browser signs
    # in and hands the session over: the app sends the browser here with a PKCE challenge and a


    def _published_desktop(self):
        """The published release: its version and, per platform, the file and its updater signature.
        A platform whose file is missing or doesn't match the manifest's size is left out."""
        if self.desktop_release_dir is None:
            return None
        try:
            manifest = json.loads((self.desktop_release_dir / "desktop-release.json").read_text())
            version, platforms = manifest["version"], manifest["platforms"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        if not isinstance(version, str) or not VERSION.match(version) or not isinstance(platforms, dict):
            return None
        files = {}
        for platform, entry in platforms.items():
            if not DESKTOP_PLATFORM.match(str(platform)) or not isinstance(entry, dict):
                continue
            name, signature, size = entry.get("file"), entry.get("signature"), entry.get("sizeBytes")
            if not isinstance(name, str) or not DESKTOP_FILE.match(name) or not isinstance(signature, str) or not signature:
                continue
            path = self.desktop_release_dir / name
            if isinstance(size, int) and path.is_file() and path.stat().st_size == size:
                files[platform] = (name, signature)
        return (version, files) if files else None

    async def desktop_release(self, request):
        self._require(request)
        release = self._published_desktop()
        if release is None:
            raise web.HTTPNotFound()
        version, files = release
        # Tauri's updater format, which the app still reads; it checks the signature against the key built into it.
        platforms = {p: {"url": f"{self.origin}/desktop/{name}", "signature": sig} for p, (name, sig) in files.items()}
        return web.json_response({"version": version, "platforms": platforms})

    async def desktop_app(self, request):
        self._require(request)
        release = self._published_desktop()
        name = request.match_info["file"]
        if release is None or name not in {n for n, _ in release[1].values()}:
            raise web.HTTPNotFound()
        return web.FileResponse(
            self.desktop_release_dir / name,
            headers={"Content-Type": "application/octet-stream", "Cache-Control": "no-store"},
        )

    async def socket(self, request):
        credential = self._require(request)
        token = request.cookies.get(self.cookie)
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=1024 * 1024)
        await ws.prepare(request)
        # The handshake yields: logout may have revoked this login while it was preparing.
        if self.store.login(token) != credential:
            await ws.close(code=1008, message=b"Login revoked")
            return ws
        client = _Client(ws, token, credential)
        self._clients.add(client)
        self.hub.join(client)
        try:
            await client.send(self._gateway_frame())
            # Where every chat stands now; a socket that joins mid-turn would otherwise wait for the next change.
            for frame in self.hub.status_frames() + (self.mesh.status_frames() if self.mesh is not None else []):
                await client.send(frame)
            # That's all of them: apps from before the sticker frame drop anything else they hold.
            await client.send({"kind": "status.synced"})
            await client.send(self.hub.sticker())
            # What runs elsewhere (Slack, cron...), which the app only watches.
            await client.send(self.hub.outside_frame())
            async for message in ws:
                if client.revoked or self.store.login(token) != credential:
                    await ws.close(code=1008, message=b"Login revoked")
                    break
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(message.data)
                except ValueError:
                    continue
                if not isinstance(data, dict):
                    continue
                if "watch" in data:
                    session = str(data["watch"] or "")
                    # No chat open (the new-chat screen) clears what this socket shows.
                    self.hub.watch(client, session if SESSION_ID.match(session) else None)
                    if self.mesh is not None and remote(session):
                        await self.mesh.read(session)
                if isinstance(data.get("looking"), bool):
                    self.hub.look(client, data["looking"])
        finally:
            self._clients.discard(client)
            self.hub.leave(client)
        return ws

    async def static(self, request):
        rel = request.match_info["path"] or "index.html"
        path = (self.web_root / rel).resolve()
        if not path.is_relative_to(self.web_root) or not path.is_file():
            if "." in Path(rel).name:
                raise web.HTTPNotFound()
            path = self.web_root / "index.html"
        if path.parent == self.web_root / "assets":
            headers = {"Cache-Control": IMMUTABLE}
        elif path.parent == self.web_root and path.name in HEAD_SCRIPTS:
            headers = {"Cache-Control": CHECK_IN_BACKGROUND}
        else:
            headers = {"Cache-Control": "no-cache"}
        if path.name == "sw.js":
            headers["Service-Worker-Allowed"] = "/"
        return web.FileResponse(path, headers=headers)


class _Client:
    def __init__(self, ws, token=None, credential=None):
        self.ws = ws
        self.token = token
        self.credential = credential
        self.revoked = False
        self.lock = asyncio.Lock()

    async def send(self, message):
        await self.send_text(json.dumps(message))

    async def send_text(self, payload):
        async with self.lock:
            if self.revoked:
                return
            await self.ws.send_str(payload)
