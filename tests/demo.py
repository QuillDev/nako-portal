"""Runs the portal against the fake backend for a browser walk-through: python tests/demo.py <port>."""

import asyncio
import os
import sys
import tempfile
import time
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

    def sign_off(self, reply):
        import time

        time.sleep(1.5)
        return "tamed the flaky timer, fifty clean runs"

    def sign_off_models(self):
        return [
            {"provider": "anthropic", "label": "Anthropic", "models": ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]},
            {"provider": "openrouter", "label": "OpenRouter", "models": ["meta-llama/llama-5-8b-instruct", "google/gemini-3-flash"]},
        ]

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
    hermes.sign_off_route = {"provider": "anthropic", "model": "claude-sonnet-5-5"}
    hermes.pause = float(os.environ.get("DEMO_PAUSE", "1"))
    hermes.reply = "Here's the plan:\n\n1. **Rebase** onto `main`\n2. Re-run CI\n\n```bash\ngit rebase origin/main\n```"
    hermes.add_session("20261024_090000_aaaaaa", "Fix the flaky CI shard", messages=[("user", "why is shard 3 failing?")])
    hermes._row("20261024_090000_aaaaaa", "tool", "", name="terminal", context="gh run view 123 --log-failed", tool_call_id="h1")
    hermes._row("20261024_090000_aaaaaa", "user", "check shard 1 too while you're in there", display_kind="steer")
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
    # A reply citing another chat the way session search does, which renders as a link to it.
    hermes.add_session(
        "20261024_080000_bbbbbb",
        "Plan next week",
        messages=[
            ("user", "where did the ci thread go?"),
            ("assistant", "it's this one: @session:default/20261024_090000_aaaaaa. the label fix is in @session:default/20261024_085000_dddddd, and `@session:default/20261024_085000_dddddd` stays as typed in code."),
        ],
    )
    # Background processes the CI chat's turns left running, as the gateway's process registry lists them.
    now = time.time()
    hermes.procs["20261024_090000_aaaaaa"] = [
        {"id": "proc_1a2b3c4d5e6f", "command": "W=scripts/wait-for-ci.sh; bash $W acme/shop 412 60", "cwd": "/srv/shop", "running": True, "started_at": now - 14 * 60, "exited_at": None, "exit_code": None, "notify": True},
        {"id": "proc_2b3c4d5e6f7a", "command": "cd web && npm run dev -- --port 5174", "cwd": "/srv/shop", "running": True, "started_at": now - 72 * 60, "exited_at": None, "exit_code": None, "notify": False},
        {"id": "proc_3c4d5e6f7a8b", "command": "npx playwright test orders.spec.ts --repeat-each 50", "cwd": "/srv/shop", "running": False, "started_at": now - 30 * 60, "exited_at": now - 21 * 60, "exit_code": 0, "ended": "exited", "notify": True},
    ]
    hermes.proc_logs["proc_1a2b3c4d5e6f"] = [
        line
        for n in range(1, 15)
        for line in (f"[{n:02d}:00] pr #412 @ 9f3c2e1: {min(n // 2 + 2, 7)}/7 checks done", f"[{n:02d}:00]   pending: {'e2e (shard 3), ' if n < 13 else ''}deploy-preview")
    ]
    hermes.proc_logs["proc_2b3c4d5e6f7a"] = [
        "> shop-web@2.4.0 dev", "> vite --port 5174", "", "  VITE v7.1.3  ready in 412 ms", "", "  ➜  Local:   http://localhost:5174/", "  ➜  Network: use --host to expose",
        "10:02:11 [vite] hmr update /src/routes/orders.tsx", "10:14:40 [vite] hmr update /src/routes/orders.tsx, /src/index.css", "10:31:05 [vite] page reload src/lib/seed.ts",
    ]
    hermes.proc_logs["proc_3c4d5e6f7a8b"] = ["Running 50 tests using 4 workers", *[f"  ✓  {n} orders.spec.ts:14:3 › lists seeded orders (1.{n % 9}s)" for n in range(1, 51)], "", "  50 passed (1.4m)"]
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
    # Another profile's own chats, shown after switching profiles in Settings.
    hermes.add_session("20261024_100000_p00001", "Draft the onboarding email", messages=[("user", "write a short welcome email for new users")], profile="work")
    hermes.add_session("20261024_093000_p00002", "Notifications", chat="inbox", profile="work")
    hermes.add_session("20261023_100000_p00003", "Compare vector databases", profile="work")
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
