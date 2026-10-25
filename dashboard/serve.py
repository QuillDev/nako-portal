"""The portal's own server process: the web app, sign-in, push and the hub.

The gateway's adapter starts it (outside the gateway's own service, so it outlives a gateway
restart) and then dials in over the loopback link. Run as `python serve.py <server.json>`;
the adapter writes that file. Only aiohttp and cryptography are needed, not Hermes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import sys
from pathlib import Path

import aiohttp
from aiohttp import web

from portal import push
from portal.hub import Hub
from portal.link import GatewayLink
from portal.server import Portal
from portal.store import Store

log = logging.getLogger("hermes.portal")
WEB_ROOT = Path(__file__).resolve().parent / "web"
BIND_RETRY = 2
# Another server still holding the port this long means one is already serving: leave it be.
BIND_GIVE_UP = 120


async def listen(runner, port):
    """Bind, waiting while an older server hands over the port."""
    waited = 0
    while True:
        try:
            await web.TCPSite(runner, "127.0.0.1", port).start()
            return
        except OSError as error:
            if waited >= BIND_GIVE_UP:
                raise SystemExit(f"portal: 127.0.0.1:{port} stays taken ({error}); another server is running")
            log.info("portal: 127.0.0.1:%s is taken (%s); waiting", port, error)
            await asyncio.sleep(BIND_RETRY)
            waited += BIND_RETRY


async def main(config_path):
    config = json.loads(Path(config_path).read_text())
    data = Path(config["data"])
    store = Store(data / "portal.db")
    vapid = push.Vapid(data / "vapid.pem", config["contact"])
    done = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, done.set)

    async with aiohttp.ClientSession() as http:
        pusher = push.Pusher(http, store, vapid)

        def alert(session, title, text):
            loop.create_task(pusher.notify(title, text, session))

        link = GatewayLink(config["code"], on_stale=done.set)
        hub = Hub(link, alert=alert)
        link.serve(hub)
        portal = Portal(
            hub,
            store,
            origin=config["origin"],
            web_root=WEB_ROOT,
            vapid=vapid,
            android_release_dir=config.get("android_release_dir"),
            android_cert_sha256=config.get("android_cert_sha256"),
            desktop_release_dir=config.get("desktop_release_dir"),
        )
        link.on_change = portal.gateway_changed
        port = int(config["port"])
        token = (data / "local-token").read_text().strip()
        runners = []
        for app, at in ((portal.app(), port), (portal.local_app(token, link), port + 1)):
            runner = web.AppRunner(app, access_log=None)
            await runner.setup()
            runners.append(runner)
            await listen(runner, at)
        (data / "local-url").write_text(f"http://127.0.0.1:{port + 1}\n")
        if not store.has_credentials():
            (data / "setup-link").write_text(f"{config['origin']}/#setup={store.new_setup_link()}\n")
            (data / "setup-link").chmod(0o600)
            log.info("portal: no passkey yet; a setup link is in %s", data / "setup-link")
        log.info("portal: serving %s on 127.0.0.1:%s", config["origin"], port)
        await done.wait()
        log.info("portal: shutting down")
        for runner in runners:
            await runner.cleanup()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main(sys.argv[1]))
