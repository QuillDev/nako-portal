"""The portal as a Hermes messaging platform, like Discord or Slack.

Every portal chat is a gateway thread (`portal:<chat id>`). Prompts go in as
gateway messages, replies come back through the adapter's sends and edits, and
transcripts are read from Hermes's own session store. The adapter
(`__init__.py`) hosts this hub and the web server inside the gateway; the
`backend` it hands over is the only part that touches Hermes, so tests use a fake.

backend:
  sessions() -> [{id, title, preview, started_at, message_count, pinned, chat_id}]
  thread(session) -> {title, messages}      transcript in Hermes's display projection
  chat_of(session) / session_of(chat) -> id or None
  new_thread(chat, title) -> session id     (async)
  adopt(chat, session) -> session id        (async) move another surface's chat into a new thread
  inbound(chat, text, files)                (async) a message from the person, as the gateway sees it
  resolve(request, result)                  (async) answer an approval or question
  set_title / set_archived / set_pinned(session, value)
  set_yolo(chat)                            approvals off for one thread
  commands() -> [{name, description, skill}]
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid

from .media import MEDIA

log = logging.getLogger("hermes.portal")

# Kinds of row a person wrote or should read; everything else is host traffic.
PUBLISHED_KINDS = {None, "steer", "failed_turn"}
ANSWERABLE = {"approval", "clarify"}
WORKING = "working"
NEEDS_YOU = "needs you"
DONE = "done"
FAILED = "failed"
MAX_FILE = 25 * 1024 * 1024
PREVIEW_CHARS = 280
# The thread cron posts and other deliveries to `portal` land in, like a bot's DM elsewhere.
INBOX = "inbox"
# Hermes labels every cron post it mirrors into a chat with this.
CRON_DELIVERY = re.compile(r"^\[Cron delivery: ([^\]\n]+)\]?\n?")
# Prompts and replies in one page of a transcript; tool rows between them come along.
PAGE_MESSAGES = 30
# A post outside a turn is mirrored into the transcript just after the send returns.
MIRROR_SETTLE = 1.0


class Hub:
    def __init__(self, backend, *, alert=None):
        self.backend = backend
        # alert(session, title, text): a reply finished, a post arrived, or something needs an answer.
        self.alert = alert or (lambda session, title, text: None)
        self.clients = set()
        self.subscribers = {}
        self.status = {}
        self.requests = {}
        self.running = set()
        self.titles = {}
        self.last_text = {}
        # In-process with the gateway, so the portal is up whenever this hub is.
        self.connected = True

    def notify(self, session, title, text):
        """An alert for every surface: web push (via ``alert``) and every live socket, which is
        how the Android app hears about it without Google's push service."""
        self.alert(session, title, text)
        frame = {"kind": "alert", "title": title, "body": text, "session": session}
        asyncio.get_running_loop().create_task(self.broadcast(frame))

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

    async def _event(self, session, kind, payload=None):
        await self._publish(session, {"kind": "event", "type": kind, "payload": payload or {}})

    async def _set_status(self, session, status):
        if self.status.get(session) == status:
            return
        self.status[session] = status
        await self.broadcast({"kind": "status", "session": session, "status": status})

    # Sessions

    async def sessions(self):
        rows = []
        for row in await asyncio.to_thread(self.backend.sessions):
            session = row["id"]
            self.titles[session] = row.get("title") or ""
            rows.append(
                {
                    "id": session,
                    "title": row.get("title") or row.get("preview") or "untitled",
                    "preview": row.get("preview") or "",
                    "started_at": row.get("started_at") or 0,
                    "message_count": row.get("message_count") or 0,
                    "source": "portal",
                    # The thread posts to `portal` land in; the sidebar keeps it on top.
                    "notifications": row.get("chat_id") == INBOX,
                    "pinned": bool(row.get("pinned")),
                    "status": self.status.get(session),
                }
            )
        return rows

    async def open(self, session):
        thread = await asyncio.to_thread(self.backend.thread, session)
        if thread is None:
            raise ValueError("No such chat")
        self.titles[session] = thread.get("title") or ""
        return {
            "session": session,
            "title": self.titles[session],
            "messages": [_as_notification(m) for m in thread["messages"] if _is_shown(m)],
            "running": session in self.running,
            "status": self.status.get(session),
            "requests": [_request_view(r) for r in self.requests.values() if r["session"] == session],
        }

    async def create(self, text, files=(), title=None, cwd=None, yolo=False):
        chat = uuid.uuid4().hex[:16]
        session = await self.backend.new_thread(chat, title)
        if yolo:
            # Thread-scoped, like Shift+Tab in Desktop: approvals stay on everywhere else.
            await asyncio.to_thread(self.backend.set_yolo, chat)
        submitted = await self.send(session, text, files)
        await self.broadcast({"kind": "sessions.changed"})
        return {"session": session, **submitted}

    async def adopt(self, session):
        """Hand a Desktop chat to the portal: it becomes a portal thread with its history intact."""
        chat = uuid.uuid4().hex[:16]
        adopted = await self.backend.adopt(chat, session)
        await self.broadcast({"kind": "sessions.changed"})
        return {"session": adopted}

    async def _chat(self, session):
        chat = await asyncio.to_thread(self.backend.chat_of, session)
        if chat is None:
            raise ValueError("This chat isn't a portal thread, so it can't take new messages here")
        return chat

    async def send(self, session, text, files=()):
        files = list(files)
        if not str(text or "").strip() and not files:
            raise ValueError("Nothing to send")
        for upload in files:
            if len(upload["data"]) > MAX_FILE:
                raise ValueError("Files must be under 25 MiB")
        await self.backend.inbound(await self._chat(session), str(text or "").strip(), files)
        await self._set_status(session, WORKING)
        return {"status": "sent"}

    async def interrupt(self, session):
        await self.backend.inbound(await self._chat(session), "/stop", [])
        return {"ok": True}

    async def answer(self, request_id, result):
        request = self.requests.get(str(request_id))
        if request is None:
            raise ValueError("That request is no longer open")
        if request["method"] == "approval":
            if result.get("choice") not in request["params"].get("choices", []):
                raise ValueError("Pick one of the offered options")
            result = {"choice": result["choice"]}
        else:
            answers = result.get("answers")
            if not isinstance(answers, dict):
                raise ValueError("Answer the questions first")
            result = {"answers": {str(k): (None if v is None else str(v)) for k, v in answers.items()}}
        await self.backend.resolve(request, result)
        await self.settle(str(request_id))
        return {"ok": True}

    async def archive(self, session, archived=True):
        if archived and await asyncio.to_thread(self.backend.chat_of, session) == INBOX:
            raise ValueError("The Notifications chat can't be archived")
        await asyncio.to_thread(self.backend.set_archived, session, archived)
        await self.broadcast({"kind": "sessions.changed"})
        return {"ok": True}

    async def rename(self, session, title):
        await asyncio.to_thread(self.backend.set_title, session, title)
        self.titles[session] = title
        await self.broadcast({"kind": "sessions.changed"})
        return {"ok": True}

    async def pin(self, session, pinned):
        await asyncio.to_thread(self.backend.set_pinned, session, pinned)
        await self.broadcast({"kind": "sessions.changed"})

    async def commands(self):
        return await asyncio.to_thread(self.backend.commands)

    async def command(self, session, text):
        """A `/command` is an ordinary message to the gateway, which runs it and answers in the chat."""
        await self.send(session, text)
        return {"output": None, "sent": True}

    # What the gateway does in a thread (called by the adapter)

    async def _session(self, chat):
        return await asyncio.to_thread(self.backend.session_of, chat)

    async def turn_started(self, chat):
        session = await self._session(chat)
        if session is None:
            return
        self.running.add(session)
        await self._set_status(session, WORKING)
        await self._event(session, "message.start")

    async def turn_finished(self, chat, outcome):
        session = await self._session(chat)
        if session is None:
            return
        self.running.discard(session)
        failed = outcome == "failure"
        if not any(r["session"] == session for r in self.requests.values()):
            await self._set_status(session, FAILED if failed else DONE)
        await self._event(session, "message.complete", {"status": "error" if failed else "complete"})
        title = self.titles.get(session) or "Nako"
        if failed:
            self.notify(session, title, "hit an error")
        elif outcome == "success":
            self.notify(session, title, _preview(self.last_text.pop(session, "")) or "done")

    async def outgoing(self, chat, message_id, text):
        """A message the gateway sent or edited. Inside a turn it shows live until the reply is saved;
        outside one (a cron post, a message from another platform) it's a notification."""
        session = await self._session(chat)
        if session is None:
            return
        self.last_text[session] = text
        await self._event(session, "gateway.message", {"id": message_id, "text": text})
        if session in self.running:
            return
        self.notify(session, self.titles.get(session) or "Nako", _preview(text) or "new message")
        await asyncio.sleep(MIRROR_SETTLE)
        await self._event(session, "message.complete", {"status": "complete"})
        await self.broadcast({"kind": "sessions.changed"})

    async def ask(self, chat, request):
        """An approval or a question the gateway wants answered: {id, method, params, private}."""
        session = await self._session(chat)
        if session is None:
            return
        request = {**request, "session": session}
        self.requests[request["id"]] = request
        await self._set_status(session, NEEDS_YOU)
        await self._publish(session, {"kind": "request", "request": _request_view(request)})
        what = {"approval": "needs your ok", "clarify": "has a question"}.get(request["method"], "needs you")
        self.notify(session, self.titles.get(session) or "Nako", what)

    async def settle(self, request_id):
        request = self.requests.pop(request_id, None)
        if request is None:
            return
        session = request["session"]
        await self._publish(session, {"kind": "request.closed", "id": request_id})
        if not any(r["session"] == session for r in self.requests.values()) and self.status.get(session) == NEEDS_YOU:
            await self._set_status(session, WORKING)


def page(messages, *, before=None, since=None, limit=PAGE_MESSAGES):
    """A window of a transcript and the index it starts at.

    `since` reads from that index to the end, which refreshes what a client already shows.
    Otherwise it's the last `limit` prompts and replies before `before` (the end when absent),
    with the tool rows between them. A page always starts on a prompt or reply, so a run of
    tool calls is never split across two pages.
    """
    total = len(messages)
    if since is not None:
        start = min(max(since, 0), total)
        return start, messages[start:]
    end = total if before is None else min(max(before, 0), total)
    start, seen = end, 0
    while start > 0 and seen < limit:
        start -= 1
        if messages[start].get("role") != "tool":
            seen += 1
    return start, messages[start:end]


def _is_shown(message):
    if message.get("role") == "tool":
        return True
    if message.get("role") not in {"user", "assistant"}:
        return False
    if message.get("display_kind") not in PUBLISHED_KINDS:
        return False
    return bool((message.get("text") or "").strip()) or message.get("role") == "assistant"


def _request_view(request):
    return {"id": request["id"], "method": request["method"], "params": request["params"], "answerable": request["method"] in ANSWERABLE}


def _preview(text, limit=PREVIEW_CHARS):
    """The start of a reply as one plain line for a notification: no MEDIA tags or markdown marks."""
    plain = re.sub(r"[`*_#>|]+", "", " ".join(MEDIA.sub("", str(text or "")).splitlines()))
    plain = re.sub(r"\s+([,.;:)])", r"\1", plain)
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain)
    plain = " ".join(plain.split())
    return plain if len(plain) <= limit else plain[: limit - 1].rstrip() + "…"


def _as_notification(message):
    """A cron post reads as Nako's message under its job's name; everything else is unchanged."""
    match = CRON_DELIVERY.match(message.get("text") or "") if message.get("role") == "user" else None
    if not match:
        return message
    return {**message, "role": "assistant", "label": match.group(1).strip(), "text": message["text"][match.end():].strip()}
