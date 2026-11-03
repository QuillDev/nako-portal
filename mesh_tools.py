"""Tools that let this machine's agent work on the other machines in its mesh.

They talk to the portal server's loopback API (the same one `nako-spawn` uses), which holds every
machine's connection. A task on a machine is a normal portal chat there, shown in this portal's
sidebar under the machine's name, so the person can watch it, steer it or answer its questions.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TOOLSET = "mesh"
POLL = 3
MAX_WAIT = 600
# Tool calls mesh_read shows, and how much of a restart or update's log comes back.
TOOL_CALLS = 10
LOG_CHARS = 1500

ONLY_WHEN_NEEDED = (
    "Only use this when the work has to happen on that machine: its files, apps, screen, hardware "
    "or local network. Do everything else here, and don't call a machine just to check on it. "
    "How the mesh works: skill_view('nako-portal:mesh')."
)


def _api(missing="the portal server isn't running here, so other machines can't be reached"):
    from hermes_constants import get_hermes_home

    data = get_hermes_home() / "nako-portal"
    try:
        base = (data / "local-url").read_text().strip()
        token = (data / "local-token").read_text().strip()
    except FileNotFoundError:
        raise RuntimeError(missing)
    return base, token


def _call(method, path, body=None, timeout=60, missing=None):
    base, token = _api(*([missing] if missing else []))
    request = urllib.request.Request(
        f"{base}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read()).get("error")
        except Exception:
            message = None
        raise RuntimeError(message or f"HTTP {error.code}")
    except urllib.error.URLError as error:
        raise RuntimeError(f"the portal server didn't answer ({error.reason})")


def _wrap(fn):
    def handler(args, **kwargs):
        try:
            return json.dumps(fn(args or {}, kwargs.get("session_id") or os.environ.get("HERMES_SESSION_ID") or None))
        except Exception as error:
            return json.dumps({"error": str(error)})

    return handler


def _quoted(session):
    return urllib.parse.quote(str(session), safe="")


def _when(stamp):
    """A unix time as UTC and how long ago, for an agent to read."""
    if not isinstance(stamp, (int, float)):
        return None
    ago = max(0, int(time.time() - stamp))
    spoken = f"{ago}s" if ago < 120 else f"{ago // 60}m" if ago < 7200 else f"{ago // 3600}h{ago % 3600 // 60:02d}m"
    return f"{time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(stamp))} UTC ({spoken} ago)"


def _machine_of(session):
    return str(session).split(".")[1] if str(session).count(".") >= 2 else None


def _read(session, wait):
    """Where a task stands; with `wait`, keep checking until it stops running or asks something."""
    deadline = time.monotonic() + max(0, min(int(wait or 0), MAX_WAIT))
    while True:
        state = _call("GET", f"/sessions/{_quoted(session)}?last=4&tools={TOOL_CALLS}")
        if not state.get("running") or state.get("requests") or time.monotonic() >= deadline:
            break
        time.sleep(POLL)
    reply = next((m["text"] for m in reversed(state.get("messages") or []) if m["role"] == "assistant"), None)
    out = {
        "session": session,
        "title": state.get("title"),
        "running": state.get("running"),
        "status": state.get("status"),
        # Open approvals/questions: answer with mesh_answer, or leave them for the person.
        "waiting_on": state.get("requests") or None,
        "latest_reply": reply,
        "last_active": _when(state.get("last_active")),
        # Its latest tool calls (since the last few messages), each with the start of its result.
        "tool_calls": state.get("tools") or [],
    }
    if state.get("gateway") is False:
        machine = _machine_of(session) or "that machine"
        out["gateway"] = False
        out["note"] = (
            f"{machine}'s Hermes gateway is down, so nothing is running there now. This is the chat as saved; "
            f"it last moved {out['last_active'] or 'at an unknown time'}. mesh_restart_gateway brings the gateway back."
        )
    return out


def machines(args, _session):
    rows = _call("GET", "/mesh/machines")
    others = [row for row in rows if not row.get("hub")]
    if not others and not any(row.get("hub") for row in rows):
        return {"machines": rows, "note": "No machines are in the mesh yet. The user can add one on the portal's Mesh page."}
    if not others:
        return {"machines": rows, "note": "Only the hub so far: no other machines have been added yet. The user can add one on the portal's Mesh page."}
    return {"machines": rows}


def _job(machine):
    return _call("GET", f"/mesh/machines/{_quoted(machine)}/job")


def _follow(machine, wait):
    """Wait for a machine's restart or update to finish and its gateway to be back, then sum it up.
    The machine's link may drop meanwhile (its portal server replaced by an update); that's waited out."""
    deadline = time.monotonic() + max(0, min(int(wait or 0), MAX_WAIT))
    state, lost = None, None
    while True:
        try:
            state, lost = _job(machine), None
        except RuntimeError as error:
            lost = str(error)
        job = (state or {}).get("job") or {}
        if not lost and job.get("status") not in ("starting", "running") and state.get("gateway"):
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(POLL)
    job = (state or {}).get("job") or {}
    now = (state or {}).get("hermes") or job.get("new")
    out = {
        "machine": machine,
        "job": job.get("kind"),
        "status": job.get("status"),
        "step": job.get("step"),
        "gateway": bool((state or {}).get("gateway")),
        "hermes_before": (job.get("old") or {}).get("line"),
        "hermes_now": (now or {}).get("line"),
        "log_tail": (job.get("log_tail") or "")[-LOG_CHARS:],
    }
    if job.get("kind") == "update":
        out["update_exit"] = job.get("update_exit")
        try:
            hub = next((row for row in _call("GET", "/mesh/machines") if row.get("hub")), None)
        except RuntimeError:
            hub = None
        if hub and (hub.get("hermes") or {}).get("commit") and now:
            out["hub_hermes"] = hub["hermes"].get("line")
            out["matches_hub"] = (now.get("commit") or "")[:10] == hub["hermes"]["commit"][:10]
    if lost:
        out["note"] = f"Couldn't reach {machine} at the end ({lost}). Check again with mesh_machines in a minute."
    elif job.get("status") in ("starting", "running"):
        out["note"] = "Still going. Call this again with wait_seconds, or check mesh_machines later."
    elif not out["gateway"]:
        out["note"] = f"The job finished but {machine}'s gateway isn't connected yet. Its portal server starts it again on its own after a while; the user can also run `hermes gateway start` there."
    return out


def restart_gateway(args, _session):
    machine = str(args.get("machine") or "").strip().lower()
    if not machine:
        raise ValueError("give a machine")
    _call("POST", f"/mesh/machines/{_quoted(machine)}/gateway/restart", {})
    return _follow(machine, args.get("wait_seconds", 120))


def update(args, _session):
    machine = str(args.get("machine") or "").strip().lower()
    if not machine:
        raise ValueError("give a machine")
    body = {"channel": str(args["channel"])} if args.get("channel") else {}
    _call("POST", f"/mesh/machines/{_quoted(machine)}/update", body)
    return _follow(machine, args.get("wait_seconds", MAX_WAIT))


def run(args, session):
    machine = str(args.get("machine") or "").strip().lower()
    prompt = str(args.get("prompt") or "").strip()
    if not machine or not prompt:
        raise ValueError("give a machine and a prompt")
    body = {"text": prompt, "title": args.get("title") or None, "cwd": args.get("cwd") or None, "from": session}
    started = _call("POST", f"/mesh/machines/{_quoted(machine)}/sessions", body)
    task = started.get("session")
    if not task:
        raise RuntimeError("the machine didn't start a chat")
    if args.get("wait_seconds"):
        return _read(task, args["wait_seconds"])
    return {"session": task, "started": True}


def send(args, session):
    task = str(args.get("session") or "")
    text = str(args.get("text") or "").strip()
    if not task.startswith("mesh.") or not text:
        raise ValueError("give a mesh session id (mesh.<machine>.<id>) and the text")
    sent = _call("POST", f"/sessions/{_quoted(task)}/messages", {"text": text, "from": session})
    if args.get("wait_seconds"):
        time.sleep(POLL)
        return _read(task, args["wait_seconds"])
    return {"session": task, **sent}


def read(args, _session):
    task = str(args.get("session") or "")
    if not task.startswith("mesh."):
        raise ValueError("give a mesh session id (mesh.<machine>.<id>)")
    return _read(task, args.get("wait_seconds") or 0)


def threads(args, _session):
    machine = str(args.get("machine") or "").strip().lower()
    if not machine:
        raise ValueError("give a machine")
    rows = _call("GET", f"/mesh/machines/{_quoted(machine)}/sessions")
    limit = max(1, min(int(args.get("limit") or 20), 100))
    return {"machine": machine, "threads": rows[:limit], "more": max(0, len(rows) - limit)}


def answer(args, _session):
    task = str(args.get("session") or "")
    request = str(args.get("request") or "")
    if not task.startswith("mesh.") or not request:
        raise ValueError("give the mesh session id and the request id from mesh_read's waiting_on")
    if args.get("answers") is not None:
        result = {"answers": {str(k): v for k, v in dict(args["answers"]).items()}}
    elif args.get("choice"):
        result = {"choice": str(args["choice"])}
    else:
        raise ValueError("give a choice (approvals) or answers (questions)")
    return _call("POST", f"/sessions/{_quoted(task)}/answer", {"request": request, "result": result})


def stop(args, _session):
    task = str(args.get("session") or "")
    if not task.startswith("mesh."):
        raise ValueError("give a mesh session id (mesh.<machine>.<id>)")
    return _call("POST", f"/sessions/{_quoted(task)}/stop", {})


WAIT = {
    "type": "integer",
    "description": f"Seconds to wait for the reply before returning (0 returns at once; max {MAX_WAIT}). Returns early if the task needs the person.",
}

TOOLS = [
    (
        "mesh_machines",
        machines,
        "List the user's other machines running Hermes (laptops, desktops, the hub), whether each is online now, "
        "whether its Hermes gateway is up, its OS, its Hermes version and commit, and how many tasks it is running. " + ONLY_WHEN_NEEDED,
        {},
        [],
    ),
    (
        "mesh_run",
        run,
        "Start a task on one of the user's other machines. That machine's own agent does it with its local tools "
        "(terminal, files, apps, computer use) in a new chat the user can watch in the portal. Write the prompt as a "
        "self-contained brief. Returns the task's session id (mesh.<machine>.<id>); follow it with mesh_read. "
        "A message that opens with a from-thread line naming a mesh.<machine>.<id> session came from that machine's thread; "
        "answer it with mesh_send to that id when it asks for something back. " + ONLY_WHEN_NEEDED,
        {
            "machine": {"type": "string", "description": "Machine name from mesh_machines, e.g. macbook."},
            "prompt": {"type": "string", "description": "What that machine's agent should do, with all the context it needs."},
            "title": {"type": "string", "description": "Short chat title."},
            "cwd": {"type": "string", "description": "Working directory on that machine (its own path)."},
            "wait_seconds": WAIT,
        },
        ["machine", "prompt"],
    ),
    (
        "mesh_send",
        send,
        "Send a follow-up or steer to a task running on another machine (queues or steers if it is busy). "
        "From a node to a hub chat, include MEDIA:<absolute local path> tags to upload files and deliver them "
        "into that chat (up to 32 files totaling 25 MiB; quote paths with spaces).",
        {"session": {"type": "string"}, "text": {"type": "string"}, "wait_seconds": WAIT},
        ["session", "text"],
    ),
    (
        "mesh_read",
        read,
        "Read where a task on another machine stands: running or done, any question it is waiting on, its latest reply, "
        "and its latest tool calls with the start of each result. Works while that machine's gateway is down: it then "
        "says so and when the chat last moved.",
        {"session": {"type": "string"}, "wait_seconds": WAIT},
        ["session"],
    ),
    ("mesh_stop", stop, "Stop the running turn of a task on another machine.", {"session": {"type": "string"}}, ["session"]),
    (
        "mesh_threads",
        threads,
        "List the chats on another machine (or the hub), newest first, with their mesh session ids and status, "
        "so you can pick one up with mesh_read or mesh_send. " + ONLY_WHEN_NEEDED,
        {"machine": {"type": "string"}, "limit": {"type": "integer", "description": "How many (default 20)."}},
        ["machine"],
    ),
    (
        "mesh_restart_gateway",
        restart_gateway,
        "Restart the Hermes gateway on another machine (its portal server does it, so this works when the gateway "
        "is down or stuck). Waits until it's back and returns its Hermes version and the restart log. Use it when "
        "mesh_machines shows the machine online but its gateway down.",
        {"machine": {"type": "string"}, "wait_seconds": {**WAIT, "description": f"Seconds to wait for the gateway to come back (default 120, max {MAX_WAIT})."}},
        ["machine"],
    ),
    (
        "mesh_update",
        update,
        "Update Hermes on another machine: its portal server runs `hermes update --yes` in a process of its own, "
        "then restarts the gateway, so the machine comes back even though the gateway stops on the way. Returns "
        "the version before and after (and whether it now matches the hub's) and the end of the update log. "
        "Never run `hermes update` inside a chat on that machine instead.",
        {
            "machine": {"type": "string"},
            "channel": {"type": "string", "description": "Update channel for this run (stable, main, ...). Default: the machine's own."},
            "wait_seconds": {**WAIT, "description": f"Seconds to wait for the update and restart (default and max {MAX_WAIT})."},
        },
        ["machine"],
    ),
    (
        "mesh_answer",
        answer,
        "Answer an approval or question a chat on another machine is waiting on (from mesh_read's waiting_on). "
        "Approvals take a choice from the request's choices; questions take answers keyed by question id. "
        "Only answer what you're sure the user would; otherwise leave it for them in the portal.",
        {
            "session": {"type": "string"},
            "request": {"type": "string", "description": "The request id from waiting_on."},
            "choice": {"type": "string", "description": "For an approval: one of its choices, e.g. once or deny."},
            "answers": {"type": "object", "description": "For a question: {question id: answer}."},
        },
        ["session", "request"],
    ),
]


# Each tool's handler as Hermes calls it (JSON in, JSON out), by name.
TOOL_HANDLERS = {name: _wrap(fn) for name, fn, *_ in TOOLS}


def register(ctx):
    # No availability check: a chat's tools are fixed when it starts, and a machine can join the
    # mesh while it runs. With no machines yet, mesh_machines says so.
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
            emoji="🖥️",
        )


# `hermes mesh ...`


def _setup_cli(parser):
    sub = parser.add_subparsers(dest="mesh_action", required=True)
    add = sub.add_parser("add", help="On the hub: let a machine join and print its token")
    add.add_argument("name")
    remove = sub.add_parser("remove", help="On the hub: revoke a machine's token")
    remove.add_argument("name")
    sub.add_parser("list", help="On the hub: the machines and whether they're online")
    join = sub.add_parser("join", help="On a machine: join a hub's mesh")
    join.add_argument("hub", help="The hub portal's address, e.g. https://portal.example.com (run again with a new address after the hub moves)")
    join.add_argument("token", nargs="?", help="The token from the hub (leave out to keep this machine's token, e.g. after the hub moved)")
    join.add_argument("--name", help="This machine's name (default: its hostname)")


def _cli(args):
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    data = home / "nako-portal"
    mesh = _mesh_module()
    if args.mesh_action == "add":
        token = mesh.add_node(data, args.name)
        from hermes_cli.config import load_config

        settings = load_config().get("plugins", {}).get("entries", {}).get("nako-portal", {}).get("settings", {}) or {}
        address = str(settings.get("mesh_address") or settings.get("origin") or "<this portal's address>").rstrip("/")
        print(f"{args.name} can join. On that machine run:\n\n  hermes mesh join {address} {token} --name {args.name}\n")
        print("Or add it on the portal's Mesh page for a one-line setup.")
        print("The token is shown only once. Restart nothing here; the hub reads new machines as they connect.")
    elif args.mesh_action == "remove":
        print("removed" if mesh.remove_node(data, args.name) else f"no machine called {args.name}")
    elif args.mesh_action == "list":
        try:
            rows = _call("GET", "/mesh/machines")
        except RuntimeError:
            rows = [{"name": name, "online": None} for name in mesh.load_nodes(data)]
        for row in rows:
            state = "online" if row.get("online") else "offline" if row.get("online") is False else "unknown"
            print(f"{row['name']:20} {state:8} {row.get('os') or ''}")
    elif args.mesh_action == "join":
        _join(home, args)


def _join(home, args):
    from hermes_cli.config import load_config, set_config_value

    if args.token:
        # An UPPER_SNAKE key goes to .env, not config.yaml.
        set_config_value("NAKO_MESH_TOKEN", args.token)
    elif not os.environ.get("NAKO_MESH_TOKEN") and "NAKO_MESH_TOKEN=" not in ((Path(home) / ".env").read_text() if (Path(home) / ".env").exists() else ""):
        raise SystemExit("No token yet: give the one the hub printed (or add the machine on the hub's Mesh page)")
    set_config_value("plugins.entries.nako-portal.settings.mesh_hub", args.hub)
    if args.name:
        set_config_value("plugins.entries.nako-portal.settings.mesh_name", args.name)
    mirror = str(Path(home) / "mesh-skills")
    dirs = list((load_config().get("skills") or {}).get("external_dirs") or [])
    if mirror not in dirs:
        set_config_value("skills.external_dirs", json.dumps(dirs + [mirror]))
    print("Joined. Restart the gateway (`hermes gateway restart`) to connect.")


# The plugin's loader for its portal modules (`_portal`), set when the plugin registers.
PORTAL = None


def _mesh_module():
    if PORTAL is None:
        raise RuntimeError("load the nako-portal plugin first")
    return PORTAL("mesh")


def register_cli(ctx):
    ctx.register_cli_command("mesh", "Connect other machines' Hermes to this one", _setup_cli, _cli)
