import asyncio

import aiohttp
import pytest

from conftest import ORIGIN, Authenticator, next_message

pytestmark = pytest.mark.asyncio


async def test_a_setup_link_makes_one_passkey_and_only_that_passkey_signs_in(world):
    signed_out = await world.http.get(world.url("/api/sessions"))
    assert signed_out.status == 401

    used = world.store.new_setup_link()
    options = await (await world.post("/api/register/options", {"setup": used})).json()
    phone = Authenticator()
    finished = await world.post(
        "/api/register/finish", {"challenge_id": options["challenge_id"], "credential": phone.create(options)}
    )
    assert finished.status == 200
    assert (await world.http.get(world.url("/api/sessions"))).status == 200

    # The link is spent: a stranger holding it gets nothing.
    stranger = await world.http.post(world.url("/api/logout"), headers={"Origin": ORIGIN})
    assert stranger.status == 200
    reuse = await world.post("/api/register/options", {"setup": used})
    assert reuse.status == 403
    assert len(world.store.credentials()) == 1

    # Signing back in with the registered passkey works; an unknown passkey doesn't.
    for authenticator, status in ((Authenticator(), 403), (phone, 200)):
        options = await (await world.post("/api/login/options")).json()
        response = await world.post(
            "/api/login/finish", {"challenge_id": options["challenge_id"], "credential": authenticator.get(options)}
        )
        assert response.status == status
    assert (await world.http.get(world.url("/api/sessions"))).status == 200


async def test_forged_sign_ins_are_refused(world):
    phone = await world.sign_up()
    await world.post("/api/logout")

    # A replayed counter (a cloned key), a ceremony run on another site, and a stale challenge.
    options = await (await world.post("/api/login/options")).json()
    cloned = await world.post(
        "/api/login/finish", {"challenge_id": options["challenge_id"], "credential": phone.get(options, count=1)}
    )
    assert cloned.status == 400

    setup = world.store.new_setup_link()
    options = await (await world.post("/api/register/options", {"setup": setup})).json()
    phished = await world.post(
        "/api/register/finish",
        {"challenge_id": options["challenge_id"], "credential": Authenticator().create(options, origin="https://evil.test")},
    )
    assert phished.status == 400
    assert world.store.setup_link_valid(setup)

    options = await (await world.post("/api/login/options")).json()
    first = await world.post("/api/login/finish", {"challenge_id": options["challenge_id"], "credential": phone.get(options)})
    replay = await world.post("/api/login/finish", {"challenge_id": options["challenge_id"], "credential": phone.get(options)})
    assert (first.status, replay.status) == (200, 400)
    assert len(world.store.credentials()) == 1


async def test_writes_from_another_site_are_refused_even_when_signed_in(world):
    await world.sign_up()
    world.hermes.add_session("20261024_010101_aaaaaa", "build the thing")
    forged = await world.post(
        "/api/sessions/20261024_010101_aaaaaa/archive", {"archived": True}, origin="https://evil.test"
    )
    assert forged.status == 403
    assert not world.hermes.sessions["20261024_010101_aaaaaa"].get("archived")
    with pytest.raises(aiohttp.WSServerHandshakeError) as refused:
        await world.http.ws_connect(world.url("/ws"), headers={"Origin": "https://evil.test"})
    assert refused.value.status == 403


async def test_desktop_and_portal_see_one_conversation_both_ways(world):
    sid = world.hermes.add_session(
        "20261024_020202_bbbbbb", "fix the build", messages=[("user", "why is ci red"), ("assistant", "lint failed")]
    )
    world.hermes.add_session("20261024_030303_cccccc", "watch run", source="cron")
    await world.sign_up()

    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert [row["id"] for row in listed] == [sid]

    opened = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
    assert [(m["role"], m["text"]) for m in opened["messages"]] == [("user", "why is ci red"), ("assistant", "lint failed")]

    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)

    # Desktop to portal: a turn typed in Desktop streams into the open portal tab.
    await world.hermes.desktop_turn(sid, "and now?")
    delta = await next_message(ws, lambda m: m.get("type") == "message.delta")
    assert (delta["session"], delta["payload"]["text"]) == (sid, "hello from hermes")
    await next_message(ws, lambda m: m.get("type") == "message.complete")

    # Portal to desktop: a message sent here lands in the same transcript Desktop reads.
    sent = await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "ship it"}, headers={"Origin": ORIGIN})
    assert sent.status == 200
    await next_message(ws, lambda m: m.get("type") == "message.complete")
    texts = [row["text"] for row in world.hermes.sessions[sid]["rows"]]
    assert texts[-2:] == ["ship it", "hello from hermes"]
    # A turn started from the portal says so when it's done, with the start of the reply;
    # Desktop's own turns stay quiet.
    assert [alert[2] for alert in world.alerts] == ["hello from hermes"]

    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert listed[0]["status"] == "done"
    await ws.close()


async def test_a_new_portal_chat_is_a_desktop_session(world):
    await world.sign_up()
    created = await world.http.post(world.url("/api/sessions"), data={"text": "plan my week"}, headers={"Origin": ORIGIN})
    assert created.status == 200
    session = (await created.json())["session"]
    stored = world.hermes.sessions[session]
    assert stored["source"] == "desktop"
    assert stored["title"] == "plan my week"
    assert stored["rows"][0]["text"] == "plan my week"


async def test_approvals_are_answered_from_the_portal(world):
    sid = world.hermes.add_session("20261024_040404_dddddd", "cleanup")
    world.hermes.ask_approval = True
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await world.http.get(world.url(f"/api/sessions/{sid}"))
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)
    await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "clean up"}, headers={"Origin": ORIGIN})

    card = await next_message(ws, lambda m: m.get("kind") == "request")
    assert card["request"]["params"]["command"] == "rm -rf build"
    assert ("needs your ok" in [alert[2] for alert in world.alerts])

    bogus = await world.post("/api/requests/req-1", {"result": {"choice": "always"}})
    assert bogus.status == 400
    assert world.hermes.answers == []

    answered = await world.post("/api/requests/req-1", {"result": {"choice": "once"}})
    assert answered.status == 200
    assert world.hermes.answers == [{"id": "req-1", "result": {"choice": "once"}}]
    closed = await next_message(ws, lambda m: m.get("kind") == "request.closed")
    assert closed["id"] == "req-1"
    again = await world.post("/api/requests/req-1", {"result": {"choice": "once"}})
    assert again.status == 400
    await ws.close()


async def test_only_files_the_agent_delivered_can_be_downloaded(world, tmp_path):
    report = tmp_path / "report.txt"
    report.write_text("quarterly numbers")
    secret = tmp_path / "secret.txt"
    secret.write_text("do not leak")
    sid = world.hermes.add_session(
        "20261024_050505_eeeeee",
        "report",
        messages=[("user", f"is {secret} there?"), ("assistant", f"here you go\nMEDIA:{report}\nalso see {secret}")],
    )
    await world.sign_up()

    delivered = await world.http.get(world.url("/api/file"), params={"session": sid, "path": str(report)})
    assert (delivered.status, await delivered.text()) == (200, "quarterly numbers")
    for path in (secret, "/etc/passwd"):
        refused = await world.http.get(world.url("/api/file"), params={"session": sid, "path": str(path)})
        assert refused.status == 404


async def test_pins_and_archives_reach_desktop(world):
    sid = world.hermes.add_session("20261024_060606_ffffff", "notes")
    await world.sign_up()
    await world.http.get(world.url(f"/api/sessions/{sid}"))
    assert (await world.post(f"/api/sessions/{sid}/pin", {"pinned": True})).status == 200
    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert listed[0]["pinned"] is True
    assert world.pins.pinned() == {sid}
    assert (await world.post(f"/api/sessions/{sid}/archive", {"archived": True})).status == 200
    assert world.hermes.sessions[sid]["archived"] is True
    assert await (await world.http.get(world.url("/api/sessions"))).json() == []


async def test_a_notification_shows_the_start_of_the_reply_as_plain_text():
    from portal.hub import _preview

    reply = "## Fixed\n\nThe **build** passes now, see [the run](https://example.com/run).\nMEDIA:/tmp/shot.png\n`git push` next."
    assert _preview(reply) == "Fixed The build passes now, see the run. git push next."
    long = _preview("word " * 200)
    assert len(long) == 280 and long.endswith("…")
    assert _preview("MEDIA:/tmp/only.png") == ""
