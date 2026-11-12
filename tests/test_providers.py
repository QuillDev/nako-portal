"""Settings > Providers: the list `hermes model` offers, an API key pasted into it, and a
sign-in that finishes on the provider's own page."""

import importlib.util
import json
from types import SimpleNamespace

from conftest import ORIGIN, ROOT, next_message

KEY = "sk-or-not-a-real-key-1234"

ROWS = [
    {"slug": "openrouter", "label": "OpenRouter", "description": "unified API", "kind": "key", "command": "", "env_var": "OPENROUTER_API_KEY", "env_vars": ["OPENROUTER_API_KEY"], "signup_url": "https://openrouter.ai/keys"},
    {"slug": "anthropic", "label": "Anthropic", "description": "Claude models", "kind": "key", "command": "", "env_var": "ANTHROPIC_API_KEY", "env_vars": ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"], "signup_url": ""},
    {"slug": "openai-codex", "label": "ChatGPT or Codex Subscription", "description": "your ChatGPT plan", "kind": "signin", "command": "", "env_var": "", "env_vars": [], "signup_url": ""},
    {"slug": "qwen-oauth", "label": "Qwen", "description": "Qwen CLI", "kind": "cli", "command": "hermes auth add qwen-oauth", "env_var": "", "env_vars": [], "signup_url": ""},
]


def a_hermes_that_lists(rows=ROWS):
    return rows


async def test_the_page_lists_what_hermes_offers_and_which_are_set_up(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()
    world.hermes.provider_keys["anthropic"] = "sk-ant-saved"
    world.hermes.provider_accounts["openai-codex"] = True

    listed = await (await world.http.get(world.url("/api/providers"))).json()

    assert [(r["slug"], r["kind"], r["connected"]) for r in listed] == [
        ("openrouter", "key", False),
        ("anthropic", "key", True),
        ("openai-codex", "signin", True),
        ("qwen-oauth", "cli", False),
    ]
    # A key never comes back, not even the one that is saved.
    assert "sk-ant-saved" not in json.dumps(listed)


async def test_a_pasted_key_is_saved_and_the_list_says_so(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})

    saved = await world.post("/api/providers/openrouter/key", {"value": KEY})
    assert saved.status == 200, await saved.text()
    assert world.hermes.provider_keys == {"openrouter": KEY}
    await next_message(ws, lambda m: m.get("kind") == "providers.changed")

    listed = await (await world.http.get(world.url("/api/providers"))).json()
    assert next(r for r in listed if r["slug"] == "openrouter")["connected"] is True
    assert KEY not in json.dumps(listed)
    await ws.close()


async def test_an_empty_key_is_refused_before_anything_is_saved(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()

    refused = await world.post("/api/providers/openrouter/key", {"value": "  "})

    assert refused.status == 400
    assert world.hermes.provider_keys == {}


async def test_a_key_cannot_be_pasted_into_a_provider_that_signs_in(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()

    refused = await world.post("/api/providers/openai-codex/key", {"value": KEY})

    assert refused.status == 400
    assert world.hermes.provider_keys == {}


async def test_removing_a_key_takes_it_out_of_the_list(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()
    world.hermes.provider_keys["openrouter"] = KEY

    removed = await world.post("/api/providers/openrouter/remove")

    assert removed.status == 200, await removed.text()
    assert world.hermes.provider_keys == {}
    listed = await (await world.http.get(world.url("/api/providers"))).json()
    assert next(r for r in listed if r["slug"] == "openrouter")["connected"] is False


async def test_signing_in_shows_a_code_and_the_list_flips_once_it_is_approved(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()

    started = await (await world.post("/api/providers/openai-codex/signin")).json()
    assert started["user_code"] == "K7QF-M2XD"
    assert started["verification_url"] == "https://example.test/device"

    pending = await (await world.http.get(world.url(f"/api/providers/openai-codex/signin/{started['session_id']}"))).json()
    assert pending["status"] == "pending"

    world.hermes.signin_status["openai-codex"] = "approved"
    world.hermes.provider_accounts["openai-codex"] = True
    done = await (await world.http.get(world.url(f"/api/providers/openai-codex/signin/{started['session_id']}"))).json()
    assert done["status"] == "approved"
    listed = await (await world.http.get(world.url("/api/providers"))).json()
    assert next(r for r in listed if r["slug"] == "openai-codex")["connected"] is True


async def test_a_terminal_only_provider_says_so_instead_of_starting_anything(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()

    refused = await world.post("/api/providers/qwen-oauth/signin")

    assert refused.status == 400
    assert "terminal" in (await refused.json())["error"]
    assert world.hermes.signin_pending == {}


async def test_a_finished_or_unknown_signin_is_not_reported_as_pending(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists()

    gone = await world.http.get(world.url("/api/providers/openai-codex/signin/gone"))

    assert gone.status == 404


async def test_providers_need_a_signed_in_page_from_this_origin(world):
    world.hermes.provider_list = a_hermes_that_lists()
    assert (await world.http.get(world.url("/api/providers"))).status == 401
    assert (await world.http.post(world.url("/api/providers/openrouter/key"), json={"value": KEY}, headers={"Origin": ORIGIN})).status == 401
    await world.sign_up()
    assert (await world.post("/api/providers/openrouter/key", {"value": KEY}, origin="https://evil.example.test")).status == 403
    assert world.hermes.provider_keys == {}


# Which providers the adapter offers, from catalog entries shaped like `hermes model`'s.

def _plugin():
    spec = importlib.util.spec_from_file_location("nako_portal_providers_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


def _entry(slug, key_vars=(), base_url_var="", auth_type="api_key", tab="keys"):
    return SimpleNamespace(slug=slug, label=slug.title(), description="", auth_type=auth_type, tab=tab,
                           api_key_env_vars=tuple(key_vars), base_url_env_var=base_url_var, signup_url="")


ENDPOINTS = {
    "deepseek": "https://api.deepseek.example.test/v1",
    "anthropic": "https://api.anthropic.example.test",
    "azure-foundry": "",
    "lmstudio": "http://127.0.0.1:1234/v1",
    "bedrock": "https://bedrock.example.test",
}


def _offered(entries, env=None):
    plugin = _plugin()
    rows = [plugin._provider_row(e, env or {}, {}, endpoint=ENDPOINTS.get) for e in entries]
    return {r["slug"]: r for r in rows if r is not None}


def test_a_key_provider_with_an_optional_address_override_is_still_offered():
    offered = _offered([
        _entry("deepseek", ["DEEPSEEK_API_KEY"], "DEEPSEEK_BASE_URL"),
        _entry("anthropic", ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"], "ANTHROPIC_BASE_URL"),
        _entry("openrouter", ["OPENROUTER_API_KEY"]),
    ], env={"ANTHROPIC_TOKEN": "set"})

    assert sorted(offered) == ["anthropic", "deepseek", "openrouter"]
    assert offered["deepseek"]["env_var"] == "DEEPSEEK_API_KEY"
    assert offered["anthropic"]["connected"] is True


def test_providers_a_key_alone_cannot_run_are_left_out():
    offered = _offered([
        _entry("azure-foundry", ["AZURE_FOUNDRY_API_KEY"], "AZURE_FOUNDRY_BASE_URL"),
        _entry("lmstudio", ["LM_API_KEY"], "LM_BASE_URL"),
        _entry("bedrock", auth_type="aws_sdk"),
        _entry("moa", auth_type="virtual"),
    ])

    assert offered == {}


async def test_one_more_account_signs_in_through_the_page(world):
    await world.sign_up()
    world.hermes.provider_list = a_hermes_that_lists(ROWS + [
        {"slug": "claude-sub", "label": "Claude Subscription", "description": "", "kind": "cli", "command": "", "env_var": "", "env_vars": [], "signup_url": ""}])
    world.hermes.account_logins["claude-sub"] = {"mode": "paste", "accounts": [
        {"id": "primary", "label": "primary", "email": "alex@example.test", "plan": "Max", "signed_in": True}]}
    world.hermes.account_logins["openai-codex"] = {"mode": "code", "accounts": []}
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})

    started = await (await world.post("/api/providers/claude-sub/accounts/signin", {})).json()
    assert started["mode"] == "paste" and started["url"].startswith("https://")
    done = await world.post(f"/api/providers/claude-sub/accounts/signin/{started['attempt']}/code", {"code": "sam@example.test"})
    assert (await done.json())["outcome"] == "added"
    await next_message(ws, lambda m: m.get("kind") == "providers.changed")

    started = await (await world.post("/api/providers/openai-codex/accounts/signin", {})).json()
    assert started["mode"] == "code" and started["user_code"]
    poll = world.url(f"/api/providers/openai-codex/accounts/signin/{started['attempt']}")
    assert (await (await world.http.get(poll)).json())["status"] == "pending"
    world.hermes.approve_account(started["attempt"], "kim@example.test")
    assert (await (await world.http.get(poll)).json())["result"]["outcome"] == "added"

    listed = {r["slug"]: r for r in await (await world.http.get(world.url("/api/providers"))).json()}
    assert [a["email"] for a in listed["claude-sub"]["accounts"]] == ["alex@example.test", "sam@example.test"]
    assert [a["email"] for a in listed["openai-codex"]["accounts"]] == ["kim@example.test"]
    assert listed["openai-codex"]["connected"] is True

    refused = await world.post(f"/api/providers/claude-sub/accounts/signin/{started['attempt']}x/code", {"code": "bad"})
    assert refused.status == 400
    await ws.close()
