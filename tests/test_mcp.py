"""Settings > MCP servers through the portal's own routes: who may read and change the list,
every open tab hears about a change, and a server's sign-in page can send the browser back."""

from conftest import ORIGIN, next_message


async def test_signed_out_callers_can_neither_read_nor_change_servers(world):
    world.hermes.mcp = {"docs": {"url": "https://docs.example.test/mcp"}}

    assert (await world.http.get(world.url("/api/mcp"))).status == 401
    refused = await world.post("/api/mcp/servers/docs/remove")

    assert refused.status == 401
    assert "docs" in world.hermes.mcp


async def test_a_change_reaches_every_open_tab_and_shows_in_the_list(world):
    await world.sign_up()
    world.hermes.mcp = {"docs": {"url": "https://docs.example.test/mcp"}}
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})

    added = await world.post("/api/mcp/servers", {"name": "files", "command": "npx", "args": ["files-mcp"], "env": {"ROOT": "/srv"}})
    assert added.status == 200, await added.text()
    await next_message(ws, lambda m: m.get("kind") == "mcp.changed")
    off = await world.post("/api/mcp/servers/docs/enabled", {"enabled": False})
    assert off.status == 200
    await next_message(ws, lambda m: m.get("kind") == "mcp.changed")

    listed = await (await world.http.get(world.url("/api/mcp"))).json()
    assert [(r["name"], r["enabled"]) for r in listed["servers"]] == [("docs", False), ("files", True)]
    # A name is refused twice, and nothing about the first one changes.
    again = await world.post("/api/mcp/servers", {"name": "files", "url": "https://other.example.test/mcp"})
    assert again.status == 400
    assert world.hermes.mcp["files"]["command"] == "npx"
    await ws.close()


async def test_a_sign_in_page_sends_the_browser_back_without_the_login_cookie(world):
    await world.sign_up()
    world.hermes.mcp = {"tracker": {"url": "https://tracker.example.test/mcp", "auth": "oauth"}}

    started = await (await world.post("/api/mcp/servers/tracker/signin")).json()
    # The provider is told to come back to this portal's own address.
    assert f"redirect_uri={ORIGIN}/api/mcp/oauth/callback/tracker" in started["authorization_url"]

    world.http.cookie_jar.clear()
    forged = await world.http.get(world.url("/api/mcp/oauth/callback/tracker?code=c&state=wrong"))
    assert forged.status == 404
    assert "tracker" not in world.hermes.mcp_tokens
    back = await world.http.get(world.url("/api/mcp/oauth/callback/tracker?code=c&state=good-state"))
    assert back.status == 200
    assert "Signed in" in await back.text()
    assert "tracker" in world.hermes.mcp_tokens
