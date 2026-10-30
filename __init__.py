"""The portal is a Hermes messaging platform, like Discord or Slack.

The portal itself (the web app, sign-in, push, and the hub that turns gateway
traffic into what the chat UI shows) runs as its own process, `dashboard/serve.py`,
so the site stays up while the gateway restarts. This adapter starts that server
when it isn't running and dials in over a loopback WebSocket (`link.py`), the way
a bot connects to Discord. Each portal chat is a gateway thread
(`portal:<chat id>`), so commands, approvals, cron delivery and `send_message`
work here the way they do on any platform.

`portal:inbox` is the Notifications thread: like a bot's DM, cron posts and other
deliveries land there, and a reply has every post in context. `portal:reviews` is a
second thread like it, for code-review status posts. `portal:new` starts a new thread
with the message as its first post, so another platform can open one.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import importlib
import importlib.util
import json
import logging
import mimetypes
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
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
REVIEWS_CHANNEL = "reviews"
# Threads posts can be addressed to by name, each with the title it gets when first opened.
CHANNELS = {HOME_CHANNEL: CHAT_TITLE, REVIEWS_CHANNEL: "Reviews"}
DEFAULT_PORT = 8797
DEFAULT_PROFILE = "default"
# The one person portal threads belong to; passkey sign-in already decided who that is.
OWNER = "owner"
INBOX_POLL = 2
# Transcripts kept projected for chats read lately; a long one holds a few MB.
CACHED_THREADS = 8
ROOT = Path(__file__).parent
SERVER = ROOT / "dashboard" / "serve.py"
# The server's code: a change here means the running server is stale and gets replaced.
SERVER_CODE = [SERVER, *sorted((ROOT / "dashboard" / "portal").glob("*.py"))]
# Don't start servers faster than this while one is still coming up.
SPAWN_GAP = 30
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


def _source(chat, profile=None, **fields):
    """A portal thread as the gateway names it. A named profile namespaces the thread's key and
    runs its turns in that profile's home; None is the default profile, keyed as it always was."""
    from gateway.config import Platform
    from gateway.session import SessionSource

    return SessionSource(platform=Platform("portal"), chat_id=chat, chat_type="dm", profile=_named(profile), **fields)


def _named(profile):
    return None if not profile or profile == DEFAULT_PROFILE else profile


def _ensure_chat(session_store, chat=HOME_CHANNEL, title=CHAT_TITLE, profile=None):
    """The gateway session for one portal thread, created now if it doesn't exist. Cron's mirror only
    appends to a session that already exists, so the Notifications thread must be there first."""
    if session_store is None:
        return None
    source = _source(chat, profile, chat_name="Nako")
    entry = session_store.get_or_create_session(source, touch_activity=False)
    # The thread's own profile store, whichever profile the caller is scoped to.
    owner = getattr(session_store, "_db_for_key", None)
    db = owner(entry.session_key) if owner else getattr(session_store, "_db", None)
    if title and db is not None and not db.get_session_title(entry.session_id):
        db.set_session_title(entry.session_id, title)
    if chat in CHANNELS and db is not None and (db.get_session(entry.session_id) or {}).get("archived"):
        # An archived Notifications or Reviews chat drops out of the sidebar list and its row goes dead.
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


def _server_config(home, origin, port, contact, apps):
    """What the server runs with, written to a file it reads. `code` names this code and these
    settings, so a server started from anything else is replaced."""
    data = home / "nako-portal"
    config = {"data": str(data), "origin": origin, "port": port, "contact": contact, **apps}
    digest = hashlib.sha256(json.dumps(config, sort_keys=True).encode())
    for path in SERVER_CODE:
        digest.update(path.name.encode() + b"\0" + path.read_bytes())
    config["code"] = digest.hexdigest()[:24]
    path = data / "server.json"
    data.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n")
    path.chmod(0o600)
    return path, config


def _spawn_server(config_path, data):
    """Start the portal server where a gateway restart can't take it down: its own systemd user
    unit when the gateway is a systemd service (which kills the service's whole cgroup on
    stop), otherwise its own session."""
    command = [sys.executable, str(SERVER), str(config_path)]
    # The gateway's interpreter finds aiohttp and cryptography through the import path Hermes set
    # up at launch, not through its own site-packages; the server gets the same path.
    path = os.pathsep.join(p for p in sys.path if p and os.path.isabs(p) and os.path.isdir(p))
    if os.environ.get("INVOCATION_ID") and shutil.which("systemd-run"):
        unit = f"nako-portal-{int(time.time())}"
        try:
            started = subprocess.run(
                ["systemd-run", "--user", "--collect", "--quiet", f"--unit={unit}", "--description=Nako portal", f"--setenv=PYTHONPATH={path}", *command],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if started.returncode == 0:
                log.info("Nako portal: started the server as %s.service", unit)
                return
            log.warning("Nako portal: systemd-run failed (%s); starting the server directly", started.stderr.strip())
        except (OSError, subprocess.SubprocessError):
            log.warning("Nako portal: systemd-run failed; starting the server directly", exc_info=True)
    with open(data / "server.log", "ab") as out:
        env = {**os.environ, "PYTHONPATH": path}
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, env=env, start_new_session=True, close_fds=True)
    log.info("Nako portal: started the server (log in %s)", data / "server.log")


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
    """The hub's view of Hermes: the gateway's session store and this adapter's inbound path.

    The portal shows one profile at a time (Settings). Its chats, history and new threads all
    come from that profile's own home and state.db, and its turns run as that profile, so
    switching is a clean change of everything the portal shows."""

    def __init__(self, adapter, home):
        self.adapter = adapter
        self.root = home
        self.profile = DEFAULT_PROFILE
        # chat -> the profile its thread lives in, so a reply goes back to the right one.
        self.owner = {}
        # (home, session) -> (revision, transcript) for chats read lately; see thread().
        self.threads = {}
        self.threads_lock = threading.Lock()

    @property
    def store(self):
        return self.adapter._session_store

    @property
    def db(self):
        return self.store._db

    # Profiles

    def homes(self):
        """The profiles this gateway serves, by name. Without multiplexing it serves only its own."""
        try:
            from hermes_cli.config import load_config
            from hermes_cli.profiles import profiles_to_serve

            multiplex = bool((load_config().get("gateway") or {}).get("multiplex_profiles"))
            served = dict(profiles_to_serve(multiplex=multiplex)) if multiplex else {}
        except Exception:
            log.warning("portal: could not list served profiles", exc_info=True)
            served = {}
        return {DEFAULT_PROFILE: self.root, **{k: Path(v) for k, v in served.items() if k != DEFAULT_PROFILE}}

    def profiles(self):
        return {"profile": self.profile, "profiles": list(self.homes())}

    def use_profile(self, name):
        if name not in self.homes():
            raise ValueError("That profile isn't served by this gateway")
        self.profile = name
        _ensure_chat(self.store, HOME_CHANNEL, CHAT_TITLE, name)
        return self.profiles()

    def _home(self, profile=None):
        return self.homes().get(profile or self.profile, self.root)

    def home_of(self, profile):
        """The home a turn for ``profile`` runs in (None is the default profile)."""
        return self.homes().get(profile or DEFAULT_PROFILE, self.root)

    def _scoped(self, fn, *args, profile=None):
        """Run ``fn`` with Hermes pointed at one profile's home, so the store reads its state.db.
        Reach ``self.db`` inside ``fn``: it resolves to the profile's store only once scoped."""
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        token = set_hermes_home_override(str(self._home(profile)))
        try:
            return fn(*args)
        finally:
            reset_hermes_home_override(token)

    def _read(self, sql, args=(), profile=None):
        state = self._home(profile) / "state.db"
        if not state.exists():
            return []
        with closing(sqlite3.connect(f"file:{state}?mode=ro", uri=True, timeout=10)) as db:
            return db.execute(sql, args).fetchall()

    def _origin(self):
        """The profile whose work is calling in: a turn or cron run is scoped to its profile's
        home; a request from the web app isn't scoped and means the profile on screen."""
        from hermes_constants import get_hermes_home_override

        override = get_hermes_home_override()
        if override:
            here = Path(override).resolve()
            for name, home in self.homes().items():
                if Path(home).resolve() == here:
                    return name
        return self.profile

    # Chats

    def sessions(self):
        live = {
            sid: (chat, pinned)
            for sid, chat, pinned in self._read(
                "SELECT id, chat_id, pinned FROM sessions WHERE source='portal' AND ended_at IS NULL AND COALESCE(archived, 0)=0"
            )
        }
        rows = self._scoped(
            lambda: self.db.list_sessions_rich(source="portal", limit=300, order_by_last_active=True, compact_rows=True, include_pinned=True)
        )
        out = []
        for row in rows:
            if row["id"] in live:
                chat, pinned = live[row["id"]]
                out.append({**row, "chat_id": chat, "pinned": bool(pinned)})
        return out

    def archived_sessions(self):
        """Archived portal chats that can come back: still their thread's chat (not ended)."""
        open_ = {
            sid
            for (sid,) in self._read(
                "SELECT id FROM sessions WHERE source='portal' AND ended_at IS NULL AND COALESCE(archived, 0)=1"
            )
        }
        rows = self._scoped(
            lambda: self.db.list_sessions_rich(source="portal", limit=300, order_by_last_active=True, compact_rows=True, archived_only=True)
        )
        return [row for row in rows if row["id"] in open_]

    def thread(self, session):
        from tui_gateway.server import _history_to_messages  # bound copy; the session_history original lacks server globals

        if not self._read("SELECT 1 FROM sessions WHERE id=? AND source='portal'", (session,)):
            return None
        home = self._home()

        def read():
            db = self.db
            # Reading and projecting a long transcript takes the better part of a second, and every
            # open, refresh and older page reads it again. Hermes's revision moves on any append,
            # undo, compaction or in-place rewrite, so the last projection stands while it holds.
            revision = db.conversation_revision(session, include_ancestors=True) if hasattr(db, "conversation_revision") else None
            key = (str(home), session)
            with self.threads_lock:
                cached = self.threads.get(key)
            if revision is not None and cached is not None and cached[0] == revision:
                messages = cached[1]
            else:
                # The display read, as Hermes's own clients do it: after a compaction the turns it
                # summarised are still the person's conversation, not just the summary and the tail.
                try:
                    history = db.get_messages_as_conversation(session, include_ancestors=True, include_row_ids=True, include_compacted=True)
                except TypeError:  # a Hermes from before display reads
                    history = db.get_messages_as_conversation(session, include_ancestors=True, include_row_ids=True)
                messages = _history_to_messages(history, profile_home=home)
                if revision is not None:
                    with self.threads_lock:
                        self.threads.pop(key, None)
                        self.threads[key] = (revision, messages)
                        while len(self.threads) > CACHED_THREADS:
                            self.threads.pop(next(iter(self.threads)))
            return {"title": db.get_session_title(session) or "", "messages": list(messages)}

        return self._scoped(read)

    def chat_of(self, session):
        rows = self._read("SELECT chat_id FROM sessions WHERE id=? AND source='portal'", (session,))
        chat = rows[0][0] if rows and rows[0][0] else None
        if chat:
            self.owner[chat] = self.profile
        return chat

    def session_of(self, chat):
        """The open thread for a chat: in the calling profile first, then any other (a turn that
        started before a switch still finds its thread)."""
        first = self._origin()
        for profile in [first, *(p for p in self.homes() if p != first)]:
            rows = self._read(
                "SELECT id FROM sessions WHERE source='portal' AND chat_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
                (chat,),
                profile,
            )
            if rows:
                return rows[0][0]
        return None

    def ensure_chat(self, chat, title=None):
        return _ensure_chat(self.store, chat, title, self.profile)

    async def new_thread(self, chat, title):
        self.owner[chat] = self.profile
        return await asyncio.to_thread(self.ensure_chat, chat, title)

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

        def repoint():
            thread = _source(chat, self.profile, chat_name="Nako")
            key = self.store.get_or_create_session(thread, touch_activity=False).session_key
            return self.store.switch_session(key, session, preserve_prompt_pin=False)

        if self._scoped(repoint) is None:
            raise ValueError("Couldn't move that chat into the portal")
        self.owner[chat] = self.profile
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
        source = dataclasses.replace(source, profile=_named(self.owner.get(chat, self.profile)))
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
        self._scoped(lambda: self.db.set_session_title(session, title))

    def set_archived(self, session, archived):
        self._scoped(lambda: self.db.set_session_archived(session, archived))

    def is_archived(self, session):
        rows = self._read("SELECT COALESCE(archived, 0) FROM sessions WHERE id=? AND source='portal'", (session,))
        return bool(rows and rows[0][0])

    def set_pinned(self, session, pinned):
        self._scoped(lambda: self.db.set_session_pinned(session, pinned))

    def sign_off(self, reply):
        """A few proud words about what the turn did, from a small fast model. The model is
        config.yaml's `auxiliary.portal_signoff` (provider/model/reasoning_effort/timeout)."""
        from agent.auxiliary_client import call_llm

        response = call_llm(
            task="portal_signoff",
            messages=[{"role": "system", "content": SIGN_OFF_PROMPT}, {"role": "user", "content": f"<reply>\n{reply[-SIGN_OFF_REPLY_CHARS:]}\n</reply>"}],
            max_tokens=120,
        )
        line = " ".join(str(response.choices[0].message.content or "").split()).strip("\"'` ").lower()
        if len(line) > SIGN_OFF_MAX_CHARS:
            line = line[:SIGN_OFF_MAX_CHARS].rsplit(" ", 1)[0] + "…"
        return line or None

    def sign_off_models(self):
        return _model_providers()

    # The shown profile's own model: what its turns run on (config.yaml `model:`).

    def _profile_scope(self):
        """Config, credentials and paths of the shown profile, the way a turn there sees them."""
        from gateway.run import _profile_runtime_scope

        return _profile_runtime_scope(Path(self._home()))

    def models(self):
        with self._profile_scope():
            return _model_providers()

    def model(self):
        from hermes_cli.config import load_config

        with self._profile_scope():
            chosen = load_config().get("model") or {}
        if not isinstance(chosen, dict):
            return {"provider": "", "model": str(chosen)}
        return {"provider": str(chosen.get("provider") or ""), "model": str(chosen.get("default") or chosen.get("model") or "")}

    def set_model(self, provider, model):
        """Switch the shown profile's model the way `/model <model> --provider <p> --global` does:
        Hermes validates the pick and rewrites the endpoint keys that go with it."""
        from hermes_cli.config import get_compatible_custom_providers, load_config
        from hermes_cli.model_switch import persist_model_selection, switch_model

        with self._profile_scope():
            config = load_config()
            current = config.get("model") if isinstance(config.get("model"), dict) else {}
            result = switch_model(
                raw_input=model,
                explicit_provider=provider,
                is_global=True,
                current_provider=str(current.get("provider") or ""),
                current_model=str(current.get("default") or ""),
                current_base_url=str(current.get("base_url") or ""),
                user_providers=config.get("providers") if isinstance(config.get("providers"), dict) else {},
                custom_providers=get_compatible_custom_providers(config),
            )
            if not result.success:
                raise ValueError(result.error_message or "That model can't be used")
            persist_model_selection(result)

    def sign_off_model(self):
        from hermes_cli.config import load_config

        task = (load_config().get("auxiliary") or {}).get("portal_signoff") or {}
        return {"provider": str(task.get("provider") or "auto"), "model": str(task.get("model") or "")}

    def set_sign_off_model(self, provider, model):
        from hermes_cli.config import set_config_value

        set_config_value("auxiliary.portal_signoff.provider", provider)
        set_config_value("auxiliary.portal_signoff.model", model)

    def set_yolo(self, chat):
        from tools.approval import enable_session_yolo

        source = _source(chat, self.profile)
        enable_session_yolo(self._scoped(lambda: self.store.get_or_create_session(source, touch_activity=False).session_key))

    def processes(self, session):
        """Background processes a chat's turns started (terminal ``background=true``), from Hermes's
        process registry, which lives in this gateway process. A portal thread's processes carry its
        gateway key, ``<profile>:portal:dm:<chat>``; finished ones stay listed for a while."""
        from tools.process_registry import process_registry

        chat = self.chat_of(session)
        if not chat:
            return []
        now = time.time()
        out = []
        for entry in process_registry.list_sessions():
            proc = self._process(chat, entry["session_id"])
            if proc is None:
                continue
            out.append(
                {
                    "id": entry["session_id"],
                    "command": proc.command,
                    "cwd": proc.cwd or "",
                    "running": entry["status"] == "running",
                    "started_at": proc.started_at or now - entry["uptime_seconds"],
                    "exited_at": proc.exited_at or None,
                    "exit_code": entry.get("exit_code"),
                    "ended": proc.completion_reason if proc.exited else None,
                    "notify": bool(proc.notify_on_complete or proc.watch_patterns),
                }
            )
        return out

    @staticmethod
    def _process(chat, proc_id):
        from tools.process_registry import process_registry

        proc = process_registry.get(proc_id)
        return proc if proc is not None and str(proc.session_key or "").endswith(f":portal:dm:{chat}") else None

    def process_log(self, session, proc_id, lines=200):
        """The last lines a chat's background process printed. Read from the buffer itself, not
        ``read_log``: that marks a finished process's completion as seen, which would swallow the
        notice Nako is waiting for."""
        from tools.ansi_strip import strip_ansi

        chat = self.chat_of(session)
        proc = self._process(chat, proc_id) if chat else None
        if proc is None:
            return None
        with proc._lock:
            text = strip_ansi(proc.output_buffer)
        return {"lines": text.splitlines()[-int(lines):], "total_chars": proc.total_output_chars}

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


# What a portal turn gets when its profile resolves to no tools at all.
FALLBACK_TOOLSETS = ["hermes-cli"]


def _fallback_toolsets(home=None):
    """Tools for a portal turn in a profile that doesn't load this plugin.

    Hermes builds a plugin platform's default toolset (`hermes-portal`) only where the plugin is
    registered, so in a profile that doesn't load it the bundle is empty and portal turns run
    with no tools. Such a profile gets the standard full toolset instead. A profile that sets
    `platform_toolsets.portal`, or where the bundle exists, is left alone (None)."""
    from hermes_cli.config import load_config
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from toolsets import resolve_toolset

    token = set_hermes_home_override(str(home)) if home else None
    try:
        if "portal" in (load_config().get("platform_toolsets") or {}):
            return None
        return None if resolve_toolset("hermes-portal") else list(FALLBACK_TOOLSETS)
    except Exception:
        log.warning("portal: could not check the toolset for a turn", exc_info=True)
        return None
    finally:
        if token is not None:
            reset_hermes_home_override(token)


def _model_providers():
    """Models Hermes can run on with the credentials in scope, grouped by provider."""
    from hermes_cli.inventory import build_models_payload, load_picker_context

    payload = build_models_payload(load_picker_context(), non_blocking_catalogs=True)
    return [
        {"provider": str(row["slug"]), "label": str(row.get("name") or row["slug"]), "models": [str(m) for m in row.get("models") or []]}
        for row in payload.get("providers", [])
        if row.get("slug")
    ]


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
            self.backend = None
            self.link = None
            self._tasks = []
            self._http = None
            self._spawned = 0.0

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            import aiohttp

            if self.link is None:
                home, origin, port, contact, apps = _settings()
                data = home / "nako-portal"
                token = _local_token(data)
                config_path, config = _server_config(home, origin, port, contact, apps)
                self.backend = HermesBackend(self, home)

                async def start_server(stale=False):
                    # A stale server shuts itself down; the new one waits for its port.
                    if not stale and time.monotonic() - self._spawned < SPAWN_GAP:
                        return
                    self._spawned = time.monotonic()
                    await asyncio.to_thread(_spawn_server, config_path, data)

                self.link = _portal("link").GatewayClient(
                    f"http://127.0.0.1:{port + 1}/gateway",
                    token,
                    config["code"],
                    self.backend,
                    on_missing=start_server,
                    on_stale=lambda: start_server(stale=True),
                )
                self._http = aiohttp.ClientSession()
                loop = asyncio.get_running_loop()
                self._tasks.append(loop.create_task(self.link.run(self._http)))
                self._tasks.append(loop.create_task(_forward_inbox(_portal("store").Store(data / "portal.db"), self)))
                _LIVE_TOOLS.update(link=self.link, loop=loop)
            # Every served profile gets its Notifications thread, so its cron posts have one to land in.
            for profile in await asyncio.to_thread(self.backend.homes):
                await asyncio.to_thread(self._chat, HOME_CHANNEL, CHAT_TITLE, profile)
            self._mark_connected()
            return True

        async def disconnect(self) -> None:
            # The server keeps running and shows "offline" until a gateway dials in again.
            for task in self._tasks:
                task.cancel()
            if self._http is not None:
                await self._http.close()
            _LIVE_TOOLS.clear()
            self._tasks, self._http, self.link, self.backend = [], None, None, None
            self._mark_disconnected()

        async def _hub(self, method, *args):
            """Tell the portal's hub something and wait for it; a no-op while it's unreachable."""
            if self.link is None:
                return False
            try:
                await self.link.call(method, *args)
                return True
            except ConnectionError:
                return False

        def _chat(self, chat, title=None, profile=None):
            """A thread in ``profile``; by default the one whose work is sending (a cron run or
            turn), else the profile the portal shows."""
            try:
                if profile is None and self.backend is not None:
                    profile = self.backend._origin()
                return _ensure_chat(getattr(self, "_session_store", None), chat, title, profile)
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
            await self._hub("sessions_changed")
            return chat

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            chat = str(chat_id or HOME_CHANNEL)
            if chat == NEW_THREAD:
                chat = await self._new_thread(content)
            elif chat in CHANNELS:
                # send_message mirrors the post into this thread right after the send returns.
                await asyncio.to_thread(self._chat, chat, CHANNELS[chat])
            message_id = uuid.uuid4().hex
            if self.link is not None:
                # Not awaited: outside a turn the hub waits for the mirror before telling clients.
                self.link.tell("outgoing", chat, message_id, content)
            return SendResult(success=True, message_id=message_id)

        async def edit_message(self, chat_id, message_id, content, *, finalize=False):
            await self._hub("outgoing", str(chat_id), message_id, content)
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

        def toolsets_for_source(self, source):
            home = self.backend.home_of(getattr(source, "profile", None)) if self.backend is not None else None
            return _fallback_toolsets(home)

        async def get_chat_info(self, chat_id):
            return {"name": "Nako", "type": "dm"}

        async def on_processing_start(self, event):
            await self._hub("turn_started", event.source.chat_id)

        async def on_processing_complete(self, event, outcome):
            await self._hub("turn_finished", event.source.chat_id, getattr(outcome, "value", str(outcome)))

        async def _send_exec_approval_prompt(self, prompt):
            request = {
                "id": uuid.uuid4().hex,
                "method": "approval",
                "params": {"command": prompt.command, "description": prompt.description, "choices": prompt.choices},
                "private": {"session_key": prompt.session_key},
            }
            if not await self._hub("ask", prompt.chat_id, request):
                return SendResult(success=False, error="the portal server isn't reachable")
            return SendResult(success=True, message_id=request["id"])

        async def send_clarify(self, chat_id, question, choices, clarify_id, session_key, metadata=None):
            if self.link is None or self.link.peer is None or not choices:
                # An open question is answered by the next message, which the gateway intercepts.
                return await super().send_clarify(chat_id, question, choices, clarify_id, session_key, metadata)
            request = {
                "id": uuid.uuid4().hex,
                "method": "clarify",
                "params": {"questions": [{"qid": clarify_id, "question": question, "choices": list(choices)}]},
                "private": {"clarify_id": clarify_id},
            }
            if not await self._hub("ask", str(chat_id), request):
                return await super().send_clarify(chat_id, question, choices, clarify_id, session_key, metadata)
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


# The reply goes in <reply> tags so small models write about it instead of answering it.
SIGN_OFF_PROMPT = (
    "You are Nako, a cheerful assistant who's quietly proud of her work. You just sent the reply inside <reply> tags. "
    "Say the tiny line you'd mutter to yourself right after, pleased with what you just did "
    "(fixed, shipped, built, found, or explained something well). "
    "One line, 3 to 9 words, lowercase, no emoji, no hearts, no quotes. "
    "Don't talk to the user, don't repeat the reply, no next steps, no questions. "
    "Tone only, don't copy: 'fixed that flaky test, and it stays fixed' / 'merged, tested, shipped. good day' / "
    "'cleared that one right up'. Output only the line."
)
SIGN_OFF_REPLY_CHARS = 3000
SIGN_OFF_MAX_CHARS = 120

# Tool hooks run on the agent's thread; the link to the hub lives on the gateway's loop.
_LIVE_TOOLS = {}


def _tool_context(name, args):
    try:
        from agent.display import build_tool_preview

        return build_tool_preview(name, args if isinstance(args, dict) else {}, max_len=80) or ""
    except Exception:
        return ""


def _forward_tool(state):
    def hook(tool_name="", args=None, session_id=None, tool_call_id=None, status=None, **_):
        link, loop = _LIVE_TOOLS.get("link"), _LIVE_TOOLS.get("loop")
        if link is None or loop is None or link.peer is None or not session_id:
            return None
        ended = "failed" if status == "error" else "done"
        payload = (session_id, str(tool_call_id or ""), tool_name, _tool_context(tool_name, args), state or ended)
        # The hub keeps only calls in a portal turn it shows as running.
        loop.call_soon_threadsafe(link.tell, "tool", *payload)
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
            "Each portal chat is its own thread; send_message to portal:new starts a new one. "
            "End every reply with <signoff>...</signoff> on its own line: a 3-9 word lowercase aside, "
            "quietly proud of the specific thing you just did this turn (not a summary, not addressed "
            "to the user, no emoji). The app shows it beside you and hides the tag."
        ),
    )
