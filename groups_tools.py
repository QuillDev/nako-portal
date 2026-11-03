"""The agent's tools for chat groups: named, colored sets of portal chats the sidebar shows together.

Groups live with the portal server (its store), so they survive restarts and every device sees
the same ones. These tools reach it over the loopback API, like the mesh tools.
"""

from __future__ import annotations

import json
import os
import urllib.parse

TOOLSET = "groups"
COLORS = ["blue", "green", "yellow", "orange", "red", "teal", "purple", "grey"]
# Set by the plugin: the loopback API call (method, path, body) -> parsed JSON, raising RuntimeError.
def CALL(method, path, body=None):
    raise RuntimeError("the portal plugin hasn't loaded the group tools")


def _q(value):
    return urllib.parse.quote(str(value), safe="")


def _sessions(args, current):
    sessions = args.get("sessions") or ([current] if current else [])
    if isinstance(sessions, str):
        sessions = [sessions]
    if not sessions:
        raise RuntimeError("say which chats (session ids)")
    return [str(s) for s in sessions]


def group_list(args, current):
    groups = CALL("GET", "/groups")
    return {"groups": groups, "this_chat": current}


def group_create(args, current):
    return CALL("POST", "/groups", {"name": args.get("name"), "color": args.get("color")})


def group_update(args, current):
    return CALL("POST", f"/groups/{_q(args.get('group'))}", {"name": args.get("name"), "color": args.get("color")})


def group_delete(args, current):
    return {"deleted": CALL("POST", f"/groups/{_q(args.get('group'))}/remove", {}), "note": "its chats are kept, just ungrouped"}


def group_add(args, current):
    group = args.get("group")
    if not group:
        raise RuntimeError("say which group")
    if args.get("create"):
        known = CALL("GET", "/groups")
        if str(group).lower() not in {g["name"].lower() for g in known} | {g["id"] for g in known}:
            CALL("POST", "/groups", {"name": group, "color": args.get("color")})
    return {"added": [CALL("POST", f"/sessions/{_q(s)}/group", {"group": group}) for s in _sessions(args, current)]}


def group_remove(args, current):
    return {"removed": [CALL("POST", f"/sessions/{_q(s)}/group", {"group": None}) for s in _sessions(args, current)]}


GROUP = {"type": "string", "description": "The group's id or name (name is matched ignoring case)."}
COLOR = {"type": "string", "enum": COLORS, "description": "Default for a new group: the least used color."}
SESSIONS = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Portal chat session ids. Leave out to mean this chat.",
}

TOOLS = [
    (
        "group_list",
        group_list,
        "List the chat groups in the user's portal sidebar, each with its id, name, color and chats "
        "(session id and title). Also returns this chat's own session id. Check here before creating a group, "
        "so related work lands in the group that already exists.",
        {},
        [],
    ),
    (
        "group_create",
        group_create,
        "Create a chat group in the portal sidebar. Names are unique ignoring case.",
        {"name": {"type": "string"}, "color": COLOR},
        ["name"],
    ),
    (
        "group_update",
        group_update,
        "Rename a chat group or change its color.",
        {"group": GROUP, "name": {"type": "string"}, "color": {**COLOR, "description": "The new color."}},
        ["group"],
    ),
    (
        "group_delete",
        group_delete,
        "Delete a chat group. Its chats stay; they just show ungrouped again.",
        {"group": GROUP},
        ["group"],
    ),
    (
        "group_add",
        group_add,
        "Put portal chats in a group, moving each out of any group it was in (a chat is in one group at most). "
        "Use it to keep related chats together, e.g. every chat about one PR or project.",
        {
            "group": GROUP,
            "sessions": SESSIONS,
            "create": {"type": "boolean", "description": "Create the group first if no group has this name."},
            "color": {**COLOR, "description": "With create: the new group's color."},
        },
        ["group"],
    ),
    (
        "group_remove",
        group_remove,
        "Take portal chats out of their group.",
        {"sessions": SESSIONS},
        [],
    ),
]


def _wrap(fn):
    def handler(args, **kwargs):
        try:
            return json.dumps(fn(args or {}, kwargs.get("session_id") or os.environ.get("HERMES_SESSION_ID") or None))
        except Exception as error:
            return json.dumps({"error": str(error)})

    return handler


TOOL_HANDLERS = {name: _wrap(fn) for name, fn, *_ in TOOLS}


def register(ctx):
    for name, fn, description, properties, required in TOOLS:
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema={
                "name": name,
                "description": description,
                "parameters": {"type": "object", "properties": properties, "required": required},
            },
            handler=TOOL_HANDLERS[name],
            description=description,
            emoji="🗂️",
        )
