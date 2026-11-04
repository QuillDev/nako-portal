"""Environments: an optional page fed by a command the owner sets; without one the portal has no such page."""

from __future__ import annotations

import json
import sys

import pytest

from portal.environments import Environments

pytestmark = pytest.mark.asyncio


def _command(tmp_path, output, *, exit_code=0, stderr=""):
    """A command that prints `output`, logs each run to a file, and exits with `exit_code`."""
    script = tmp_path / "envs.py"
    runs = tmp_path / "runs"
    script.write_text(
        "import sys\n"
        f"open({str(runs)!r}, 'a').write('x')\n"
        f"sys.stdout.write({output!r})\n"
        f"sys.stderr.write({stderr!r})\n"
        f"sys.exit({exit_code})\n"
    )
    return [sys.executable, "-I", str(script)], runs


async def _get(world):
    response = await world.http.get(world.url("/api/environments"))
    return response.status, await response.json()


async def test_without_a_command_there_is_no_environments_page(world):
    await world.sign_up()
    me = await (await world.http.get(world.url("/api/me"))).json()
    assert me["environments"] is False
    status, _ = await _get(world)
    assert status == 404


async def test_the_page_lists_what_the_command_prints(world, tmp_path):
    output = json.dumps({
        "title": "Stacks",
        "environments": [
            {"name": "feature-x", "status": "running", "session": "20261104_101500_ab12cd", "links": [
                {"label": "app", "url": "https://feature-x.example.test/"},
                {"label": "local file", "url": "file:///etc/passwd"},
                {"label": "script", "url": "javascript:alert(1)"},
            ]},
            {"name": "half-up", "status": "partial", "detail": "3 of 7 running", "session": "../../etc"},
            {"name": "odd", "status": "exploded"},
            {"status": "running"},
        ],
        "links": [{"label": "sign in", "url": "https://gate.example.test/key"}],
    })
    command, _ = _command(tmp_path, output)
    world.portal.environments = Environments(command)
    assert (await _get(world))[0] == 401
    await world.sign_up()
    assert (await (await world.http.get(world.url("/api/me"))).json())["environments"] is True
    status, body = await _get(world)
    assert status == 200
    assert body == {
        "title": "Stacks",
        "environments": [
            {"name": "feature-x", "status": "running", "session": "20261104_101500_ab12cd", "links": [{"label": "app", "url": "https://feature-x.example.test/"}]},
            {"name": "half-up", "status": "partial", "detail": "3 of 7 running", "links": []},
            {"name": "odd", "status": "stopped", "links": []},
        ],
        "links": [{"label": "sign in", "url": "https://gate.example.test/key"}],
    }


async def test_the_title_defaults_when_the_command_gives_none(world, tmp_path):
    command, _ = _command(tmp_path, json.dumps({"environments": []}))
    world.portal.environments = Environments(command)
    await world.sign_up()
    assert await _get(world) == (200, {"title": "Environments", "environments": [], "links": []})


async def test_a_failing_command_says_why(world, tmp_path):
    command, _ = _command(tmp_path, "", exit_code=3, stderr="warming up\nstate dir missing\n")
    world.portal.environments = Environments(command)
    await world.sign_up()
    status, body = await _get(world)
    assert status == 502
    assert "state dir missing" in body["error"]


async def test_output_that_isnt_the_expected_json_is_an_error(world, tmp_path):
    command, _ = _command(tmp_path, "stack-a running\n")
    world.portal.environments = Environments(command)
    await world.sign_up()
    status, body = await _get(world)
    assert status == 502
    assert "JSON" in body["error"]


async def test_a_missing_program_is_an_error_not_a_crash(world, tmp_path):
    world.portal.environments = Environments([str(tmp_path / "nope")])
    await world.sign_up()
    status, body = await _get(world)
    assert status == 502
    assert "can't run" in body["error"]


async def test_reads_close_together_run_the_command_once(world, tmp_path):
    command, runs = _command(tmp_path, json.dumps({"environments": []}))
    world.portal.environments = Environments(command, ttl=60)
    await world.sign_up()
    for _ in range(3):
        assert (await _get(world))[0] == 200
    assert runs.read_text() == "x"


async def test_a_slow_command_times_out(tmp_path):
    script = tmp_path / "slow.py"
    script.write_text("import time\ntime.sleep(5)\n")
    environments = Environments([sys.executable, "-I", str(script)], timeout=0.3)
    with pytest.raises(Exception, match="longer than"):
        await environments.read()
