"""Detached machine restart/update runner (`dashboard/portal/machine_job.py`)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from portal.machine_job import Job, parse_version


def _stub_hermes(tmp_path: Path, *, behavior: str) -> tuple[list[str], Path]:
    calls = tmp_path / "calls.jsonl"
    script = tmp_path / "stub_hermes.py"
    script.write_text(
        "import json, pathlib, sys\n"
        f"calls = pathlib.Path({str(calls)!r})\n"
        f"state = pathlib.Path({str(tmp_path / 'ver')!r})\n"
        "with calls.open('a') as f: f.write(json.dumps(sys.argv[1:]) + chr(10))\n"
        + behavior,
        encoding="utf-8",
    )
    return [sys.executable, str(script)], calls


def _run_job(tmp_path: Path, *, kind: str, hermes: list[str], channel: str | None = None, platform: str = "linux") -> dict:
    job_file = tmp_path / "job.json"
    log_file = tmp_path / "job.log"
    log_file.write_text("", encoding="utf-8")
    job_file.write_text(
        json.dumps({
            "id": "j1",
            "kind": kind,
            "channel": channel,
            "status": "starting",
            "hermes": hermes,
            "platform": platform,
            "log": str(log_file),
        }),
        encoding="utf-8",
    )
    Job(job_file).main()
    return json.loads(job_file.read_text(encoding="utf-8"))


def test_parse_version_handles_standard_rebranded_and_invalid_lines():
    full = parse_version("noise\nHermes Agent v0.22.5 (2026.9.24) · stable · commit 3333bbbb4444\n")
    assert full == {
        "version": "v0.22.5",
        "date": "2026.9.24",
        "channel": "stable",
        "commit": "3333bbbb4444",
        "line": "Hermes Agent v0.22.5 (2026.9.24) · stable · commit 3333bbbb4444",
    }

    rebranded = parse_version("Nako Agent v1.2.0-rc1 (2026.11.01) · main · git deadbeef1234")
    assert rebranded is not None
    assert (rebranded["version"], rebranded["channel"], rebranded["commit"]) == ("v1.2.0-rc1", "main", "deadbeef1234")

    minimal = parse_version("Hermes Agent v0.9.0")
    assert minimal is not None and minimal["version"] == "v0.9.0" and minimal["commit"] is None

    assert parse_version("") is None
    assert parse_version("not a version line") is None


def test_start_job_runs_gateway_start_without_restarting(tmp_path):
    hermes, calls = _stub_hermes(
        tmp_path,
        behavior=(
            "if sys.argv[1:] == ['--version']: print('Hermes Agent v0.22.2 (2026.9.1) · stable · commit 1111aaaa'); sys.exit(0)\n"
            "print('gateway started'); sys.exit(0)\n"
        ),
    )
    result = _run_job(tmp_path, kind="start", hermes=hermes)
    assert result["status"] == "done"
    assert result["started_gateway"] is True
    assert result["old"]["version"] == "v0.22.2"
    assert result["new"]["version"] == "v0.22.2"
    assert "gateway started" in result["log_tail"]
    recorded = [json.loads(line) for line in calls.read_text().splitlines()]
    assert ["gateway", "start"] in recorded
    assert ["gateway", "restart"] not in recorded


def test_restart_job_falls_back_to_gateway_start_when_restart_fails(tmp_path):
    hermes, calls = _stub_hermes(
        tmp_path,
        behavior=(
            "if sys.argv[1:] == ['--version']: print('Hermes Agent v0.22.2'); sys.exit(0)\n"
            "if sys.argv[1:] == ['gateway', 'restart']: print('not running'); sys.exit(1)\n"
            "if sys.argv[1:] == ['gateway', 'start']: print('started fresh'); sys.exit(0)\n"
            "sys.exit(2)\n"
        ),
    )
    result = _run_job(tmp_path, kind="restart", hermes=hermes)
    assert result["status"] == "done"
    assert result["started_gateway"] is True
    assert "started fresh" in result["log_tail"]
    recorded = [json.loads(line) for line in calls.read_text().splitlines()]
    assert recorded.index(["gateway", "restart"]) < recorded.index(["gateway", "start"])


def test_update_job_passes_channel_records_versions_and_restarts(tmp_path):
    (tmp_path / "ver").write_text("v0.22.2 · stable · commit 1111aaaa", encoding="utf-8")
    hermes, calls = _stub_hermes(
        tmp_path,
        behavior=(
            "if sys.argv[1:] == ['--version']: print('Hermes Agent ' + state.read_text()); sys.exit(0)\n"
            "if sys.argv[1:2] == ['update']: state.write_text('v0.23.0 · beta · commit 9999ffff'); print('updated'); sys.exit(0)\n"
            "if sys.argv[1:] == ['gateway', 'restart']: print('restarted'); sys.exit(0)\n"
            "sys.exit(2)\n"
        ),
    )
    result = _run_job(tmp_path, kind="update", hermes=hermes, channel="beta")
    assert result["status"] == "done"
    assert result["update_exit"] == 0
    assert result["started_gateway"] is True
    assert result["old"]["version"] == "v0.22.2"
    assert result["new"]["version"] == "v0.23.0"
    recorded = [json.loads(line) for line in calls.read_text().splitlines()]
    assert ["update", "--yes", "--channel", "beta"] in recorded


def test_failed_update_still_starts_gateway_and_marks_job_failed(tmp_path):
    hermes, calls = _stub_hermes(
        tmp_path,
        behavior=(
            "if sys.argv[1:] == ['--version']: print('Hermes Agent v0.22.2'); sys.exit(0)\n"
            "if sys.argv[1:2] == ['update']: print('network error'); sys.exit(1)\n"
            "if sys.argv[1:] == ['gateway', 'restart']: print('back up'); sys.exit(0)\n"
            "sys.exit(2)\n"
        ),
    )
    result = _run_job(tmp_path, kind="update", hermes=hermes)
    assert result["status"] == "failed"
    assert result["update_exit"] == 1
    assert result["started_gateway"] is True
    assert "network error" in result["log_tail"]
    recorded = [json.loads(line) for line in calls.read_text().splitlines()]
    assert ["gateway", "restart"] in recorded


def test_missing_command_marks_job_failed_cleanly(tmp_path):
    result = _run_job(tmp_path, kind="restart", hermes=[str(tmp_path / "does-not-exist")])
    assert result["status"] == "failed"
    assert result["started_gateway"] is False
    assert result["old"] is None
    assert "couldn't run it" in result["log_tail"]
