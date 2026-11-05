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
from portal.environments import Environments  # noqa: E402
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

    def usage(self):
        time.sleep(0.8)
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        resets = (now + timedelta(days=4)).isoformat()
        session = (now + timedelta(hours=3)).isoformat()
        return [
            {"provider": "claude", "label": "Claude", "accounts": [
                {"label": "work", "windows": [
                    {"label": "Current session", "used_percent": 38.0, "resets_at": session},
                    {"label": "Current week", "used_percent": 100.0, "resets_at": (now + timedelta(hours=20)).isoformat()},
                ], "note": None},
                {"label": "personal", "windows": [
                    {"label": "Current session", "used_percent": 4.0, "resets_at": None},
                    {"label": "Current week", "used_percent": 34.0, "resets_at": resets},
                ], "note": None},
            ]},
            {"provider": "codex", "label": "OpenAI Codex", "accounts": [
                {"label": "", "windows": [{"label": "Weekly", "used_percent": 6.0, "resets_at": resets}], "note": None},
            ]},
        ]

    def sign_off_models(self):
        return [
            {"provider": "anthropic", "label": "Anthropic", "models": ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]},
            {"provider": "openrouter", "label": "OpenRouter", "models": ["meta-llama/llama-5-8b-instruct", "google/gemini-3-flash"]},
        ]

    async def resolve(self, request, result):
        if request["method"] == "secret":
            self.secret_answer.set_result(result)
            return
        await super().resolve(request, result)

    async def _turn(self, chat, sid):
        await self.hub.turn_started(chat)
        text = self.sessions[sid]["rows"][-1]["text"]
        if "secret" in text:
            # agent-secrets asking through the portal: a card in the chat, then a reply that only names it.
            self.secret_answer = asyncio.get_running_loop().create_future()
            note = "the test-mode secret key for the checkout smoke test (dashboard.stripe.com/test/apikeys)"
            card = {"id": "sec-demo", "method": "secret", "params": {"name": "STRIPE_TEST_KEY", "note": note, "replace": False}, "private": {"secret_request": "sec-demo"}}
            await self.hub.ask(chat, card)
            result = await self.secret_answer
            if result.get("value"):
                self.vault["STRIPE_TEST_KEY"] = {"value": result["value"], "note": note, "origin": "you"}
            reply = "got it, the smoke test passed with STRIPE_TEST_KEY." if result.get("value") else "ok, skipping the smoke test."
            await self.hub.outgoing(chat, "reply", reply)
            self._row(sid, "assistant", reply)
            await self.hub.turn_finished(chat, "success")
            return
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
    # Review threads run archived and post their status to Reviews.
    for sid, title in (("20261024_091500_r00001", "Review shop#412"), ("20261024_092000_r00002", "Review shop#415")):
        hermes.add_session(sid, title, messages=[("user", f"review {title.split()[-1]} for sam"), ("assistant", "reviewed, posted to Reviews.")])
        hermes.sessions[sid]["archived"] = True
    hermes.add_session(
        "20261024_092500_v00001",
        "Reviews",
        chat="reviews",
        messages=[
            ("assistant", "[shop#415](https://github.com/acme/shop/pull/415) · changes requested · sam\n- head `4d81a0c`, ci green\n- blocker: refund retry never backs off\n- blocker: failed refund marked paid\n\n[open the review](#/c/20261024_092000_r00002)"),
            ("assistant", "[shop#412](https://github.com/acme/shop/pull/412) · approved · sam\n- head `9f3c2e1`, ci green\n- ready to merge\n- nit: test name\n\n[open the review](#/c/20261024_091500_r00001)"),
        ],
    )
    # A thread that started a review, and the review's report handed back to it (`nako-spawn --to`).
    from portal.hub import from_thread_line  # noqa: E402

    hermes.add_session(
        "20261024_094000_f00001",
        "Shop refunds",
        messages=[
            ("user", "can you get shop#412 reviewed before i merge it?"),
            ("assistant", "started a review thread for it. i'll pass on what it finds."),
            ("user", from_thread_line("20261024_091500_r00001", "Review shop#412") + "review of shop#412 is done. head `9f3c2e1`, ci green, approved.\n\npass 1 found two blockers, both fixed and folded into the refunds commit. a refund that failed at the provider was still marked paid; it now stays failed and shows the provider's error. and the retry loop never backed off, so a down provider got hit every second; it now waits longer each time, up to a minute.\n\npass 2 on `9f3c2e1` found nothing.\n\none nit left: the retry test's name doesn't say what it checks. nothing blocking.\n\ngates all pass: typecheck, unit tests 42/42, e2e orders and refunds, lint."),
            ("assistant", "the review approved it. only a test-name nit is left, so it's fine to merge."),
        ],
    )
    hermes._row("20261024_091500_r00001", "user", from_thread_line("20261024_094000_f00001", "Shop refunds") + "when you're done, also hand the report back to me.", display_kind="steer")
    hermes._row("20261024_091500_r00001", "assistant", "will do.")
    hermes.add_session("20261023_070000_cccccc", "Write the release notes")
    # Archived chats: Cmd+K finds them and picking one brings it back.
    for sid, title in (("20261019_080000_a00001", "Plan the garden beds"), ("20261018_080000_a00002", "Compare release note formats")):
        hermes.add_session(sid, title, messages=[("user", title.lower())])
        hermes.sessions[sid]["archived"] = True
    long = hermes.add_session("20261023_060000_eeeeee", "Untangle the importer")
    for turn in range(1, 81):
        hermes._row(long, "user", f"step {turn}: what's next for the importer?")
        hermes._row(long, "tool", "", name="read_file", context=f"src/importer/stage_{turn}.ts", tool_call_id=f"l{turn}")
        body = " ".join(["The row parser and the batch writer disagree about blank lines, so this pass makes them share one reader."] * (1 + turn % 3))
        hermes._row(long, "assistant", f"**Step {turn}.** {body}")
    # A password Nako made and shared: the reply names it and the portal shows it behind a button.
    hermes.add_session(
        "20261024_083000_5ec7e7",
        "Rotate the staging db password",
        messages=[
            ("user", "rotate the staging database admin password and give me the new one"),
            ("assistant", "rotated it and restarted the api pods, they're healthy on the new login.\n\nSECRET:STAGING_DB_ADMIN\n\nthe old password stops working at midnight."),
        ],
    )
    # Another profile's own chats, shown after switching profiles in Settings.
    hermes.add_session("20261024_100000_p00001", "Draft the onboarding email", messages=[("user", "write a short welcome email for new users")], profile="work")
    hermes.add_session("20261024_093000_p00002", "Notifications", chat="inbox", profile="work")
    hermes.add_session("20261023_100000_p00003", "Compare vector databases", profile="work")
    # What the agent-secrets plugin would hold.
    hermes.vault = {
        "STAGING_DB_ADMIN": {"value": "q7Rz-Lw2v-9KpT-x4Hn", "note": "staging postgres admin", "origin": "agent"},
        "OPENAI_API_KEY": {"value": "sk-demo-0000000000000000", "note": "personal key for the eval scripts", "origin": "you"},
        "GITHUB_TOKEN": {"value": "ghp_demo000000000000000000000000", "note": "repo access for release.sh", "origin": "you"},
    }
    data = Path(tempfile.mkdtemp())
    store = Store(data / "portal.db")
    # Chat groups in the sidebar.
    for name, color, sids in (
        ("Shop refunds", "blue", ("20261024_094000_f00001", "20261024_090000_aaaaaa", "20261024_083000_5ec7e7")),
        ("Importer", "green", ("20261023_060000_eeeeee", "20261023_070000_cccccc")),
    ):
        group = store.create_group(name, color)
        for sid in sids:
            store.set_chat_group(hermes.sessions[sid]["chat"], group["id"])
    store.create_group("Garden", "orange")
    hub = Hub(Backend(hermes))
    hermes.hub = hub
    # Turns that ended while nobody was looking: the sidebar marks them until they're opened.
    for sid in ("20261024_085000_dddddd", "20261023_070000_cccccc"):
        hub.status[sid] = "done"
        hub.unread.add(sid)
    origin = f"http://localhost:{port}"
    # NAKO_DESKTOP_RELEASE_DIR serves a desktop build for trying the app's self-update.
    # NAKO_ENVIRONMENTS_COMMAND: show the Environments page fed by that command.
    environments = Environments(os.environ["NAKO_ENVIRONMENTS_COMMAND"]) if os.environ.get("NAKO_ENVIRONMENTS_COMMAND") else None
    portal = Portal(hub, store, origin=origin, web_root=ROOT / "dashboard" / "web", desktop_release_dir=os.environ.get("NAKO_DESKTOP_RELEASE_DIR"), environments=environments)
    runner = web.AppRunner(portal.app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    await _laptop(portal, hub, data, port + 2)
    (data / "setup-link").write_text(f"{origin}/#setup={store.new_setup_link()}\n")
    print(f"setup link file: {data / 'setup-link'}", flush=True)
    await asyncio.Event().wait()


async def _laptop(portal, hub, data, port):
    """Other machines in this portal's mesh, with chats of their own, dialing in like real ones:
    a laptop, a desktop busy on a task, and a homelab box that has been away a while."""
    import aiohttp

    from portal.mesh import Mesh, Node, add_node

    portal.mesh = Mesh(data, hub, name="hub", address="https://portal.example.com", store=portal.store)
    add_node(data, "homelab")
    portal.store.set_meta("mesh:seen:homelab", time.time() - 3 * 3600)
    runner = web.AppRunner(portal.mesh.app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    http = aiohttp.ClientSession()

    async def machine(name, os_name, chats, pause=1):
        gateway = DemoGateway()
        gateway.pause = pause
        gateway.reply = "Printer queue is clear and the driver is updated."
        for sid, title, messages in chats:
            gateway.add_session(sid, title, messages=messages)
        machine_hub = Hub(Backend(gateway))
        gateway.hub = machine_hub
        node = Node(f"http://127.0.0.1:{port}/mesh", name, add_node(data, name), machine_hub)
        hello = node._hello
        node._hello = lambda: {**hello(), "os": os_name}
        asyncio.get_running_loop().create_task(node.run(http))
        return machine_hub

    await machine(
        "laptop",
        "Darwin 25.1.0",
        [
            ("20261024_095500_m00001", "Fix the printer driver", [("user", "the printer stopped working"), ("assistant", "on it")]),
            ("20261024_083000_m00002", "Clean up Downloads", [("user", "sort my downloads folder")]),
        ],
    )
    # Real files cross the node's mesh socket, not a browser-only image fixture.
    outputs = data / "node-output"
    outputs.mkdir()
    picture = outputs / "capture.png"
    picture.write_bytes((ROOT / "web/public/icon-512.png").read_bytes())
    report = outputs / "results.csv"
    report.write_text("check,result\nimage upload,passed\nfile download,passed\n")
    await machine("studio", "Windows 11", [
        ("20261024_110000_f00001", "Mesh attachments", [
            ("user", "send the capture and the results file"),
            ("assistant", f"saved both on the hub. they stay here when this machine disconnects.\n\nMEDIA:{picture}\nMEDIA:{report}"),
        ]),
    ])
    desktop = await machine("desktop", "Windows 11", [("20261024_100500_w00001", "Render the trailer", [("user", "render the trailer at 4k")])], pause=3600)
    await asyncio.sleep(1)
    await desktop.send("20261024_100500_w00001", "use the new color grade")


asyncio.run(main(int(sys.argv[1])))
