"""Agent tools for linking GitHub PRs to Portal chats.

Links live in Portal's store (`session_prs`) and are reached over the loopback API,
matching `groups_tools.py`. Linking a PR lets the chat header show live CI, review,
and stack status without manual dashboard triage.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse

TOOLSET = "prs"
PR_URL_RE = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
PR_KEY_RE = re.compile(r"^([\w.-]+/[\w.-]+)#(\d+)$")


# Set by the plugin: loopback API call (method, path, body) -> parsed JSON, raising RuntimeError.
def CALL(method, path, body=None):
    raise RuntimeError("the portal plugin hasn't loaded the PR tools")


def _q(value):
    return urllib.parse.quote(str(value), safe="")


def _session(args, current):
    sid = args.get("session") or current
    if not sid:
        raise RuntimeError("say which chat (session id)")
    return str(sid)


def _split_pr(value):
    text = str(value or "").strip()
    m = PR_URL_RE.search(text) or PR_KEY_RE.match(text)
    if not m:
        raise RuntimeError("PR must be 'owner/repo#123' or a GitHub PR URL")
    owner, repo = m.group(1).split("/", 1)
    return owner, repo, int(m.group(2))


def pr_attach(args, current):
    sid = _session(args, current)
    body = {
        k: args[k]
        for k in ("pr", "url", "repo", "number", "title", "branch", "base", "state")
        if args.get(k) is not None
    }
    return CALL("POST", f"/sessions/{_q(sid)}/prs", body)


def pr_detach(args, current):
    sid = _session(args, current)
    owner, repo, number = _split_pr(args.get("pr") or args.get("url"))
    return CALL("DELETE", f"/sessions/{_q(sid)}/prs/{_q(owner)}/{_q(repo)}/{number}")


def pr_list(args, current):
    sid = _session(args, current)
    return {"session": sid, "prs": CALL("GET", f"/sessions/{_q(sid)}/prs")}


PR_REF = {"type": "string", "description": "GitHub PR as 'owner/repo#123' or full PR URL."}
SESSION = {"type": "string", "description": "Portal chat session id. Leave out to mean this chat."}

TOOLS = [
    (
        "pr_attach",
        pr_attach,
        (
            "Attach a GitHub pull request to a Portal chat so its header shows live CI, review, and stack status. "
            "Call this right after opening or adopting a PR in a chat."
        ),
        {
            "pr": PR_REF,
            "session": SESSION,
            "title": {"type": "string", "description": "Optional PR title."},
            "branch": {"type": "string", "description": "Optional head branch name."},
            "base": {"type": "string", "description": "Optional base branch name."},
            "state": {"type": "string", "enum": ["open", "merged", "closed"], "description": "Optional PR state."},
        },
        ["pr"],
    ),
    (
        "pr_detach",
        pr_detach,
        "Detach a GitHub pull request from a Portal chat.",
        {"pr": PR_REF, "session": SESSION},
        ["pr"],
    ),
    (
        "pr_list",
        pr_list,
        "List GitHub pull requests explicitly attached to a Portal chat.",
        {"session": SESSION},
        [],
    ),
]


def _wrap(fn):
    def handler(args, **kwargs):
        try:
            return json.dumps(fn(args or {}, kwargs.get("session_id") or os.environ.get("HERMES_SESSION_ID") or None))
        except Exception as error:  # noqa: BLE001 - Tool failures are returned to the agent as JSON.
            return json.dumps({"error": str(error)})

    return handler


TOOL_HANDLERS = {name: _wrap(fn) for name, fn, *_ in TOOLS}


def register(ctx):
    for name, _fn, description, properties, required in TOOLS:
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
            emoji="🔀",
        )
