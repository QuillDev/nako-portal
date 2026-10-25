"""One live connection to the Hermes backend, shared by every open portal tab.

The portal is another client of the same sessions Desktop shows, over the same
`/api/ws` JSON-RPC Desktop uses. It never writes transcript rows or runs a
second agent: prompts go through `prompt.submit`, which takes the session's
turn lock, so a busy session queues or steers exactly as it does for Desktop.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import re
import time
import uuid

from .media import MEDIA
from .rpc import RpcError

log = logging.getLogger("hermes.portal")

# Session sources the list never shows: machine traffic, not conversations.
HIDDEN_SOURCES = {"cron", "oneshot", "tool", "kanban", "subagent"}
# Kinds of row a person wrote or should read; everything else is host traffic.
PUBLISHED_KINDS = {None, "steer", "failed_turn"}
ANSWERABLE = {"approval", "clarify"}
WORKING = "working"
NEEDS_YOU = "needs you"
DONE = "done"
FAILED = "failed"
MAX_FILE = 25 * 1024 * 1024
PREVIEW_CHARS = 280


class Hub:
    def __init__(self, rpc, *, profile=None, pins=None, alert=None, clock=time.time):
        self.rpc = rpc
        self.profile = profile
        self.pins = pins
        # alert(session, title, text): a turn the portal started finished, or something needs an answer.
        self.alert = alert or (lambda session, title, text: None)
        self.clock = clock
        self.clients = set()
        self.subscribers = {}
        self.runtime = {}
        self.stored = {}
        self.requests = {}
        self.status = {}
        self.titles = {}
        self.from_portal = set()
        self.connected = False
        self.ready = asyncio.Event()
        self.last_error = None
        self.attach_locks = {}

    def notify(self, session, title, text):
        """An alert for every surface: web push (via ``alert``) and every live socket, which is
        how the Android app hears about it without Google's push service."""
        self.alert(session, title, text)
        frame = {"kind": "alert", "title": title, "body": text, "session": session}
        asyncio.get_running_loop().create_task(self.broadcast(frame))

    def _scoped(self, params):
        return {**params, "profile": self.profile} if self.profile else params

    # Clients (browser tabs)

    def join(self, client):
        self.clients.add(client)

    def leave(self, client):
        self.clients.discard(client)
        for watchers in self.subscribers.values():
            watchers.discard(client)

    def watch(self, client, session):
        self.subscribers.setdefault(session, set()).add(client)

    async def _send(self, clients, message):
        for client in list(clients):
            try:
                await client.send(message)
            except Exception:
                self.leave(client)

    async def broadcast(self, message):
        await self._send(self.clients, message)

    async def _publish(self, session, message):
        await self._send(self.subscribers.get(session, ()), {"session": session, **message})

    async def _set_status(self, session, status):
        if self.status.get(session) == status:
            return
        self.status[session] = status
        await self.broadcast({"kind": "status", "session": session, "status": status})

    # Sessions

    async def sessions(self):
        listing = await self.rpc.call("session.list", self._scoped({"limit": 300}))
        pinned = set() if self.pins is None else self.pins.pinned()
        rows = []
        for row in listing.get("sessions", []):
            if row.get("source") in HIDDEN_SOURCES:
                continue
            session = row["id"]
            self.titles[session] = row.get("title") or ""
            rows.append(
                {
                    "id": session,
                    "title": row.get("title") or row.get("preview") or "untitled",
                    "preview": row.get("preview") or "",
                    "started_at": row.get("started_at") or 0,
                    "source": row.get("source") or "",
                    "pinned": session in pinned,
                    "status": self.status.get(session),
                }
            )
        return rows

    async def attach(self, session):
        """The runtime id of a stored session, resuming it (lazily) on first use."""
        if session in self.runtime:
            return self.runtime[session]
        lock = self.attach_locks.setdefault(session, asyncio.Lock())
        async with lock:
            if session in self.runtime:
                return self.runtime[session]
            snapshot = await self.rpc.call(
                "session.resume",
                self._scoped(
                    {
                        "session_id": session,
                        "lazy": True,
                        "defer_history": True,
                        "inline_images": False,
                        "close_on_disconnect": False,
                    }
                ),
            )
            runtime = snapshot["session_id"]
            self.runtime[session] = runtime
            self.stored[runtime] = session
            if not self.titles.get(session):
                with contextlib.suppress(RpcError):
                    self.titles[session] = (await self.rpc.call("session.title", {"session_id": runtime})).get("title") or ""
            for request in snapshot.get("open_requests") or []:
                self.requests[str(request["id"])] = request
            inflight = snapshot.get("inflight") or {}
            if self._requests_for(runtime):
                await self._set_status(session, NEEDS_YOU)
            elif inflight.get("streaming") or snapshot.get("running"):
                await self._set_status(session, WORKING)
            return runtime

    def _requests_for(self, runtime):
        return [frame for frame in self.requests.values() if (frame.get("params") or {}).get("session_id") == runtime]

    async def open(self, session):
        runtime = await self.attach(session)
        history = await self.rpc.call("session.history", {"session_id": runtime})
        status = {}
        with contextlib.suppress(RpcError):
            status = await self.rpc.call("session.status", {"session_id": runtime})
        return {
            "session": session,
            "title": self.titles.get(session, ""),
            "messages": [m for m in history.get("messages", []) if _is_shown(m)],
            "running": bool((status or {}).get("running")) or self.status.get(session) == WORKING,
            "status": self.status.get(session),
            "requests": [_request_view(frame) for frame in self._requests_for(runtime)],
        }

    async def create(self, text, files=(), title=None):
        created = await self.rpc.call(
            "session.create",
            self._scoped(
                {
                    "source": "desktop",
                    "title": title or _title_from(text),
                    "close_on_disconnect": False,
                    "idempotency_key": f"nako-portal:{uuid.uuid4().hex}",
                }
            ),
        )
        session = created["stored_session_id"]
        runtime = created["session_id"]
        self.runtime[session] = runtime
        self.stored[runtime] = session
        self.titles[session] = title or _title_from(text)
        submitted = await self.send(session, text, files)
        return {"session": session, **submitted}

    async def send(self, session, text, files=()):
        runtime = await self.attach(session)
        refs = [ref for ref in [await self._attach_file(runtime, f) for f in files] if ref]
        prompt = "\n".join([text.strip(), *refs]).strip()
        if not prompt and not files:
            raise ValueError("Nothing to send")
        result = await self.rpc.call(
            "prompt.submit", {"session_id": runtime, "text": prompt or "(image)", "surface": "desktop"}
        )
        self.from_portal.add(session)
        status = result.get("status") or "streaming"
        await self._set_status(session, WORKING)
        return {"status": status, "row_id": result.get("user_row_id")}

    async def _attach_file(self, runtime, upload):
        data = upload["data"]
        if len(data) > MAX_FILE:
            raise ValueError("Files must be under 25 MiB")
        mime = upload.get("content_type") or "application/octet-stream"
        encoded = base64.b64encode(data).decode()
        if mime.startswith("image/"):
            await self.rpc.call(
                "image.attach_bytes",
                {"session_id": runtime, "filename": upload["filename"], "content_base64": encoded},
            )
            return None
        result = await self.rpc.call(
            "file.attach",
            {"session_id": runtime, "name": upload["filename"], "data_url": f"data:{mime};base64,{encoded}"},
        )
        return result.get("ref_text")

    async def interrupt(self, session):
        runtime = await self.attach(session)
        return await self.rpc.call("session.interrupt", {"session_id": runtime})

    async def answer(self, request_id, result):
        frame = self.requests.get(str(request_id))
        if frame is None:
            raise ValueError("That request is no longer open")
        if frame.get("method") == "approval":
            if result.get("choice") not in (frame.get("params") or {}).get("choices", []):
                raise ValueError("Pick one of the offered options")
            result = {"choice": result["choice"]}
        elif frame.get("method") == "clarify":
            answers = result.get("answers")
            if not isinstance(answers, dict):
                raise ValueError("Answer the questions first")
            result = {"answers": {str(k): (None if v is None else str(v)) for k, v in answers.items()}}
        else:
            raise ValueError("That request has to be answered in the desktop app")
        answered = await self.rpc.call("request.answer", {"id": str(request_id), "result": result})
        await self._settle(str(request_id))
        return answered

    async def archive(self, session, archived=True):
        runtime = self.runtime.get(session, session)
        result = await self.rpc.call("session.archive", {"session_id": runtime, "archived": archived})
        await self.broadcast({"kind": "sessions.changed"})
        return result

    async def rename(self, session, title):
        runtime = await self.attach(session)
        result = await self.rpc.call("session.title", {"session_id": runtime, "title": title})
        self.titles[session] = title
        await self.broadcast({"kind": "sessions.changed"})
        return result

    async def pin(self, session, pinned):
        if self.pins is None:
            raise ValueError("Pins are unavailable")
        await asyncio.to_thread(self.pins.set, session, pinned)
        await self.broadcast({"kind": "sessions.changed"})

    # Backend events

    async def event(self, frame):
        method = frame.get("method")
        if method == "bridge.disconnected":
            raise ConnectionError("Hermes backend connection closed")
        if method != "event":
            await self._server_request(frame)
            return
        event = frame.get("params") or {}
        kind = event.get("type")
        if kind == "sessions.changed":
            await self.broadcast({"kind": "sessions.changed"})
            return
        runtime = event.get("session_id")
        session = self.stored.get(runtime)
        if session is None:
            return
        payload = event.get("payload") or {}
        if kind in {"request.cancel", "approval.cancelled"}:
            rid = str(payload.get("id") or payload.get("request_id") or "")
            if rid:
                await self._settle(rid)
        if kind == "message.start":
            await self._set_status(session, WORKING)
        elif kind == "message.complete":
            await self._finish(session, runtime, payload)
        elif kind == "session.title" and payload.get("title"):
            self.titles[session] = payload["title"]
            await self.broadcast({"kind": "sessions.changed"})
        elif kind == "error":
            await self._set_status(session, FAILED)
        await self._publish(session, {"kind": "event", "type": kind, "payload": payload})

    async def _finish(self, session, runtime, payload):
        outcome = payload.get("status") or "complete"
        if self._requests_for(runtime):
            return
        await self._set_status(session, FAILED if outcome == "error" else DONE)
        title = self.titles.get(session) or "Nako"
        if outcome == "error":
            self.notify(session, title, "hit an error")
        elif session in self.from_portal and outcome == "complete":
            self.notify(session, title, _preview(payload.get("text")) or "done")
        self.from_portal.discard(session)

    async def _server_request(self, frame):
        rid = str(frame.get("id") or "")
        params = frame.get("params") or {}
        session = self.stored.get(params.get("session_id"))
        if not rid or session is None:
            return
        self.requests[rid] = frame
        await self._set_status(session, NEEDS_YOU)
        await self._publish(session, {"kind": "request", "request": _request_view(frame)})
        what = {"approval": "needs your ok", "clarify": "has a question"}.get(frame.get("method"), "needs the desktop app")
        self.notify(session, self.titles.get(session) or "Nako", what)

    async def _settle(self, rid):
        frame = self.requests.pop(rid, None)
        if frame is None:
            return
        runtime = (frame.get("params") or {}).get("session_id")
        session = self.stored.get(runtime)
        if session is None:
            return
        await self._publish(session, {"kind": "request.closed", "id": rid})
        if not self._requests_for(runtime) and self.status.get(session) == NEEDS_YOU:
            await self._set_status(session, WORKING)

    # Connection

    async def serve(self):
        delay = 1
        while True:
            try:
                await self.rpc.connect()
                self.runtime.clear()
                self.stored.clear()
                self.requests.clear()
                self.connected = True
                self.last_error = None
                self.ready.set()
                delay = 1
                await self.broadcast({"kind": "hub.connected"})
                while True:
                    await self.event(await self.rpc.events.get())
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.last_error = str(error) if isinstance(error, (RpcError, ValueError)) else type(error).__name__
                log.warning("Nako portal lost the backend: %s", self.last_error)
            finally:
                if self.connected:
                    self.connected = False
                    self.ready.clear()
                    await self.broadcast({"kind": "hub.disconnected"})
                with contextlib.suppress(Exception):
                    await self.rpc.close()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


def _is_shown(message):
    if message.get("role") == "tool":
        return True
    if message.get("role") not in {"user", "assistant"}:
        return False
    if message.get("display_kind") not in PUBLISHED_KINDS:
        return False
    return bool((message.get("text") or "").strip()) or message.get("role") == "assistant"


def _request_view(frame):
    params = dict(frame.get("params") or {})
    params.pop("session_id", None)
    return {"id": str(frame.get("id")), "method": frame.get("method"), "params": params, "answerable": frame.get("method") in ANSWERABLE}


def _preview(text, limit=PREVIEW_CHARS):
    """The start of a reply as one plain line for a notification: no MEDIA tags or markdown marks."""
    plain = re.sub(r"[`*_#>|]+", "", " ".join(MEDIA.sub("", str(text or "")).splitlines()))
    plain = re.sub(r"\s+([,.;:)])", r"\1", plain)
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain)
    plain = " ".join(plain.split())
    return plain if len(plain) <= limit else plain[: limit - 1].rstrip() + "…"


def _title_from(text):
    first = (str(text or "").strip().splitlines() or [""])[0]
    return first[:90] or "portal chat"
