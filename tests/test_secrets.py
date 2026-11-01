"""The portal as the place the agent-secrets plugin asks for secrets and shows them."""

import asyncio
import importlib.util
import json
import sys

import pytest

from conftest import ORIGIN, ROOT, next_message

VALUE = "sk_test_51Hx-not-a-real-key"


def _card(request_id="sec-1", name="STRIPE_KEY", note="for the checkout script", replace=False):
    """What the adapter sends the hub when agent-secrets asks (`SecretSurface.ask`)."""
    return {"id": request_id, "method": "secret", "params": {"name": name, "note": note, "replace": replace}, "private": {"secret_request": request_id}}


async def _open(world, sid):
    return await (await world.http.get(world.url(f"/api/sessions/{sid}"))).json()


async def test_a_typed_secret_goes_to_the_gateway_answer_and_nowhere_else(world):
    await world.sign_up()
    sid = world.hermes.add_session("20261101_010101_aaaaaa", "deploy")
    await world.client.call("ask", world.hermes.sessions[sid]["chat"], _card())

    opened = await _open(world, sid)
    assert opened["requests"] == [{"id": "sec-1", "method": "secret", "params": {"name": "STRIPE_KEY", "note": "for the checkout script", "replace": False}, "answerable": True}]
    assert opened["status"] == "needs you"
    assert [alert[2] for alert in world.alerts] == ["needs STRIPE_KEY"]

    answered = await world.post("/api/requests/sec-1", {"result": {"value": VALUE}})
    assert answered.status == 200, await answered.text()
    assert world.hermes.answers == [{"id": "sec-1", "private": {"secret_request": "sec-1"}, "result": {"value": VALUE}}]
    # Not a message, not in the transcript, and the card is gone.
    assert world.hermes.received == []
    opened = await _open(world, sid)
    assert opened["requests"] == [] and VALUE not in json.dumps(opened)


async def test_not_now_declines_and_an_empty_field_answers_nothing(world):
    await world.sign_up()
    sid = world.hermes.add_session("20261101_020202_bbbbbb", "deploy")
    await world.client.call("ask", world.hermes.sessions[sid]["chat"], _card())

    empty = await world.post("/api/requests/sec-1", {"result": {"value": ""}})
    assert empty.status == 400
    assert world.hermes.answers == []
    assert len((await _open(world, sid))["requests"]) == 1

    await world.post("/api/requests/sec-1", {"result": {"declined": True, "value": "ignored-value"}})
    assert world.hermes.answers == [{"id": "sec-1", "private": {"secret_request": "sec-1"}, "result": {"declined": True}}]
    assert (await _open(world, sid))["requests"] == []


async def test_settings_lists_names_and_reveals_one_value_at_a_time(world):
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    saved = await world.post("/api/secrets/OPENAI_KEY", {"value": "sk-from-settings", "note": "personal key"})
    assert saved.status == 200, await saved.text()
    await next_message(ws, lambda m: m.get("kind") == "secrets.changed")
    listed = await (await world.http.get(world.url("/api/secrets"))).json()
    assert [(s["name"], s["note"], s["origin"]) for s in listed] == [("OPENAI_KEY", "personal key", "you")]
    assert "sk-from-settings" not in json.dumps(listed)
    assert (await (await world.http.get(world.url("/api/secrets/OPENAI_KEY"))).json())["value"] == "sk-from-settings"
    assert (await world.http.get(world.url("/api/secrets/MISSING"))).status == 404
    removed = await world.post("/api/secrets/OPENAI_KEY/remove")
    assert (await removed.json())["removed"] is True
    assert world.hermes.vault == {}
    await ws.close()


async def test_without_the_secrets_plugin_the_app_is_told_there_are_none(world):
    await world.sign_up()
    world.hermes.vault = None
    for method, path in (("GET", "/api/secrets"), ("GET", "/api/secrets/ANY"), ("POST", "/api/secrets/ANY"), ("POST", "/api/secrets/ANY/remove")):
        response = await world.http.request(method, world.url(path), json={"value": "some-value"}, headers={"Origin": ORIGIN})
        assert response.status == 404, (method, path)
        assert "agent-secrets" in (await response.json())["error"]
    assert world.hermes.vault is None


async def test_secrets_need_a_signed_in_page_from_this_origin(world):
    world.hermes.vault["KEPT"] = {"value": "kept-value-123", "note": "", "origin": "you"}
    assert (await world.http.get(world.url("/api/secrets"))).status == 401
    assert (await world.http.get(world.url("/api/secrets/KEPT"))).status == 401
    assert (await world.post("/api/secrets/NEW", {"value": "x" * 10})).status == 401
    await world.sign_up()
    assert (await world.post("/api/secrets/NEW", {"value": "x" * 10}, origin="https://evil.example.test")).status == 403
    assert list(world.hermes.vault) == ["KEPT"]


async def test_the_gateway_saying_secrets_changed_reaches_every_tab(world):
    await world.sign_up()
    ws = await world.http.ws_connect(world.url("/ws"), headers={"Origin": ORIGIN})
    await world.client.call("secrets_changed")
    await next_message(ws, lambda m: m.get("kind") == "secrets.changed")
    await ws.close()


async def test_a_shared_secret_line_reads_as_its_name_in_a_notification(world):
    sid = world.hermes.add_session("20261101_070707_aaaaab", "deploy", chat="inbox")
    await world.hub.sessions()
    await world.hermes.post(sid, "new admin password:\nSECRET:DB_ADMIN\nrotate it monthly")
    assert [alert[2] for alert in world.alerts] == ["new admin password: DB_ADMIN rotate it monthly"]


# The adapter's half, against a stand-in for the agent-secrets API.


class SecretsApi:
    def __init__(self):
        self.answers = []
        self.open = {"sec-1"}

    def answer(self, request_id, value=None, *, declined=False):
        if request_id not in self.open:
            return False
        self.open.discard(request_id)
        self.answers.append((request_id, value, declined))
        return True


def _plugin(monkeypatch, api):
    monkeypatch.setitem(sys.modules, "agent_secrets", api)
    spec = importlib.util.spec_from_file_location("nako_portal_secrets_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


async def test_the_adapter_hands_the_answer_to_agent_secrets(monkeypatch, tmp_path):
    api = SecretsApi()
    backend = _plugin(monkeypatch, api).HermesBackend(adapter=None, home=tmp_path)
    await backend.resolve(_card(), {"value": VALUE})
    assert api.answers == [("sec-1", VALUE, False)]
    with pytest.raises(ValueError, match="no longer open"):
        await backend.resolve(_card(), {"value": VALUE})


async def test_the_surface_shows_a_card_in_the_chat_that_asked(monkeypatch):
    plugin = _plugin(monkeypatch, SecretsApi())
    sent = []

    class Backend:
        @staticmethod
        def chat_of(session):
            return {"20261101_080808_cccccc": "chat-abc"}.get(session)

    class Adapter:
        backend = Backend()

        async def _hub(self, method, *args):
            sent.append((method, *args))
            return True

    surface = plugin.SecretSurface(Adapter(), asyncio.get_running_loop())
    request = {"id": "sec-9", "name": "GH_TOKEN", "note": "repo access", "replace": False}
    # agent-secrets calls it from the agent's tool thread.
    assert await asyncio.to_thread(surface.ask, "20261101_080808_cccccc", request) is True
    assert sent == [("ask", "chat-abc", {"id": "sec-9", "method": "secret", "params": {"name": "GH_TOKEN", "note": "repo access", "replace": False}, "private": {"secret_request": "sec-9"}})]
    assert await asyncio.to_thread(surface.ask, "20261101_090909_dddddd", request) is False
    assert len(sent) == 1
    assert surface.show_line("GH_TOKEN") == "SECRET:GH_TOKEN"
