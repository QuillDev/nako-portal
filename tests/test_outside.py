"""Sessions that came in another way (Slack, Discord, cron, the CLI): the app lists them, shows
which are running a turn, and opens them read-only."""

from __future__ import annotations

import pytest
from conftest import ORIGIN, next_message

pytestmark = pytest.mark.asyncio

SLACK = "20261116_090000_slack1"
CRON = "local-cron0000000000000000"
DISCORD = "20261116_080000_disc01"


def _seed(hermes):
    hermes.add_session("20261116_100000_portal", "Trip budget", messages=[("user", "hi"), ("assistant", "hello")])
    hermes.add_session(DISCORD, "Book club picks", source="discord", last_active=1_000, messages=[("user", "picks?"), ("assistant", "three of them")])
    hermes.add_session(SLACK, "Shipping export", source="slack", last_active=3_000, messages=[("user", "is the export short?"), ("assistant", "4 orders moved to tonight")])
    hermes.add_session(CRON, "Morning digest", source="cron", last_active=2_000, messages=[("user", "digest"), ("assistant", "five links")])
    # A cron run with nothing saved yet still lists; a turn's helper session doesn't.
    hermes.add_session("local-empty000000000000000", "Inbox check", source="cron", last_active=4_000)
    hermes.add_session("20261116_110000_tool01", "helper", source="tool", last_active=5_000, messages=[("user", "x")])


async def _outside(world, query=""):
    response = await world.http.get(world.url(f"/api/outside{query}"))
    assert response.status == 200, await response.text()
    return [(row["title"], row["source"], row["running"]) for row in await response.json()]


async def test_sessions_from_elsewhere_list_latest_first_and_stay_out_of_the_sidebar(world):
    await world.sign_up()
    _seed(world.hermes)

    assert await _outside(world) == [
        ("Inbox check", "cron", False),
        ("Shipping export", "slack", False),
        ("Morning digest", "cron", False),
        ("Book club picks", "discord", False),
    ]
    assert await _outside(world, "?source=cron") == [("Inbox check", "cron", False), ("Morning digest", "cron", False)]
    assert await _outside(world, "?offset=3") == [("Book club picks", "discord", False)]

    sidebar = await (await world.http.get(world.url("/api/sessions"))).json()
    assert [row["title"] for row in sidebar] == ["Trip budget"]


async def test_the_app_hears_which_sessions_elsewhere_are_running_without_any_alert(world):
    await world.sign_up()
    _seed(world.hermes)
    await world.hermes.hub.outside({"sources": ["cron", "discord", "slack"], "running": []})
    sticker = world.hub.sticker()

    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    joined = await next_message(ws, lambda m: m.get("kind") == "outside")
    assert joined == {"kind": "outside", "sources": ["cron", "discord", "slack"], "running": []}

    await world.hermes.hub.outside({"sources": ["cron", "discord", "slack"], "running": [SLACK]})
    started = await next_message(ws, lambda m: m.get("kind") == "outside")
    assert started["running"] == [SLACK]
    assert await _outside(world) == [
        ("Inbox check", "cron", False),
        ("Shipping export", "slack", True),
        ("Morning digest", "cron", False),
        ("Book club picks", "discord", False),
    ]

    await world.hermes.hub.outside({"sources": ["cron", "discord", "slack"], "running": []})
    assert (await next_message(ws, lambda m: m.get("kind") == "outside"))["running"] == []
    # Watching isn't being told: nothing pinged, and nothing counts toward the sticker.
    assert world.alerts == []
    assert world.hub.sticker() == sticker
    assert SLACK not in world.hub.status
    await ws.close()


async def test_a_gateway_going_away_stops_showing_sessions_elsewhere_as_running(world):
    await world.sign_up()
    _seed(world.hermes)
    await world.hermes.hub.outside({"sources": ["slack"], "running": [SLACK]})
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    assert (await next_message(ws, lambda m: m.get("kind") == "outside"))["running"] == [SLACK]

    await world.gateway.stop(world.hub)
    gone = await next_message(ws, lambda m: m.get("kind") == "outside")
    assert gone == {"kind": "outside", "sources": ["slack"], "running": []}
    await ws.close()


async def test_a_session_from_elsewhere_opens_read_only(world):
    await world.sign_up()
    _seed(world.hermes)

    opened = await (await world.http.get(world.url(f"/api/sessions/{SLACK}"))).json()
    assert opened["source"] == "slack"
    assert [m["text"] for m in opened["messages"]] == ["is the export short?", "4 orders moved to tonight"]
    portal = await (await world.http.get(world.url("/api/sessions/20261116_100000_portal"))).json()
    assert portal["source"] == "portal"

    for path, body in (
        ("messages", None),
        ("stop", None),
        ("title", {"title": "mine now"}),
        ("pin", {"pinned": True}),
        ("archive", {"archived": True}),
    ):
        if body is None:
            response = await world.http.post(world.url(f"/api/sessions/{SLACK}/{path}"), data={"text": "take over"}, headers={"Origin": ORIGIN})
        else:
            response = await world.post(f"/api/sessions/{SLACK}/{path}", body)
        assert response.status == 400, (path, response.status, await response.text())

    session = world.hermes.sessions[SLACK]
    assert (session["title"], session["pinned"], session["archived"], len(session["rows"])) == ("Shipping export", False, False, 2)
    assert world.hermes.received == []


async def test_a_turns_helper_session_does_not_open(world):
    await world.sign_up()
    _seed(world.hermes)
    response = await world.http.get(world.url("/api/sessions/20261116_110000_tool01"))
    assert response.status >= 400
