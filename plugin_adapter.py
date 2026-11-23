"""Hermes platform adapter, secret request surface, and display defaults."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

log = logging.getLogger("hermes.portal")


@dataclass(frozen=True)
class AdapterRuntime:
    """Plugin services and settings used by each adapter's lifecycle."""

    backend: Callable
    settings: Callable
    local_token: Callable
    server_config: Callable
    spawn_server: Callable
    portal: Callable
    hermes_build: Callable
    forward_inbox: Callable
    live_tools: dict
    secrets_api: Callable
    secrets_changed: Callable
    own_origins: Callable
    ensure_chat: Callable
    fallback_toolsets: Callable
    home_channel: str
    chat_title: str
    new_thread: str
    channels: dict
    spawn_gap: int
    turn_sweep: Callable
    outside_sources_every: int
    outside_repeat_every: int


class SecretSurface:
    """The portal as the place agent-secrets asks for a secret: a card with a masked field in the
    chat that asked. The answer comes back through `HermesBackend.resolve`."""

    def __init__(self, adapter, loop):
        self.adapter = adapter
        self.loop = loop
        # Requests shown since connecting; their cards go when the gateway does.
        self.shown = set()

    def ask(self, session_id, request):
        try:
            from gateway.session_context import get_session_env

            chat = get_session_env("HERMES_SESSION_CHAT_ID", "")
        except ImportError:
            chat = ""
        backend = self.adapter.backend
        if not chat and backend is not None and session_id:
            chat = backend.chat_of(session_id) or ""
        if not chat:
            return False
        card = {
            "id": request["id"],
            "method": "secret",
            "params": {"name": request["name"], "note": request.get("note") or "", "replace": bool(request.get("replace"))},
            "private": {"secret_request": request["id"]},
        }
        try:
            shown = bool(asyncio.run_coroutine_threadsafe(self.adapter._hub("ask", str(chat), card), self.loop).result(timeout=15))
        except Exception:
            log.warning("portal: couldn't show a secret request", exc_info=True)
            return False
        if shown:
            self.shown.add(request["id"])
        return shown

    def show_line(self, name):
        return f"SECRET:{name}"


def _adapter(config, runtime: AdapterRuntime):
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
            # Chats whose turn the gateway announced through the processing hooks, and the turns
            # the sweep announced itself because Hermes ran them without the hooks (chat -> admission).
            self._hooked = set()
            self._swept = {}

        # One portal per machine: the default profile's adapter runs the link to the server and
        # shows every served profile. Hermes still gives each other profile that loads this
        # plugin its own portal adapter, and only that adapter may carry the profile's turns
        # (the gateway refuses a turn whose profile isn't its adapter's owner). So such a
        # secondary never dials the server; the primary hands it that profile's messages, and it
        # hands everything it sends back to the primary.

        def _secondary(self):
            return bool(getattr(self, "_owner_profile", None))

        def _primary(self):
            """The adapter that holds the link, when this one is a secondary; else None."""
            if not self._secondary():
                return None
            adapters = getattr(getattr(self, "gateway_runner", None), "adapters", None) or {}
            primary = adapters.get(self.platform)
            return primary if primary is not None and primary is not self else None

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            import aiohttp

            if self._secondary():
                self._mark_connected()
                return True
            if self.link is None:
                home, origin, port, contact, apps = runtime.settings()
                data = home / "nako-portal"
                token = runtime.local_token(data)
                config_path, config = runtime.server_config(home, origin, port, contact, apps)
                self.backend = runtime.backend(self, home)

                async def start_server(stale=False):
                    # A stale server shuts itself down; the new one waits for its port.
                    if not stale and time.monotonic() - self._spawned < runtime.spawn_gap:
                        return
                    self._spawned = time.monotonic()
                    await asyncio.to_thread(runtime.spawn_server, config_path, data)

                self.link = runtime.portal("link").GatewayClient(
                    f"http://127.0.0.1:{port + 1}/gateway",
                    token,
                    config["code"],
                    self.backend,
                    hermes_build=await asyncio.to_thread(runtime.hermes_build),
                    on_missing=start_server,
                    on_stale=lambda: start_server(stale=True),
                )
                self._http = aiohttp.ClientSession()
                loop = asyncio.get_running_loop()
                self._tasks.append(loop.create_task(self.link.run(self._http)))
                self._tasks.append(loop.create_task(runtime.forward_inbox(runtime.portal("store").Store(data / "portal.db"), self)))
                self._tasks.append(loop.create_task(self._sweep_turns()))
                runtime.live_tools.update(link=self.link, loop=loop)
                # With agent-secrets loaded, the portal is where its requests and shared secrets show.
                secrets_api = runtime.secrets_api()
                if secrets_api is not None:
                    self._secrets = SecretSurface(self, loop)
                    secrets_api.register_surface("portal", self._secrets)
                    if not getattr(secrets_api, "_portal_listening", False):
                        secrets_api._portal_listening = True
                        secrets_api.on_change(lambda _home: runtime.secrets_changed())
            store = getattr(self, "_session_store", None)
            if store is not None:
                await asyncio.to_thread(runtime.own_origins, store)
            # Every served profile gets its Notifications thread, so its cron posts have one to land in.
            for profile in await asyncio.to_thread(self.backend.homes):
                await asyncio.to_thread(self._chat, runtime.home_channel, runtime.chat_title, profile)
            self._mark_connected()
            return True

        async def disconnect(self) -> None:
            if self._secondary():
                self._mark_disconnected()
                return
            # The server keeps running and shows "offline" until a gateway dials in again.
            for task in self._tasks:
                task.cancel()
            if self._http is not None:
                await self._http.close()
            runtime.live_tools.clear()
            secrets_api = runtime.secrets_api()
            if secrets_api is not None and getattr(self, "_secrets", None) is not None:
                secrets_api.unregister_surface("portal", self._secrets)
                for request_id in self._secrets.shown:
                    secrets_api.close(request_id)
            self._secrets = None
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
                return runtime.ensure_chat(getattr(self, "_session_store", None), chat, title, profile)
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
            if (primary := self._primary()) is not None:
                return await primary.send(chat_id, content, reply_to=reply_to, metadata=metadata)
            chat = str(chat_id or runtime.home_channel)
            if chat == runtime.new_thread:
                chat = await self._new_thread(content)
            elif chat in runtime.channels:
                # send_message mirrors the post into this thread right after the send returns.
                await asyncio.to_thread(self._chat, chat, runtime.channels[chat])
            message_id = uuid.uuid4().hex
            if self.link is not None:
                # Not awaited: outside a turn the hub waits for the mirror before telling clients.
                self.link.tell("outgoing", chat, message_id, content)
            return SendResult(success=True, message_id=message_id)

        async def edit_message(self, chat_id, message_id, content, *, finalize=False):
            if (primary := self._primary()) is not None:
                return await primary.edit_message(chat_id, message_id, content, finalize=finalize)
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
            if (primary := self._primary()) is not None:
                return primary.toolsets_for_source(source)
            home = self.backend.home_of(getattr(source, "profile", None)) if self.backend is not None else None
            return runtime.fallback_toolsets(home)

        async def get_chat_info(self, chat_id):
            return {"name": "Nako", "type": "dm"}

        async def on_processing_start(self, event):
            if (primary := self._primary()) is not None:
                return await primary.on_processing_start(event)
            chat = event.source.chat_id
            self._hooked.add(chat)
            self._swept.pop(chat, None)  # the hooks report this chat's turns from here
            if self.backend is not None:
                await asyncio.to_thread(self.backend.restore_model_options, event.source)
            await self._hub("turn_started", chat)

        async def on_processing_complete(self, event, outcome):
            if (primary := self._primary()) is not None:
                return await primary.on_processing_complete(event, outcome)
            self._hooked.discard(event.source.chat_id)
            await self._hub("turn_finished", event.source.chat_id, getattr(outcome, "value", str(outcome)))

        async def _sweep_turns(self):
            """Hermes runs some turns without the processing hooks: a message queued behind a busy
            turn runs from its durable queue, and so does one held over a gateway restart. Read
            what it is running and tell the hub, so those chats show as working and finish with a
            reply and a ping like any other turn. A turn is announced once it has run a whole sweep,
            and never for a turn the hooks already reported, whose record may settle a moment after it ends."""
            seen, hooked = {}, set()
            sweeps, outside = 0, None
            while True:
                await asyncio.sleep(runtime.turn_sweep())
                backend = self.backend
                if backend is None:
                    continue
                outside = await self._sweep_outside(backend, sweeps, outside)
                sweeps += 1
                try:
                    running = await asyncio.to_thread(backend.running_turns)
                except Exception:
                    log.warning("portal: could not read running turns", exc_info=True)
                    continue
                for chat, admission in list(self._swept.items()):
                    if running.get(chat) != admission:
                        del self._swept[chat]
                        outcome = await asyncio.to_thread(backend.turn_outcome, admission)
                        await self._hub("turn_finished", chat, outcome)
                for chat, admission in running.items():
                    if chat in self._hooked:
                        hooked.add(admission)
                    if admission in hooked or self._swept.get(chat) == admission:
                        continue
                    if seen.get(chat) == admission:
                        self._swept[chat] = admission
                        await self._hub("turn_started", chat)
                seen, hooked = running, hooked & set(running.values())

        async def _sweep_outside(self, backend, sweeps, last):
            """Tell the hub which sessions from other ways in are running a turn (and which ways in
            there are), when that changes and every so often anyway. Returns what it last sent."""
            try:
                sources = last["sources"] if last and sweeps % runtime.outside_sources_every else await asyncio.to_thread(backend.outside_sources)
                now = {"sources": sources, "running": await asyncio.to_thread(backend.outside_running)}
            except Exception:
                log.warning("portal: could not read sessions from other platforms", exc_info=True)
                return last
            if (now != last or sweeps % runtime.outside_repeat_every == 0) and not await self._hub("outside", now):
                return None
            return now

        async def _send_exec_approval_prompt(self, prompt):
            if (primary := self._primary()) is not None:
                return await primary._send_exec_approval_prompt(prompt)
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
            if (primary := self._primary()) is not None:
                return await primary.send_clarify(chat_id, question, choices, clarify_id, session_key, metadata)
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
