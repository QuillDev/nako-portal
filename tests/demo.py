"""Runs the portal against the fake backend for a browser walk-through: python tests/demo.py <port>."""

import asyncio
import os
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


class DemoHermes(FakeHermes):
    """Turns that look like real ones: reasoning, tool calls and a reply streamed in pieces.
    A message mentioning "delete" asks for approval; one with "ask" asks a question.
    History reads take a moment, like a long transcript on a real machine."""

    async def handle(self, method, params):
        if method == "session.history":
            await asyncio.sleep(0.6)
        return await super().handle(method, params)

    async def _turn(self, sid, text):
        await self.emit(sid, "message.start")
        for piece in ["Looking at ", "the shard logs ", "first."]:
            await self.emit(sid, "reasoning.delta", {"text": piece})
            await asyncio.sleep(0.3)
        method = "approval" if "delete" in text else "clarify" if "ask" in text else None
        if method:
            params = (
                {"command": "rm -rf build", "description": "delete the build folder", "choices": ["once", "session", "deny"]}
                if method == "approval"
                else {"questions": [{"qid": "q1", "question": "Which branch?", "choices": ["main", "develop"]}]}
            )
            frame = {"jsonrpc": "2.0", "id": "req-1", "method": method, "params": {"session_id": self.runtime(sid), "request_id": "req-1", **params}}
            for ws in list(self.sockets):
                await ws.send_json(frame)
            return
        for i, (name, context) in enumerate([("terminal", "gh run view 123 --log-failed"), ("read_file", "tests/e2e/orders.spec.ts")]):
            await self.emit(sid, "tool.start", {"tool_id": f"t{i}", "name": name, "context": context})
            await asyncio.sleep(0.8)
            self._row(sid, "tool", "", name=name, context=context, tool_call_id=f"t{i}")
            await self.emit(sid, "tool.complete", {"tool_id": f"t{i}", "name": name, "summary": "done in 0.8s"})
        for word in self.reply.split(" "):
            await self.emit(sid, "message.delta", {"text": word + " "})
            await asyncio.sleep(0.04)
        self._row(sid, "assistant", self.reply, reasoning="Looking at the shard logs first.")
        await self.emit(sid, "message.complete", {"status": "complete", "text": self.reply})


async def main(port):
    hermes = DemoHermes()
    hermes.reply = "Here's the plan:\n\n1. **Rebase** onto `main`\n2. Re-run CI\n\n```bash\ngit rebase origin/main\n```"
    hermes.add_session("20261024_090000_aaaaaa", "Fix the flaky CI shard", messages=[("user", "why is shard 3 failing?")])
    hermes._row("20261024_090000_aaaaaa", "tool", "", name="terminal", context="gh run view 123 --log-failed", tool_call_id="h1")
    hermes._row("20261024_090000_aaaaaa", "tool", "", name="search_files", context="seed.ts", tool_call_id="h2")
    hermes._row("20261024_090000_aaaaaa", "assistant", "The `orders` e2e test races the seed script. I'd add a wait on the seed job:\n\n| shard | status |\n| --- | --- |\n| 1 | passing |\n| 3 | flaky |", reasoning="Shard 3 runs orders.spec.ts, which reads seeded rows.")
    shots = Path(tempfile.mkdtemp())
    for name in ("layout.png", "error.png"):
        (shots / name).write_bytes((ROOT / "web" / "public" / "icon-512.png").read_bytes())
    hermes.add_session(
        "20261024_085000_dddddd",
        "Label layout",
        messages=[
            ("user", f"this label prints wrong\n\n[Image attached at: {shots / 'error.png'}]\n[screenshot]\nVoice: a note a plugin added for the model"),
            ("assistant", f"Here's the fixed layout MEDIA:{shots / 'layout.png'}, with the barcode on the right.\n\nMEDIA:{shots / 'gone.png'}"),
        ],
    )
    hermes.add_session("20261024_080000_bbbbbb", "Plan next week")
    hermes.add_session("20261023_070000_cccccc", "Write the release notes")
    long = hermes.add_session("20261023_060000_eeeeee", "Untangle the importer")
    for turn in range(1, 81):
        hermes._row(long, "user", f"step {turn}: what's next for the importer?")
        hermes._row(long, "tool", "", name="read_file", context=f"src/importer/stage_{turn}.ts", tool_call_id=f"l{turn}")
        body = " ".join(["The row parser and the batch writer disagree about blank lines, so this pass makes them share one reader."] * (1 + turn % 3))
        hermes._row(long, "assistant", f"**Step {turn}.** {body}")
    backend = TestServer(hermes.app())
    await backend.start_server()
    data = Path(tempfile.mkdtemp())
    store = Store(data / "portal.db")
    async with aiohttp.ClientSession() as http:
        hub = Hub(Rpc(http, str(backend.make_url("/api/ws"))), pins=Pins())
        origin = f"http://localhost:{port}"
        # NAKO_DESKTOP_RELEASE_DIR serves a desktop build for trying the app's self-update.
        portal = Portal(hub, store, origin=origin, web_root=ROOT / "dashboard" / "web", desktop_release_dir=os.environ.get("NAKO_DESKTOP_RELEASE_DIR"))
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
