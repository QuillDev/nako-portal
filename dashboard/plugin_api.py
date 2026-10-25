"""Backend half: runs the portal inside the Hermes backend, on its own loopback port.

It starts with the backend (no Desktop toggle), talks to sessions through the
same `/api/ws` RPC Desktop uses with the server-internal credential, and serves
the web app to Caddy on 127.0.0.1. Nothing it holds leaves this machine.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import logging
import sqlite3
import sys
import threading
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlencode

import aiohttp
from aiohttp import web
from fastapi import APIRouter

_package = __name__ + "_portal"
_spec = importlib.util.spec_from_file_location(
    _package, Path(__file__).parent / "portal" / "__init__.py", submodule_search_locations=[str(Path(__file__).parent / "portal")]
)
_module = importlib.util.module_from_spec(_spec)
sys.modules[_package] = _module
_spec.loader.exec_module(_module)
Hub = importlib.import_module(_package + ".hub").Hub
Portal = importlib.import_module(_package + ".server").Portal
Rpc = importlib.import_module(_package + ".rpc").Rpc
Store = importlib.import_module(_package + ".store").Store
push = importlib.import_module(_package + ".push")

log = logging.getLogger("hermes.portal")
PLUGIN = "nako-portal"
DEFAULT_PORT = 8797
INBOX_POLL = 2
WEB_ROOT = Path(__file__).parent / "web"


def _settings():
    from hermes_cli.config import load_config
    from hermes_constants import get_hermes_home, named_profile_home

    config = load_config()
    plugins = config.get("plugins", {})
    if PLUGIN not in plugins.get("enabled", []):
        raise RuntimeError("Enable the nako-portal plugin first")
    home = get_hermes_home().resolve()
    if named_profile_home(home) is not None:
        raise RuntimeError("Nako portal runs for the default profile only")
    entry = plugins.get("entries", {}).get(PLUGIN, {}).get("settings", {})
    origin = str(entry.get("origin") or "").strip()
    if not origin.startswith("https://"):
        raise RuntimeError("Set plugins.entries.nako-portal.settings.origin to the portal's https URL")
    apps = {
        "android_release_dir": entry.get("android_release_dir") or None,
        "android_cert_sha256": entry.get("android_cert_sha256") or None,
        "desktop_release_dir": entry.get("desktop_release_dir") or None,
    }
    contact = str(entry.get("contact") or "mailto:owner@localhost")
    return home, origin.rstrip("/"), int(entry.get("port") or DEFAULT_PORT), contact, apps


def _connection_url(app, port):
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth.ws_tickets import internal_ws_credential

    def url():
        if getattr(app.state, "auth_required", False):
            query = {"internal": internal_ws_credential()}
        else:
            query = {"token": web_server._SESSION_TOKEN}
        return f"http://127.0.0.1:{port}/api/ws?{urlencode(query)}"

    return url


class HermesPins:
    """Desktop pins, read from and written to the profile's own session database."""

    def __init__(self, home):
        self.path = home / "state.db"

    def pinned(self):
        with closing(sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)) as db:
            return {row[0] for row in db.execute("SELECT id FROM sessions WHERE pinned=1")}

    def set(self, session, pinned):
        from hermes_state_registry import acquire, release_or_close

        db = acquire(self.path)
        try:
            db.set_session_pinned(session, pinned)
        finally:
            release_or_close(db)


class _Service:
    def __init__(self):
        self.thread = None
        self.error = "starting"
        self.lock = threading.Lock()

    def ensure(self):
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                return
            self.thread = threading.Thread(target=self._run, name="nako-portal", daemon=True)
            self.thread.start()

    def _run(self):
        from hermes_cli.web_server import app

        while getattr(app.state, "bound_port", None) is None:
            time.sleep(0.5)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._main(app))
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
            log.exception("Nako portal stopped")

    async def _configured(self):
        while True:
            try:
                settings = _settings()
            except RuntimeError as error:
                self.error = str(error)
                log.warning("Nako portal waiting: %s", self.error)
                await asyncio.sleep(30)
                continue
            self.error = None
            return settings

    async def _main(self, app):
        home, origin, port, contact, apps = await self._configured()
        data = home / "nako-portal"
        store = Store(data / "portal.db")
        vapid = push.Vapid(data / "vapid.pem", contact)
        async with aiohttp.ClientSession() as http:
            pusher = push.Pusher(http, store, vapid)
            loop = asyncio.get_running_loop()

            def alert(session, title, text):
                loop.create_task(pusher.notify(title, text, session))

            hub = Hub(Rpc(http, _connection_url(app, app.state.bound_port)), pins=HermesPins(home), alert=alert)
            portal = Portal(hub, store, origin=origin, web_root=WEB_ROOT, vapid=vapid, **apps)
            runner = web.AppRunner(portal.app(), access_log=None)
            await runner.setup()
            await web.TCPSite(runner, "127.0.0.1", port).start()
            log.info("Nako portal serving %s on 127.0.0.1:%s", origin, port)
            if not store.has_credentials():
                (data / "setup-link").write_text(f"{origin}/#setup={store.new_setup_link()}\n")
                (data / "setup-link").chmod(0o600)
                log.info("Nako portal has no passkey yet; a setup link is in %s", data / "setup-link")
            await asyncio.gather(hub.serve(), _forward_inbox(store, hub))


async def _forward_inbox(store, hub):
    """Messages the gateway delivered to the portal (cron results, send_message) become notifications."""
    last = store.meta("inbox_pushed", None)
    if last is None:
        newest = store.inbox(1)
        last = newest[0]["id"] if newest else 0
    while True:
        await asyncio.sleep(INBOX_POLL)
        fresh = [row for row in reversed(store.inbox(50)) if row["id"] > last]
        for row in fresh:
            first = (row["text"].strip().splitlines() or [""])[0][:180]
            hub.notify(None, "Nako", first)
            last = row["id"]
        if fresh:
            store.set_meta("inbox_pushed", last)


_service = _Service()
router = APIRouter()


@router.get("/status")
async def status():
    return {"running": _service.thread is not None and _service.thread.is_alive(), "error": _service.error}


_service.ensure()
