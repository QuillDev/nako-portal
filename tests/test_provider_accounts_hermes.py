"""Codex accounts on the Providers page, against Hermes's real credential pool.

Only OpenAI is left out: the tokens are unsigned JWTs carrying the claims Hermes reads (email,
ChatGPT account id, subject). Needs a real Hermes to import, so CI skips it.
"""

import base64
import importlib.util
import json

import pytest

from conftest import ROOT

pytest.importorskip("agent.credential_pool")


def _token(email, account, subject, n=1):
    def part(data):
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

    claims = {"sub": subject, "n": n, "https://api.openai.com/profile": {"email": email},
              "https://api.openai.com/auth": {"chatgpt_account_id": account, "chatgpt_plan_type": "pro"}}
    return f"{part({'alg': 'none'})}.{part(claims)}.sig"


def _tokens(email, account="acct-1", subject=None, n=1):
    return {"access_token": _token(email, account, subject or email, n), "refresh_token": f"refresh-{email}-{n}"}


@pytest.fixture
def codex(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text("model:\n  default: some-model\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    spec = importlib.util.spec_from_file_location("nako_portal_accounts_test", ROOT / "provider_accounts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CodexAccounts()


def _shown(codex):
    from agent.credential_pool import load_pool

    tokens = {e.id: e.access_token for e in load_pool("openai-codex").entries()}
    return {row["email"]: (row["signed_in"], tokens[row["id"]]) for row in codex.list()}


def test_a_new_account_is_added_and_the_same_one_again_is_refreshed(codex):
    from hermes_cli.auth_codex import _save_codex_tokens

    # The account Hermes's own login already holds, as `hermes auth add` / the dashboard leave it.
    _save_codex_tokens(_tokens("alex@example.test"), set_active=False)
    assert list(_shown(codex)) == ["alex@example.test"]

    assert codex._link(_tokens("sam@example.test", account="acct-2"), None)["outcome"] == "added"
    assert sorted(_shown(codex)) == ["alex@example.test", "sam@example.test"]

    fresh_alex = _tokens("alex@example.test", n=2)
    assert codex._link(fresh_alex, None)["outcome"] == "refreshed"
    fresh_sam = _tokens("sam@example.test", account="acct-2", n=2)
    assert codex._link(fresh_sam, None)["outcome"] == "refreshed"

    assert sorted((r["label"], r["plan"]) for r in codex.list()) == [("alex@example.test", "Pro"), ("sam@example.test", "Pro")]
    shown = _shown(codex)
    assert sorted(shown) == ["alex@example.test", "sam@example.test"]
    assert shown["alex@example.test"] == (True, fresh_alex["access_token"])
    assert shown["sam@example.test"] == (True, fresh_sam["access_token"])


def test_a_teammate_in_the_same_workspace_is_another_account(codex):
    codex._link(_tokens("alex@example.test", subject="user-a"), None)

    assert codex._link(_tokens("kim@example.test", subject="user-k"), None)["outcome"] == "added"
    assert sorted(_shown(codex)) == ["alex@example.test", "kim@example.test"]


def test_signing_in_again_on_a_row_as_someone_else_leaves_that_row_alone(codex):
    codex._link(_tokens("alex@example.test"), None)
    before = _shown(codex)["alex@example.test"]
    alex = next(row["id"] for row in codex.list())

    result = codex._link(_tokens("sam@example.test", account="acct-2"), alex)

    assert result["outcome"] == "added"
    assert _shown(codex)["alex@example.test"] == before
