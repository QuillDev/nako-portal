"""The loopback API scripts on this machine use to start a chat the user can then steer."""

from conftest import LOCAL_TOKEN


async def _start(world, payload, token=LOCAL_TOKEN):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return await world.http.post(str(world.local.make_url("/sessions")), json=payload, headers=headers)


async def test_a_script_starts_a_desktop_chat_that_runs_the_brief(world):
    started = await _start(world, {"text": "build the shell", "title": "Shell build", "cwd": "/home/me/projects", "yolo": True})
    assert started.status == 200, await started.text()
    session = (await started.json())["session"]
    stored = world.hermes.sessions[session]
    assert stored["source"] == "desktop"
    assert stored["title"] == "Shell build"
    assert stored["cwd"] == "/home/me/projects"
    assert stored["yolo"] is True
    assert stored["rows"][0]["text"] == "build the shell"


async def test_approvals_stay_on_unless_the_script_asks(world):
    started = await _start(world, {"text": "look around"})
    session = (await started.json())["session"]
    assert world.hermes.sessions[session].get("yolo") is None


async def test_the_loopback_api_refuses_callers_without_the_token(world):
    before = set(world.hermes.sessions)
    for token in (None, "wrong"):
        refused = await _start(world, {"text": "hello"}, token=token)
        assert refused.status == 401
    assert set(world.hermes.sessions) == before


async def test_a_signed_in_portal_cookie_is_not_the_token(world):
    await world.sign_up()
    before = set(world.hermes.sessions)
    refused = await world.http.post(str(world.local.make_url("/sessions")), json={"text": "hello"})
    assert refused.status == 401
    assert set(world.hermes.sessions) == before


async def test_an_empty_brief_is_rejected(world):
    before = set(world.hermes.sessions)
    rejected = await _start(world, {"text": "  "})
    assert rejected.status == 400
    assert set(world.hermes.sessions) == before
