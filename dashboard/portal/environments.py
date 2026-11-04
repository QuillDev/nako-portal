"""Environments: an optional page listing whatever a local command says is running here.

The owner points `environments_command` at any program that prints JSON like

    {"title": "Stacks",
     "environments": [{"name": "feature-x", "status": "running", "detail": "...", "session": "<chat id>",
                       "links": [{"label": "app", "url": "https://..."}]}],
     "links": [{"label": "sign in", "url": "https://..."}]}

`status` is running, partial or stopped; `title`, `detail`, both `links` lists and `session` (the
Hermes chat an environment belongs to; the chat's header then offers its links) are optional.
Unset, the portal shows no Environments page at all.
"""

import asyncio
import json
import logging
import os
import re
import shlex
import time
from urllib.parse import urlparse

log = logging.getLogger(__name__)

STATUSES = ("running", "partial", "stopped")
MAX_ITEMS = 200
MAX_LINKS = 20
SESSION = re.compile(r"[\w.-]{1,120}")


class EnvironmentsError(Exception):
    """The command failed, timed out or printed something that isn't the expected JSON."""


def _text(value, limit):
    return " ".join(str(value).split())[:limit] if isinstance(value, (str, int, float)) else ""


def _links(raw):
    out = []
    for link in raw if isinstance(raw, list) else []:
        if not isinstance(link, dict):
            continue
        url = str(link.get("url") or "").strip()
        # Only web links: the page renders them as anchors.
        if urlparse(url).scheme not in ("http", "https"):
            continue
        out.append({"label": _text(link.get("label"), 60) or urlparse(url).hostname or url, "url": url})
        if len(out) == MAX_LINKS:
            break
    return out


def parse(raw):
    """The command's output, kept to the fields and shapes the page draws."""
    try:
        data = json.loads(raw)
    except ValueError as error:
        raise EnvironmentsError(f"output isn't JSON: {error}") from None
    if not isinstance(data, dict) or not isinstance(data.get("environments"), list):
        raise EnvironmentsError('output needs an "environments" list')
    items = []
    for item in data["environments"][:MAX_ITEMS]:
        if not isinstance(item, dict) or not _text(item.get("name"), 120):
            continue
        status = item.get("status")
        entry = {
            "name": _text(item["name"], 120),
            "status": status if status in STATUSES else "stopped",
            "links": _links(item.get("links")),
        }
        if _text(item.get("detail"), 200):
            entry["detail"] = _text(item["detail"], 200)
        # The chat it belongs to, when the command knows (a Hermes session id).
        session = item.get("session")
        if isinstance(session, str) and SESSION.fullmatch(session):
            entry["session"] = session
        items.append(entry)
    return {"title": _text(data.get("title"), 40) or "Environments", "environments": items, "links": _links(data.get("links"))}


class Environments:
    """Runs the command on demand, sharing one run between callers and reusing it for `ttl` seconds."""

    def __init__(self, command, *, ttl=5.0, timeout=20.0, clock=time.monotonic):
        args = shlex.split(command) if isinstance(command, str) else [str(part) for part in command]
        if not args:
            raise ValueError("environments_command is empty")
        args[0] = os.path.expanduser(args[0])
        self.args = args
        self.ttl = ttl
        self.timeout = timeout
        self.clock = clock
        self.cached = None
        self.at = 0.0
        self.running = None

    async def read(self):
        if self.cached is not None and self.clock() - self.at < self.ttl:
            return self.cached
        if self.running is None:
            self.running = asyncio.ensure_future(self._run())
        try:
            result = await asyncio.shield(self.running)
        finally:
            if self.running is not None and self.running.done():
                self.running = None
        return result

    async def _run(self):
        try:
            proc = await asyncio.create_subprocess_exec(
                *self.args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
        except OSError as error:
            raise EnvironmentsError(f"can't run {self.args[0]}: {error.strerror or error}") from None
        try:
            out, err = await asyncio.wait_for(proc.communicate(), self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise EnvironmentsError(f"{self.args[0]} took longer than {self.timeout:g}s") from None
        if proc.returncode != 0:
            tail = err.decode(errors="replace").strip().splitlines()[-1:] or [f"exit {proc.returncode}"]
            raise EnvironmentsError(f"{os.path.basename(self.args[0])} failed: {tail[0][:200]}")
        result = parse(out.decode(errors="replace"))
        self.cached, self.at = result, self.clock()
        return result
