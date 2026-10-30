"""The link between the portal's server and the Hermes gateway.

The server runs on its own and stays up; the gateway dials in over one WebSocket on the
loopback port, the way a bot connects to Discord. Either side can call the other's methods:
the server asks the gateway about chats and hands it messages (the hub's `backend`), and the
gateway tells the hub what happens in a thread (a turn starting, a reply, a question).

While no gateway is connected, every backend call raises ConnectionError, which the web
server answers with "Nako is offline".
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets

from aiohttp import WSMsgType, web

log = logging.getLogger("hermes.portal")

GATEWAY_PATH = "/gateway"
# A message can carry 25 MiB of files, base64-encoded.
MAX_FRAME = 80 * 1024 * 1024
CALL_TIMEOUT = 180
HEARTBEAT = 20
# The hub's backend, as calls over the link. These block (the hub runs them in a thread).
BACKEND_SYNC = (
    "sessions",
    "archived_sessions",
    "thread",
    "chat_of",
    "session_of",
    "set_title",
    "set_archived",
    "is_archived",
    "set_pinned",
    "set_yolo",
    "commands",
    "processes",
    "process_log",
    "sign_off",
    "sign_off_models",
    "sign_off_model",
    "set_sign_off_model",
    "profiles",
    "use_profile",
    "models",
    "model",
    "set_model",
)
# These are awaited.
BACKEND_ASYNC = ("new_thread", "adopt", "inbound", "resolve")
# What the gateway tells the hub.
HUB_CALLS = ("turn_started", "turn_finished", "outgoing", "ask", "tool", "sessions_changed")


def _error(frame):
    kind = {"value": ValueError, "connection": ConnectionError}.get(frame.get("type"), RuntimeError)
    return kind(str(frame.get("error") or "the other side failed"))


def encode_files(files):
    return [{**f, "data": base64.b64encode(f["data"]).decode()} for f in files]


def decode_files(files):
    return [{**f, "data": base64.b64decode(f["data"])} for f in files]


class Peer:
    """One open link: calls the other side's methods and answers its calls, until it closes."""

    def __init__(self, ws, methods):
        self.ws = ws
        self.methods = methods
        self.pending = {}
        self.tasks = set()
        self.lock = asyncio.Lock()

    async def _write(self, frame):
        async with self.lock:
            await self.ws.send_str(json.dumps(frame, default=str))

    async def call(self, method, *args, timeout=CALL_TIMEOUT):
        cid = secrets.token_hex(8)
        future = asyncio.get_running_loop().create_future()
        self.pending[cid] = future
        try:
            try:
                await self._write({"id": cid, "call": method, "args": list(args)})
            except Exception as error:
                raise ConnectionError("the link closed") from error
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(cid, None)

    async def run(self):
        try:
            async for message in self.ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    frame = json.loads(message.data)
                except ValueError:
                    continue
                if not isinstance(frame, dict):
                    continue
                if "call" in frame:
                    task = asyncio.get_running_loop().create_task(self._answer(frame))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                    continue
                future = self.pending.get(frame.get("id"))
                if future is None or future.done():
                    continue
                if "error" in frame:
                    future.set_exception(_error(frame))
                else:
                    future.set_result(frame.get("result"))
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("the link closed"))
            for task in list(self.tasks):
                task.cancel()

    async def _answer(self, frame):
        method = self.methods.get(str(frame["call"]))
        try:
            if method is None:
                raise ValueError(f"no such call: {frame['call']}")
            reply = {"id": frame.get("id"), "result": await method(*(frame.get("args") or []))}
        except asyncio.CancelledError:
            raise
        except Exception as error:
            kind = "value" if isinstance(error, ValueError) else "connection" if isinstance(error, ConnectionError) else "other"
            if kind == "other":
                log.exception("portal: link call %s failed", frame.get("call"))
            reply = {"id": frame.get("id"), "error": str(error), "type": kind}
        try:
            await self._write(reply)
        except Exception:
            log.debug("portal: couldn't answer over a closed link", exc_info=True)


class GatewayLink:
    """The server's end of the link, and the hub's backend.

    `code` names the server's own code and settings. A gateway running different code is told
    to start a fresh server (409) and this one shuts down via `on_stale`, so a plugin update
    reaches the server on the next gateway restart, while a plain restart leaves it running.
    `on_change(connected)` runs each time a gateway connects or goes away."""

    def __init__(self, code, *, on_change=None, on_stale=None):
        self.code = code
        self.on_change = on_change
        self.on_stale = on_stale
        self.peer = None
        self.hub = None
        self.loop = None

    def serve(self, hub):
        self.hub = hub
        hub.backend = self
        hub.connected = False
        return self

    def _methods(self):
        hub = self.hub

        async def sessions_changed():
            await hub.broadcast({"kind": "sessions.changed"})

        methods = {name: getattr(hub, name) for name in HUB_CALLS if name != "sessions_changed"}
        methods["sessions_changed"] = sessions_changed
        return methods

    @property
    def connected(self):
        return self.peer is not None

    async def handle(self, request):
        """GET /gateway on the loopback app, behind its token check."""
        if request.query.get("code") != self.code:
            log.info("portal: a gateway with other code connected; handing over to a fresh server")
            if self.on_stale is not None:
                asyncio.get_running_loop().call_later(0.2, self.on_stale)
            return web.json_response({"error": "restart", "code": self.code}, status=409)
        self.loop = asyncio.get_running_loop()
        ws = web.WebSocketResponse(heartbeat=HEARTBEAT, max_msg_size=MAX_FRAME)
        await ws.prepare(request)
        peer = Peer(ws, self._methods())
        old, self.peer = self.peer, peer
        if old is not None:
            await old.ws.close()
        log.info("portal: gateway connected")
        changed = self.loop.create_task(self._changed(True))
        try:
            await peer.run()
        finally:
            changed.cancel()
            if self.peer is peer:
                self.peer = None
                log.info("portal: gateway went away")
                await self._changed(False)
        return ws

    async def _changed(self, connected):
        if self.on_change is not None:
            try:
                await self.on_change(connected)
            except Exception:
                log.exception("portal: handling the gateway %s failed", "connecting" if connected else "leaving")

    async def call(self, method, *args):
        peer = self.peer
        if peer is None:
            raise ConnectionError("Nako is offline")
        return await peer.call(method, *args)

    def call_sync(self, method, *args):
        """A backend call from one of the hub's worker threads."""
        loop = self.loop
        if loop is None or self.peer is None:
            raise ConnectionError("Nako is offline")
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            raise RuntimeError(f"backend.{method} blocks; call it from a thread")
        return asyncio.run_coroutine_threadsafe(self.call(method, *args), loop).result(CALL_TIMEOUT + 5)

    def __getattr__(self, name):
        if name in BACKEND_SYNC:
            return lambda *args: self.call_sync(name, *args)
        if name in BACKEND_ASYNC:
            return lambda *args: self.call(name, *args)
        raise AttributeError(name)

    async def inbound(self, chat, text, files):
        return await self.call("inbound", chat, text, encode_files(files))


class GatewayClient:
    """The gateway's end: dials the server, answers its backend calls, and passes the hub what
    happens in portal threads. Reconnects for as long as it runs; `on_missing` runs when nothing
    listens (start the server), `on_stale` when the server runs other code (start a new one)."""

    RETRY = 1.0

    def __init__(self, url, token, code, backend, *, on_missing=None, on_stale=None):
        self.url = url
        self.token = token
        self.code = code
        self.backend = backend
        self.on_missing = on_missing
        self.on_stale = on_stale
        self.peer = None
        self.connected_event = asyncio.Event()

    def _methods(self):
        methods = {}
        for name in BACKEND_SYNC:
            fn = getattr(self.backend, name)

            async def run(*args, _fn=fn):
                return await asyncio.to_thread(_fn, *args)

            methods[name] = run
        for name in BACKEND_ASYNC:
            methods[name] = getattr(self.backend, name)

        async def inbound(chat, text, files):
            return await self.backend.inbound(chat, text, decode_files(files))

        methods["inbound"] = inbound
        return methods

    async def run(self, http):
        while True:
            try:
                ws = await http.ws_connect(
                    self.url,
                    params={"code": self.code},
                    headers={"Authorization": f"Bearer {self.token}"},
                    heartbeat=HEARTBEAT,
                    max_msg_size=MAX_FRAME,
                )
            except Exception as error:
                status = getattr(error, "status", None)
                if status == 409:
                    if self.on_stale is not None:
                        await self.on_stale()
                elif status is None and self.on_missing is not None:
                    await self.on_missing()
                else:
                    log.warning("portal: the server refused the gateway (%s)", error)
                await asyncio.sleep(self.RETRY)
                continue
            peer = Peer(ws, self._methods())
            self.peer = peer
            self.connected_event.set()
            log.info("portal: connected to the portal server")
            try:
                await peer.run()
            finally:
                self.peer = None
                self.connected_event.clear()
                # Stopping (the gateway shutting down) closes the link, so the server knows at once.
                await ws.close()
            log.info("portal: lost the portal server; reconnecting")
            await asyncio.sleep(self.RETRY)

    async def call(self, method, *args):
        peer = self.peer
        if peer is None:
            raise ConnectionError("the portal server isn't connected")
        return await peer.call(method, *args)

    def tell(self, method, *args):
        """Tell the hub something and move on; nothing waits for the answer."""
        task = asyncio.get_running_loop().create_task(self.call(method, *args))
        task.add_done_callback(_quiet)
        return task


def _quiet(task):
    if task.cancelled():
        return
    error = task.exception()
    if error is not None and not isinstance(error, ConnectionError):
        log.warning("portal: telling the hub failed: %s", error)
