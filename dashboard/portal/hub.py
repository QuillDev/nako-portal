"""The portal as a Hermes messaging platform, like Discord or Slack.

Every portal chat is a gateway thread (`portal:<chat id>`). Prompts go in as
gateway messages, replies come back through the adapter's sends and edits, and
transcripts are read from Hermes's own session store. The hub and the
web server run in their own process (`dashboard/serve.py`), so the site stays up
while the gateway restarts; the `backend` is the gateway's adapter on the other
end of the link (`link.py`), the only part that touches Hermes, so tests use a fake.

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
  processes(session) -> [{id, command, cwd, running, started_at, exited_at, exit_code, ended, notify}]   background processes the chat started
  process_log(session, id, lines) -> {lines, total_chars} or None   one of them's latest output
  sign_off(reply) -> str or None            a short line Nako says once a turn's reply is in
  sign_off_models() -> [{provider, label, models}]   what the sign-off can run on
  sign_off_model() -> {provider, model}     / set_sign_off_model(provider, model)
  profiles() -> {profile, profiles}         the Hermes profile shown, and the ones served
  use_profile(name) -> profiles()           show another profile's chats (ValueError if not served)
  models() / model() / set_model(provider, model)   the shown profile's own model (ValueError if refused)
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
# A message sent while a turn runs is steered into it with a note for the model saying where it
# came from; Hermes keeps that note in the saved text, but the user never typed it. Several messages
# sent during one turn arrive joined, each with its own note at the start of a line.
STEER_ORIGIN = re.compile(r"^Gateway message origin \([^)\n]*\):\n\{[^\n]*\}\n(?:Do not guess[^\n]*\n)?\n*", re.M)
# When Hermes compacts a chat mid-turn it restates the unfinished request after the summary, under
# this header, so the model carries on. The person sent that message once, earlier in the turn.
RESTATED = re.compile(r"^\[STILL IN PROGRESS\b[^\]]*\]\s*")
# Prompts and replies in one page of a transcript; tool rows between them come along.
PAGE_MESSAGES = 30
# What the app draws from a transcript row. Hermes's rows also carry reasoning signatures, full
# tool arguments and display metadata, which made a page of a long chat ~170 KB instead of ~10 KB.
SHOWN_FIELDS = ("role", "text", "row_id", "reasoning", "label", "steered", "name", "context", "tool_call_id")
# Nako's own one-liner for the end of a reply: the model writes it in the reply, the app shows it
# beside her and hides the tag. A tag still streaming in (`<sign`, `<signoff>proud of`) is hidden too.
SIGN_OFF_TAG = re.compile(r"\s*<signoff>(.*?)</signoff>\s*", re.S | re.I)
SIGN_OFF_OPEN = re.compile(r"\s*(?:<signoff>[^<]*|<(?:s(?:i(?:g(?:n(?:o(?:f(?:f)?)?)?)?)?)?)?)$", re.I)
# A post outside a turn is mirrored into the transcript just after the send returns.
MIRROR_SETTLE = 1.0


class Hub:
    def __init__(self, backend, *, alert=None):
        self.backend = backend
        # alert(session, title, text): a reply finished, a post arrived, or something needs an answer.
        self.alert = alert or (lambda session, title, text: None)
        self.clients = set()
        self.subscribers = {}
        # The chat each socket shows, and the sockets whose page is on screen and focused.
        self.viewing = {}
        self.looking = set()
        self.status = {}
        self.requests = {}
        self.running = set()
        self.titles = {}
        # The notification chats the last listing found; None until the first listing.
        self.inboxes = None
        self.last_text = {}
        # What a running turn has shown so far (its messages and tool calls), so a chat opened
        # mid-turn picks up where the live view is instead of starting blank.
        self.progress = {}
        # Whether a gateway is there to run turns. The standalone server's link keeps this.
        self.connected = True
        # Whether a finished turn gets Nako's sign-off line (Settings; the server keeps it).
        self.sign_off_on = True

    def notify(self, session, title, text):
        """An alert for every surface: web push (via ``alert``) and every live socket, which is
        how the Android app hears about it without Google's push service. Nothing goes out while
        the chat is open in front of you on some device: you're already reading it."""
        if self.seen(session):
            return
        self.alert(session, title, text)
        frame = {"kind": "alert", "title": title, "body": text, "session": session}
        asyncio.get_running_loop().create_task(self.broadcast(frame))

    # Clients (browser tabs)

    def join(self, client):
        self.clients.add(client)

    def leave(self, client):
        self.clients.discard(client)
        self.viewing.pop(client, None)
        self.looking.discard(client)
        for watchers in self.subscribers.values():
            watchers.discard(client)

    def watch(self, client, session):
        """The chat a socket shows now. It hears that chat's live events and no longer the last
        one's, so a tab that has opened many chats isn't sent every reply streaming in them."""
        shown = self.viewing.pop(client, None)
        if shown is not None:
            watchers = self.subscribers.get(shown, set())
            watchers.discard(client)
            if not watchers:
                self.subscribers.pop(shown, None)
        if session is None:
            return
        self.subscribers.setdefault(session, set()).add(client)
        self.viewing[client] = session

    def look(self, client, looking):
        """The page on this socket came on screen and into focus, or left it."""
        if looking:
            self.looking.add(client)
        else:
            self.looking.discard(client)

    def seen(self, session):
        return any(self.viewing.get(client) == session for client in self.looking)

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
        inboxes = set()
        for row in await asyncio.to_thread(self.backend.sessions):
            session = row["id"]
            self.titles[session] = row.get("title") or ""
            if row.get("chat_id") == INBOX:
                inboxes.add(session)
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
        self.inboxes = inboxes
        return rows

    async def open(self, session):
        thread = await asyncio.to_thread(self.backend.thread, session)
        if thread is None:
            raise ValueError("No such chat")
        title = thread.get("title") or ""
        # Hermes names a chat after its first exchange; a list fetched before that still says untitled.
        renamed = session in self.titles and self.titles[session] != title
        self.titles[session] = title
        if renamed:
            await self.broadcast({"kind": "sessions.changed"})
        return {
            "session": session,
            "title": self.titles[session],
            "messages": _without_restated([_without_sign_off(_as_notification(_without_steer_origin(m))) for m in thread["messages"] if _is_shown(m)]),
            "running": session in self.running,
            **({"live": _progress_view(self.progress[session])} if session in self.running and session in self.progress else {}),
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

    async def processes(self, session):
        """The chat's background processes, running first, each with a short label for its command."""
        rows = await asyncio.to_thread(self.backend.processes, session)
        rows = sorted(rows, key=lambda p: (not p["running"], -p["started_at"]))
        return [{**p, "label": process_label(p["command"])} for p in rows]

    async def process_log(self, session, proc_id, lines=200):
        return await asyncio.to_thread(self.backend.process_log, session, proc_id, lines)

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
        self.progress[session] = {"messages": {}, "tools": {}}
        await self._set_status(session, WORKING)
        await self._event(session, "message.start")

    async def turn_finished(self, chat, outcome):
        session = await self._session(chat)
        if session is None:
            return
        self.running.discard(session)
        self.progress.pop(session, None)
        failed = outcome == "failure"
        if not any(r["session"] == session for r in self.requests.values()):
            await self._set_status(session, FAILED if failed else DONE)
        await self._event(session, "message.complete", {"status": "error" if failed else "complete"})
        title = self.titles.get(session) or "Nako"
        reply = self.last_text.pop(session, "")
        if failed:
            self.notify(session, title, "hit an error")
        elif outcome == "success":
            self.notify(session, title, _preview(reply) or "done")
            if self.sign_off_on:
                asyncio.get_running_loop().create_task(self._sign_off(session, reply))

    async def _sign_off(self, session, sent):
        """Nako's one-liner about the turn that just ended, for the chat's sticker. Her own line
        from the saved reply when she wrote one; otherwise a small model writes it from the reply.
        Best effort: without one the chat says a plain "done"."""
        try:
            reply = await asyncio.to_thread(self._last_reply, session) or sent
            clean, line = split_sign_off(reply)
            if not line and clean.strip():
                line = await asyncio.to_thread(self.backend.sign_off, clean)
        except Exception:
            log.debug("portal sign-off failed", exc_info=True)
            return
        if line and session not in self.running:
            await self._event(session, "signoff", {"text": line})

    def _last_reply(self, session):
        """The turn's reply as saved, not as last streamed: the final send can land after the turn ends."""
        thread = self.backend.thread(session) or {}
        last = (thread.get("messages") or [])[-1:]
        return last[0].get("text") or "" if last and last[0].get("role") == "assistant" else ""

    async def tool(self, session, call_id, name, context, state):
        """A tool call starting ("running") or ending ("done"/"failed") in a running turn, for the
        live view; the saved transcript draws the finished calls itself."""
        if session not in self.running:
            return
        tool = {"id": call_id, "name": name, "context": context, "state": state}
        if session in self.progress:
            tools = self.progress[session]["tools"]
            tools[call_id or f"#{len(tools)}"] = tool
        await self._event(session, "tool", tool)

    async def outgoing(self, chat, message_id, text):
        """A message the gateway sent or edited. Inside a turn it shows live until the reply is saved;
        outside one (a cron post, a message from another platform) it's a notification."""
        session = await self._session(chat)
        if session is None:
            return
        self.last_text[session] = text
        shown = split_sign_off(text)[0]
        if session in self.running and session in self.progress:
            # `after`: how many tool calls had started when its text last changed, as the app counts.
            progress = self.progress[session]
            was = progress["messages"].get(message_id)
            after = was["after"] if was and was["text"] == shown else len(progress["tools"])
            progress["messages"][message_id] = {"id": message_id, "text": shown, "after": after}
        await self._event(session, "gateway.message", {"id": message_id, "text": shown})
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


# Setup at the front of a background command (variables, cd, source) says nothing about what it runs.
SETUP_STEP = re.compile(r"^(\w+=\S*|cd\s|source\s|export\s|\.\s)")


def process_label(command):
    """What a background command runs, for a one-line list: its first step past the setup."""
    steps = [s.strip() for s in re.split(r";|&&|\n", command) if s.strip()]
    doing = [s for s in steps if not SETUP_STEP.match(s)]
    return " ".join((doing or steps or [command])[0].split())


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


def for_app(message):
    """A transcript row with only what the app draws."""
    return {key: message[key] for key in SHOWN_FIELDS if key in message}


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


def split_sign_off(text):
    """A reply without its sign-off tag (or the start of one still streaming), and the line."""
    text = str(text or "")
    found = SIGN_OFF_TAG.findall(text)
    clean = SIGN_OFF_OPEN.sub("", SIGN_OFF_TAG.sub("\n\n", text)).strip()
    line = " ".join(found[-1].split()).strip("\"'` ") if found else ""
    return clean, line[:80] or None


def _without_sign_off(message):
    if message.get("role") != "assistant" or not message.get("text"):
        return message
    return {**message, "text": split_sign_off(message["text"])[0]}


def _preview(text, limit=PREVIEW_CHARS):
    """The start of a reply as one plain line for a notification: no MEDIA tags or markdown marks."""
    text = split_sign_off(text)[0]
    plain = re.sub(r"[`*_#>|]+", "", " ".join(MEDIA.sub("", str(text or "")).splitlines()))
    plain = re.sub(r"\s+([,.;:)])", r"\1", plain)
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain)
    plain = " ".join(plain.split())
    return plain if len(plain) <= limit else plain[: limit - 1].rstrip() + "…"


def _without_steer_origin(message):
    if message.get("role") != "user" or not message.get("text"):
        return message
    if message.get("display_kind") == "steer":
        message = {**message, "steered": True}
    text, notes = STEER_ORIGIN.subn("", message["text"])
    return {**message, "text": text.strip()} if notes else message


def _without_restated(messages):
    """Drop Hermes's mid-turn restatement of a request after a compaction: the person's own
    message is already in the transcript above it. Without that original (an older Hermes that
    doesn't hand back compacted rows), show the message as they sent it, without the header."""
    out = []
    for message in messages:
        match = RESTATED.match(message.get("text") or "") if message.get("role") == "user" else None
        if match:
            text = message["text"][match.end():].strip()
            sent = next((m for m in reversed(out) if m.get("role") == "user"), None)
            if sent is not None and (sent.get("text") or "").strip() == text:
                continue
            message = {**message, "text": text}
        out.append(message)
    return out


def _progress_view(progress):
    return {"messages": list(progress["messages"].values()), "tools": list(progress["tools"].values())}


def _as_notification(message):
    """A cron post reads as Nako's message under its job's name; everything else is unchanged."""
    match = CRON_DELIVERY.match(message.get("text") or "") if message.get("role") == "user" else None
    if not match:
        return message
    return {**message, "role": "assistant", "label": match.group(1).strip(), "text": message["text"][match.end():].strip()}
