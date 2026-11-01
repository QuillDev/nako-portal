"""Looking after this machine's Hermes from its portal server: its version, restarting its gateway,
updating it, and bringing the gateway back when it goes away and stays away.

The server outlives the gateway, so it's the one part of a machine that can still act when the
gateway is down. Another machine (the mesh hub) reaches these through the machine's mesh link.
Restarts and updates run as a detached job (`machine_job.py`), so they finish even if the gateway
they stop, or a server replaced by an updated plugin, goes away under them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .machine_job import hermes_version

log = logging.getLogger("hermes.portal")

JOB_FILE = "mesh-job.json"
JOB_SCRIPT = Path(__file__).resolve().parent / "machine_job.py"
KINDS = ("restart", "start", "update")
# A job that never wrote a result this long after it started is taken as dead.
JOB_STALE = 45 * 60
# How long the gateway may stay away before the watchdog starts it, and how often it may.
GRACE = 90
COOLDOWN = 10 * 60
# Hermes's own marker while `hermes update` runs (the update stops and restarts gateways itself).
UPDATE_MARKER = ".hermes-update-in-progress"
UPDATE_MARKER_TTL = 40 * 60


def _task_name(home):
    """The Windows scheduled task Hermes installs for this home's gateway."""
    home = Path(home)
    if home.parent.name == "profiles":
        return f"Hermes_Gateway_{home.name}"
    return "Hermes_Gateway"


def _platform():
    return "windows" if os.name == "nt" else "posix"


class MachineOps:
    """`hub` is this server's own hub (its `connected` says whether a gateway is dialed in).
    `hermes` is the command that runs Hermes here (argv), or None when it wasn't found."""

    def __init__(self, data, home, hermes, hub, *, python=None, platform=None, watchdog=False, grace=GRACE, cooldown=COOLDOWN, clock=time.time):
        self.data = Path(data)
        self.home = Path(home)
        self.hermes = list(hermes) if hermes else None
        self.hub = hub
        self.python = python or sys.executable
        self.platform = platform or _platform()
        self.watchdog = watchdog
        self.grace = grace
        self.cooldown = cooldown
        self.clock = clock
        self.info = None
        self.revived_at = None
        # Called with this machine's Hermes info whenever it's read again (the node tells the hub).
        self.on_info = None
        self._waiting = None
        self._watching = None

    # Version

    async def refresh(self):
        if self.hermes is None:
            return None
        info = await asyncio.to_thread(hermes_version, self.hermes)
        if info is not None:
            self.info = info
            if self.on_info is not None:
                self.on_info(info)
        return self.info

    # Jobs

    @property
    def job_path(self):
        return self.data / JOB_FILE

    def _read_job(self):
        try:
            return json.loads(self.job_path.read_text())
        except (OSError, ValueError):
            return None

    def running(self):
        job = self._read_job()
        return bool(job) and job.get("status") in ("starting", "running") and self.clock() - (job.get("started_at") or 0) < JOB_STALE

    def job(self):
        """The last restart or update and how it went, with whether the gateway is up now."""
        job = self._read_job()
        if job is None:
            return {"job": None, "gateway": bool(self.hub.connected), "hermes": self.info}
        status = job.get("status")
        if status in ("starting", "running") and self.clock() - (job.get("started_at") or 0) >= JOB_STALE:
            status = "lost"
        view = {k: job.get(k) for k in ("id", "kind", "channel", "step", "old", "new", "update_exit", "started_gateway", "started_at", "finished_at", "log_tail")}
        if status in ("starting", "running"):
            try:
                view["log_tail"] = Path(job["log"]).read_text(encoding="utf-8", errors="replace")[-2000:]
            except (OSError, KeyError):
                pass
        return {"job": {**view, "status": status}, "gateway": bool(self.hub.connected), "hermes": self.info}

    async def start(self, kind, channel=None):
        if kind not in KINDS:
            raise ValueError(f"unknown job {kind!r}")
        if self.hermes is None:
            raise ValueError("Can't find the hermes command on this machine")
        if channel is not None and not (isinstance(channel, str) and channel.replace("-", "").replace(".", "").isalnum() and len(channel) < 40):
            raise ValueError("bad channel name")
        if self.running():
            current = self._read_job() or {}
            raise ValueError(f"A {current.get('kind')} is already running here (started {int(self.clock() - current.get('started_at', 0))}s ago)")
        self.data.mkdir(parents=True, exist_ok=True)
        job_id = uuid.uuid4().hex[:12]
        log_path = self.data / f"mesh-job-{kind}.log"
        log_path.write_text("")
        state = {
            "id": job_id,
            "kind": kind,
            "channel": channel,
            "status": "starting",
            "step": "starting",
            "started_at": self.clock(),
            "hermes": self.hermes,
            "platform": self.platform,
            "task": _task_name(self.home),
            "log": str(log_path),
        }
        temp = self.job_path.with_suffix(".tmp")
        temp.write_text(json.dumps(state, indent=2))
        os.replace(temp, self.job_path)
        await asyncio.to_thread(self._spawn)
        log.info("portal: started a %s job (%s)", kind, job_id)
        if self._waiting is None or self._waiting.done():
            self._waiting = asyncio.get_running_loop().create_task(self._until_done(job_id))
        return self.job()

    def _spawn(self):
        command = [self.python, "-I", str(JOB_SCRIPT), str(self.job_path)]
        with open(self.data / "mesh-job.out", "ab") as out:
            if os.name == "nt":
                flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
                subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, creationflags=flags, close_fds=True)
            else:
                subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)

    async def _until_done(self, job_id):
        while True:
            await asyncio.sleep(1)
            job = self._read_job() or {}
            if job.get("id") != job_id or not self.running():
                break
        await self.refresh()

    # The gateway

    def gateway_changed(self, connected):
        """The gateway connected (read the version it brought) or went away (start watching)."""
        loop = asyncio.get_running_loop()
        if connected:
            if self._watching is not None:
                self._watching.cancel()
                self._watching = None
            loop.create_task(self.refresh())
            return
        if self.watchdog and (self._watching is None or self._watching.done()):
            self._watching = loop.create_task(self._watch())

    def _updating(self):
        """Hermes's own `hermes update` is running (it restarts the gateway itself when done)."""
        for root in (self.home, self.home.parent.parent):
            marker = root / UPDATE_MARKER
            try:
                if self.clock() - marker.stat().st_mtime < UPDATE_MARKER_TTL:
                    return True
            except OSError:
                continue
        return False

    async def _watch(self):
        """Bring a gateway back that went away and stayed away."""
        try:
            while not self.hub.connected:
                await asyncio.sleep(self.grace)
                if self.hub.connected:
                    return
                if self.running() or self._updating():
                    continue
                if self.revived_at is not None and self.clock() - self.revived_at < self.cooldown:
                    continue
                self.revived_at = self.clock()
                log.warning("portal: the gateway has been away for %ss; starting it", self.grace)
                try:
                    await self.start("start")
                except ValueError as error:
                    log.warning("portal: couldn't start the gateway: %s", error)
        except asyncio.CancelledError:
            pass
