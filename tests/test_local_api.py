"""The loopback API scripts on this machine use to start a chat the user can then steer."""

from conftest import LOCAL_TOKEN, ORIGIN


async def _start(world, payload, token=LOCAL_TOKEN):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return await world.http.post(str(world.local.make_url("/sessions")), json=payload, headers=headers)


async def test_a_script_starts_a_portal_thread_that_runs_the_brief(world):
    started = await _start(world, {"text": "build the shell", "title": "Shell build", "yolo": True})
    assert started.status == 200, await started.text()
    session = (await started.json())["session"]
    stored = world.hermes.sessions[session]
    assert stored["title"] == "Shell build"
    assert stored["chat"] in world.hermes.yolo
    assert stored["rows"][0]["text"] == "build the shell"


async def test_approvals_stay_on_unless_the_script_asks(world):
    started = await _start(world, {"text": "look around"})
    session = (await started.json())["session"]
    assert world.hermes.sessions[session]["chat"] not in world.hermes.yolo


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


async def test_a_script_can_follow_up_on_an_existing_chat(world):
    sid = world.hermes.add_session("20261024_050505_eeeeee", "stack pr")
    sent = await world.http.post(
        str(world.local.make_url(f"/sessions/{sid}/messages")), json={"text": "parent moved, restack"}, headers={"Authorization": f"Bearer {LOCAL_TOKEN}"}
    )
    assert sent.status == 200, await sent.text()
    assert [row["text"] for row in world.hermes.sessions[sid]["rows"] if row["role"] == "user"] == ["parent moved, restack"]


async def test_follow_ups_need_the_token_too(world):
    sid = world.hermes.add_session("20261024_060606_ffffff", "stack pr")
    refused = await world.http.post(str(world.local.make_url(f"/sessions/{sid}/messages")), json={"text": "hi"})
    assert refused.status == 401
    assert world.hermes.sessions[sid]["rows"] == []


async def _handoff(world, sid, token=LOCAL_TOKEN):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return await world.http.post(str(world.local.make_url(f"/sessions/{sid}/handoff")), headers=headers)


async def test_a_desktop_chat_handed_off_shows_in_the_portal_with_its_history(world):
    await world.sign_up()
    world.hermes.elsewhere["20261020_101010_aaaaaa"] = {
        "id": "20261020_101010_aaaaaa", "title": "Trip plan", "rows": [{"role": "user", "text": "plan the trip", "row_id": 1, "timestamp": 1_700_000_000}],
        "started_at": 1_700_000_000, "pinned": False, "archived": False,
    }
    moved = await _handoff(world, "20261020_101010_aaaaaa")
    assert moved.status == 200, await moved.text()
    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert [row["title"] for row in listed] == ["Trip plan"]
    opened = await (await world.http.get(world.url("/api/sessions/20261020_101010_aaaaaa"))).json()
    assert [m["text"] for m in opened["messages"]] == ["plan the trip"]
    sent = await world.http.post(world.url("/api/sessions/20261020_101010_aaaaaa/messages"), data={"text": "book the hotel"}, headers={"Origin": ORIGIN})
    assert sent.status == 200, await sent.text()
    assert world.hermes.received[-1][1] == "book the hotel"


async def test_handing_off_an_unknown_or_portal_chat_is_refused(world):
    sid = world.hermes.add_session("20261024_070707_abcdef", "already here")
    for target in ("20261024_080808_000000", sid):
        refused = await _handoff(world, target)
        assert refused.status == 400
    assert list(world.hermes.sessions) == [sid]


async def test_handoff_needs_the_token(world):
    world.hermes.elsewhere["20261020_101010_bbbbbb"] = {"id": "20261020_101010_bbbbbb", "title": "x", "rows": [], "started_at": 0, "pinned": False, "archived": False}
    assert (await _handoff(world, "20261020_101010_bbbbbb", token=None)).status == 401
    assert "20261020_101010_bbbbbb" not in world.hermes.sessions
