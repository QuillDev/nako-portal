"""Runs the portal against the fake backend for a browser walk-through: python tests/demo.py <port>."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).parent))
from conftest import ROOT, Backend, FakeGateway  # noqa: E402
from portal.hub import Hub  # noqa: E402
from portal.server import Portal  # noqa: E402
from portal.store import Store  # noqa: E402


class DemoGateway(FakeGateway):
    """Turns that look like real ones on a gateway platform: a tool progress line, then a reply
    streamed by edits. A message mentioning "delete" asks for approval; one with "ask" asks a question.
    History reads take a moment, like a long transcript on a real machine."""

    def thread(self, sid):
        import time

        time.sleep(0.6)
        return super().thread(sid)

    async def _turn(self, chat, sid):
        await self.hub.turn_started(chat)
        text = self.sessions[sid]["rows"][-1]["text"]
        method = "approval" if "delete" in text else "clarify" if "ask" in text else None
        if method:
            params = (
                {"command": "rm -rf build", "description": "delete the build folder", "choices": ["once", "session", "deny"]}
                if method == "approval"
                else {"questions": [{"qid": "q1", "question": "Which branch?", "choices": ["main", "develop"]}]}
            )
            await self.hub.ask(chat, {"id": "req-1", "method": method, "params": params, "private": {}})
            return
        await asyncio.sleep(self.pause)
        for name, context in (("terminal", "gh run list --branch main"), ("terminal", "gh run view 123 --log-failed"), ("search_files", "orders.spec.ts")):
            call = f"t{self.next_row}"
            await self.hub.tool(sid, call, name, context, "running")
            await asyncio.sleep(self.pause)
            await self.hub.tool(sid, call, name, context, "done")
            self._row(sid, "tool", "", name=name, context=context, tool_call_id=call)
        await asyncio.sleep(self.pause / 2)
        shown = ""
        for word in self.reply.split(" "):
            shown += word + " "
            await self.hub.outgoing(chat, "reply", shown.strip())
            await asyncio.sleep(self.pause / 25)
        self._row(sid, "assistant", self.reply)
        await self.hub.turn_finished(chat, "success")


async def main(port):
    hermes = DemoGateway()
    # Seconds per step of a demo turn; long enough to watch each state.
    hermes.pause = float(os.environ.get("DEMO_PAUSE", "1"))
    hermes.reply = "Here's the plan:\n\n1. **Rebase** onto `main`\n2. Re-run CI\n\n```bash\ngit rebase origin/main\n```"
    hermes.add_session("20261024_090000_aaaaaa", "Fix the flaky CI shard", messages=[("user", "why is shard 3 failing?")])
    hermes._row("20261024_090000_aaaaaa", "tool", "", name="terminal", context="gh run view 123 --log-failed", tool_call_id="h1")
    hermes._row("20261024_090000_aaaaaa", "tool", "", name="search_files", context="seed.ts", tool_call_id="h2")
    hermes._row("20261024_090000_aaaaaa", "assistant", "The `orders` e2e test races the seed script. I'd add a wait on the seed job:\n\n| shard | status |\n| --- | --- |\n| 1 | passing |\n| 3 | flaky |", reasoning="Shard 3 runs orders.spec.ts, which reads seeded rows.")
    shots = Path(tempfile.mkdtemp())
    for name in ("layout.png", "error.png"):
        (shots / name).write_bytes((ROOT / "web" / "public" / "icon-512.png").read_bytes())
    (shots / "barcode.png").write_bytes((ROOT / "web" / "public" / "icon-192.png").read_bytes())
    hermes.add_session(
        "20261024_085000_dddddd",
        "Label layout",
        messages=[
            ("user", f"this label prints wrong\n\n[Image attached at: {shots / 'error.png'}]\n[screenshot]\nVoice: a note a plugin added for the model"),
            ("assistant", f"Here's the fixed layout MEDIA:{shots / 'layout.png'}, with the barcode on the right.\n\nMEDIA:{shots / 'gone.png'}\nMEDIA:{shots / 'barcode.png'}"),
        ],
    )
    hermes.add_session("20261024_080000_bbbbbb", "Plan next week")
    hermes.add_session(
        "20261024_093000_d00001",
        "Notifications",
        chat="inbox",
        messages=[
            ("user", "[Cron delivery: build watch]\nci went red on main: the lint job fails on an unused import"),
            ("user", "[Cron delivery: build watch]\nci is green again on main"),
            ("user", "[Cron delivery: news digest]\nfive links worth reading today, starting with a new sorting paper"),
            ("user", "which one is worth reading first?"),
            ("assistant", "the sorting paper. it's short and the benchmark section is the interesting part."),
        ],
    )
    hermes.add_session("20261023_070000_cccccc", "Write the release notes")
    long = hermes.add_session("20261023_060000_eeeeee", "Untangle the importer")
    for turn in range(1, 81):
        hermes._row(long, "user", f"step {turn}: what's next for the importer?")
        hermes._row(long, "tool", "", name="read_file", context=f"src/importer/stage_{turn}.ts", tool_call_id=f"l{turn}")
        body = " ".join(["The row parser and the batch writer disagree about blank lines, so this pass makes them share one reader."] * (1 + turn % 3))
        hermes._row(long, "assistant", f"**Step {turn}.** {body}")
    data = Path(tempfile.mkdtemp())
    store = Store(data / "portal.db")
    hub = Hub(Backend(hermes))
    hermes.hub = hub
    origin = f"http://localhost:{port}"
    # NAKO_DESKTOP_RELEASE_DIR serves a desktop build for trying the app's self-update.
    portal = Portal(hub, store, origin=origin, web_root=ROOT / "dashboard" / "web", desktop_release_dir=os.environ.get("NAKO_DESKTOP_RELEASE_DIR"))
    runner = web.AppRunner(portal.app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    (data / "setup-link").write_text(f"{origin}/#setup={store.new_setup_link()}\n")
    print(f"setup link file: {data / 'setup-link'}", flush=True)
    await asyncio.Event().wait()


asyncio.run(main(int(sys.argv[1])))
