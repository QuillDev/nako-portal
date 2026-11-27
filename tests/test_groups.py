"""Chat groups: the agent makes and fills them with its tools, the app's sidebar reads them, and
they outlive a restart."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sqlite3
import time
from pathlib import Path

import pytest
from conftest import LOCAL_TOKEN
from portal.group_overview import GroupInspector
from portal.store import Store

pytestmark = pytest.mark.asyncio
ROOT = Path(__file__).resolve().parents[1]


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _tools(world):
    """The agent's group tools, pointed at the portal's loopback API the way the plugin wires them."""
    mesh = _load("mesh_tools_for_groups", "mesh_tools.py")
    mesh._api = lambda *_: (str(world.local.make_url("")).rstrip("/"), LOCAL_TOKEN)
    tools = _load("groups_tools_under_test", "groups_tools.py")
    tools.CALL = lambda method, path, body=None: mesh._call(method, path, body)

    async def call(name, args=None, session=None):
        return json.loads(await asyncio.to_thread(tools.TOOL_HANDLERS[name], args or {}, session_id=session))

    return call


async def _sidebar(world):
    rows = await (await world.http.get(world.url("/api/sessions"))).json()
    return {row["title"]: (row["group"] or {}).get("name") for row in rows}


async def test_the_agent_groups_chats_and_the_sidebar_shows_them_after_a_restart(world, tmp_path):
    await world.sign_up()
    here = world.hermes.add_session("20261103_090000_aaaaaa", "fix stock check")
    world.hermes.add_session("20261103_090100_bbbbbb", "picking PR review")
    world.hermes.add_session("20261103_090200_cccccc", "tax forms")
    tool = _tools(world)

    # The agent puts the chat it runs in, and another, into a new group.
    created = await tool("group_add", {"group": "Warehouse app", "create": True}, session=here)
    assert "error" not in created, created
    await tool("group_add", {"group": "warehouse APP", "sessions": ["20261103_090100_bbbbbb"]})
    assert await _sidebar(world) == {"fix stock check": "Warehouse app", "picking PR review": "Warehouse app", "tax forms": None}

    listed = await tool("group_list", session=here)
    assert listed["this_chat"] == here
    [group] = listed["groups"]
    assert (group["name"], group["color"]) == ("Warehouse app", "blue")
    assert sorted(c["title"] for c in group["chats"]) == ["fix stock check", "picking PR review"]

    # A second group takes the next free color; moving a chat there takes it out of the first.
    assert (await tool("group_create", {"name": "Billing"}))["color"] == "green"
    await tool("group_add", {"group": "Billing", "sessions": ["20261103_090100_bbbbbb"]})
    await tool("group_update", {"group": "Billing", "name": "Billing migration", "color": "teal"})
    rows = await (await world.http.get(world.url("/api/sessions"))).json()
    review = next(r for r in rows if r["title"] == "picking PR review")
    assert (review["group"]["name"], review["group"]["color"]) == ("Billing migration", "teal")
    assert (await _sidebar(world))["fix stock check"] == "Warehouse app"

    # Groups live in the portal's store: a fresh server on the same file sees the same ones.
    restarted = Store(world.store.path)
    assert [(g["name"], g["color"]) for g in restarted.groups()] == [("Warehouse app", "blue"), ("Billing migration", "teal")]
    assert {g["name"] for g in restarted.chat_groups().values()} == {"Warehouse app", "Billing migration"}

    # Taking a chat out, and deleting a group, leave the chats in the list ungrouped.
    await tool("group_remove", session=here)
    await tool("group_delete", {"group": "Billing migration"})
    assert await _sidebar(world) == {"fix stock check": None, "picking PR review": None, "tax forms": None}
    assert [g["name"] for g in (await tool("group_list"))["groups"]] == ["Warehouse app"]


async def test_bad_group_changes_are_refused_and_change_nothing(world):
    await world.sign_up()
    chat = world.hermes.add_session("20261103_100000_dddddd", "assembly labels")
    tool = _tools(world)
    await tool("group_create", {"name": "Home server", "color": "orange"})
    before = (world.store.groups(), world.store.chat_groups())

    for name, args, session in [
        ("group_create", {"name": "home SERVER"}, None),
        ("group_create", {"name": "   "}, None),
        ("group_create", {"name": "Media", "color": "pink"}, None),
        ("group_update", {"group": "Nope", "name": "x"}, None),
        ("group_update", {"group": "Home server", "color": "magenta"}, None),
        ("group_add", {"group": "Nope"}, chat),
        ("group_add", {"group": "Home server", "sessions": ["20261103_100000_notreal"]}, None),
        ("group_delete", {"group": "Nope"}, None),
    ]:
        result = await tool(name, args, session=session)
        assert "error" in result, (name, args, result)
    assert (world.store.groups(), world.store.chat_groups()) == before


async def test_group_routes_need_a_signed_in_app_or_the_loopback_token(world):
    world.hermes.add_session("20261103_110000_eeeeee", "assembly labels")
    for path in ("/api/groups", "/api/sessions/20261103_110000_eeeeee/group"):
        refused = await world.post(path, {"name": "x", "group": "x"})
        assert refused.status == 401
    refused = await world.http.post(str(world.local.make_url("/groups")), json={"name": "x"}, headers={"Authorization": "Bearer wrong"})
    assert refused.status == 401
    assert world.store.groups() == []

    # Signed in, the app makes a group and files a chat in it.
    await world.sign_up()
    made = await (await world.post("/api/groups", {"name": "Labels"})).json()
    filed = await world.post("/api/sessions/20261103_110000_eeeeee/group", {"group": made["id"]})
    assert filed.status == 200, await filed.text()
    assert (await _sidebar(world)) == {"assembly labels": "Labels"}


async def test_group_goal_overview_sorting_and_thread_metadata(world):
    await world.sign_up()
    s_idle = world.hermes.add_session("20261104_090000_idle01", "idle thread")
    s_work = world.hermes.add_session("20261104_090100_work01", "working thread")
    s_wait = world.hermes.add_session("20261104_090200_wait01", "waiting on checks")
    s_need = world.hermes.add_session("20261104_090300_need01", "blocked on input")
    s_done = world.hermes.add_session("20261104_090400_done01", "finished cleanup")
    tool = _tools(world)

    made = await tool("group_create", {"name": "Nightly Refactor", "goal": "Unify web apps onto Bun and oxlint."})
    assert made["goal"] == "Unify web apps onto Bun and oxlint."
    await tool("group_add", {"group": made["id"], "sessions": [s_idle, s_work, s_wait, s_need, s_done]})

    await tool("group_thread_update", {"session": s_work, "task_state": "working", "summary": "Running bun check"})
    await tool(
        "group_thread_update",
        {
            "session": s_wait,
            "task_state": "waiting",
            "summary": "Waiting on GitHub CI",
            "links": [{"label": "portal#214", "url": "https://github.com/QuillDev/portal/pull/214", "kind": "pr"}],
        },
    )
    await tool("group_thread_update", {"session": s_need, "task_state": "needs_you", "summary": "Need ok on schema"})
    await tool("group_thread_update", {"session": s_done, "task_state": "done", "summary": "Merged and verified"})

    overview = await tool("group_overview", {"group": "nightly refactor"})
    assert overview["group"]["goal"] == "Unify web apps onto Bun and oxlint."
    assert [t["id"] for t in overview["threads"]] == [s_need, s_work, s_wait, s_idle, s_done]
    assert overview["counts"]["needs_you"] == 1
    assert overview["counts"]["working"] == 1
    assert overview["counts"]["waiting"] == 1
    assert overview["counts"]["idle"] == 1
    assert overview["counts"]["done"] == 1
    wait_row = next(t for t in overview["threads"] if t["id"] == s_wait)
    assert wait_row["summary"] == "Waiting on GitHub CI"
    assert wait_row["links"] == [{"label": "portal#214", "url": "https://github.com/QuillDev/portal/pull/214", "kind": "pr"}]

    # Updating and clearing the goal persists across store reloads.
    await tool("group_update", {"group": made["id"], "goal": "Ship green CI across repos."})
    assert Store(world.store.path).group(made["id"])["goal"] == "Ship green CI across repos."
    await tool("group_update", {"group": made["id"], "goal": ""})
    assert Store(world.store.path).group(made["id"])["goal"] == ""


async def test_group_spawn_broadcast_and_archive_idle_behaviors(world):
    await world.sign_up()
    s_idle = world.hermes.add_session("20261105_090000_idle01", "old idle chat")
    s_done = world.hermes.add_session("20261105_090100_done01", "finished task")
    s_pinned = world.hermes.add_session("20261105_090200_pin001", "pinned idle chat")
    s_need = world.hermes.add_session("20261105_090300_need01", "needs decision")
    s_work = world.hermes.add_session("20261105_090400_work01", "active build")
    world.hermes.set_pinned(s_pinned, True)
    tool = _tools(world)

    group = await tool("group_create", {"name": "Release Prep", "goal": "Keep changes small and verified."})
    await tool("group_add", {"group": group["id"], "sessions": [s_idle, s_done, s_pinned, s_need, s_work]})
    await tool("group_thread_update", {"session": s_done, "task_state": "done"})
    await tool("group_thread_update", {"session": s_need, "task_state": "needs_you"})
    await tool("group_thread_update", {"session": s_work, "task_state": "working"})

    # Dry-run spawn previews the composed prompt without creating a thread.
    before_count = len(world.hermes.sessions)
    dry_spawn = await (
        await world.post(
            f"/api/groups/{group['id']}/spawn",
            {"text": "Audit bundle size", "title": "bundle audit", "inherit_goal": True, "dry_run": True},
        )
    ).json()
    assert dry_spawn["dry_run"] is True
    assert "Keep changes small and verified." in dry_spawn["composed_text"]
    assert "Audit bundle size" in dry_spawn["composed_text"]
    assert len(world.hermes.sessions) == before_count

    # Real spawn creates a thread inside the group with the goal inherited.
    spawned = await (
        await world.post(
            f"/api/groups/{group['id']}/spawn",
            {"text": "Audit bundle size", "title": "bundle audit", "inherit_goal": True},
        )
    ).json()
    assert spawned["dry_run"] is False
    new_sid = spawned["session"]
    assert (await _sidebar(world))["bundle audit"] == "Release Prep"
    first_prompt = world.hermes.sessions[new_sid]["rows"][0]["text"]
    assert "Keep changes small and verified." in first_prompt
    assert "Audit bundle size" in first_prompt

    # Broadcast dry-run reports exact targets and sends nothing; real broadcast sends to matching scope.
    dry_bc = await (
        await world.post(
            f"/api/groups/{group['id']}/broadcast",
            {"text": "Status check?", "scope": "needs_you", "dry_run": True},
        )
    ).json()
    assert dry_bc["dry_run"] is True
    assert [t["id"] for t in dry_bc["targets"]] == [s_need]
    assert dry_bc["sent"] == []
    assert world.hermes.sessions[s_need]["rows"] == []

    real_bc = await (
        await world.post(
            f"/api/groups/{group['id']}/broadcast",
            {"text": "Status check?", "scope": "needs_you", "dry_run": False},
        )
    ).json()
    assert real_bc["sent"] == [s_need]
    assert any("Status check?" in r["text"] for r in world.hermes.sessions[s_need]["rows"])

    # Archive-idle dry-run selects only unpinned idle/done threads and leaves them unarchived.
    # Mark the newly spawned thread as working so we verify active threads are skipped.
    await tool("group_thread_update", {"session": new_sid, "task_state": "working"})
    dry_arch = await (await world.post(f"/api/groups/{group['id']}/archive-idle", {"dry_run": True})).json()
    assert {t["id"] for t in dry_arch["targets"]} == {s_idle, s_done}
    assert not world.hermes.sessions[s_idle]["archived"]
    assert not world.hermes.sessions[s_done]["archived"]

    # Real archive-idle archives idle/done while keeping pinned, working, and needs_you threads active.
    real_arch = await (await world.post(f"/api/groups/{group['id']}/archive-idle", {"dry_run": False})).json()
    assert set(real_arch["archived"]) == {s_idle, s_done}
    assert world.hermes.sessions[s_idle]["archived"] is True
    assert world.hermes.sessions[s_done]["archived"] is True
    assert world.hermes.sessions[s_pinned]["archived"] is False
    assert world.hermes.sessions[s_need]["archived"] is False
    assert world.hermes.sessions[s_work]["archived"] is False


async def test_inspector_extracts_status_snippets_and_artifacts_read_only(tmp_path):
    state_db = tmp_path / "state.db"
    now = time.time()
    con = sqlite3.connect(state_db)
    con.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT, chat_id TEXT, title TEXT, archived INTEGER DEFAULT 0,
            auto_archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
            message_count INTEGER DEFAULT 0, started_at REAL, last_activity_at REAL,
            last_activity_description TEXT, git_branch TEXT, cwd TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
            tool_calls TEXT, tool_call_id TEXT, timestamp REAL, active INTEGER DEFAULT 1, observed INTEGER DEFAULT 0
        );
        CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, acquired_at REAL, expires_at REAL);
        CREATE TABLE session_admissions (target_session_id TEXT, status TEXT);
        """
    )
    con.execute(
        "INSERT INTO sessions VALUES (?, 'portal', 'chat-a', 'PR fix', 0, 0, 0, 0, 2, ?, ?, 'Running tests', 'fix/groups', NULL)",
        ("s-ask", now - 300, now - 60),
    )
    con.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ?)",
        (
            "s-ask",
            "Opened https://github.com/example/portal/pull/99 and preview at https://demo.preview.example.test — ready to merge?\n<signoff>all green</signoff>",
            now - 60,
        ),
    )
    con.execute(
        "INSERT INTO sessions VALUES (?, 'portal', 'chat-b', 'PR 99: read-only review', 1, 0, 0, 0, 2, ?, ?, NULL, NULL, NULL)",
        ("s-rev", now - 600, now - 500),
    )
    con.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
        ("s-rev", '[From another thread, not typed by the user: "PR fix" (session s-ask)]\nReview this PR.', now - 550),
    )
    con.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ?)",
        ("s-rev", "Looks clean, no blockers found.", now - 500),
    )
    con.commit()
    con.close()

    inspector = GroupInspector(tmp_path, preview_hosts=("preview.example.test",), clock=lambda: now)
    inspected = inspector.inspect_chats({"chat-a", "chat-b"})
    ask = inspected["s-ask"]
    assert ask["status"] == "needs_you"
    assert ask["reason"] == "Asked you"
    assert ask["branch"] == "fix/groups"
    assert ask["prs"] == [{"key": "example/portal#99", "url": "https://github.com/example/portal/pull/99"}]
    assert ask["previews"] == [{"label": "demo.preview.example.test", "url": "https://demo.preview.example.test"}]
    assert "signoff" not in ask["summary"].lower()
    assert "ready to merge" in ask["summary"].lower()

    rev = inspected["s-rev"]
    assert rev["status"] == "done"
    assert rev["background"] is True
    assert rev["parent"] == {"id": "s-ask", "title": "PR fix"}


async def test_inspector_tolerates_missing_optional_state_tables(tmp_path):
    state_db = tmp_path / "state.db"
    now = time.time()
    con = sqlite3.connect(state_db)
    con.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT, chat_id TEXT, title TEXT, archived INTEGER DEFAULT 0,
            auto_archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
            message_count INTEGER DEFAULT 0, started_at REAL, last_activity_at REAL,
            last_activity_description TEXT, git_branch TEXT, cwd TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
            tool_calls TEXT, tool_call_id TEXT, timestamp REAL, active INTEGER DEFAULT 1, observed INTEGER DEFAULT 0
        );
        """
    )
    con.execute(
        "INSERT INTO sessions VALUES (?, 'portal', 'chat-min', 'minimal db chat', 0, 0, 0, 0, 1, ?, ?, NULL, NULL, NULL)",
        ("s-min", now - 120, now - 60),
    )
    con.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'Ready.', ?)",
        ("s-min", now - 60),
    )
    con.commit()
    con.close()

    inspector = GroupInspector(tmp_path, clock=lambda: now)
    inspected = inspector.inspect_chats({"chat-min"})
    assert inspected["s-min"]["status"] == "idle"
    assert inspected["s-min"]["summary"] == "Ready."


async def test_group_lead_session_lifecycle_and_local_api(world):
    await world.sign_up()
    lead = world.hermes.add_session("20261106_090000_lead01", "orchestrate POCs")
    worker_a = world.hermes.add_session("20261106_090100_work01", "worker: PRs")
    worker_b = world.hermes.add_session("20261106_090200_work02", "worker: context")
    tool = _tools(world)

    # Creating a group with lead_session automatically includes the lead chat and persists across restarts.
    created = await tool("group_create", {"name": "Synthesis", "lead_session": lead})
    assert created["lead_session"] == lead
    await tool("group_add", {"group": created["id"], "sessions": [worker_a, worker_b]})
    await tool("group_thread_update", {"session": worker_a, "task_state": "working", "summary": "Running checks"})
    await tool("group_thread_update", {"session": worker_b, "task_state": "idle", "summary": "Done drafting"})

    restarted = Store(world.store.path)
    assert restarted.group(created["id"])["lead_session"] == lead

    # GET /local/groups/<id> separates lead from child workers and computes child_counts.
    state = await tool("group_overview", {"group": created["id"]})
    assert state["lead_session"] == lead
    assert state["lead"]["id"] == lead
    assert state["lead"]["is_lead"] is True
    assert [c["id"] for c in state["children"]] == [worker_a, worker_b]
    assert all(not c["is_lead"] for c in state["children"])
    assert state["child_counts"]["total"] == 2
    assert state["child_counts"]["working"] == 1
    assert state["child_counts"]["idle"] == 1

    # Archive-idle skips the lead chat even when it is idle, archiving only idle workers.
    archived = await (await world.post(f"/api/groups/{created['id']}/archive-idle", {"dry_run": False})).json()
    assert archived["archived"] == [worker_b]
    assert world.hermes.sessions[lead]["archived"] is False
    assert world.hermes.sessions[worker_a]["archived"] is False
    assert world.hermes.sessions[worker_b]["archived"] is True

    # Promoting another chat updates lead_session; removing the lead from the group clears lead_session.
    promoted = await tool("group_update", {"group": created["id"], "lead_session": worker_a})
    assert promoted["lead_session"] == worker_a
    await tool("group_remove", {"sessions": [worker_a]})
    after_remove = await tool("group_overview", {"group": created["id"]})
    assert after_remove["lead_session"] is None
    assert after_remove["lead"] is None


