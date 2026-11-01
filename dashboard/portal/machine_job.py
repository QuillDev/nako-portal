"""Restarting or updating this machine's Hermes, run apart from both the gateway and the server.

`python machine_job.py <job.json>`. The portal server writes the job file and starts this in its
own detached process, so neither a gateway that stops nor a server that's replaced mid-update
takes the job down with it. Progress goes back into the same file, which the server reads.

Jobs:
  restart  bring the gateway up fresh (stop it if it runs, then start it)
  start    start a gateway that's down (the server's watchdog)
  update   `hermes update --yes [--channel C]`, then restart; records the version before and after

The gateway is always started as a background service, never in the foreground of this process:
through the Hermes_Gateway scheduled task on Windows (installed first if it's missing), and with
`hermes gateway restart`/`start` elsewhere.

Only the standard library: this runs with whatever Python the server has, even mid-update.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

UPDATE_TIMEOUT = 40 * 60
STEP_TIMEOUT = 180
LOG_TAIL = 4000
VERSION = re.compile(r"Hermes Agent\s+(v[\w.+-]+)(?:\s*\(([^)]*)\))?(?:\s*·\s*([\w.-]+))?(?:\s*·\s*\w+\s+([0-9a-f]{7,64}))?")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def parse_version(text):
    """{version, date, channel, commit, line} from `hermes --version`, or None."""
    for line in str(text or "").splitlines():
        found = VERSION.search(line)
        if found:
            version, date, channel, commit = found.groups()
            return {"version": version, "date": date, "channel": channel, "commit": commit, "line": line.strip()}
    return None


def hermes_version(hermes, timeout=60):
    try:
        done = subprocess.run([*hermes, "--version"], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_version(done.stdout)


class Job:
    def __init__(self, path):
        self.path = Path(path)
        self.state = json.loads(self.path.read_text())
        self.log_path = Path(self.state["log"])
        self.hermes = list(self.state["hermes"])

    def save(self, **changes):
        self.state.update(changes)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.state, indent=2))
        os.replace(temp, self.path)

    def say(self, line):
        with open(self.log_path, "a", encoding="utf-8") as log:
            log.write(f"[{time.strftime('%H:%M:%S')}] {line}\n")

    def run(self, argv, timeout=STEP_TIMEOUT):
        """Run one command, its output into the log; its exit code (None when it couldn't run)."""
        self.say("$ " + " ".join(str(a) for a in argv))
        try:
            with open(self.log_path, "a", encoding="utf-8") as log:
                done = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=timeout, creationflags=NO_WINDOW)
            self.say(f"exit {done.returncode}")
            return done.returncode
        except subprocess.TimeoutExpired:
            self.say(f"gave up after {timeout}s")
            return None
        except OSError as error:
            self.say(f"couldn't run it: {error}")
            return None

    # The gateway

    def _task_registered(self, task):
        try:
            done = subprocess.run(["schtasks", "/Query", "/TN", task], capture_output=True, timeout=30, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        except (OSError, subprocess.SubprocessError):
            return False
        return done.returncode == 0

    def start_gateway(self, fresh):
        """Bring the gateway up as a background service. `fresh`: stop a running one first."""
        if self.state.get("platform") == "windows":
            task = self.state.get("task") or "Hermes_Gateway"
            if not self._task_registered(task):
                self.say(f"no {task} scheduled task yet; installing it")
                self.run([*self.hermes, "gateway", "install", "--if-missing", "--start-on-login", "--no-start-now"])
            if not self._task_registered(task):
                self.say(f"the {task} task still isn't registered, so the gateway can't be started in the background")
                return False
            if fresh:
                self.run([*self.hermes, "gateway", "stop"])
            return self.run(["schtasks", "/Run", "/TN", task], timeout=60) == 0
        if fresh and self.run([*self.hermes, "gateway", "restart"]) == 0:
            return True
        return self.run([*self.hermes, "gateway", "start"]) == 0

    # Jobs

    def main(self):
        kind = self.state["kind"]
        self.save(pid=os.getpid(), status="running")
        old = hermes_version(self.hermes)
        self.save(old=old)
        ok = True
        if kind == "update":
            self.save(step="updating")
            argv = [*self.hermes, "update", "--yes"]
            if self.state.get("channel"):
                argv += ["--channel", self.state["channel"]]
            code = self.run(argv, timeout=UPDATE_TIMEOUT)
            ok = code == 0
            self.save(update_exit=code)
        self.save(step="starting the gateway")
        started = self.start_gateway(fresh=kind != "start")
        new = hermes_version(self.hermes)
        try:
            tail = self.log_path.read_text(encoding="utf-8", errors="replace")[-LOG_TAIL:]
        except OSError:
            tail = ""
        self.save(
            status="done" if ok and started else "failed",
            step=None,
            started_gateway=started,
            new=new,
            finished_at=time.time(),
            log_tail=tail,
        )


if __name__ == "__main__":
    Job(sys.argv[1]).main()
