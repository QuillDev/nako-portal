"""Other machines' Hermes, reached through this portal.

One portal server is the hub. Every other machine (a node) runs the portal too, with its server
dialing the hub's mesh port over one WebSocket and a per-machine token. The hub can then list
a node's chats, open them, start one, send into one, stop one and answer its questions, and the
node passes everything its own hub would show a browser (live replies, tool calls, status) back
up, so the hub's app shows the node's chats like its own, under the machine's name.

Node chats get ids `mesh.<machine>.<session>` on the hub. Nothing here imports Hermes: the hub
side only knows the node's hub methods, the node side only its own hub.

The node also mirrors the hub's skills into a folder of its own (the hub owns them; the node's
copies are read-only and replaced on every change), which its Hermes reads as an extra skills dir.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import platform
import re
import secrets
import socket
import stat
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from .mesh_setup import powershell_script, shell_script
from .link import HEARTBEAT, MAX_FRAME, Peer, decode_files, encode_files

log = logging.getLogger("hermes.portal")

MESH_PATH = "/mesh"
PREFIX = "mesh."
MACHINE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
REMOTE = re.compile(r"^mesh\.([a-z0-9][a-z0-9-]{0,31})\.([\w-][\w.-]{0,100})$")
NODES_FILE = "mesh-nodes.json"
# A node's chat list is skipped (not waited on) past this, so one slow machine can't stall the sidebar.
LIST_TIMEOUT = 5
# What the hub may call on a node: its hub's own methods, by name.
# What a machine may ask the hub to do on another machine (or on the hub) for its agent.
RELAYED = ("open", "send", "interrupt", "answer")
NODE_CALLS = (
    "sessions",
    "archived",
    "open",
    "create",
    "send",
    "interrupt",
    "answer",
    "archive",
    "rename",
    "pin",
    "commands",
    "processes",
    "process_log",
    "command",
)
# How long a new machine's one-line setup works.
SETUP_TTL = 24 * 3600
SETUP_PATH = MESH_PATH + "/setup/{code}"
NO_SOURCE = (
    "Machines can't install this plugin from where the hub's copy came from. Set the plugin "
    "source on the Mesh page to a git URL they can reach (the repo this plugin was published to)."
)
SOURCE_KEY = "mesh:plugin_source"
SKILL_POLL = 60
SKILL_BATCH = 8 * 1024 * 1024
SKILL_FILE_MAX = 4 * 1024 * 1024
SKIPPED_NAMES = {"__pycache__", "node_modules"}
MIRROR_STATE = ".mesh-manifest.json"


def remote_id(machine, session):
    return f"{PREFIX}{machine}.{session}"


def parse(session):
    """(machine, node session) for a node's chat, else None."""
    found = REMOTE.match(str(session or ""))
    return (found.group(1), found.group(2)) if found else None


def thread_rows(machine, rows):
    """A machine's chats as an agent lists them: ids it can use, the person's inboxes left out."""
    return [
        {
            "session": remote_id(machine, row["id"]),
            "title": row.get("title"),
            "status": row.get("status"),
            "started_at": row.get("started_at"),
            "messages": row.get("message_count"),
        }
        for row in rows or []
        if not row.get("notifications") and not row.get("reviews")
    ]


def _rewrite(value, machine):
    """A node's answer as the hub shows it: its chat ids carry the machine."""
    if isinstance(value, dict):
        return {k: (remote_id(machine, v) if k == "session" and isinstance(v, str) and v else _rewrite(v, machine)) for k, v in value.items()}
    if isinstance(value, list):
        return [_rewrite(v, machine) for v in value]
    return value


# Tokens


def _digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def load_nodes(data):
    path = Path(data) / NODES_FILE
    try:
        nodes = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return nodes if isinstance(nodes, dict) else {}


def add_node(data, name):
    """A new machine's token (shown once; the hub keeps only its hash). Re-adding replaces it."""
    if not MACHINE.match(name):
        raise ValueError("Machine names are lowercase letters, digits and dashes")
    data = Path(data)
    data.mkdir(parents=True, exist_ok=True)
    nodes = load_nodes(data)
    token = secrets.token_urlsafe(32)
    nodes[name] = {"token_sha256": _digest(token), "added": int(time.time())}
    _write_private(data / NODES_FILE, json.dumps(nodes, indent=2) + "\n")
    return token


def _save_nodes(data, nodes):
    _write_private(Path(data) / NODES_FILE, json.dumps(nodes, indent=2) + "\n")


def start_setup(data, name, token, now=None):
    """A one-line setup for a machine just added: a code for its setup page, which holds the
    token until the machine joins or a day passes. Only the code's hash is kept for lookups."""
    now = time.time() if now is None else now
    nodes = load_nodes(data)
    code = secrets.token_urlsafe(18)
    nodes[name]["setup"] = {"code_sha256": _digest(code), "token": token, "expires": now + SETUP_TTL}
    _save_nodes(data, nodes)
    return code


def setup_for(data, code, now=None):
    """(machine, its setup) for a live setup code, else (None, None)."""
    now = time.time() if now is None else now
    digest = _digest(str(code or ""))
    for name, entry in load_nodes(data).items():
        setup = entry.get("setup") or {}
        if setup.get("code_sha256") and secrets.compare_digest(setup["code_sha256"], digest) and setup.get("expires", 0) > now:
            return name, setup
    return None, None


def _joined(data, name):
    """The machine is in: its setup page stops holding the token."""
    nodes = load_nodes(data)
    setup = (nodes.get(name) or {}).get("setup")
    if setup and setup.get("token"):
        setup.pop("token")
        _save_nodes(data, nodes)


def setup_page(*, name, address, token, code, plugin):
    """What a stock Hermes on the new machine reads and follows to join."""
    source = (plugin or {}).get("source")
    ref = (plugin or {}).get("ref")
    install = f"hermes plugins install {source}" + (f" --ref {ref}" if ref else "") + " --enable --yes-deps --force"
    status = f"curl -fsSL {address}{SETUP_PATH.format(code=code)}/status"
    return f"""# Join the Nako mesh as "{name}"

The user wants this machine to join their Nako mesh, so their main Hermes (the hub at {address}) can hand it tasks.
Do every step yourself, in order, with your terminal. If a step fails, stop and tell the user which one and what it printed.
Never repeat the token below to the user or write it anywhere except through these commands.
On Windows, type curl.exe wherever these steps say curl (PowerShell's curl is something else), and ~/.hermes is %USERPROFILE%\\.hermes.

1. Install the Nako Portal plugin:

   {install}

2. Join the mesh. This saves the token in this Hermes's .env, adds the hub's synced skills folder, and names the machine:

   hermes mesh join {address} {token} --name {name}

3. Keep the gateway running in the background so the machine stays reachable:
   run `hermes gateway status`. If no background service is installed, run `hermes gateway install` and then `hermes gateway start`.
   Otherwise run `hermes gateway restart`. If you are running inside that gateway and can't restart it, ask the user to run
   `hermes gateway restart` in a terminal, then continue.

4. Check that it joined: run `{status}` every 10 seconds for up to 2 minutes until it prints "online": true.
   If it never does, show the user the end of ~/.hermes/logs/gateway.log and ~/.hermes/nako-portal/server.log.

5. Tell the user in one line that "{name}" joined the mesh.
"""


def remove_node(data, name):
    nodes = load_nodes(data)
    if nodes.pop(name, None) is None:
        return False
    _write_private(Path(data) / NODES_FILE, json.dumps(nodes, indent=2) + "\n")
    return True


def _write_private(path, text):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text)
    temp.chmod(0o600)
    os.replace(temp, path)


# Skills


def _excluded(parts, exclude):
    return any(p in exclude or p.startswith(".") or p in SKIPPED_NAMES for p in parts)


def skill_manifest(root, exclude=()):
    """{relative path: sha256} for every file the hub shares: each skill folder (one with a
    SKILL.md) and category DESCRIPTION.md files, minus any path with an excluded name in it
    (a skill's name or a category's)."""
    root = Path(root)
    exclude = set(exclude or ())
    files = {}
    if not root.is_dir():
        return files
    skill_dirs = {p.parent for p in root.rglob("SKILL.md") if p.is_file()}
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(root)
        if _excluded(rel.parts, exclude):
            continue
        in_skill = any(parent in skill_dirs for parent in path.parents)
        if not in_skill and path.name != "DESCRIPTION.md":
            continue
        try:
            if path.stat().st_size > SKILL_FILE_MAX:
                continue
            files[rel.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            continue
    return files


def read_skill_files(root, wanted, exclude=()):
    root = Path(root).resolve()
    shared = skill_manifest(root, exclude)
    out, size = {}, 0
    for rel in wanted:
        if rel not in shared:
            continue
        data = (root / rel).read_bytes()
        if out and size + len(data) > SKILL_BATCH:
            break
        out[rel] = base64.b64encode(data).decode()
        size += len(data)
    return out


def _safe_rel(rel):
    parts = Path(rel).parts
    return bool(parts) and not Path(rel).is_absolute() and ".." not in parts and not any(":" in p for p in parts)


async def mirror_skills(target, manifest, fetch):
    """Make `target` hold exactly the hub's skills. `fetch(paths)` -> {path: base64}. Files are
    left read-only, so an edit on this machine fails loudly instead of being lost on the next sync."""
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    state_path = target / MIRROR_STATE
    try:
        have = json.loads(state_path.read_text())
    except (OSError, ValueError):
        have = {}
    manifest = {rel: sha for rel, sha in manifest.items() if _safe_rel(rel)}
    stale = [rel for rel, sha in manifest.items() if have.get(rel) != sha or not (target / rel).is_file()]
    changed = 0
    while stale:
        got = await fetch(stale)
        if not got:
            break
        for rel, encoded in got.items():
            if rel not in manifest:
                continue
            data = base64.b64decode(encoded)
            path = target / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                path.chmod(stat.S_IWRITE | stat.S_IREAD)
            temp = path.with_name(path.name + ".mesh-tmp")
            temp.write_bytes(data)
            os.replace(temp, path)
            path.chmod(stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
            have[rel] = manifest[rel]
            changed += 1
        stale = [rel for rel in stale if rel not in got]
    for rel in [rel for rel in have if rel not in manifest]:
        path = target / rel
        if path.exists():
            path.chmod(stat.S_IWRITE | stat.S_IREAD)
            path.unlink()
        have.pop(rel)
        changed += 1
    for folder in sorted((p for p in target.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            folder.rmdir()
        except OSError:
            pass
    state_path.write_text(json.dumps(have, sort_keys=True))
    return changed


# The hub's side


class RemoteHub:
    """One node's hub, called like the local one."""

    def __init__(self, mesh, machine):
        self.mesh = mesh
        self.machine = machine

    def __getattr__(self, name):
        if name not in NODE_CALLS:
            raise AttributeError(name)

        async def call(*args):
            args = list(args)
            # Files cross the link base64-encoded: send(session, text, files), create(text, files, ...).
            at = {"send": 2, "create": 1}.get(name)
            if at is not None and len(args) > at:
                args[at] = encode_files(list(args[at] or []))
            return _rewrite(await self.mesh.call(self.machine, name, *args), self.machine)

        return call


class LocalHub:
    """The hub's own hub, as another machine sees it: chat ids carry the hub's name."""

    def __init__(self, hub, name):
        self.hub = hub
        self.name = name

    def __getattr__(self, name):
        method = getattr(self.hub, name)

        async def call(*args):
            return _rewrite(await method(*args), self.name)

        return call


class Mesh:
    """The hub's machines: who is connected, what they're doing, and calls into them.

    `hub` is this server's own hub; a node's live frames reach the app through it."""

    def __init__(self, data, hub, *, name="hub", address=None, plugin=None, skills_dir=None, skills_exclude=(), store=None, clock=time.time):
        self.data = Path(data)
        # The hub's own name in the mesh: other machines reach its chats as `mesh.<name>.<id>`.
        self.name = name
        # Where machines dial in (`mesh_listen`), for the join command a new machine runs.
        self.address = address
        # {source, ref}: the plugin a new machine installs, so it runs the hub's own version.
        self.plugin = plugin
        self.hub = hub
        self.skills_dir = Path(skills_dir) if skills_dir else None
        self.skills_exclude = list(skills_exclude or ())
        self.store = store
        self.clock = clock
        self.peers = {}
        self.info = {}
        self.status = {}
        self.requests = {}

    # Where machines get the plugin

    def plugin_source(self):
        """The git URL new machines install the plugin from: the one saved on the Mesh page, else
        the one found from settings or the plugin's own checkout. None when neither exists."""
        saved = self.store.meta(SOURCE_KEY, None) if self.store is not None else None
        return saved or (self.plugin or {}).get("source")

    def install_from(self):
        return {"source": self.plugin_source(), "ref": (self.plugin or {}).get("ref")}

    def source_view(self):
        saved = self.store.meta(SOURCE_KEY, None) if self.store is not None else None
        return {"source": self.plugin_source(), "detected": (self.plugin or {}).get("source"), "saved": bool(saved)}

    def set_source(self, source):
        """Save the plugin source from the Mesh page; empty goes back to the detected one."""
        from .mesh_setup import SAFE

        source = str(source or "").strip()
        if source and not SAFE["source"].match(source):
            raise ValueError("Use a git URL machines can reach, like https://github.com/<you>/<repo>.git")
        if self.store is None:
            raise ValueError("Nowhere to save it")
        self.store.set_meta(SOURCE_KEY, source or None)
        return self.source_view()

    # Who's there

    def add(self, name):
        """Let a machine join: its token, and the command that joins it, shown once."""
        if name == self.name:
            raise ValueError(f"{name} is this hub's own name")
        if not self.plugin_source():
            raise ValueError(NO_SOURCE)
        if not self.address:
            raise ValueError("Machines need an address for this hub: set the portal's origin (or mesh_address)")
        token = add_node(self.data, name)
        command = f"hermes mesh join {self.address or '<this hub>'} {token} --name {name}"
        code = start_setup(self.data, name, token, self.clock())
        url = f"{self.address}{SETUP_PATH.format(code=code)}"
        prompt = f'Set this machine up as "{name}" in my Nako mesh: run `curl -fsSL {url}` (curl.exe on Windows) and follow the steps it prints, exactly and in order.'
        # The one line to paste in a terminal on the new machine, by its OS.
        lines = {"unix": f"curl -fsSL {url}/sh | bash", "windows": f"iex (irm {url}/ps1)"}
        return {"name": name, "token": token, "command": command, "prompt": prompt, "lines": lines}

    async def script(self, request):
        """GET /mesh/setup/{code}/sh or /ps1: the script that line runs."""
        code, kind = request.match_info["code"], request.match_info["kind"]
        name, setup = setup_for(self.data, code, self.clock())
        if name is None:
            message = "This setup line expired or was never made. Add the machine again on the Mesh page."
            text = f"echo '{message}' >&2; exit 1\n" if kind == "sh" else f"Write-Host '{message}' -ForegroundColor Red\n"
            return web.Response(status=404 if kind == "sh" else 200, text=text, content_type="text/plain")
        if not setup.get("token"):
            text = f"echo '{name} already joined the mesh.'\n" if kind == "sh" else f"Write-Host '{name} already joined the mesh.'\n"
            return web.Response(text=text, content_type="text/plain")
        plugin = self.install_from()
        values = {
            "hub": self.address,
            "name": name,
            "token": setup["token"],
            "status": f"{self.address}{SETUP_PATH.format(code=code)}/status",
            "source": plugin.get("source") or "",
            "ref": plugin.get("ref") or "",
        }
        text = shell_script(**values) if kind == "sh" else powershell_script(**values)
        return web.Response(text=text, content_type="text/plain", headers={"Cache-Control": "no-store"})

    async def setup(self, request):
        """GET /mesh/setup/{code}: the steps a new machine's Hermes follows (plain text)."""
        name, setup = setup_for(self.data, request.match_info["code"], self.clock())
        if name is None:
            return web.Response(status=404, text="This setup link expired or was never made. Add the machine again in Settings.\n")
        if not setup.get("token"):
            return web.Response(text=f'"{name}" already joined the mesh. Nothing to do.\n')
        page = setup_page(name=name, address=self.address, token=setup["token"], code=request.match_info["code"], plugin=self.install_from())
        return web.Response(text=page, content_type="text/plain", headers={"Cache-Control": "no-store"})

    async def setup_status(self, request):
        name, _ = setup_for(self.data, request.match_info["code"], self.clock())
        if name is None:
            return web.json_response({"error": "unknown or expired setup"}, status=404)
        return web.json_response({"machine": name, "online": name in self.peers})

    async def remove(self, name):
        """Revoke a machine's token and drop its link, so it's gone at once."""
        if not remove_node(self.data, name) and name not in self.peers:
            raise ValueError(f"No machine called {name}")
        peer = self.peers.get(name)
        if peer is not None:
            await peer.ws.close()
        self.info.pop(name, None)
        if self.store is not None:
            self.store.set_meta(f"mesh:seen:{name}", None)
        await self.hub.broadcast({"kind": "machines.changed"})
        return {"ok": True}

    def machines(self):
        nodes = load_nodes(self.data)
        rows = []
        for name in sorted(set(nodes) | set(self.peers)):
            info = self.info.get(name, {})
            online = name in self.peers
            last = info.get("last_seen") or (self.store.meta(f"mesh:seen:{name}", None) if self.store else None)
            rows.append(
                {
                    "name": name,
                    "online": online,
                    "gateway": bool(info.get("gateway")) if online else False,
                    "os": info.get("os"),
                    "hostname": info.get("hostname"),
                    "connected_at": info.get("connected_at") if online else None,
                    "last_seen": self.clock() if online else last,
                    "working": sum(1 for s, v in self.status.items() if (parse(s) or ("",))[0] == name and v.get("status") == "working"),
                }
            )
        return rows

    def target(self, session):
        """The hub that holds a chat and its id there."""
        found = parse(session)
        if found is None:
            return self.hub, session
        machine, inner = found
        if machine == self.name:
            return self.hub, inner
        if machine not in self.peers:
            raise ConnectionError(f"{machine} is offline")
        return RemoteHub(self, machine), inner

    def machine_hub(self, machine):
        if machine == self.name:
            return LocalHub(self.hub, self.name)
        if machine not in self.peers:
            if machine in load_nodes(self.data):
                raise ConnectionError(f"{machine} is offline")
            raise ValueError(f"No machine called {machine}")
        return RemoteHub(self, machine)

    async def threads(self, machine):
        """Another machine's chats (or the hub's own), newest first."""
        hub = self.hub if machine == self.name else self.machine_hub(machine)
        # Listing rows carry the machine's own ids under `id`; thread_rows names them for the mesh.
        listed = thread_rows(machine, await hub.sessions())
        return sorted(listed, key=lambda r: r.get("started_at") or 0, reverse=True)

    async def call(self, machine, method, *args):
        peer = self.peers.get(machine)
        if peer is None:
            raise ConnectionError(f"{machine} is offline")
        return await peer.call(method, *args)

    async def sessions(self):
        """Every connected machine's chats, for the sidebar. A machine that doesn't answer in time
        is left out of this listing rather than holding it up."""

        async def one(machine):
            try:
                rows = await asyncio.wait_for(self.call(machine, "sessions"), LIST_TIMEOUT)
            except Exception as error:
                log.info("portal: %s didn't list its chats (%s)", machine, error)
                return []
            shown = []
            for row in rows or []:
                if row.get("notifications") or row.get("reviews"):
                    continue
                session = remote_id(machine, row["id"])
                shown.append({**row, "id": session, "machine": machine, "status": (self.status.get(session) or {}).get("status")})
            return shown

        lists = await asyncio.gather(*(one(m) for m in list(self.peers)))
        return [row for rows in lists for row in rows]

    def status_frames(self):
        return [{"kind": "status", "session": s, **v} for s, v in self.status.items()]

    async def read(self, session):
        """The chat came up on screen here: its finished turn is seen."""
        entry = self.status.get(session)
        if entry and entry.get("unread"):
            entry["unread"] = False
            await self.hub.broadcast({"kind": "status", "session": session, **entry})

    async def answer(self, request_id, result):
        machine = self.requests.get(str(request_id))
        if machine is None:
            raise ValueError("That request is no longer open")
        return await self.call(machine, "answer", request_id, result)

    # A node's live view

    async def _frame(self, machine, frame):
        if not isinstance(frame, dict):
            return
        kind = frame.get("kind")
        inner = frame.get("session")
        session = remote_id(machine, inner) if isinstance(inner, str) and inner else None
        if kind == "sessions.changed":
            await self.hub.broadcast({"kind": "sessions.changed"})
        elif kind == "status" and session:
            self.status[session] = {"status": frame.get("status"), "unread": bool(frame.get("unread")) and not self.hub.seen(session)}
            await self.hub.broadcast({"kind": "status", "session": session, **self.status[session]})
            await self.hub.broadcast({"kind": "machines.changed"})
        elif kind == "alert" and session:
            self.hub.notify(session, f"{machine} · {frame.get('title') or 'Nako'}", str(frame.get("body") or ""))
        elif session and kind in {"event", "request", "request.closed"}:
            if kind == "request" and isinstance(frame.get("request"), dict):
                self.requests[str(frame["request"].get("id"))] = machine
            if kind == "request.closed":
                self.requests.pop(str(frame.get("id")), None)
            payload = {k: v for k, v in frame.items() if k != "session"}
            await self.hub._publish(session, payload)
        # hub.connected / hub.disconnected: the node's own gateway; kept in its info instead.
        if kind in {"hub.connected", "hub.disconnected"} and machine in self.info:
            self.info[machine]["gateway"] = kind == "hub.connected"
            await self.hub.broadcast({"kind": "sessions.changed"})
            await self.hub.broadcast({"kind": "machines.changed"})

    def _methods(self, machine):
        async def hello(info):
            info = info if isinstance(info, dict) else {}
            self.info[machine] = {
                "os": str(info.get("os") or "")[:40] or None,
                "hostname": str(info.get("hostname") or "")[:80] or None,
                "gateway": bool(info.get("gateway")),
                "connected_at": self.clock(),
            }
            for frame in info.get("statuses") or []:
                await self._frame(machine, frame)
            await self.hub.broadcast({"kind": "machines.changed"})
            return {"hub": socket.gethostname()}

        async def frame(value):
            await self._frame(machine, value)

        async def skills_manifest():
            if self.skills_dir is None:
                return {}
            return await asyncio.to_thread(skill_manifest, self.skills_dir, self.skills_exclude)

        async def skill_files(paths):
            if self.skills_dir is None:
                return {}
            return await asyncio.to_thread(read_skill_files, self.skills_dir, [str(p) for p in paths or []], self.skills_exclude)

        async def machines():
            """The mesh as this machine's agent sees it: the hub and every other machine."""
            me = {"name": self.name, "hub": True, "online": True, "gateway": bool(self.hub.connected), "os": None, "hostname": socket.gethostname(), "last_seen": self.clock(), "working": sum(1 for v in self.hub.status.values() if v == "working")}  # noqa: E501
            return [me] + [row for row in self.machines() if row["name"] != machine]

        async def start(target, text, title=None, cwd=None, yolo=True):
            """A new chat on another machine (or the hub), for this machine's agent."""
            if target == machine:
                raise ValueError("That's this machine; do it here")
            return await self.machine_hub(target).create(str(text), [], title, cwd, bool(yolo))

        async def threads(target):
            if target == machine:
                raise ValueError("Those are this machine's own chats")
            return await self.threads(target)

        async def relay(session, method, args):
            """A call into a chat on another machine (or the hub), for this machine's agent."""
            if method not in RELAYED:
                raise ValueError(f"can't relay {method}")
            found = parse(session)
            if found is None:
                raise ValueError("give a mesh chat id (mesh.<machine>.<id>)")
            if found[0] == machine:
                raise ValueError("That chat is on this machine")
            hub, inner = self.target(session)
            args = list(args or [])
            if method == "send":
                args = [args[0] if args else "", []]
            # answer(request id, result) names the request, not the chat.
            call = getattr(hub, method)
            result = await (call(*args) if method == "answer" else call(inner, *args))
            return _rewrite(result, self.name) if hub is self.hub else result

        return {
            "hello": hello,
            "frame": frame,
            "skills_manifest": skills_manifest,
            "skill_files": skill_files,
            "machines": machines,
            "start": start,
            "relay": relay,
            "threads": threads,
        }

    async def handle(self, request):
        """GET /mesh: a node dialing in with `?name=` and its bearer token."""
        name = str(request.query.get("name") or "")
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        known = load_nodes(self.data).get(name) if MACHINE.match(name) else None
        if not known or not token or not secrets.compare_digest(_digest(token), str(known.get("token_sha256"))):
            log.warning("portal: refused a mesh connection for %r", name)
            return web.json_response({"error": "bad machine or token"}, status=401)
        ws = web.WebSocketResponse(heartbeat=HEARTBEAT, max_msg_size=MAX_FRAME)
        await ws.prepare(request)
        peer = Peer(ws, self._methods(name))
        old, self.peers[name] = self.peers.get(name), peer
        if old is not None:
            await old.ws.close()
        log.info("portal: %s joined the mesh", name)
        _joined(self.data, name)
        await self.hub.broadcast({"kind": "machines.changed"})
        try:
            await peer.run()
        finally:
            if self.peers.get(name) is peer:
                self.peers.pop(name, None)
                seen = self.clock()
                self.info.setdefault(name, {})["last_seen"] = seen
                if self.store is not None:
                    self.store.set_meta(f"mesh:seen:{name}", seen)
                for session in [s for s in self.status if (parse(s) or ("",))[0] == name]:
                    if self.status[session].get("status") in ("working", "needs you"):
                        del self.status[session]
                for rid in [r for r, m in self.requests.items() if m == name]:
                    self.requests.pop(rid, None)
                log.info("portal: %s left the mesh", name)
                await self.hub.broadcast({"kind": "sessions.changed"})
                await self.hub.broadcast({"kind": "machines.changed"})
        return ws

    def app(self):
        app = web.Application(client_max_size=MAX_FRAME)
        app.router.add_get(MESH_PATH, self.handle)
        app.router.add_get(SETUP_PATH, self.setup)
        app.router.add_get(SETUP_PATH + "/status", self.setup_status)
        app.router.add_get(SETUP_PATH + "/{kind:sh|ps1}", self.script)
        return app


# A node's side


class Node:
    """This machine's portal, dialed into a hub: answers the hub's calls with the local hub and
    passes up everything the local hub shows its own app."""

    RETRY = 3.0

    def __init__(self, url, name, token, hub, *, skills_into=None):
        self.url = url
        self.name = name
        self.token = token
        self.hub = hub
        self.skills_into = Path(skills_into) if skills_into else None
        self.peer = None
        self.connected_event = asyncio.Event()
        hub.taps.add(self._tap)

    def _tap(self, frame):
        peer = self.peer
        if peer is None:
            return
        task = asyncio.get_running_loop().create_task(peer.call("frame", frame))
        task.add_done_callback(_quiet)

    async def call(self, method, *args):
        peer = self.peer
        if peer is None:
            raise ConnectionError("not connected to the mesh hub")
        return await peer.call(method, *args)

    def remote(self, session):
        """A chat on another machine, through the hub, called like a local hub holding it.
        `answer(request, result)` names no chat, like the hub's own, so the relay is bound to one."""
        node = self

        class Relay:
            def __getattr__(self, name):
                if name not in RELAYED:
                    raise AttributeError(name)

                async def call(*args):
                    if name != "answer":
                        args = args[1:]  # the chat, which this relay already holds
                    return await node.call("relay", session, name, list(args[:1]) if name == "send" else list(args))

                return call

        return Relay()

    def _methods(self):
        methods = {name: getattr(self.hub, name) for name in NODE_CALLS}

        async def send(session, text, files=(), *rest):
            return await self.hub.send(session, text, decode_files(files or []), *rest)

        async def create(text, files=(), *rest):
            return await self.hub.create(text, decode_files(files or []), *rest)

        methods.update(send=send, create=create)
        return methods

    def _hello(self):
        return {
            "os": f"{platform.system()} {platform.release()}".strip(),
            "hostname": socket.gethostname(),
            "gateway": bool(self.hub.connected),
            "statuses": self.hub.status_frames(),
        }

    async def run(self, http):
        while True:
            try:
                ws = await http.ws_connect(
                    self.url,
                    params={"name": self.name},
                    headers={"Authorization": f"Bearer {self.token}"},
                    heartbeat=HEARTBEAT,
                    max_msg_size=MAX_FRAME,
                )
            except Exception as error:
                log.info("portal: can't reach the mesh hub at %s (%s)", self.url, error)
                await asyncio.sleep(self.RETRY)
                continue
            peer = Peer(ws, self._methods())
            self.peer = peer
            running = asyncio.get_running_loop().create_task(peer.run())
            syncing = None
            try:
                await peer.call("hello", self._hello())
                self.connected_event.set()
                log.info("portal: joined the mesh at %s as %s", self.url, self.name)
                if self.skills_into is not None:
                    syncing = asyncio.get_running_loop().create_task(self._sync_skills(peer))
                await running
            except Exception as error:
                log.warning("portal: mesh link dropped (%s)", error)
            finally:
                self.peer = None
                self.connected_event.clear()
                for task in (running, syncing):
                    if task is not None:
                        task.cancel()
                await ws.close()
            await asyncio.sleep(self.RETRY)

    async def _sync_skills(self, peer):
        while True:
            try:
                manifest = await peer.call("skills_manifest")
                changed = await mirror_skills(self.skills_into, manifest or {}, lambda paths: peer.call("skill_files", paths))
                if changed:
                    log.info("portal: synced %d skill file(s) from the hub", changed)
            except asyncio.CancelledError:
                raise
            except ConnectionError:
                return
            except Exception:
                log.warning("portal: skill sync failed", exc_info=True)
            await asyncio.sleep(SKILL_POLL)


def _quiet(task):
    if not task.cancelled() and task.exception() is not None and not isinstance(task.exception(), ConnectionError):
        log.debug("portal: mesh frame failed: %s", task.exception())


def main(argv=None):
    """`python -m portal.mesh add|remove|list <name> --data <dir>`: manage the hub's machines."""
    import argparse

    parser = argparse.ArgumentParser(prog="nako-mesh")
    parser.add_argument("action", choices=["add", "remove", "list"])
    parser.add_argument("name", nargs="?")
    parser.add_argument("--data", required=True)
    args = parser.parse_args(argv)
    if args.action == "list":
        for name, entry in sorted(load_nodes(args.data).items()):
            print(name, time.strftime("%Y-%m-%d", time.localtime(entry.get("added") or 0)))
        return 0
    if not args.name:
        parser.error("name a machine")
    if args.action == "add":
        print(add_node(args.data, args.name))
        return 0
    return 0 if remove_node(args.data, args.name) else 1


if __name__ == "__main__":
    raise SystemExit(main())
