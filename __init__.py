"""The portal is a Hermes messaging platform, like Discord or Slack.

Its adapter runs in the gateway and hosts the whole portal: the web app, sign-in,
push, and the hub that turns gateway traffic into what the chat UI shows. Each
portal chat is a gateway thread (`portal:<chat id>`), so commands, approvals,
cron delivery and `send_message` work here the way they do on any platform.

`portal:inbox` is the Notifications thread: like a bot's DM, cron posts and other
deliveries land there, and a reply has every post in context. `portal:new` starts
a new thread with the message as its first post, so another platform can open one.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import logging
import mimetypes
import secrets
import sqlite3
import sys
import time
import uuid
from contextlib import closing
from pathlib import Path

log = logging.getLogger("hermes.portal")
PLUGIN = "nako-portal"
HOME_CHANNEL = "inbox"
NEW_THREAD = "new"
# A chat whose newest row is mid-turn this recently may still be running on its old surface.
BUSY_WINDOW = 15 * 60
CHAT_TITLE = "Notifications"
DEFAULT_PORT = 8797
# The one person portal threads belong to; passkey sign-in already decided who that is.
OWNER = "owner"
INBOX_POLL = 2
BIND_RETRY = 5
ROOT = Path(__file__).parent
WEB_ROOT = ROOT / "dashboard" / "web"
# Gateway commands with no use in a portal thread (platform setup, the portal's own list).
UNSUPPORTED = {"start", "sethome", "topic", "platform", "commands"}


def _portal(module):
    """A module of the portal package (dashboard/portal), loaded once under a private name."""
    package = "nako_portal_portal"
    if package not in sys.modules:
        here = ROOT / "dashboard" / "portal"
        spec = importlib.util.spec_from_file_location(package, here / "__init__.py", submodule_search_locations=[str(here)])
        loaded = importlib.util.module_from_spec(spec)
        sys.modules[package] = loaded
        spec.loader.exec_module(loaded)
    return importlib.import_module(f"{package}.{module}")


def _deliver(chat_id, text):
    """Out-of-process sends (cron with no gateway running) wait in the store for the adapter."""
    from hermes_constants import get_hermes_home

    store = _portal("store").Store(get_hermes_home() / "nako-portal" / "portal.db")
    try:
        return store.deliver(str(chat_id or HOME_CHANNEL), str(text))
    finally:
        store.db.close()


def _ensure_chat(session_store, chat=HOME_CHANNEL, title=CHAT_TITLE):
    """The gateway session for one portal thread, created now if it doesn't exist. Cron's mirror only
    appends to a session that already exists, so the Notifications thread must be there first."""
    if session_store is None:
        return None
    from gateway.config import Platform
    from gateway.session import SessionSource

    source = SessionSource(platform=Platform("portal"), chat_id=chat, chat_name="Nako", chat_type="dm")
    entry = session_store.get_or_create_session(source, touch_activity=False)
    db = getattr(session_store, "_db", None)
    if title and db is not None and not db.get_session_title(entry.session_id):
        db.set_session_title(entry.session_id, title)
    if chat == HOME_CHANNEL and db is not None and (db.get_session(entry.session_id) or {}).get("archived"):
        # An archived Notifications chat drops out of the sidebar list and its bell row goes dead.
        db.set_session_archived(entry.session_id, False)
    return entry.session_id


def _settings():
    from hermes_cli.config import load_config
    from hermes_constants import get_hermes_home

    config = load_config()
    entry = config.get("plugins", {}).get("entries", {}).get(PLUGIN, {}).get("settings", {})
    origin = str(entry.get("origin") or "").strip()
    if not origin.startswith("https://"):
        raise RuntimeError("Set plugins.entries.nako-portal.settings.origin to the portal's https URL")
    apps = {
        "android_release_dir": entry.get("android_release_dir") or None,
        "android_cert_sha256": entry.get("android_cert_sha256") or None,
        "desktop_release_dir": entry.get("desktop_release_dir") or None,
    }
    contact = str(entry.get("contact") or "mailto:owner@localhost")
    return get_hermes_home().resolve(), origin.rstrip("/"), int(entry.get("port") or DEFAULT_PORT), contact, apps


def _local_token(data):
    """The credential for the loopback API: kept across restarts so scripts need no refresh."""
    path = data / "local-token"
    if not path.exists():
        data.mkdir(parents=True, exist_ok=True)
        path.touch(mode=0o600)
        path.write_text(secrets.token_urlsafe(32) + "\n")
    path.chmod(0o600)
    return path.read_text().strip()


class HermesBackend:
    """The hub's view of Hermes: the gateway's session store and this adapter's inbound path."""

    def __init__(self, adapter, home):
        self.adapter = adapter
        self.state = home / "state.db"

    @property
    def store(self):
        return self.adapter._session_store

    @property
    def db(self):
        return self.store._db

    def _read(self, sql, args=()):
        with closing(sqlite3.connect(f"file:{self.state}?mode=ro", uri=True, timeout=10)) as db:
            return db.execute(sql, args).fetchall()

    def sessions(self):
        live = {
            sid: (chat, pinned)
            for sid, chat, pinned in self._read(
                "SELECT id, chat_id, pinned FROM sessions WHERE source='portal' AND ended_at IS NULL AND COALESCE(archived, 0)=0"
            )
        }
        rows = self.db.list_sessions_rich(source="portal", limit=300, order_by_last_active=True, compact_rows=True, include_pinned=True)
        out = []
        for row in rows:
            if row["id"] in live:
                chat, pinned = live[row["id"]]
                out.append({**row, "chat_id": chat, "pinned": bool(pinned)})
        return out

    def thread(self, session):
        from hermes_constants import get_hermes_home
        from tui_gateway.server import _history_to_messages  # bound copy; the session_history original lacks server globals

        if not self._read("SELECT 1 FROM sessions WHERE id=? AND source='portal'", (session,)):
            return None
        history = self.db.get_messages_as_conversation(session, include_ancestors=True, include_row_ids=True)
        return {"title": self.db.get_session_title(session) or "", "messages": _history_to_messages(history, profile_home=get_hermes_home())}

    def chat_of(self, session):
        rows = self._read("SELECT chat_id FROM sessions WHERE id=? AND source='portal'", (session,))
        return rows[0][0] if rows and rows[0][0] else None

    def session_of(self, chat):
        rows = self._read(
            "SELECT id FROM sessions WHERE source='portal' AND chat_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", (chat,)
        )
        return rows[0][0] if rows else None

    async def new_thread(self, chat, title):
        return await asyncio.to_thread(_ensure_chat, self.store, chat, title)

    async def adopt(self, chat, session):
        return await asyncio.to_thread(self._adopt, chat, session)

    def _adopt(self, chat, session):
        """Move another surface's chat (a Desktop thread) into a new portal thread, keeping its id
        and transcript: the same repoint Hermes's own /handoff does for a messaging platform."""
        rows = self._read(
            "SELECT source, ended_at, COALESCE(archived, 0) FROM sessions WHERE id=?", (session,)
        )
        if not rows:
            raise ValueError("No chat with that id")
        surface, _, archived = rows[0]
        if surface == "portal":
            raise ValueError("That chat is already in the portal")
        if archived:
            raise ValueError("That chat is archived")
        newest = self._read(
            "SELECT role, finish_reason, timestamp FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1", (session,)
        )
        if newest:
            role, finish, stamp = newest[0]
            mid_turn = role in ("user", "tool") or finish == "tool_calls"
            if mid_turn and (stamp or 0) > time.time() - BUSY_WINDOW:
                raise ValueError("That chat is in the middle of a turn; hand it off once it finishes")
        from gateway.config import Platform
        from gateway.session import SessionSource

        thread = SessionSource(platform=Platform("portal"), chat_id=chat, chat_name="Nako", chat_type="dm")
        key = self.store.get_or_create_session(thread, touch_activity=False).session_key
        if self.store.switch_session(key, session, preserve_prompt_pin=False) is None:
            raise ValueError("Couldn't move that chat into the portal")
        return session

    async def inbound(self, chat, text, files):
        from gateway.platforms.base import cache_document_from_bytes, cache_image_from_bytes
        from gateway.platforms.event import MessageEvent, MessageType

        paths, kinds, kind = [], [], MessageType.TEXT
        for upload in files:
            mime = upload.get("content_type") or mimetypes.guess_type(upload["filename"])[0] or "application/octet-stream"
            if mime.startswith("image/"):
                paths.append(cache_image_from_bytes(upload["data"], Path(upload["filename"]).suffix or ".png"))
                kind = MessageType.PHOTO
            else:
                paths.append(cache_document_from_bytes(upload["data"], upload["filename"]))
                if kind != MessageType.PHOTO:
                    kind = MessageType.DOCUMENT
            kinds.append(mime)
        if text.startswith("/"):
            kind = MessageType.COMMAND
        source = self.adapter.build_source(chat_id=chat, chat_name="Nako", chat_type="dm", user_id=OWNER, user_name="you")
        event = MessageEvent(text=text, message_type=kind, source=source, message_id=uuid.uuid4().hex, media_urls=paths, media_types=kinds)
        await self.adapter.handle_message(event)

    async def resolve(self, request, result):
        private = request.get("private") or {}
        if request["method"] == "approval":
            from tools.approval import resolve_gateway_approval

            resolve_gateway_approval(private["session_key"], result["choice"])
        else:
            from tools.clarify_gateway import resolve_gateway_clarify

            resolve_gateway_clarify(private["clarify_id"], next(iter(result["answers"].values()), None) or "")

    def set_title(self, session, title):
        self.db.set_session_title(session, title)

    def set_archived(self, session, archived):
        self.db.set_session_archived(session, archived)

    def set_pinned(self, session, pinned):
        self.db.set_session_pinned(session, pinned)

    def sign_off(self, reply):
        """A few proud words about what the turn did, from a small fast model. The model is
        config.yaml's `auxiliary.portal_signoff` (provider/model/reasoning_effort/timeout)."""
        from agent.auxiliary_client import call_llm

        response = call_llm(
            task="portal_signoff",
            messages=[{"role": "system", "content": SIGN_OFF_PROMPT}, {"role": "user", "content": reply[-SIGN_OFF_REPLY_CHARS:]}],
            max_tokens=30,
        )
        line = " ".join(str(response.choices[0].message.content or "").split()).strip("\"'` ")
        return line[:SIGN_OFF_MAX_CHARS] or None

    def sign_off_models(self):
        from hermes_cli.inventory import build_models_payload, load_picker_context

        payload = build_models_payload(load_picker_context(), non_blocking_catalogs=True)
        return [
            {"provider": str(row["slug"]), "label": str(row.get("name") or row["slug"]), "models": [str(m) for m in row.get("models") or []]}
            for row in payload.get("providers", [])
            if row.get("slug")
        ]

    def sign_off_model(self):
        from hermes_cli.config import load_config

        task = (load_config().get("auxiliary") or {}).get("portal_signoff") or {}
        return {"provider": str(task.get("provider") or "auto"), "model": str(task.get("model") or "")}

    def set_sign_off_model(self, provider, model):
        from hermes_cli.config import set_config_value

        set_config_value("auxiliary.portal_signoff.provider", provider)
        set_config_value("auxiliary.portal_signoff.model", model)

    def set_yolo(self, chat):
        from gateway.config import Platform
        from gateway.session import SessionSource
        from tools.approval import enable_session_yolo

        source = SessionSource(platform=Platform("portal"), chat_id=chat, chat_type="dm")
        enable_session_yolo(self.store.get_or_create_session(source, touch_activity=False).session_key)

    def commands(self):
        from agent.skill_commands import get_interactive_skill_commands
        from hermes_cli import commands as registry

        listed = [
            {"name": f"/{cmd.name}", "description": registry._build_description(cmd), "skill": False}
            for cmd in registry.COMMAND_REGISTRY
            if not cmd.cli_only and cmd.name not in UNSUPPORTED
        ]
        names = {c["name"] for c in listed}
        for name, info in sorted(get_interactive_skill_commands().items()):
            if name not in names:
                listed.append({"name": name, "description": str(info.get("description") or "Skill"), "skill": True})
        return listed


async def _listen(runner, port):
    """Bind the portal's port, retrying while something else still holds it (an older
    portal shutting down), so the gateway never fails to start over it."""
    from aiohttp import web

    while True:
        try:
            await web.TCPSite(runner, "127.0.0.1", port).start()
            log.info("Nako portal listening on 127.0.0.1:%s", port)
            return
        except OSError as error:
            log.warning("Nako portal can't bind 127.0.0.1:%s yet (%s); retrying", port, error)
            await asyncio.sleep(BIND_RETRY)


async def _forward_inbox(store, adapter):
    """Posts written while no gateway ran (`_deliver`) are sent once it's back."""
    last = store.meta("inbox_pushed", None)
    if last is None:
        newest = store.inbox(1)
        last = newest[0]["id"] if newest else 0
    while True:
        await asyncio.sleep(INBOX_POLL)
        fresh = [row for row in reversed(store.inbox(50)) if row["id"] > last]
        for row in fresh:
            await adapter.send(row["chat"], row["text"])
            last = row["id"]
        if fresh:
            store.set_meta("inbox_pushed", last)


def _check():
    return True


def _validate(config):
    return True


def _env_enablement():
    return {"home_channel": {"chat_id": HOME_CHANNEL, "name": CHAT_TITLE}}


async def _standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
    text = "\n".join([message, *(f"MEDIA:{path}" for path in media_files or [])])
    row = await asyncio.to_thread(_deliver, chat_id, text)
    return {"success": True, "message_id": str(row)}


def _adapter(config):
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult

    class PortalAdapter(BasePlatformAdapter):
        @property
        def authorization_is_upstream(self) -> bool:
            # Only the portal's own server delivers here, and it has already signed its one
            # person in with a passkey; there is no sender for a gateway allowlist to check.
            return True

        def __init__(self, cfg):
            super().__init__(cfg, Platform("portal"))
            self.hub = None
            self._runners = []
            self._tasks = []
            self._http = None

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            import aiohttp
            from aiohttp import web

            if self.hub is None:
                home, origin, port, contact, apps = _settings()
                data = home / "nako-portal"
                store = _portal("store").Store(data / "portal.db")
                push = _portal("push")
                vapid = push.Vapid(data / "vapid.pem", contact)
                self._http = aiohttp.ClientSession()
                pusher = push.Pusher(self._http, store, vapid)
                loop = asyncio.get_running_loop()

                def alert(session, title, text):
                    loop.create_task(pusher.notify(title, text, session))

                self.hub = _portal("hub").Hub(HermesBackend(self, home), alert=alert)
                portal = _portal("server").Portal(self.hub, store, origin=origin, web_root=WEB_ROOT, vapid=vapid, **apps)
                for app, at in ((portal.app(), port), (portal.local_app(_local_token(data)), port + 1)):
                    runner = web.AppRunner(app, access_log=None)
                    await runner.setup()
                    self._runners.append(runner)
                    self._tasks.append(loop.create_task(_listen(runner, at)))
                (data / "local-url").write_text(f"http://127.0.0.1:{port + 1}\n")
                if not store.has_credentials():
                    (data / "setup-link").write_text(f"{origin}/#setup={store.new_setup_link()}\n")
                    (data / "setup-link").chmod(0o600)
                    log.info("Nako portal has no passkey yet; a setup link is in %s", data / "setup-link")
                self._tasks.append(loop.create_task(_forward_inbox(store, self)))
                _LIVE_TOOLS.update(hub=self.hub, loop=loop)
                log.info("Nako portal serving %s on 127.0.0.1:%s", origin, port)
            await asyncio.to_thread(self._chat, HOME_CHANNEL, CHAT_TITLE)
            self._mark_connected()
            return True

        async def disconnect(self) -> None:
            for task in self._tasks:
                task.cancel()
            for runner in self._runners:
                await runner.cleanup()
            if self._http is not None:
                await self._http.close()
            self._tasks, self._runners, self._http, self.hub = [], [], None, None
            self._mark_disconnected()

        def _chat(self, chat, title=None):
            try:
                return _ensure_chat(getattr(self, "_session_store", None), chat, title)
            except Exception:
                log.exception("portal: could not open thread %s", chat)
                return None

        async def _new_thread(self, content):
            """`portal:new`: a thread whose first post is this message, titled by its first line."""
            from gateway.mirror import mirror_to_session

            chat = uuid.uuid4().hex[:16]
            title = (content.strip().splitlines() or ["new thread"])[0][:80]
            session = await asyncio.to_thread(self._chat, chat, title)
            # send_message mirrors into the chat it was given ("new"), which no session matches.
            if session:
                await asyncio.to_thread(mirror_to_session, "portal", chat, content, source_label="send_message", session_id=session)
            if self.hub is not None:
                await self.hub.broadcast({"kind": "sessions.changed"})
            return chat

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            chat = str(chat_id or HOME_CHANNEL)
            if chat == NEW_THREAD:
                chat = await self._new_thread(content)
            elif chat == HOME_CHANNEL:
                await asyncio.to_thread(self._chat, HOME_CHANNEL, CHAT_TITLE)
            message_id = uuid.uuid4().hex
            if self.hub is not None:
                # Not awaited: outside a turn the hub waits for the mirror before telling clients.
                asyncio.get_running_loop().create_task(self.hub.outgoing(chat, message_id, content))
            return SendResult(success=True, message_id=message_id)

        async def edit_message(self, chat_id, message_id, content, *, finalize=False):
            if self.hub is not None:
                await self.hub.outgoing(str(chat_id), message_id, content)
            return SendResult(success=True, message_id=message_id)

        async def _send_file(self, chat_id, path, caption):
            return await self.send(chat_id, "\n".join(part for part in (caption, f"MEDIA:{path}") if part))

        async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._send_file(chat_id, image_path, caption)

        async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs):
            return await self._send_file(chat_id, file_path, caption)

        async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._send_file(chat_id, audio_path, caption)

        async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._send_file(chat_id, video_path, caption)

        async def send_typing(self, chat_id, metadata=None):
            return None

        async def get_chat_info(self, chat_id):
            return {"name": "Nako", "type": "dm"}

        async def on_processing_start(self, event):
            if self.hub is not None:
                await self.hub.turn_started(event.source.chat_id)

        async def on_processing_complete(self, event, outcome):
            if self.hub is not None:
                await self.hub.turn_finished(event.source.chat_id, getattr(outcome, "value", str(outcome)))

        async def _send_exec_approval_prompt(self, prompt):
            if self.hub is None:
                return SendResult(success=False, error="portal is not serving")
            request = {
                "id": uuid.uuid4().hex,
                "method": "approval",
                "params": {"command": prompt.command, "description": prompt.description, "choices": prompt.choices},
                "private": {"session_key": prompt.session_key},
            }
            await self.hub.ask(prompt.chat_id, request)
            return SendResult(success=True, message_id=request["id"])

        async def send_clarify(self, chat_id, question, choices, clarify_id, session_key, metadata=None):
            if self.hub is None or not choices:
                # An open question is answered by the next message, which the gateway intercepts.
                return await super().send_clarify(chat_id, question, choices, clarify_id, session_key, metadata)
            request = {
                "id": uuid.uuid4().hex,
                "method": "clarify",
                "params": {"questions": [{"qid": clarify_id, "question": question, "choices": list(choices)}]},
                "private": {"clarify_id": clarify_id},
            }
            await self.hub.ask(str(chat_id), request)
            return SendResult(success=True, message_id=request["id"])

    return PortalAdapter(config)


# The chat UI draws tool calls and mid-turn commentary from the session store, so the gateway's
# text breadcrumbs and interim bubbles would show each turn twice. Streaming and heartbeats stay on.
QUIET_DISPLAY = {"tool_progress": "off", "interim_assistant_messages": False}


def _quiet_display_defaults():
    """Hermes's named display tiers can't drop just these two (the low tier also stops streaming),
    so the portal's built-in defaults are the high tier minus them. config.yaml still overrides."""
    try:
        from gateway import display_config
    except ImportError:
        return
    defaults = getattr(display_config, "_PLATFORM_DEFAULTS", None)
    high = getattr(display_config, "_TIERS", {}).get("high")
    if isinstance(defaults, dict) and isinstance(high, dict):
        defaults.setdefault("portal", {**high, **QUIET_DISPLAY})


SIGN_OFF_PROMPT = (
    "You are Nako, a cheerful, slightly smug assistant. You just finished a task. "
    "Write ONE short line (3-8 words, lowercase, no emoji, no hearts, no quotes) that sounds a little proud "
    "of what you actually did, based on your final reply below. Be specific. Output only the line."
)
SIGN_OFF_REPLY_CHARS = 3000
SIGN_OFF_MAX_CHARS = 80

# Tool hooks run on the agent's thread; the hub lives on the gateway's loop.
_LIVE_TOOLS = {}


def _tool_context(name, args):
    try:
        from agent.display import build_tool_preview

        return build_tool_preview(name, args if isinstance(args, dict) else {}, max_len=80) or ""
    except Exception:
        return ""


def _forward_tool(state):
    def hook(tool_name="", args=None, session_id=None, tool_call_id=None, status=None, **_):
        hub, loop = _LIVE_TOOLS.get("hub"), _LIVE_TOOLS.get("loop")
        if hub is None or loop is None or not session_id or session_id not in hub.running:
            return None
        ended = "failed" if status == "error" else "done"
        payload = (session_id, str(tool_call_id or ""), tool_name, _tool_context(tool_name, args), state or ended)
        asyncio.run_coroutine_threadsafe(hub.tool(*payload), loop)
        return None

    return hook


def register(ctx):
    _quiet_display_defaults()
    # Live tool calls for the chat's activity view (the gateway's own text breadcrumbs are off).
    ctx.register_hook("pre_tool_call", _forward_tool("running"))
    ctx.register_hook("post_tool_call", _forward_tool(None))
    # Its own model slot, so Desktop's Models page and the portal's Settings can pick it.
    if hasattr(ctx, "register_auxiliary_task"):
        ctx.register_auxiliary_task(
            "portal_signoff",
            display_name="Nako's sign-off",
            description="The few words Nako says in the portal when a turn ends. A small fast model is plenty.",
            defaults={"timeout": 15},
        )
    ctx.register_platform(
        name="portal",
        label="Nako",
        adapter_factory=_adapter,
        check_fn=_check,
        validate_config=_validate,
        env_enablement_fn=_env_enablement,
        standalone_sender_fn=_standalone_send,
        cron_deliver_env_var="PORTAL_HOME_CHANNEL",
        max_message_length=0,
        emoji="🪟",
        pii_safe=True,
        platform_hint=(
            "You are chatting in the user's private Nako app. It renders markdown. "
            "Each portal chat is its own thread; send_message to portal:new starts a new one."
        ),
    )
