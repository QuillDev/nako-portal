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
from portal.machine_ops import MachineOps
from portal.mesh import Mesh, Node
from portal.offline import Offline
from portal.server import Portal
from portal.store import Store

log = logging.getLogger("hermes.portal")
WEB_ROOT = Path(__file__).resolve().parent / "web"
BIND_RETRY = 2
# Another server still holding the port this long means one is already serving: leave it be.
BIND_GIVE_UP = 120


async def listen(runner, port, host="127.0.0.1"):
    """Bind, waiting while an older server hands over the port."""
    waited = 0
    while True:
        try:
            await web.TCPSite(runner, host, port).start()
            return
        except OSError as error:
            if waited >= BIND_GIVE_UP:
                raise SystemExit(f"portal: {host}:{port} stays taken ({error}); another server is running")
            log.info("portal: %s:%s is taken (%s); waiting", host, port, error)
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
        try:
            loop.add_signal_handler(sig, done.set)
        except (NotImplementedError, RuntimeError):
            # Windows: no loop signal handlers; Ctrl+C still raises KeyboardInterrupt, and the
            # gateway replaces a stale server through the link (409) rather than a signal.
            pass

    async with aiohttp.ClientSession() as http:
        pusher = push.Pusher(http, store, vapid)

        def alert(session, title, text):
            loop.create_task(pusher.notify(title, text, session))

        link = GatewayLink(config["code"], on_stale=done.set)
        hub = Hub(link, alert=alert)
        link.serve(hub)
        # Hermes's home: chats are read from its session store while no gateway is connected.
        home = Path(config.get("home") or data.parent)
        link.offline = Offline(home)
        mesh = config.get("mesh") or {}
        # This machine's Hermes, looked after from here: its version, gateway restarts, updates.
        # A machine in someone's mesh also brings its gateway back when it goes away and stays away.
        ops = MachineOps(data, home, config.get("hermes"), hub, watchdog=bool(mesh.get("hub")) and mesh.get("watchdog", True) is not False)
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
        portal.ops = ops
        port = int(config["port"])
        token = (data / "local-token").read_text().strip()
        sites = [(portal.app(), "127.0.0.1", port), (portal.local_app(token, link), "127.0.0.1", port + 1)]
        tasks = [loop.create_task(ops.refresh())]
        if mesh.get("address"):
            # This portal is a hub: machines dial in on its own address (the public app serves
            # /mesh), and on `listen` too when one is set.
            portal.mesh = Mesh(data, hub, name=mesh.get("name") or "hub", address=mesh["address"], plugin=mesh.get("plugin"), skills_dir=mesh.get("skills_dir"), skills_exclude=mesh.get("skills_exclude") or (), store=store, ops=ops)
            if mesh.get("listen"):
                host, _, at = str(mesh["listen"]).rpartition(":")
                sites.append((portal.mesh.app(), host or "127.0.0.1", int(at)))
        elif mesh.get("hub"):
            # This portal is a machine in someone's mesh: dial its hub.
            node = Node(mesh["hub"], mesh["name"], mesh["token"], hub, skills_into=mesh.get("skills_into"), ops=ops)
            portal.node = node
            tasks.append(loop.create_task(node.run(http)))
        runners = []
        for app, host, at in sites:
            runner = web.AppRunner(app, access_log=None)
            await runner.setup()
            runners.append(runner)
            await listen(runner, at, host)
        (data / "local-url").write_text(f"http://127.0.0.1:{port + 1}\n")
        if not store.has_credentials():
            (data / "setup-link").write_text(f"{config['origin']}/#setup={store.new_setup_link()}\n")
            (data / "setup-link").chmod(0o600)
            log.info("portal: no passkey yet; a setup link is in %s", data / "setup-link")
        log.info("portal: serving %s on 127.0.0.1:%s", config["origin"], port)
        await done.wait()
        log.info("portal: shutting down")
        for task in tasks:
            task.cancel()
        for runner in runners:
            await runner.cleanup()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main(sys.argv[1]))
