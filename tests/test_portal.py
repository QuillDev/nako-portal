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


async def test_a_message_goes_to_the_gateway_and_its_reply_streams_back(world):
    sid = world.hermes.add_session(
        "20261024_020202_bbbbbb", "fix the build", messages=[("user", "why is ci red"), ("assistant", "lint failed")]
    )
    await world.sign_up()

    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert [row["id"] for row in listed] == [sid]
    opened = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
    assert [(m["role"], m["text"]) for m in opened["messages"]] == [("user", "why is ci red"), ("assistant", "lint failed")]

    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": sid})
    await asyncio.sleep(0.05)
    sent = await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data={"text": "ship it"}, headers={"Origin": ORIGIN})
    assert sent.status == 200
    assert world.hermes.received == [(f"chat-{sid}", "ship it", [])]

    await next_message(ws, lambda m: m.get("type") == "message.start")
    shown = await next_message(ws, lambda m: m.get("type") == "gateway.message")
    assert (shown["session"], shown["payload"]["text"]) == (sid, "hello from hermes")
    await next_message(ws, lambda m: m.get("type") == "message.complete")
    texts = [row["text"] for row in world.hermes.sessions[sid]["rows"]]
    assert texts[-2:] == ["ship it", "hello from hermes"]
    # A finished reply says so with its start, on push and on every open socket.
    assert [alert[2] for alert in world.alerts] == ["hello from hermes"]
    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert listed[0]["status"] == "done"
    await ws.close()


async def test_no_alert_for_a_chat_open_in_front_of_you(world):
    sid = world.hermes.add_session("20261024_030303_cccccc", "ci")
    other = world.hermes.add_session("20261024_040404_dddddd", "plans")
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})

    async def reply_in(session):
        await world.http.post(world.url(f"/api/sessions/{session}/messages"), data={"text": "go"}, headers={"Origin": ORIGIN})
        await next_message(ws, lambda m: m.get("session") == session and m.get("type") == "message.complete")

    await ws.send_json({"watch": sid, "looking": True})
    await asyncio.sleep(0.05)
    await reply_in(sid)
    assert world.alerts == []

    # Looking away from the page brings alerts back.
    await ws.send_json({"looking": False})
    await asyncio.sleep(0.05)
    await reply_in(sid)
    assert [alert[0] for alert in world.alerts] == [sid]

    # So does a reply in a chat you aren't showing, even with the page in front of you.
    await ws.send_json({"watch": other, "looking": True})
    await asyncio.sleep(0.05)
    await reply_in(sid)
    assert [alert[0] for alert in world.alerts] == [sid, sid]

    # Closing the page closes its view too.
    await ws.close()
    await asyncio.sleep(0.05)
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": other})
    await asyncio.sleep(0.05)
    await reply_in(other)
    assert [alert[0] for alert in world.alerts] == [sid, sid, other]
    await ws.close()


async def test_a_new_portal_chat_is_a_new_gateway_thread(world):
    await world.sign_up()
    created = await world.http.post(world.url("/api/sessions"), data={"text": "plan my week"}, headers={"Origin": ORIGIN})
    assert created.status == 200
    session = (await created.json())["session"]
    stored = world.hermes.sessions[session]
    assert stored["rows"][0]["text"] == "plan my week"
    # Each new chat is its own thread; the gateway names it after the first answer.
    assert world.hermes.received[0][0] == stored["chat"]
    assert stored["title"] == ""


async def test_the_chat_list_picks_up_a_title_the_gateway_gave_a_chat_after_it_was_listed(world):
    session = world.hermes.add_session("20261025_050505_eeeeee", "")
    await world.sign_up()
    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert [r["title"] for r in listed if r["id"] == session] == ["untitled"]
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await asyncio.sleep(0.05)

    world.hermes.set_title(session, "Plan the week")
    opened = await (await world.http.get(world.url(f"/api/sessions/{session}"))).json()
    assert opened["title"] == "Plan the week"
    await next_message(ws, lambda m: m.get("kind") == "sessions.changed")
    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert [r["title"] for r in listed if r["id"] == session] == ["Plan the week"]
    await ws.close()


async def test_a_post_outside_a_turn_lands_in_the_chat_and_alerts(world):
    inbox = world.hermes.add_session("20261024_040404_dddddd", "Notifications", chat="inbox")
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await ws.send_json({"watch": inbox})
    await asyncio.sleep(0.05)

    await world.hermes.post(inbox, "[Cron delivery: build watch]\nci went red")
    shown = await next_message(ws, lambda m: m.get("type") == "gateway.message")
    assert shown["payload"]["text"] == "[Cron delivery: build watch]\nci went red"
    await next_message(ws, lambda m: m.get("type") == "message.complete")
    await next_message(ws, lambda m: m.get("kind") == "sessions.changed")
    assert [alert[2] for alert in world.alerts] == ["[Cron delivery: build watch] ci went red"]
    await ws.close()


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
    assert world.hermes.answers == [{"id": "req-1", "private": {"session_key": f"key-chat-{sid}"}, "result": {"choice": "once"}}]
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


async def test_a_photo_the_user_sends_can_be_viewed_back_from_the_chat(world):
    sid = world.hermes.add_session("20261024_050606_abcabc", "photo")
    await world.sign_up()
    await world.http.get(world.url(f"/api/sessions/{sid}"))
    form = aiohttp.FormData()
    form.add_field("text", "what is this?")
    form.add_field("file", b"\x89PNG fake", filename="cat.png", content_type="image/png")
    sent = await world.http.post(world.url(f"/api/sessions/{sid}/messages"), data=form, headers={"Origin": ORIGIN})
    assert sent.status == 200

    opened = await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()
    text = next(m["text"] for m in opened["messages"] if m["role"] == "user")
    path = text.split("[Image attached at: ")[1].split("]")[0]
    shown = await world.http.get(world.url("/api/file"), params={"session": sid, "path": path})
    assert (shown.status, await shown.read(), shown.content_type) == (200, b"\x89PNG fake", "image/png")


async def test_images_shown_in_a_chat_are_viewable_but_nothing_else_is(world, tmp_path):
    files = {name: tmp_path / name for name in ("inline.png", "own line.jpg", "hint.png", "ref.webp", "typed.txt", "example.png")}
    for path in files.values():
        path.write_bytes(b"x")
    sid = world.hermes.add_session(
        "20261024_050707_bcdbcd",
        "shots",
        messages=[
            ("user", f"look\n\n[Image attached at: {files['hint.png']}]\n[screenshot]\nand @image:{files['typed.txt']}"),
            ("user", f"again\n@image:`{files['ref.webp']}`"),
            ("assistant", f"the layout is here MEDIA:{files['inline.png']}, then\nMEDIA:{files['own line.jpg']}\n`MEDIA:{files['example.png']}`"),
        ],
    )
    await world.sign_up()
    status = lambda r: r.status  # noqa: E731
    for name in ("inline.png", "own line.jpg", "hint.png", "ref.webp"):
        shown = await world.http.get(world.url("/api/file"), params={"session": sid, "path": str(files[name])})
        assert (name, status(shown)) == (name, 200)
    for name in ("typed.txt", "example.png"):
        refused = await world.http.get(world.url("/api/file"), params={"session": sid, "path": str(files[name])})
        assert (name, status(refused)) == (name, 404)


async def test_a_long_chat_opens_on_its_latest_turns_and_pages_back_through_the_rest(world, tmp_path):
    chart = tmp_path / "chart.png"
    chart.write_bytes(b"x")
    sid = world.hermes.add_session("20261024_070707_aaaaaa", "long one")
    world.hermes._row(sid, "assistant", f"first chart MEDIA:{chart}")
    for turn in range(40):
        world.hermes._row(sid, "user", f"ask {turn}")
        world.hermes._row(sid, "tool", "", name="terminal", context=f"run {turn}a", tool_call_id=f"{turn}a")
        world.hermes._row(sid, "tool", "", name="terminal", context=f"run {turn}b", tool_call_id=f"{turn}b")
        world.hermes._row(sid, "assistant", f"answer {turn}")
    await world.sign_up()

    async def read(**query):
        response = await world.http.get(world.url(f"/api/sessions/{sid}"), params=query)
        assert response.status == 200
        return await response.json()

    def said(messages):
        return [m["text"] if m["role"] != "tool" else m["context"] for m in messages]

    # Opening shows the last 30 prompts and replies (turns 25-39) with their tool calls.
    latest = await read()
    assert said(latest["messages"])[:4] == ["ask 25", "run 25a", "run 25b", "answer 25"]
    assert said(latest["messages"])[-1] == "answer 39"
    assert len(latest["messages"]) == 15 * 4

    # Scrolling up reads the page right before it, and the one before that reaches the start.
    older = await read(before=latest["start"])
    assert said(older["messages"])[0] == "ask 10" and said(older["messages"])[-1] == "answer 24"
    oldest = await read(before=older["start"])
    assert oldest["start"] == 0
    assert said(oldest["messages"])[0] == f"first chart MEDIA:{chart}"
    assert said(oldest["messages"])[-1] == "answer 9"

    # Refreshing what's on screen returns everything from where the open page starts.
    world.hermes._row(sid, "tool", "", name="terminal", context="run late", tool_call_id="late")
    world.hermes._row(sid, "assistant", "late answer")
    refreshed = await read(since=latest["start"])
    assert said(refreshed["messages"])[-3:] == ["answer 39", "run late", "late answer"]
    assert refreshed["start"] == latest["start"]

    # A file delivered long before the open page still opens from the chat.
    shown = await world.http.get(world.url("/api/file"), params={"session": sid, "path": str(chart)})
    assert shown.status == 200
    assert (await world.http.get(world.url(f"/api/sessions/{sid}"), params={"before": "-1"})).status == 400


async def test_cron_posts_read_as_nakos_messages_in_the_notifications_thread(world):
    inbox = world.hermes.add_session(
        "20261024_040404_dddddd",
        "Notifications",
        chat="inbox",
        messages=[("user", "[Cron delivery: build watch]\nci went red on main"), ("user", "[Cron delivery: news digest]\nfive links"), ("user", "which first?"), ("assistant", "the sorting paper")],
    )
    chat = world.hermes.add_session("20261024_070707_aaaaaa", "", messages=[("user", "what is [Cron delivery: x] about")])
    await world.sign_up()

    listed = {row["id"]: row["notifications"] for row in await (await world.http.get(world.url("/api/sessions"))).json()}
    assert listed == {inbox: True, chat: False}

    opened = await (await world.http.get(world.url(f"/api/sessions/{inbox}"))).json()
    assert [(m["role"], m.get("label"), m["text"]) for m in opened["messages"]] == [
        ("assistant", "build watch", "ci went red on main"),
        ("assistant", "news digest", "five links"),
        ("user", None, "which first?"),
        ("assistant", None, "the sorting paper"),
    ]


async def test_the_notifications_chat_is_unread_until_opened_and_again_after_a_new_post(world):
    inbox = world.hermes.add_session("20261024_040404_dddddd", "Notifications", chat="inbox", messages=[("user", "[Cron delivery: build watch]\nci red")])
    chat = world.hermes.add_session("20261024_070707_aaaaaa", "plans", messages=[("user", "hi")])
    await world.sign_up()

    async def unread():
        return {row["id"]: row["unread"] for row in await (await world.http.get(world.url("/api/sessions"))).json()}

    assert await unread() == {inbox: True, chat: False}
    await world.http.get(world.url(f"/api/sessions/{inbox}"))
    assert await unread() == {inbox: False, chat: False}
    world.hermes._row(inbox, "user", "[Cron delivery: build watch]\nci green")
    assert await unread() == {inbox: True, chat: False}


async def test_slash_commands_go_to_the_gateway_like_any_message(world):
    sid = world.hermes.add_session("20261024_020202_bbbbbb", "fix the build", messages=[("user", "hi"), ("assistant", "hello")])
    await world.sign_up()

    listed = await (await world.http.get(world.url("/api/commands"))).json()
    assert [(c["name"], c["skill"]) for c in listed] == [("/status", False), ("/work", True)]
    ran = await world.post(f"/api/sessions/{sid}/command", {"text": "/restart"})
    assert (ran.status, await ran.json()) == (200, {"output": None, "sent": True})
    assert world.hermes.received == [(f"chat-{sid}", "/restart", [])]
    # Stop is the gateway's /stop in that thread.
    assert (await world.post(f"/api/sessions/{sid}/stop")).status == 200
    assert world.hermes.received[-1] == (f"chat-{sid}", "/stop", [])


async def test_the_name_for_the_greeting_is_shared_by_every_signed_in_device(world):
    assert "name" not in await (await world.http.get(world.url("/api/me"))).json()
    assert (await world.post("/api/me/name", {"name": "quill"})).status == 401
    await world.sign_up()
    assert (await (await world.http.get(world.url("/api/me"))).json())["name"] == ""
    saved = await (await world.post("/api/me/name", {"name": "  Quill   Dev  "})).json()
    assert saved == {"name": "Quill Dev"}
    assert (await (await world.http.get(world.url("/api/me"))).json())["name"] == "Quill Dev"


async def test_pins_and_archives_are_saved_on_the_session(world):
    sid = world.hermes.add_session("20261024_060606_ffffff", "notes")
    await world.sign_up()
    await world.http.get(world.url(f"/api/sessions/{sid}"))
    assert (await world.post(f"/api/sessions/{sid}/pin", {"pinned": True})).status == 200
    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert listed[0]["pinned"] is True
    assert world.hermes.sessions[sid]["pinned"] is True
    assert (await world.post(f"/api/sessions/{sid}/archive", {"archived": True})).status == 200
    assert world.hermes.sessions[sid]["archived"] is True
    assert await (await world.http.get(world.url("/api/sessions"))).json() == []


async def test_the_notifications_chat_cant_be_archived_out_of_the_sidebar(world):
    # Archived, it drops out of the list and the bell row has nothing to open.
    inbox = world.hermes.add_session("20261024_070707_eeeeee", "Notifications", chat="inbox")
    await world.sign_up()
    assert (await world.post(f"/api/sessions/{inbox}/archive", {"archived": True})).status == 400
    listed = await (await world.http.get(world.url("/api/sessions"))).json()
    assert [(row["id"], row["notifications"]) for row in listed] == [(inbox, True)]


async def test_a_notification_shows_the_start_of_the_reply_as_plain_text():
    from portal.hub import _preview

    reply = "## Fixed\n\nThe **build** passes now, see [the run](https://example.com/run).\nMEDIA:/tmp/shot.png\n`git push` next."
    assert _preview(reply) == "Fixed The build passes now, see the run. git push next."
    long = _preview("word " * 200)
    assert len(long) == 280 and long.endswith("…")
    assert _preview("MEDIA:/tmp/only.png") == ""
    assert _preview("the layout is here MEDIA:/tmp/a b.png, then done") == "the layout is here, then done"
