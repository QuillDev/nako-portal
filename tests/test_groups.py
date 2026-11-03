"""Chat groups: the agent makes and fills them with its tools, the app's sidebar reads them, and
they outlive a restart."""

from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

from conftest import LOCAL_TOKEN
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
