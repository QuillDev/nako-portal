"""PR management in Portal: read-only GitHub guard, deterministic status & stack grouping,
explicit session PR attachments (loopback API + tools), and Portal web routes.
"""

from __future__ import annotations

import json
import sys

import pytest
from conftest import LOCAL_TOKEN, ROOT, next_message
from portal.prs import (
    PRService,
    ReadOnlyViolation,
    assemble_view,
    check_read_only,
    parse_pr_ref,
)

sys.path.insert(0, str(ROOT))
import prs_tools


def _pr(
    number: int,
    *,
    repo: str = "acme/api",
    author: str = "alice",
    title: str | None = None,
    base: str = "develop",
    head: str | None = None,
    trunk: str = "develop",
    draft: bool = False,
    mergeable: str = "MERGEABLE",
    merge_state: str = "CLEAN",
    behind_by: int = 0,
    source: str = "mine",
    checks: list | None = None,
    reviews: list | None = None,
    threads: list | None = None,
    review_requested: list | None = None,
    base_changes: list | None = None,
    contains_merged_parent: dict | None = None,
    owner_session: str | None = None,
):
    head_name = head or f"feat/pr-{number}"
    item = {
        "key": f"{repo}#{number}",
        "repo": repo,
        "number": number,
        "title": title or f"PR {number}",
        "url": f"https://github.com/{repo}/pull/{number}",
        "body": "",
        "author": author,
        "draft": draft,
        "created_at": "2026-11-26T00:00:00Z",
        "updated_at": "2026-11-27T12:00:00Z",
        "trunk": trunk,
        "base": base,
        "head": head_name,
        "base_oid": "aaa0001",
        "head_oid": f"head{number:04d}",
        "last_commit_at": "2026-11-27T11:00:00Z",
        "mergeable": mergeable,
        "merge_state": merge_state,
        "review_decision": "",
        "additions": 10,
        "deletions": 2,
        "changed_files": 1,
        "review_requested": review_requested or [],
        "source": source,
        "checks": checks if checks is not None else [{"name": "test:pure", "state": "pass", "url": ""}],
        "reviews": reviews or [],
        "threads": threads or [],
        "base_changes": base_changes or [],
        "ahead_by": 1,
        "behind_by": behind_by,
    }
    if contains_merged_parent:
        item["contains_merged_parent"] = contains_merged_parent
    if owner_session:
        item["link"] = {"owner": {"session": owner_session, "title": f"Chat {number}", "source": "portal", "archived": False}}
    return item


def test_read_only_guard_blocks_writes_and_allows_queries():
    check_read_only(["api", "graphql", "-f", "query=query{ viewer{ login } }"])
    check_read_only(["api", "-X", "GET", "repos/a/b/pulls"])

    for forbidden in (
        ["pr", "merge", "12"],
        ["pr", "comment", "12", "--body", "hi"],
        ["api", "-X", "POST", "repos/a/b/issues/1/comments"],
        ["api", "--method=PATCH", "repos/a/b/pulls/1"],
        ["api", "repos/a/b/pulls/1", "-f", "title=oops"],
        ["api", "graphql", "-f", "query=mutation { addComment(input: {}) { clientMutationId } }"],
    ):
        with pytest.raises(ReadOnlyViolation):
            check_read_only(forbidden)


def test_parse_pr_ref_accepts_urls_keys_and_dicts():
    assert parse_pr_ref("acme/api#4921") == ("acme/api", 4921, "https://github.com/acme/api/pull/4921")
    assert parse_pr_ref("https://github.com/alice/portal/pull/196") == (
        "alice/portal",
        196,
        "https://github.com/alice/portal/pull/196",
    )
    assert parse_pr_ref({"repo": "acme/wms", "number": 744}) == (
        "acme/wms",
        744,
        "https://github.com/acme/wms/pull/744",
    )
    for bad in ("not-a-pr", "owner/repo#0", {"repo": "../etc", "number": 1}, {"repo": "a/b", "number": -3}):
        with pytest.raises(ValueError):
            parse_pr_ref(bad)


def test_stack_grouping_and_deterministic_status_evaluation():
    parent = _pr(
        4742,
        head="stack-parent",
        base="develop",
        reviews=[{"author": "pullfrog[bot]", "state": "APPROVED", "at": "2026-11-27T12:00:00Z", "commit": "head4742", "body": ""}],
        owner_session="sess_parent",
    )
    child = _pr(
        4743,
        head="stack-child",
        base="stack-parent",
        behind_by=2,
        owner_session="sess_child",
    )
    ci_red = _pr(
        5001,
        checks=[{"name": "test:pure", "state": "fail", "url": "https://ci.example/1"}],
        owner_session="sess_red",
    )
    pf_changes = _pr(
        5002,
        reviews=[{"author": "pullfrog[bot]", "state": "CHANGES_REQUESTED", "at": "2026-11-27T12:00:00Z", "commit": "head5002", "body": ""}],
        threads=[{"resolved": False, "author": "pullfrog[bot]", "path": "a.ts", "line": 10, "body": "fix"}],
        owner_session="sess_pf",
    )
    coworker = _pr(
        5003,
        author="bob",
        source="review_requested",
        review_requested=["alice"],
    )
    draft = _pr(5004, draft=True)

    view = assemble_view({"viewer": "alice", "taken_at": 1700000000, "prs": [parent, child, ci_red, pf_changes, coworker, draft]})
    by_key = {p["key"]: p for p in view["prs"]}

    assert by_key["acme/api#4742"]["status"] == "ready_to_merge"
    assert by_key["acme/api#4742"]["tone"] == "ready"
    assert by_key["acme/api#4743"]["status"] == "conflict"
    assert by_key["acme/api#4743"]["tone"] == "failing"
    assert by_key["acme/api#4743"]["parent_key"] == "acme/api#4742"
    assert [n["number"] for n in by_key["acme/api#4743"]["stack"]] == [4742, 4743]
    assert by_key["acme/api#4743"]["stack"][0]["session"] == "sess_parent"

    assert by_key["acme/api#5001"]["status"] == "ci_failed"
    assert any(a["id"] == "fix-ci" for a in by_key["acme/api#5001"]["quick_actions"])

    assert by_key["acme/api#5002"]["status"] == "changes_requested"
    assert any(a["id"] == "address-threads" for a in by_key["acme/api#5002"]["quick_actions"])

    assert by_key["acme/api#5003"]["status"] == "needs_your_review"
    assert by_key["acme/api#5003"]["mine"] is False

    assert by_key["acme/api#5004"]["status"] == "draft"
    assert view["stacks"][0]["kind"] == "stack"
    assert [m["key"] for m in view["stacks"][0]["members"]] == ["acme/api#4742", "acme/api#4743"]


async def test_disabled_prs_reports_false_and_404s(world):
    await world.sign_up()
    me = await (await world.http.get(world.url("/api/me"))).json()
    assert me["prs"] is False
    assert (await world.http.get(world.url("/api/prs"))).status == 404


async def test_explicit_pr_attach_detach_ws_and_session_endpoint(world):
    chat = world.hermes.add_session("20261127_100000_prchat", "Fix billing")
    snapshot = {
        "viewer": "alice",
        "taken_at": 1700000000,
        "prs": [
            _pr(4921, title="Fix billing guard", checks=[{"name": "test:pure", "state": "pass", "url": ""}]),
        ],
        "merged": [],
    }
    world.portal.prs = PRService(world.store, viewer="alice", collector=lambda _v=None: snapshot)

    # Unauthenticated web requests are rejected.
    assert (await world.http.get(world.url("/api/prs"))).status == 401

    await world.sign_up()
    me = await (await world.http.get(world.url("/api/me"))).json()
    assert me["prs"] is True

    headers = {"Authorization": f"Bearer {LOCAL_TOKEN}"}
    async with world.http.ws_connect(world.url("/ws"), headers={"Origin": "http://portal.test"}) as ws:
        # Attach an open PR and a merged PR via the loopback API.
        res = await world.http.post(
            str(world.local.make_url(f"/sessions/{chat}/prs")),
            headers=headers,
            json={"pr": "acme/api#4921", "title": "Fix billing guard", "branch": "fix/billing"},
        )
        assert res.status == 200
        frame = await next_message(ws, lambda m: m.get("kind") == "prs.changed")
        assert frame["kind"] == "prs.changed"

        merged_res = await world.http.post(
            str(world.local.make_url(f"/sessions/{chat}/prs")),
            headers=headers,
            json={
                "url": "https://github.com/acme/api/pull/4800",
                "title": "Earlier merged PR",
                "branch": "fix/old",
                "base": "develop",
                "state": "merged",
            },
        )
        assert merged_res.status == 200
        await next_message(ws, lambda m: m.get("kind") == "prs.changed")

        # Web session PR endpoint returns both: live open PR (explicit owner) + merged purple PR.
        sess_res = await world.http.get(world.url(f"/api/sessions/{chat}/prs"))
        assert sess_res.status == 200
        sess_prs = (await sess_res.json())["prs"]
        by_num = {p["number"]: p for p in sess_prs}
        assert set(by_num) == {4921, 4800}
        assert by_num[4921]["owner"]["session"] == chat
        assert by_num[4921]["owner"]["explicit"] is True
        assert by_num[4800]["status"] == "merged"
        assert by_num[4800]["tone"] == "merged"

        # Loopback GET lists explicit links; DELETE detaches cleanly.
        listed = await (await world.http.get(str(world.local.make_url(f"/sessions/{chat}/prs")), headers=headers)).json()
        assert {item["number"] for item in listed} == {4921, 4800}

        deleted = await world.http.delete(
            str(world.local.make_url(f"/sessions/{chat}/prs/acme/api/4800")),
            headers=headers,
        )
        assert deleted.status == 200
        assert (await deleted.json())["removed"] is True
        await next_message(ws, lambda m: m.get("kind") == "prs.changed")

        after = await (await world.http.get(world.url(f"/api/sessions/{chat}/prs"))).json()
        assert [p["number"] for p in after["prs"]] == [4921]


async def test_start_review_chat_preview_and_live_modes(world):
    coworker = _pr(730, repo="acme/wms", author="bob", title="Cross-merchant sub", source="review_requested", review_requested=["alice"])
    snapshot = {"viewer": "alice", "taken_at": 1700000000, "prs": [coworker], "merged": []}

    # Read-only preview mode never creates a chat; it returns the spawn preview plan.
    world.portal.prs = PRService(world.store, viewer="alice", readonly=True, collector=lambda _v=None: snapshot)
    await world.sign_up()
    before_count = len(world.hermes.sessions)
    preview_res = await world.post("/api/prs/review-chat", {"repo": "acme/wms", "number": 730})
    assert preview_res.status == 200
    plan = await preview_res.json()
    assert plan["preview"] is True
    assert plan["pr"] == "acme/wms#730"
    assert "wms#730" in plan["title"]
    assert "https://github.com/acme/wms/pull/730" in plan["prompt"]
    assert len(world.hermes.sessions) == before_count

    # Live mode spawns a review chat and attaches the PR to that new session.
    world.portal.prs = PRService(world.store, viewer="alice", readonly=False, collector=lambda _v=None: snapshot)
    live_res = await world.post("/api/prs/review-chat", {"repo": "acme/wms", "number": 730})
    assert live_res.status == 200
    created = await live_res.json()
    assert created["preview"] is False
    assert created["session"]
    attached = world.store.session_prs(created["session"])
    assert [(a["repo"], a["number"]) for a in attached] == [("acme/wms", 730)]


def test_prs_tools_contract_roundtrip(monkeypatch):
    calls = []

    def fake_call(method, path, body=None):
        calls.append((method, path, body))
        if method == "GET":
            return [{"repo": "acme/api", "number": 4921}]
        return {"ok": True, "path": path}

    monkeypatch.setattr(prs_tools, "CALL", fake_call)
    attach_out = json.loads(prs_tools.TOOL_HANDLERS["pr_attach"]({"pr": "acme/api#4921", "branch": "feat/x"}, session_id="s1"))
    list_out = json.loads(prs_tools.TOOL_HANDLERS["pr_list"]({}, session_id="s1"))
    detach_out = json.loads(prs_tools.TOOL_HANDLERS["pr_detach"]({"pr": "https://github.com/acme/api/pull/4921"}, session_id="s1"))

    assert attach_out["ok"] is True
    assert list_out["session"] == "s1" and list_out["prs"][0]["number"] == 4921
    assert detach_out["ok"] is True
    assert calls == [
        ("POST", "/sessions/s1/prs", {"pr": "acme/api#4921", "branch": "feat/x"}),
        ("GET", "/sessions/s1/prs", None),
        ("DELETE", "/sessions/s1/prs/acme/api/4921", None),
    ]
