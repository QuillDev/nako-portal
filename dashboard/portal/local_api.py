"""Loopback-only API for local agents, gateway connections, and mesh operations."""

from __future__ import annotations

import asyncio
import re
import secrets

from aiohttp import web

from .hub import from_thread_line
from .link import GATEWAY_PATH
from .mesh import parse as remote

MAX_BODY = 60 * 1024 * 1024
SESSION_ID = re.compile(r"^[\w.-]{1,120}$")
# Maximum tool result text returned by local transcript reads.
TOOL_RESULT_CHARS = 600


class LocalAPI:
    """Local routes bound to the owning portal and its hub/mesh state."""

    def local_app(self, token, link=None):
        """Starts chats for scripts on this machine (an agent handing work to a new thread), and
        is where the gateway dials in (`link`).

        Served on its own loopback port, never through the public origin, and every call
        carries the token from a 0600 file only this account can read.
        """
        expected = f"Bearer {token}".encode()

        @web.middleware
        async def guard(request, handler):
            if not secrets.compare_digest(request.headers.get("Authorization", "").encode(), expected):
                return web.json_response({"error": "bad token"}, status=401)
            try:
                return await handler(request)
            except ValueError as error:
                return web.json_response({"error": str(error)}, status=400)
            except ConnectionError:
                return web.json_response({"error": "Nako is offline right now"}, status=503)

        async def brief(request):
            body = await request.json()
            text = str(body.get("text") or "")
            if not text.strip():
                raise ValueError("Write something first")
            return body, text

        async def start(request):
            body, text = await brief(request)
            hub = await self._hub()
            started = await hub.create(
                text, title=body.get("title") or None, cwd=body.get("cwd") or None, yolo=bool(body.get("yolo")), archived=bool(body.get("archived")), sender=body.get("from") or None
            )
            return web.json_response(started)

        async def send(request):
            # Same turn lock as a typed message: a busy thread queues or steers it.
            # `from`: the thread sending it (nako-spawn passes its own session), shown as that thread's message.
            body, text = await brief(request)
            hub, session = await self._target(self._session(request))
            if hub is not self.hub:
                return web.json_response(await hub.send(session, await self._signed(text, body.get("from")), []))
            return web.json_response(await hub.send(session, text, sender=body.get("from") or None))

        async def handoff(request):
            hub = await self._hub()
            return web.json_response(await hub.adopt(self._session(request)))

        async def read(request):
            """Where a chat stands, for an agent following it: running or not, any open question,
            its last few messages (?last=, default 4) as plain text, and with ?tools=N the last N
            tool calls among them with the start of each result. It reads with this machine's
            gateway down too (from the session store), and says so in `gateway`."""
            session = self._session(request)
            hub, inner = await self._target(session) if remote(session) else (self.hub, session)
            try:
                opened = await hub.open(inner, True)
            except RuntimeError:
                # A machine on a plugin from before tool results: its transcript without them.
                opened = await hub.open(inner)
            last = max(1, min(int(request.query.get("last") or 4), 50))
            tools = max(0, min(int(request.query.get("tools") or 0), 50))
            rows = opened.get("messages") or []
            spoken = [i for i, m in enumerate(rows) if m.get("role") in ("user", "assistant") and (m.get("text") or "").strip()]
            window = spoken[-last:]
            calls = [m for m in rows[window[0] if window else 0 :] if m.get("role") == "tool"][-tools:] if tools else []
            return web.json_response(
                {
                    "session": request.match_info["session"],
                    "title": opened.get("title"),
                    "running": bool(opened.get("running")),
                    "status": opened.get("status"),
                    "requests": opened.get("requests") or [],
                    "gateway": opened.get("gateway", True),
                    "last_active": opened.get("last_active"),
                    "messages": [{"role": rows[i]["role"], "text": rows[i]["text"]} for i in window],
                    **({"tools": [{"name": m.get("name"), "context": m.get("context") or "", "result": (m.get("result") or "")[:TOOL_RESULT_CHARS]} for m in calls]} if tools else {}),
                }
            )

        async def stop(request):
            hub, session = await self._target(self._session(request))
            return web.json_response(await hub.interrupt(session))

        async def machines(request):
            if self.node is not None:
                return web.json_response(await self.node.call("machines"))
            return web.json_response([self.mesh.me()] + self.mesh.machines() if self.mesh is not None else [])

        async def machine_op(request, op, *args):
            """A restart, update or job check on another machine, run by that machine's portal server."""
            machine = request.match_info["machine"]
            if self.node is not None:
                return web.json_response(await self.node.call("machine_op", machine, op, list(args)))
            if self.mesh is None:
                raise ValueError("This machine isn't in a mesh")
            return web.json_response(await self.mesh.machine_op(machine, op, *args))

        async def restart_gateway(request):
            return await machine_op(request, "restart_gateway")

        async def update(request):
            body = await request.json() if request.can_read_body else {}
            return await machine_op(request, "update_hermes", body.get("channel") or None)

        async def job(request):
            return await machine_op(request, "job")

        async def threads(request):
            """Another machine's chats, so an agent can pick one up."""
            machine = request.match_info["machine"]
            if self.node is not None:
                return web.json_response(await self.node.call("threads", machine))
            if self.mesh is None:
                raise ValueError("This machine isn't in a mesh")
            return web.json_response(await self.mesh.threads(machine))

        async def answer(request):
            """Answer a question or approval a chat on another machine is waiting on."""
            body = await request.json()
            request_id = str(body.get("request") or "")
            if not request_id:
                raise ValueError("Say which request")
            hub, _session = await self._target(self._session(request))
            if hub is self.hub:
                raise ValueError("Answer this machine's own questions in its chat")
            return web.json_response(await hub.answer(request_id, body.get("result") or {}))

        async def start_on(request):
            """A new chat on another machine, running a brief from a thread here."""
            body, text = await brief(request)
            machine = request.match_info["machine"]
            signed = await self._signed(text, body.get("from"))
            cwd, title, yolo = body.get("cwd") or None, body.get("title") or None, body.get("yolo", True) is not False
            if self.node is not None:
                return web.json_response(await self.node.call("start", machine, signed, title, cwd, yolo))
            if self.mesh is None:
                raise ValueError("This machine isn't in a mesh")
            return web.json_response(await self.mesh.machine_hub(machine).create(signed, [], title, cwd, yolo))

        app = web.Application(client_max_size=MAX_BODY, middlewares=[guard])
        app.router.add_post("/sessions", start)
        app.router.add_get("/sessions/{session}", read)
        app.router.add_post("/sessions/{session}/messages", send)
        app.router.add_post("/sessions/{session}/stop", stop)
        app.router.add_post("/sessions/{session}/handoff", handoff)
        app.router.add_get("/mesh/machines", machines)
        app.router.add_get("/mesh/machines/{machine}/sessions", threads)
        app.router.add_post("/sessions/{session}/answer", answer)
        app.router.add_post("/mesh/machines/{machine}/sessions", start_on)
        app.router.add_post("/mesh/machines/{machine}/gateway/restart", restart_gateway)
        app.router.add_post("/mesh/machines/{machine}/update", update)
        app.router.add_get("/mesh/machines/{machine}/job", job)
        app.router.add_post("/sessions/{session}/group", self.set_group)
        app.router.add_get("/groups", self.groups)
        app.router.add_post("/groups", self.create_group)
        app.router.add_post("/groups/{group}", self.update_group)
        app.router.add_post("/groups/{group}/remove", self.delete_group)
        if link is not None:
            app.router.add_get(GATEWAY_PATH, link.handle)
        return app


    async def _signed(self, text, sender):
        """A message from a thread here, going to another machine: it opens with the line saying
        which thread sent it, so that machine's model doesn't read it as the person's own words."""
        if not sender or text.startswith("/"):
            return text
        if not SESSION_ID.match(str(sender)):
            raise ValueError("The sending thread's id isn't a session id")
        try:
            title = await asyncio.to_thread(self.hub.backend.title_of, str(sender))
        except Exception:  # noqa: BLE001 - Optional backend titles must not block message delivery.
            title = None
        # Named the way the other machine reaches it, so its agent can answer that thread.
        here = self.mesh_name
        if here:
            sender, title = f"mesh.{here}.{sender}", f"{title or 'untitled'} on {here}"
        return from_thread_line(str(sender), title) + text
