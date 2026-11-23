"""Agent mesh tool wrappers (`mesh_tools.py`) against a real loopback HTTP server."""

from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "mesh-tools-token"


def _load_mesh_tools(base_url: str):
    spec = importlib.util.spec_from_file_location("mesh_tools_unit", ROOT / "mesh_tools.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod._api = lambda *_: (base_url.rstrip("/"), TOKEN)
    mod.POLL = 0.01
    return mod


async def _invoke(tools, name: str, args: dict | None = None, **kwargs) -> dict:
    raw = await asyncio.to_thread(tools.TOOL_HANDLERS[name], args or {}, **kwargs)
    return json.loads(raw)


@pytest.mark.asyncio
async def test_mesh_tools_request_payloads_and_responses():
    seen = []
    state = {
        "machines": [
            {"name": "hub", "hub": True, "online": True, "hermes": {"commit": "abcdef1234567890", "line": "Hermes v1.0"}},
            {"name": "macbook", "hub": False, "online": True, "gateway": True},
        ],
        "job": {
            "gateway": True,
            "hermes": {"commit": "abcdef1234999999", "line": "Hermes v1.0"},
            "job": {"kind": "update", "status": "done", "update_exit": 0, "old": {"line": "Hermes v0.9"}, "log_tail": "ok"},
        },
    }

    async def check_auth(request):
        assert request.headers.get("Authorization") == f"Bearer {TOKEN}"

    async def get_machines(request):
        await check_auth(request)
        return web.json_response(state["machines"])

    async def list_threads(request):
        await check_auth(request)
        return web.json_response([{"id": f"mesh.macbook.s{i}"} for i in range(5)])

    async def start_session(request):
        await check_auth(request)
        body = await request.json()
        seen.append(("run", request.match_info["machine"], body))
        return web.json_response({"session": "mesh.macbook.s1"})

    async def send_msg(request):
        await check_auth(request)
        body = await request.json()
        seen.append(("send", request.match_info["session"], body))
        return web.json_response({"queued": True})

    async def answer_req(request):
        await check_auth(request)
        body = await request.json()
        seen.append(("answer", request.match_info["session"], body))
        return web.json_response({"ok": True})

    async def stop_session(request):
        await check_auth(request)
        seen.append(("stop", request.match_info["session"]))
        return web.json_response({"stopped": True})

    async def post_restart(request):
        await check_auth(request)
        seen.append(("restart", request.match_info["machine"]))
        return web.json_response({"ok": True})

    async def post_update(request):
        await check_auth(request)
        body = await request.json()
        seen.append(("update", request.match_info["machine"], body))
        return web.json_response({"ok": True})

    async def get_job(request):
        await check_auth(request)
        return web.json_response(state["job"])

    async def bad_session(request):
        return web.json_response({"error": "no such chat"}, status=404)

    app = web.Application()
    app.router.add_get("/mesh/machines", get_machines)
    app.router.add_get("/mesh/machines/{machine}/sessions", list_threads)
    app.router.add_post("/mesh/machines/{machine}/sessions", start_session)
    app.router.add_post("/sessions/{session}/messages", send_msg)
    app.router.add_post("/sessions/{session}/answer", answer_req)
    app.router.add_post("/sessions/{session}/stop", stop_session)
    app.router.add_get("/sessions/mesh.macbook.missing", bad_session)
    app.router.add_post("/mesh/machines/{machine}/gateway/restart", post_restart)
    app.router.add_post("/mesh/machines/{machine}/update", post_update)
    app.router.add_get("/mesh/machines/{machine}/job", get_job)

    server = TestServer(app)
    await server.start_server()
    try:
        tools = _load_mesh_tools(str(server.make_url("")))

        # mesh_machines with peer, hub-only, and empty mesh.
        listed = await _invoke(tools, "mesh_machines")
        assert len(listed["machines"]) == 2 and "note" not in listed

        state["machines"] = [state["machines"][0]]
        hub_only = await _invoke(tools, "mesh_machines")
        assert "Only the hub" in hub_only["note"]

        state["machines"] = []
        empty = await _invoke(tools, "mesh_machines")
        assert "No machines" in empty["note"]

        state["machines"] = [
            {"name": "hub", "hub": True, "online": True, "hermes": {"commit": "abcdef1234567890", "line": "Hermes v1.0"}},
            {"name": "macbook", "hub": False, "online": True, "gateway": True},
        ]

        # mesh_run forwards normalized machine name and sender session id.
        ran = await _invoke(tools, "mesh_run", {"machine": " MacBook ", "prompt": "check disk", "title": "Disk", "cwd": "/tmp"}, session_id="parent-1")
        assert ran == {"session": "mesh.macbook.s1", "started": True}
        assert seen[-1] == ("run", "macbook", {"text": "check disk", "title": "Disk", "cwd": "/tmp", "from": "parent-1"})

        # mesh_threads clamps limit and reports overflow count.
        th = await _invoke(tools, "mesh_threads", {"machine": "macbook", "limit": 2})
        assert len(th["threads"]) == 2 and th["more"] == 3

        # mesh_send, mesh_answer (choice + answers), and mesh_stop.
        sent = await _invoke(tools, "mesh_send", {"session": "mesh.macbook.s1", "text": "keep going"}, session_id="parent-1")
        assert sent == {"session": "mesh.macbook.s1", "queued": True}
        assert seen[-1] == ("send", "mesh.macbook.s1", {"text": "keep going", "from": "parent-1"})

        await _invoke(tools, "mesh_answer", {"session": "mesh.macbook.s1", "request": "r1", "choice": "once"})
        assert seen[-1] == ("answer", "mesh.macbook.s1", {"request": "r1", "result": {"choice": "once"}})

        await _invoke(tools, "mesh_answer", {"session": "mesh.macbook.s1", "request": "r2", "answers": {"q1": "yes"}})
        assert seen[-1] == ("answer", "mesh.macbook.s1", {"request": "r2", "result": {"answers": {"q1": "yes"}}})

        stopped = await _invoke(tools, "mesh_stop", {"session": "mesh.macbook.s1"})
        assert stopped == {"stopped": True}

        # mesh_update compares 10-char commit prefix with hub.
        updated = await _invoke(tools, "mesh_update", {"machine": "macbook", "channel": "stable", "wait_seconds": 0})
        assert updated["matches_hub"] is True
        assert updated["update_exit"] == 0
        assert updated["hermes_before"] == "Hermes v0.9"
        assert seen[-1] == ("update", "macbook", {"channel": "stable"})

        # Restart with gateway still down adds recovery note.
        state["job"] = {"gateway": False, "job": {"kind": "restart", "status": "done", "log_tail": "restarting"}}
        restarted = await _invoke(tools, "mesh_restart_gateway", {"machine": "macbook", "wait_seconds": 0})
        assert restarted["gateway"] is False
        assert "isn't connected yet" in restarted["note"]

        # HTTP 404 JSON error surfaces cleanly as tool error.
        missing = await _invoke(tools, "mesh_read", {"session": "mesh.macbook.missing"})
        assert missing == {"error": "no such chat"}
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_mesh_tools_validation_errors_return_json_errors():
    tools = _load_mesh_tools("http://127.0.0.1:1")
    cases = [
        ("mesh_run", {"machine": "macbook", "prompt": "   "}),
        ("mesh_send", {"session": "local-session", "text": "hi"}),
        ("mesh_read", {"session": "not-a-mesh-id"}),
        ("mesh_stop", {"session": "not-a-mesh-id"}),
        ("mesh_threads", {"machine": ""}),
        ("mesh_restart_gateway", {"machine": ""}),
        ("mesh_update", {"machine": ""}),
        ("mesh_answer", {"session": "mesh.macbook.s1", "request": "r1"}),
    ]
    for name, args in cases:
        res = await _invoke(tools, name, args)
        assert "error" in res, (name, args, res)
