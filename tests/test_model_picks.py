"""Model presets and starred models are kept by the portal server, so a cleared browser, a
reinstalled app or a second device still has them."""

import aiohttp
import pytest
from conftest import ORIGIN
from portal.store import Store

FAST = {"id": "p1", "name": "Quick", "icon": "🐇", "pick": {"provider": "fast", "model": "small", "effort": "low", "speed": "fast"}}
DEEP = {"id": "p2", "name": "Deep", "icon": "", "pick": {"provider": "fast", "model": "small", "effort": "high", "speed": ""}}


@pytest.mark.parametrize("path, body", [
    ("presets", []),
    ("presets", {**FAST, "pick": []}),
    ("favorites", []),
])
async def test_wrong_json_types_are_validation_errors(world, path, body):
    await world.sign_up()
    response = await world.http.post(world.url(f"/api/model-picks/{path}"), json=body, headers={"Origin": ORIGIN})
    assert response.status == 400
    assert "error" in await response.json()
    assert await read(world) == {"presets": [], "favorites": []}


async def read(world, http=None):
    return await (await (http or world.http).get(world.url("/api/model-picks"))).json()


async def test_saved_presets_and_stars_outlive_the_browser_and_a_restart(world):
    await world.sign_up()
    await world.post("/api/model-picks/presets", FAST)
    await world.post("/api/model-picks/presets", DEEP)
    await world.post("/api/model-picks/presets", {**FAST, "name": "Quicker"})
    await world.post("/api/model-picks/favorites", {"provider": "fast", "model": "tiny"})
    await world.post("/api/model-picks/favorites", {"provider": "fast", "model": "small", "effort": "high", "speed": ""})

    # A browser with none of the first one's storage, signed in with the same passkey.
    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as other:
        world.http, first = other, world.http
        await world.sign_up()
        seen = await read(world, other)
        world.http = first
    assert [(p["id"], p["name"]) for p in seen["presets"]] == [("p1", "Quicker"), ("p2", "Deep")]
    assert seen["favorites"] == [
        {"provider": "fast", "model": "tiny"},
        {"provider": "fast", "model": "small", "effort": "high", "speed": ""},
    ]
    assert Store(world.store.path).model_picks() == seen


async def test_a_star_toggles_off_and_a_removed_preset_is_gone(world):
    await world.sign_up()
    await world.post("/api/model-picks/presets", FAST)
    await world.post("/api/model-picks/favorites", {"provider": "fast", "model": "tiny"})
    await world.post("/api/model-picks/favorites", {"provider": "fast", "model": "tiny"})
    await world.post("/api/model-picks/presets/p1/remove")
    assert await read(world) == {"presets": [], "favorites": []}


async def test_only_the_signed_in_owner_reads_or_writes_them_and_bad_picks_are_refused(world):
    assert (await world.http.get(world.url("/api/model-picks"))).status == 401
    assert (await world.post("/api/model-picks/presets", FAST)).status == 401
    await world.sign_up()
    nameless = await world.post("/api/model-picks/presets", {**FAST, "name": "  "})
    assert nameless.status == 400
    no_model = await world.post("/api/model-picks/favorites", {"provider": "fast"})
    assert no_model.status == 400
    assert await read(world) == {"presets": [], "favorites": []}
