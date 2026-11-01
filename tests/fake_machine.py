"""A stand-in for a machine's Hermes in mesh tests: the `hermes` command, `schtasks`, and the
gateway process they start, which dials the machine's portal server over the real link.

  python fake_machine.py hermes <args...>     the hermes CLI (--version, update, gateway ...)
  python fake_machine.py schtasks <args...>   Windows' task scheduler (/Query, /Run)
  python fake_machine.py gateway              a gateway process: connects and stays connected

Everything it knows comes from the environment (FAKE_HERMES_*), and everything it does lands in
FAKE_HERMES_DIR: `version` (the installed version line's parts), `next` (what an update installs),
`gateway.pid`, `task` (the scheduled task is registered) and `calls.log`.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = Path(os.environ.get("FAKE_HERMES_DIR", "."))


def _say(line):
    with open(STATE / "calls.log", "a") as log:
        log.write(line + "\n")


def _version():
    return json.loads((STATE / "version").read_text())


def _alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _stop_gateway():
    try:
        pid = int((STATE / "gateway.pid").read_text())
    except (OSError, ValueError):
        return
    if _alive(pid):
        os.kill(pid, signal.SIGTERM)
    (STATE / "gateway.pid").unlink(missing_ok=True)


def _start_gateway():
    _stop_gateway()
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "gateway"],
        stdin=subprocess.DEVNULL,
        stdout=open(STATE / "gateway.log", "ab"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    (STATE / "gateway.pid").write_text(str(process.pid))


def hermes(args):
    _say("hermes " + " ".join(args))
    if args[:1] == ["--version"]:
        v = _version()
        print(f"Hermes Agent {v['version']} ({v['date']}) · {v['channel']} · local {v['commit']}")
        print("Install directory: /opt/hermes")
        return 0
    if args[:1] == ["update"]:
        print("→ Update channel: stable")
        nxt = json.loads((STATE / "next").read_text())
        print(f"Updating Hermes Agent {_version()['version']} -> {nxt['version']}")
        # Like the real thing: the update stops the gateway on its way.
        _stop_gateway()
        (STATE / "version").write_text(json.dumps(nxt))
        print("✓ Updated")
        return 0
    if args[:2] == ["gateway", "stop"]:
        _stop_gateway()
        return 0
    if args[:2] == ["gateway", "install"]:
        (STATE / "task").touch()
        return 0
    if args[:2] in (["gateway", "restart"], ["gateway", "start"]):
        if os.environ.get("FAKE_HERMES_NO_DIRECT"):
            # Windows with a task: starting the gateway outside it is what must not happen.
            print("refusing to start the gateway outside its scheduled task", file=sys.stderr)
            return 1
        _start_gateway()
        return 0
    print(f"unknown: {args}", file=sys.stderr)
    return 2


def schtasks(args):
    _say("schtasks " + " ".join(args))
    registered = (STATE / "task").exists()
    if args[:1] == ["/Query"]:
        return 0 if registered else 1
    if args[:1] == ["/Run"]:
        if not registered:
            return 1
        _start_gateway()
        return 0
    return 2


def gateway():
    """Dial the machine's portal server like the adapter does, answer its calls with nothing."""
    sys.path.insert(0, str(HERE.parent / "dashboard"))
    import aiohttp

    from portal.link import GatewayClient

    class Quiet:
        def __getattr__(self, name):
            if name in ("new_thread", "adopt", "inbound", "resolve", "set_session_model"):

                async def call(*args):
                    return None

                return call
            return lambda *args: [] if name in ("sessions", "archived_sessions") else None

    async def run():
        async with aiohttp.ClientSession() as http:
            client = GatewayClient(os.environ["FAKE_HERMES_LINK"], os.environ["FAKE_HERMES_TOKEN"], os.environ["FAKE_HERMES_CODE"], Quiet())
            await client.run(http)

    asyncio.run(run())


if __name__ == "__main__":
    kind, rest = sys.argv[1], sys.argv[2:]
    if kind == "gateway":
        gateway()
    else:
        raise SystemExit(hermes(rest) if kind == "hermes" else schtasks(rest))
