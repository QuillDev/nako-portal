"""Runs the portal against the fake backend for a browser walk-through: python tests/demo.py <port>."""

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).parent))
from conftest import ROOT, Backend, FakeGateway
from portal.environments import Environments
from portal.hub import Hub
from portal.machine_load import MachineLoad
from portal.server import Portal
from portal.store import Store


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
        from datetime import UTC, datetime, timedelta

        now = datetime.now(UTC)
        resets = (now + timedelta(days=4)).isoformat()
        session = (now + timedelta(hours=3)).isoformat()
        codex_used = getattr(self, "_demo_codex_used", 84.0)
        codex_resets = getattr(self, "_demo_codex_resets", 3)
        claude_week = getattr(self, "_demo_claude_week", 100.0)
        claude_opts = getattr(self, "_demo_claude_opts", [
            {"id": "full-reset-2611", "label": "weekly reset", "available": 1, "usable": True},
            {"id": "launch-2610-fable", "label": "Fable reset", "available": 2, "usable": True},
        ])
        claude_resets = ({"available": sum(o["available"] for o in claude_opts), "usable": any(o["usable"] for o in claude_opts),
                          "account": "primary", "options": claude_opts} if claude_opts else None)
        return [
            {"provider": "claude-subscription-directsdk-experimental", "label": "Claude Subscription DirectSDK (Experimental)", "accounts": [
                {"label": "primary", "windows": [
                    {"label": "Current session", "used_percent": 58.0, "resets_at": session},
                    {"label": "Current week", "used_percent": claude_week, "resets_at": (now + timedelta(hours=20)).isoformat()},
                    {"label": "Fable week", "used_percent": 78.0, "resets_at": (now + timedelta(hours=20)).isoformat(), "scope": "model"},
                ], "note": None, **({"resets": claude_resets} if claude_resets else {})},
                {"label": "sam@example.test", "windows": [
                    {"label": "Current session", "used_percent": 4.0, "resets_at": None},
                    {"label": "Current week", "used_percent": 34.0, "resets_at": resets},
                ], "note": None},
            ]},
            {"provider": "openrouter", "label": "OpenRouter", "accounts": [
                {"label": "", "windows": [{"label": "API key quota", "used_percent": 2.0, "resets_at": None}], "note": None},
            ]},
            {"provider": "antigravity-oauth", "label": "Google Antigravity (OAuth)", "accounts": [
                {"label": "", "windows": [
                    {"label": "Gemini 7d", "used_percent": 12.0, "resets_at": resets},
                    {"label": "Gemini 5h", "used_percent": 8.0, "resets_at": session},
                ], "note": None},
            ]},
            {"provider": "openai-codex", "label": "OpenAI Codex", "accounts": [
                {"label": "", "windows": [{"label": "Weekly", "used_percent": codex_used, "resets_at": resets}], "note": None,
                 "resets": {"available": codex_resets, "usable": codex_resets > 0 and codex_used >= 20.0}},
            ]},
        ]

    def use_reset(self, provider, account="", force=False, grant=""):
        if provider == "claude-subscription-directsdk-experimental":
            opts = [dict(o) for o in getattr(self, "_demo_claude_opts", [
                {"id": "full-reset-2611", "label": "weekly reset", "available": 1, "usable": True},
                {"id": "launch-2610-fable", "label": "Fable reset", "available": 2, "usable": True},
            ])]
            chosen = next((o for o in opts if o["id"] == grant), None) if grant else (opts[0] if opts else None)
            if chosen is None:
                return {"status": "not_eligible", "redeemed": False, "message": "That reset is no longer available.", "available": sum(o["available"] for o in opts)}
            chosen["available"] -= 1
            opts = [o for o in opts if o["available"] > 0]
            self._demo_claude_opts = opts
            if chosen["id"] == "full-reset-2611":
                self._demo_claude_week = 0.0
            return {"status": "reset", "redeemed": True, "message": "Limits reset.", "available": sum(o["available"] for o in opts)}
        if provider != "openai-codex":
            raise ValueError("That provider doesn't support usage resets")
        available = getattr(self, "_demo_codex_resets", 3)
        used = getattr(self, "_demo_codex_used", 84.0)
        if available <= 0:
            return {"status": "no_credits_banked", "redeemed": False, "message": "No banked reset credits on this account.", "available": 0}
        if used < 20.0:
            return {"status": "nothing_to_reset", "redeemed": False, "message": "Backend reports nothing to reset yet.", "available": available}
        self._demo_codex_resets = available - 1
        self._demo_codex_used = 0.0
        return {"status": "reset", "redeemed": True, "message": f"Reset redeemed. {self._demo_codex_resets} remaining.", "available": self._demo_codex_resets}

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
                self.vault["STRIPE_TEST_KEY"] = {"value": result["value"], "note": note, "origin": "you", "updated_at": time.time()}
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
    hermes.sessions["20261024_090000_aaaaaa"]["model_options"] = {"provider": "openai-codex", "model": "codex"}
    hermes._row("20261024_090000_aaaaaa", "tool", "", name="terminal", context="gh run view 123 --log-failed", tool_call_id="h1")
    hermes._row("20261024_090000_aaaaaa", "user", "check shard 1 too while you're in there", display_kind="steer")
    hermes._row("20261024_090000_aaaaaa", "tool", "", name="search_files", context="seed.ts", tool_call_id="h2")
    hermes._row("20261024_090000_aaaaaa", "assistant", "The `orders` e2e test races the seed script. I'd add a wait on the seed job:\n\n| shard | status |\n| --- | --- |\n| 1 | passing |\n| 3 | flaky |", reasoning="Shard 3 runs orders.spec.ts, which reads seeded rows.")
    shots = Path(tempfile.mkdtemp())
    for name in ("layout.png", "error.png"):
        (shots / name).write_bytes((ROOT / "web" / "public" / "icon-512.png").read_bytes())
    (shots / "barcode.png").write_bytes((ROOT / "web" / "public" / "icon-192.png").read_bytes())
    (shots / "order-email.html").write_text(
        """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Order #4819 Confirmed</title>
<style>
  body { margin: 0; padding: 24px 16px; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18181b; }
  .wrap { max-width: 580px; margin: 0 auto; background: #ffffff; border: 1px solid #e4e4e7; border-radius: 10px; overflow: hidden; }
  .head { background: #18181b; color: #ffffff; padding: 24px 28px; }
  .head h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
  .head p { margin: 0; color: #a1a1aa; font-size: 13px; }
  .body { padding: 24px 28px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #dcfce7; color: #166534; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  th, td { text-align: left; padding: 10px 0; border-bottom: 1px solid #e4e4e7; }
  td:last-child, th:last-child { text-align: right; }
  .total td { font-weight: 600; border-bottom: none; padding-top: 14px; }
  .cta { display: inline-block; margin-top: 12px; padding: 10px 18px; border-radius: 6px; background: #18181b; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 500; border: 0; cursor: pointer; }
  .note { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e4e4e7; font-size: 13px; color: #52525b; line-height: 1.6; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>Your order is on the way</h1>
      <p>Order #4819 · Placed Nov 25, 2026</p>
    </div>
    <div class="body">
      <div class="badge" id="status-badge">Preparing shipment</div>
      <p style="margin: 0 0 12px; font-size: 14px; line-height: 1.6;">Thanks for ordering! Your package has left the warehouse and will arrive Thursday before 8:00 PM.</p>
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Mechanical Keycap Set (PBT)</td><td>1</td><td>$64.00</td></tr>
          <tr><td>USB-C Coiled Cable (1.5m)</td><td>1</td><td>$28.00</td></tr>
          <tr><td>Desk Mat — Slate</td><td>2</td><td>$44.00</td></tr>
          <tr><td>Shipping (Express)</td><td>—</td><td>$12.00</td></tr>
          <tr class="total"><td colspan="2">Total</td><td>$148.00</td></tr>
        </tbody>
      </table>
      <button class="cta" id="toggle-details" type="button">Show tracking timeline</button>
      <div id="timeline" style="display:none; margin-top: 14px; padding: 12px; background: #f4f4f5; border-radius: 6px; font-size: 13px; line-height: 1.6;">
        <div><strong>10:15 AM</strong> — Departed Oakland hub</div>
        <div><strong>07:40 AM</strong> — Label scanned at warehouse</div>
        <div><strong>Yesterday</strong> — Order confirmed</div>
      </div>
      <div class="note">
        <p><strong>Shipping address</strong><br />Sam Rivera<br />742 Evergreen Terrace<br />San Francisco, CA 94107</p>
        <p>Need to make a change? Reply directly to this email and our support team will update your delivery preferences before the courier picks up the parcel.</p>
        <p>Returns are accepted within 30 days of delivery in original packaging. Refunds post to your original payment method within 3–5 business days.</p>
      </div>
    </div>
  </div>
  <script>
    document.getElementById("status-badge").textContent = "In transit · JS active";
    document.getElementById("toggle-details").addEventListener("click", function () {
      var box = document.getElementById("timeline");
      var open = box.style.display !== "none";
      box.style.display = open ? "none" : "block";
      this.textContent = open ? "Show tracking timeline" : "Hide tracking timeline";
    });
  </script>
</body>
</html>
""",
        encoding="utf-8",
    )
    hermes.add_session(
        "20261024_085500_h7a100",
        "Email preview",
        messages=[
            ("user", "render the shipping confirmation email so i can check the layout"),
            ("assistant", f"here's the rendered email:\n\nMEDIA:{shots / 'order-email.html'}\nMEDIA:{shots / 'missing-draft.html'}"),
        ],
    )
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
    from portal.hub import from_thread_line

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
    # Times as a real chat has them: it started yesterday evening and picked back up this morning.
    now = time.time()
    for n, row in enumerate(hermes.sessions["20261024_094000_f00001"]["rows"]):
        row["timestamp"] = now - 20 * 3600 + n * 240 if n < 2 else now - 600 + n * 120
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
    day = 86400
    now = time.time()
    # MCP servers as a profile might have them: one failing sign-in, one switched off, one a plugin brings.
    # Settings > Providers: two subscriptions with several accounts each, and one API key.
    hermes.provider_list = [
        {"slug": "claude-subscription-directsdk-experimental", "label": "Claude Subscription", "description": "", "kind": "cli", "command": "", "env_var": "", "env_vars": [], "signup_url": ""},
        {"slug": "openai-codex", "label": "ChatGPT or Codex Subscription", "description": "", "kind": "signin", "command": "", "env_var": "", "env_vars": [], "signup_url": ""},
        {"slug": "openrouter", "label": "OpenRouter", "description": "", "kind": "key", "command": "", "env_var": "OPENROUTER_API_KEY", "env_vars": ["OPENROUTER_API_KEY"], "signup_url": "https://openrouter.ai/keys"},
    ]
    hermes.provider_keys = {"openrouter": "demo"}
    hermes.account_logins = {
        "claude-subscription-directsdk-experimental": {"mode": "paste", "accounts": [
            {"id": "primary", "label": "alex@example.test", "email": "alex@example.test", "plan": "Claude Max", "signed_in": True, "removable": True},
            {"id": "sam@example.test", "label": "sam@example.test", "email": "sam@example.test", "plan": "Claude Pro", "signed_in": True, "removable": True},
            {"id": "secondary", "label": "secondary", "email": "", "plan": "", "signed_in": False, "removable": True}]},
        "openai-codex": {"mode": "code", "accounts": [
            {"id": "a1b2c3", "label": "alex@example.test", "email": "alex@example.test", "plan": "", "signed_in": True, "removable": True}]},
    }
    hermes.mcp = {
        "deepwiki": {"url": "https://mcp.deepwiki.example.test/mcp"},
        "linear": {"url": "https://mcp.linear.example.test/mcp", "auth": "oauth"},
        "local-files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"], "env": {"LOG_LEVEL": "info"}},
        "notion": {"url": "https://mcp.notion.example.test/mcp", "auth": "oauth", "tools": {"include": ["search", "fetch", "create-pages", "update-page", "get-comments"]}},
        "weather": {"command": "uvx", "args": ["weather-mcp"], "enabled": False},
    }
    hermes.mcp_tokens = {"notion"}
    hermes.mcp_plugins = {"tracker": ({"url": "https://tracker.example.test/mcp"}, "tracker-tools")}
    hermes.mcp_tools = {
        "notion": [("search", "Search pages and databases"), ("fetch", "Read a page or database"), ("create-pages", "Create pages"),
                   ("update-page", "Edit a page's content or properties"), ("move-pages", "Move pages to a new parent"), ("get-comments", "List comments on a page")],
        "deepwiki": [("ask_question", "Ask about a public GitHub repo"), ("read_wiki_structure", "List a repo's wiki topics"), ("read_wiki_contents", "Read a repo's wiki")],
    }
    hermes.mcp_catalog_list = [
        {"name": n, "description": d, "transport": "http" if u else "stdio", "url": u, "command": c, "args": a, "auth": au, "env": e, "source": "", "post_install": p}
        for n, d, u, c, a, au, e, p in [
            ("airtable", "Bases, tables, and records from your Airtable workspace.", "", "npx", ["-y", "airtable-mcp-server"], "none",
             [{"name": "AIRTABLE_API_KEY", "prompt": "Airtable personal access token", "required": True, "secret": True, "saved": False}], "Create a token at airtable.com/create/tokens with data.records:read."),
            ("asana", "Tasks, projects, and goals from your Asana workspace.", "https://mcp.asana.example.test/sse", "", [], "oauth", [], ""),
            ("context7", "Up-to-date, version-specific library docs and code examples.", "https://mcp.context7.example.test/mcp", "", [], "none", [], ""),
            ("deepwiki", "Ask questions about any public GitHub repo.", "https://mcp.deepwiki.example.test/mcp", "", [], "none", [], ""),
            ("figma", "Design context and write-to-canvas from Figma.", "https://mcp.figma.example.test/mcp", "", [], "oauth", [], ""),
            ("github", "Issues, pull requests, and code from GitHub.", "https://api.github.example.test/mcp", "", [], "none",
             [{"name": "GITHUB_TOKEN", "prompt": "GitHub token", "required": True, "secret": True, "saved": False}], ""),
        ]
    ]
    hermes.vault = {
        "STAGING_DB_ADMIN": {"value": "q7Rz-Lw2v-9KpT-x4Hn", "note": "staging postgres admin", "origin": "agent", "updated_at": now - 2 * day},
        "OPENAI_API_KEY": {"value": "sk-dem...0000", "note": "personal key for the eval scripts", "origin": "you", "updated_at": now - 29 * day},
        "GITHUB_TOKEN": {"value": "ghp_de...0000", "note": "repo access for release.sh", "origin": "you", "updated_at": now - 38 * day},
        "AWS_ACCESS_KEY_ID": {"value": "AKIADEMO0000", "note": "deploy user for the staging bucket", "origin": "you", "updated_at": now - 17 * day},
        "AWS_SECRET_ACCESS_KEY": {"value": "demo/secret/0000", "note": "pairs with AWS_ACCESS_KEY_ID", "origin": "you", "updated_at": now - 17 * day},
        "CLOUDFLARE_API_TOKEN": {"value": "cf-demo-0000", "note": "DNS edit on example.test zones", "origin": "agent", "updated_at": now - 5 * day},
        "LINEAR_API_KEY": {"value": "lin_demo_0000", "note": "", "origin": "agent", "updated_at": now - 2 * day},
        "SENTRY_AUTH_TOKEN": {"value": "sntrys_demo", "note": "source map uploads", "origin": "agent", "updated_at": now - 10 * day},
        "STRIPE_TEST_KEY": {"value": "sk_test_51Pz8eDEMOq9fK2vLmN0aBcDeF7hTuV", "note": "test mode key from dashboard.stripe.example.test/apikeys", "origin": "agent", "updated_at": now - 3600},
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
    # Sessions that came in other ways (Slack, Discord, cron, the CLI): Elsewhere lists them and opens them read-only.
    hour = 3600
    for sid, title, source, ago, rows in (
        ("20261024_094100_s00001", "Can you check the shipping export?", "slack", 0.1, [
            ("user", "[Sam] can you check the shipping export? last night's file looks short, i think a few orders are missing."),
            ("assistant", "on it. pulling last night's export and comparing it to the orders list."),
            ("tool", "terminal"),
            ("assistant", "found it: 4 orders were marked shipped after the export ran, so they'll be in tonight's file. nothing is lost. want me to rerun it now?"),
            ("user", "[Sam] yes please, rerun it."),
        ]),
        ("local-c00000000000000000000001", "Morning digest", "cron", 1.5, [("user", "[cron] morning digest"), ("assistant", "five links today, starting with a new sorting paper.")]),
        ("local-c00000000000000000000002", "Price watch: desk lamp", "cron", 2.2, [("user", "[cron] price watch"), ("assistant", "the desk lamp is still $64, above the $50 target.")]),
        ("20261024_081200_d00001", "Help with the release notes", "discord", 3, [("user", "can you tidy these release notes?"), ("assistant", "tidied: grouped by area and cut the duplicate fixes.")]),
        ("20261023_160000_c00001", "Rename the test fixtures", "cli", 20, [("user", "rename the fixtures to match the new models"), ("assistant", "renamed 12 fixtures and updated their imports.")]),
        ("20261023_120000_s00002", "Question about the invoice page", "slack", 26, [("user", "[Kai] why does the invoice page show two totals?"), ("assistant", "one is before tax and one after; the label was missing, so i added it.")]),
        ("local-c00000000000000000000003", "Morning digest", "cron", 25.5, [("user", "[cron] morning digest"), ("assistant", "three links today.")]),
        ("20261021_190000_d00002", "Book club picks", "discord", 74, [("user", "pick three books for next month"), ("assistant", "three picks, all under 300 pages.")]),
    ):
        hermes.add_session(sid, title, source=source, last_active=now - ago * hour)
        for n, (role, text) in enumerate(rows):
            stamp = now - ago * hour - (len(rows) - n) * 90
            if role == "tool":
                hermes._row(sid, "tool", "", name=text, context="python3 export_check.py --since yesterday", tool_call_id=f"o{sid[-3:]}{n}", timestamp=stamp)
            else:
                hermes._row(sid, role, text, timestamp=stamp)
    hub = Hub(Backend(hermes))
    hermes.hub = hub
    # The Slack session is mid-turn; DEMO_OUTSIDE_IDLE=1 shows Elsewhere with nothing running.
    hub.outside_now = {"sources": ["cli", "cron", "discord", "slack"], "running": [] if os.environ.get("DEMO_OUTSIDE_IDLE") else ["20261024_094100_s00001"]}
    # Turns that ended while nobody was looking: the sidebar marks them until they're opened.
    for sid in ("20261024_085000_dddddd", "20261023_070000_cccccc"):
        hub.status[sid] = "done"
        hub.unread.add(sid)
    origin = f"http://localhost:{port}"
    # NAKO_DESKTOP_RELEASE_DIR serves a desktop build for trying the app's self-update.
    # NAKO_ENVIRONMENTS_COMMAND: show the Environments page fed by that command (and
    # NAKO_ENVIRONMENTS_STOP_COMMAND its Stop buttons).
    environments = (
        Environments(os.environ["NAKO_ENVIRONMENTS_COMMAND"], stop_command=os.environ.get("NAKO_ENVIRONMENTS_STOP_COMMAND"))
        if os.environ.get("NAKO_ENVIRONMENTS_COMMAND")
        else None
    )
    # This machine's load, or NAKO_PROC: a directory with its own meminfo and stat.
    load = MachineLoad(os.environ.get("NAKO_PROC", "/proc"))
    portal = Portal(
        hub,
        store,
        origin=origin,
        web_root=ROOT / "dashboard" / "web",
        desktop_release_dir=os.environ.get("NAKO_DESKTOP_RELEASE_DIR"),
        environments=environments,
        machine_load=load if load.available else None,
    )
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
