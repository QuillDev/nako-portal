import aiohttp
import pytest

from conftest import ORIGIN, ROOT, Backend, Hub, Portal, next_message

pytestmark = pytest.mark.asyncio


async def ids(world):
    return {row["id"] for row in await (await world.http.get(world.url("/api/sessions"))).json()}


async def test_switching_profiles_shows_only_that_profiles_chats(world):
    await world.sign_up()
    world.hermes.add_session("work", "work chat", profile="default")
    world.hermes.add_session("home", "home chat", profile="work")

    shown = await (await world.http.get(world.url("/api/profile"))).json()
    assert shown == {"profile": "default", "profiles": ["default", "work", "research"]}
    assert await ids(world) == {"work"}

    switched = await world.post("/api/profile", {"profile": "work"})
    assert (await switched.json())["profile"] == "work"
    assert await ids(world) == {"home"}
    # The other profile's chats can't be opened or written to either.
    assert (await world.http.get(world.url("/api/sessions/work"))).status != 200
    sent = await world.http.post(world.url("/api/sessions/work/messages"), data=aiohttp.FormData({"text": "hi"}), headers={"Origin": ORIGIN})
    assert sent.status != 200
    assert world.hermes.received == []

    await world.post("/api/profile", {"profile": "default"})
    assert await ids(world) == {"work"}


async def test_a_new_chat_belongs_to_the_profile_on_screen(world):
    await world.sign_up()
    await world.post("/api/profile", {"profile": "work"})
    form = aiohttp.FormData({"text": "plan my weekend"})
    created = await (await world.http.post(world.url("/api/sessions"), data=form, headers={"Origin": ORIGIN})).json()
    assert await ids(world) == {created["session"]}

    await world.post("/api/profile", {"profile": "default"})
    assert created["session"] not in await ids(world)


async def test_an_unknown_profile_is_refused_and_nothing_changes(world):
    await world.sign_up()
    world.hermes.add_session("work", "work chat", profile="default")
    refused = await world.post("/api/profile", {"profile": "nope"})
    assert refused.status == 400
    assert (await (await world.http.get(world.url("/api/profile"))).json())["profile"] == "default"
    assert await ids(world) == {"work"}


async def test_the_chosen_profile_survives_a_restart(world):
    await world.sign_up()
    await world.post("/api/profile", {"profile": "work"})

    world.hermes.profile = "default"  # a fresh gateway starts on the default profile
    Portal(Hub(Backend(world.hermes)), world.store, origin=ORIGIN, web_root=ROOT / "dashboard" / "web")
    assert world.hermes.profile == "work"


async def test_every_open_tab_hears_about_a_switch(world):
    await world.sign_up()
    async with world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN}) as ws:
        await world.post("/api/profile", {"profile": "work"})
        frame = await next_message(ws, lambda m: m.get("kind") == "profile.changed")
        assert frame["profile"] == "work"


async def test_switching_needs_a_signed_in_person(world):
    async with aiohttp.ClientSession() as stranger:
        refused = await stranger.post(world.url("/api/profile"), json={"profile": "work"}, headers={"Origin": ORIGIN})
        assert refused.status == 401
    assert world.hermes.profile == "default"
