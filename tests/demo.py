"""Runs the portal against the fake backend for a browser walk-through: python tests/demo.py <port>."""

import asyncio
import sys
import tempfile
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).parent))
from conftest import ROOT, FakeHermes, Pins  # noqa: E402
from portal.hub import Hub  # noqa: E402
from portal.rpc import Rpc  # noqa: E402
from portal.server import Portal  # noqa: E402
from portal.store import Store  # noqa: E402


async def main(port):
    hermes = FakeHermes()
    hermes.reply = "Here's the plan:\n\n1. **Rebase** onto `main`\n2. Re-run CI\n\n```bash\ngit rebase origin/main\n```"
    hermes.add_session("20261024_090000_aaaaaa", "Fix the flaky CI shard", messages=[("user", "why is shard 3 failing?"), ("assistant", "The `orders` e2e test races the seed script. I'd add a wait on the seed job.")])
    hermes.add_session("20261024_080000_bbbbbb", "Plan next week")
    hermes.add_session("20261023_070000_cccccc", "Write the release notes")
    backend = TestServer(hermes.app())
    await backend.start_server()
    data = Path(tempfile.mkdtemp())
    store = Store(data / "portal.db")
    async with aiohttp.ClientSession() as http:
        hub = Hub(Rpc(http, str(backend.make_url("/api/ws"))), pins=Pins())
        origin = f"http://localhost:{port}"
        portal = Portal(hub, store, origin=origin, web_root=ROOT / "dashboard" / "web")
        runner = web.AppRunner(portal.app())
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", port).start()
        (data / "setup-link").write_text(f"{origin}/#setup={store.new_setup_link()}\n")
        print(f"setup link file: {data / 'setup-link'}", flush=True)

        async def desktop_typing():
            await hub.ready.wait()
            while True:
                await asyncio.sleep(3600)

        await asyncio.gather(hub.serve(), desktop_typing())


asyncio.run(main(int(sys.argv[1])))
