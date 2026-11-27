"""GitHub PR tracking for Portal: read-only GitHub snapshots, stack grouping, status evaluation,
and chat-to-PR linking (explicit links in portal.db with automatic fallback from state.db).

Every GitHub call goes through `gh_json`, which refuses any write (REST method other than GET,
REST fields without explicit GET, or GraphQL mutations).
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import zlib
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

log = logging.getLogger("hermes.portal.prs")

GH = shutil.which("gh") or "/usr/bin/gh"
REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$")
PR_URL_RE = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
PR_KEY_RE = re.compile(r"^([\w.-]+/[\w.-]+)#(\d+)$")

INTERACTIVE_SOURCES = {"portal", "desktop", "slack", "discord", "tui", "cli"}
META_CHECKS = ("pullfrog", "protect-branch", "vercel", "vercel preview comments")

PR_FIELDS = """
 id number title url isDraft updatedAt body
 baseRefName headRefName baseRefOid headRefOid baseRef{target{oid}}
 mergeable mergeStateStatus reviewDecision
 author{login}
 repository{nameWithOwner defaultBranchRef{name}}
 reviewRequests(first:6){nodes{requestedReviewer{... on User{login} ... on Team{slug}}}}
 commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:40){nodes{
   __typename
   ... on CheckRun{name conclusion status detailsUrl completedAt}
   ... on StatusContext{context state targetUrl}
 }}}}}}
 reviews(last:12){nodes{author{login} state submittedAt commit{oid} body}}
 reviewThreads(first:25){nodes{isResolved isOutdated
   comments(first:1){nodes{author{login}}}}}
 timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], last:2){nodes{
   ... on BaseRefChangedEvent{previousRefName currentRefName createdAt}}}
"""

INDEX_FIELDS = """
 id number updatedAt isDraft headRefOid baseRefName
 baseRef{target{oid}}
 repository{nameWithOwner}
 commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}
"""

COMBINED_INDEX_QUERY = (
    "query($qm:String!, $qr:String!){\n"
    "  rateLimit { cost remaining limit resetAt }\n"
    "  mine: search(query:$qm, type:ISSUE, first:100){\n"
    "    pageInfo{hasNextPage endCursor}\n"
    f"    nodes{{ ... on PullRequest {{ {INDEX_FIELDS} }} }}\n"
    "  }\n"
    "  rev: search(query:$qr, type:ISSUE, first:100){\n"
    "    pageInfo{hasNextPage endCursor}\n"
    f"    nodes{{ ... on PullRequest {{ {INDEX_FIELDS} }} }}\n"
    "  }\n"
    "}"
)

NODES_QUERY = (
    "query($ids:[ID!]!){\n"
    "  rateLimit { cost remaining limit resetAt }\n"
    f"  nodes(ids:$ids){{ ... on PullRequest {{ {PR_FIELDS} }} }}\n"
    "}"
)

SEARCH_QUERY = (
    "query($q:String!, $after:String){\n"
    "  rateLimit { cost remaining limit resetAt }\n"
    "  search(query:$q, type:ISSUE, first:20, after:$after){\n"
    "    pageInfo{hasNextPage endCursor}\n"
    f"    nodes{{ ... on PullRequest {{ {PR_FIELDS} }} }}\n"
    "  }\n"
    "}"
)

MERGED_QUERY = """
query($owner:String!, $name:String!){
  rateLimit { cost remaining limit resetAt }
  repository(owner:$owner, name:$name){
    pullRequests(states:MERGED, last:30, orderBy:{field:UPDATED_AT, direction:ASC}){
      nodes{ number title url headRefName headRefOid baseRefName mergedAt
             mergeCommit{oid parents(first:2){totalCount}} }
    }
  }
}"""

VIEWER_QUERY = "query{ viewer{ login } }"

RECENT_CONFLICT_WINDOW_S = 14 * 86_400
DEFAULT_WINDOW_DAYS = 30
MERGED_CACHE_TTL_S = 900.0
CONDITIONAL_MAX_AGE_S = 900.0
LOW_RATE_LIMIT_THRESHOLD = 500
ACTIVE_CI_TTL_S = 90.0
DEFAULT_PR_TTL_S = 300.0


class ReadOnlyViolation(RuntimeError):
    """Raised if code attempts to pass a mutating command through gh_json."""


class PRError(RuntimeError):
    """Raised when reading PR data fails."""


def parse_pr_ref(value) -> tuple[str, int, str]:
    """Parse a PR reference from a dict, URL, or `owner/repo#123` string -> (repo, number, url)."""
    if isinstance(value, dict):
        raw_url = str(value.get("url") or "").strip()
        raw_pr = str(value.get("pr") or "").strip()
        repo = str(value.get("repo") or "").strip()
        number = value.get("number")
        if repo and number is not None:
            return _validated_ref(repo, number, raw_url)
        if raw_pr:
            return parse_pr_ref(raw_pr)
        if raw_url:
            return parse_pr_ref(raw_url)
        raise ValueError("Provide repo + number, pr ('owner/repo#123'), or a GitHub PR url")
    text = str(value or "").strip()
    m = PR_URL_RE.search(text)
    if m:
        return _validated_ref(m.group(1), int(m.group(2)), f"https://github.com/{m.group(1)}/pull/{m.group(2)}")
    m = PR_KEY_RE.match(text)
    if m:
        return _validated_ref(m.group(1), int(m.group(2)), "")
    raise ValueError("PR must be 'owner/repo#123' or a GitHub pull request URL")


def _validated_ref(repo: str, number, url: str = "") -> tuple[str, int, str]:
    _owner, _, name = repo.partition("/")
    if not REPO_RE.fullmatch(repo) or name in (".", "..") or ".." in name:
        raise ValueError(f"Invalid repo {repo!r}; expected 'owner/repo'")
    if isinstance(number, bool):
        raise ValueError("PR number must be a positive integer")  # noqa: TRY004 - Request guard surfaces ValueError as HTTP 400.
    try:
        num = int(number)
    except (TypeError, ValueError) as error:
        raise ValueError("PR number must be a positive integer") from error
    if num <= 0:
        raise ValueError("PR number must be a positive integer")
    canonical = f"https://github.com/{repo}/pull/{num}"
    if url and PR_URL_RE.search(url):
        canonical = canonical
    return repo, num, canonical


def check_read_only(args: list[str]) -> None:
    """Refuse any gh invocation that is not a read-only `gh api` query."""
    if not args or args[0] != "api":
        raise ReadOnlyViolation(f"only `gh api` reads are allowed, got {args[:2]}")
    joined = " ".join(args)
    for i, arg in enumerate(args):
        if arg in ("-X", "--method") and (i + 1 >= len(args) or args[i + 1].upper() != "GET"):
            raise ReadOnlyViolation(f"method {args[i + 1] if i + 1 < len(args) else '?'} is not allowed")
        if arg.startswith("--method=") and arg.split("=", 1)[1].upper() != "GET":
            raise ReadOnlyViolation(f"{arg} is not allowed")
    if len(args) > 1 and args[1] == "graphql" and re.search(r"\bmutation\b", joined):
        raise ReadOnlyViolation("graphql mutations are not allowed")
    if (
        len(args) > 1
        and args[1] != "graphql"
        and any(a in ("-f", "-F", "--field", "--raw-field", "--input") for a in args)
        and "-X" not in args
        and "--method" not in args
    ):
        raise ReadOnlyViolation("REST fields without an explicit GET would POST")


def gh_json(*args: str, timeout: int = 90):
    arg_list = list(args)
    check_read_only(arg_list)
    out = subprocess.run([GH, *arg_list], capture_output=True, text=True, timeout=timeout, check=False)
    if out.returncode != 0:
        raise PRError(f"gh {' '.join(arg_list[:2])}: {out.stderr.strip()[-300:]}")
    return json.loads(out.stdout or "null")


def gh_rest_conditional(endpoint: str, etag: str | None = None, *, timeout: int = 20) -> tuple[int, str | None]:
    """Read-only REST conditional GET returning (http_status, etag); 304 costs 0 GitHub rate-limit points."""
    args = ["api", "-X", "GET", "-i", endpoint]
    if etag:
        args += ["-H", f"If-None-Match: {etag}"]
    check_read_only(args)
    out = subprocess.run([GH, *args], capture_output=True, text=True, timeout=timeout, check=False)
    raw_out = out.stdout or ""
    head = raw_out.split("\r\n\r\n", 1)[0] if "\r\n\r\n" in raw_out else raw_out.split("\n\n", 1)[0]
    lines = head.splitlines()
    status = 0
    if lines:
        parts = lines[0].split()
        if len(parts) >= 2 and parts[1].isdigit():
            status = int(parts[1])
    new_etag = etag
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            if k.strip().lower() == "etag":
                new_etag = v.strip()
                break
    return status, new_etag


def graphql(query: str, **variables):
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            for item in value:
                args += ["-F" if isinstance(item, int) else "-f", f"{key}[]={item}"]
        else:
            args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    body = gh_json(*args)
    if body.get("errors"):
        raise PRError(f"graphql: {body['errors'][0].get('message')}")
    return body["data"]


def is_bot(login: str | None) -> bool:
    who = login or ""
    return who.startswith("pullfrog") or who.endswith("[bot]")


def is_pullfrog(login: str | None) -> bool:
    return (login or "").lower().startswith("pullfrog")


def check_bucket(node: dict) -> str:
    if node.get("__typename") == "StatusContext":
        return {"SUCCESS": "pass", "FAILURE": "fail", "ERROR": "fail"}.get(str(node.get("state") or ""), "pending")
    if node.get("status") != "COMPLETED":
        return "pending"
    return {
        "SUCCESS": "pass",
        "NEUTRAL": "pass",
        "SKIPPED": "skip",
        "FAILURE": "fail",
        "TIMED_OUT": "fail",
        "CANCELLED": "fail",
        "ACTION_REQUIRED": "fail",
        "STARTUP_FAILURE": "fail",
        "STALE": "pending",
    }.get(str(node.get("conclusion") or ""), "pending")


def normalize_pr(node: dict, source: str) -> dict:
    commit = (node.get("commits", {}).get("nodes") or [{}])[0].get("commit") or {}
    rollup = commit.get("statusCheckRollup") or {}
    latest = {}
    for c in (rollup.get("contexts") or {}).get("nodes") or []:
        name = c.get("name") or c.get("context") or "?"
        state = check_bucket(c)
        order = "~" if state == "pending" else (c.get("completedAt") or "")
        if name not in latest or order >= latest[name][0]:
            latest[name] = (order, {"name": name, "state": state, "url": c.get("detailsUrl") or c.get("targetUrl")})
    checks = [row for _, row in latest.values()]
    requested = []
    for r in (node.get("reviewRequests") or {}).get("nodes") or []:
        who = r.get("requestedReviewer") or {}
        name = who.get("login") or who.get("slug")
        if name:
            requested.append(name)
    reviews = []
    for r in (node.get("reviews") or {}).get("nodes") or []:
        reviews.append({
            "author": (r.get("author") or {}).get("login") or "",
            "state": r.get("state") or "",
            "at": r.get("submittedAt") or "",
            "commit": (r.get("commit") or {}).get("oid") or "",
            "body": (r.get("body") or "")[:400],
            "url": r.get("url") or "",
        })
    threads = []
    for t in (node.get("reviewThreads") or {}).get("nodes") or []:
        first = ((t.get("comments") or {}).get("nodes") or [{}])[0]
        threads.append({
            "resolved": bool(t.get("isResolved")),
            "outdated": bool(t.get("isOutdated")),
            "path": t.get("path") or "",
            "line": t.get("line"),
            "author": (first.get("author") or {}).get("login") or "",
            "body": (first.get("body") or "")[:240],
            "url": first.get("url") or "",
        })
    base_changes = []
    for ev in (node.get("timelineItems") or {}).get("nodes") or []:
        if ev.get("previousRefName"):
            base_changes.append({
                "from": ev.get("previousRefName"),
                "to": ev.get("currentRefName"),
                "at": ev.get("createdAt"),
            })
    repo = node["repository"]["nameWithOwner"]
    trunk = ((node["repository"].get("defaultBranchRef") or {}).get("name")) or "main"
    return {
        "node_id": node.get("id") or "",
        "key": f"{repo}#{node['number']}",
        "repo": repo,
        "number": node["number"],
        "title": node["title"],
        "url": node["url"],
        "body": (node.get("body") or "")[:4000],
        "author": (node.get("author") or {}).get("login") or "",
        "draft": bool(node.get("isDraft")),
        "created_at": node.get("createdAt") or "",
        "updated_at": node.get("updatedAt") or "",
        "trunk": trunk,
        "base": node.get("baseRefName") or trunk,
        "head": node.get("headRefName") or "",
        "base_oid": ((node.get("baseRef") or {}).get("target") or {}).get("oid") or node.get("baseRefOid") or "",
        "head_oid": node.get("headRefOid") or commit.get("oid") or "",
        "rollup_state": rollup.get("state") or "",
        "last_commit_at": commit.get("committedDate") or "",
        "mergeable": node.get("mergeable") or "UNKNOWN",
        "merge_state": node.get("mergeStateStatus") or "UNKNOWN",
        "review_decision": node.get("reviewDecision") or "",
        "additions": int(node.get("additions") or 0),
        "deletions": int(node.get("deletions") or 0),
        "changed_files": int(node.get("changedFiles") or 0),
        "review_requested": requested,
        "source": source,
        "checks": checks,
        "reviews": reviews,
        "threads": threads,
        "base_changes": base_changes,
        "ahead_by": 0,
        "behind_by": 0,
    }


def _parse_iso_ts(iso: str | None) -> float:
    if not iso:
        return 0.0
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _is_rate_limit_error(message: str | None) -> bool:
    text = (message or "").lower()
    return any(
        needle in text
        for needle in (
            "rate limit",
            "secondary rate",
            "abuse detection",
            "http 429",
            "http 403",
            "api rate limit exceeded",
        )
    )


def _merge_rate_limit(cur: dict | None, sample: dict | None) -> dict | None:
    if not isinstance(sample, dict):
        return cur
    points = (cur.get("points_used", 0) if cur else 0) + int(sample.get("points_used") or sample.get("cost") or 0)
    return {
        "remaining": sample.get("remaining"),
        "limit": sample.get("limit"),
        "resetAt": sample.get("resetAt"),
        "points_used": points,
    }


def _index_entry(node: dict, source: str) -> dict | None:
    if not node or not node.get("number") or not node.get("repository"):
        return None
    repo = node["repository"]["nameWithOwner"]
    commit = (node.get("commits", {}).get("nodes") or [{}])[0].get("commit") or {}
    rollup = commit.get("statusCheckRollup") or {}
    return {
        "node_id": node.get("id") or "",
        "key": f"{repo}#{node['number']}",
        "repo": repo,
        "number": node["number"],
        "updated_at": node.get("updatedAt") or "",
        "draft": bool(node.get("isDraft")),
        "head_oid": node.get("headRefOid") or commit.get("oid") or "",
        "base": node.get("baseRefName") or "",
        "base_oid": ((node.get("baseRef") or {}).get("target") or {}).get("oid") or "",
        "rollup_state": rollup.get("state") or "",
        "source": source,
    }


def _needs_rehydrate(prev: dict | None, entry: dict, *, now: float) -> bool:
    if prev is None:
        return True
    if prev.get("updated_at") != entry["updated_at"]:
        return True
    if bool(prev.get("draft")) != entry["draft"]:
        return True
    if prev.get("head_oid") != entry["head_oid"]:
        return True
    if entry["base"] and prev.get("base") != entry["base"]:
        return True
    if prev.get("index_rollup_state", prev.get("rollup_state")) != entry["rollup_state"]:
        return True
    if prev.get("mergeable") in (None, "", "UNKNOWN"):
        return True
    if any(c.get("state") == "pending" for c in (prev.get("checks") or [])):
        return True
    # When the base branch advances on an active, non-conflicting PR, re-check mergeability.
    if (
        entry["source"] == "mine"
        and prev.get("mergeable") != "CONFLICTING"
        and entry["base_oid"]
        and prev.get("base_oid") != entry["base_oid"]
    ):
        updated_ts = _parse_iso_ts(entry["updated_at"])
        if updated_ts and (now - updated_ts) <= RECENT_CONFLICT_WINDOW_S:
            return True
    return False


def _search_prs(query: str, source: str, limit: int = 80) -> list[dict]:
    out, cursor = [], None
    while len(out) < limit:
        data = graphql(SEARCH_QUERY, q=query, after=cursor)["search"]
        for node in data.get("nodes") or []:
            if node and node.get("number"):
                out.append(normalize_pr(node, source))
        if not data["pageInfo"]["hasNextPage"]:
            break
        cursor = data["pageInfo"]["endCursor"]
    return out


def _hydrate_nodes(entries: list[dict], *, batch_size: int = 20) -> tuple[list[dict], list[str], dict | None]:
    if not entries:
        return [], [], None
    source_by_id = {e["node_id"]: e["source"] for e in entries if e.get("node_id")}
    batches = [
        [e["node_id"] for e in entries[i : i + batch_size] if e.get("node_id")]
        for i in range(0, len(entries), batch_size)
    ]
    batches = [b for b in batches if b]
    out: list[dict] = []
    errors: list[str] = []
    rate_limit: dict | None = None

    def fetch_batch(ids: list[str]):
        return graphql(NODES_QUERY, ids=ids)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda b: _try(fetch_batch, b), batches))
    for value, error in results:
        if error:
            errors.append(f"hydrate: {error}")
            continue
        rate_limit = _merge_rate_limit(rate_limit, (value or {}).get("rateLimit"))
        for node in (value or {}).get("nodes") or []:
            if node and node.get("number") and node.get("repository"):
                source = source_by_id.get(node.get("id") or "", "mine")
                out.append(normalize_pr(node, source))
    return out, errors, rate_limit


def _merged_prs(repo: str) -> tuple[list[dict], dict | None]:
    owner, name = repo.split("/", 1)
    data = graphql(MERGED_QUERY, owner=owner, name=name)
    nodes = data["repository"]["pullRequests"]["nodes"]
    items = [{
        "key": f"{repo}#{n['number']}",
        "repo": repo,
        "number": n["number"],
        "title": n["title"],
        "url": n["url"],
        "head": n["headRefName"],
        "head_oid": n["headRefOid"],
        "base": n["baseRefName"],
        "merged_at": n["mergedAt"],
        "merge_oid": (n.get("mergeCommit") or {}).get("oid"),
        "squash": ((n.get("mergeCommit") or {}).get("parents") or {}).get("totalCount") == 1,
    } for n in nodes]
    return items, data.get("rateLimit")


def _check_activity_etags(viewer: str, prev_etags: dict | None = None) -> tuple[bool, dict[str, str]]:
    """Probe GitHub notifications + user events with If-None-Match; returns (both_304, updated_etags)."""
    endpoints = (
        ("notifications", "notifications?per_page=1"),
        ("events", f"users/{viewer}/events?per_page=1"),
    )
    prev = prev_etags if isinstance(prev_etags, dict) else {}
    had_all = all(bool(prev.get(k)) for k, _ in endpoints)
    updated: dict[str, str] = {}
    statuses: dict[str, int] = {}

    def probe(item: tuple[str, str]):
        key, ep = item
        return key, _try(gh_rest_conditional, ep, prev.get(key))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(probe, endpoints))
    for key, (value, error) in results:
        if error or value is None:
            if prev.get(key):
                updated[key] = prev[key]
            statuses[key] = 0
            continue
        status, new_etag = value
        statuses[key] = status
        if new_etag:
            updated[key] = new_etag
    unchanged = had_all and all(statuses.get(k) == 304 for k, _ in endpoints)
    return unchanged, updated


def collect_live(
    viewer: str | None = None,
    *,
    previous: dict | None = None,
    include_older: bool = False,
    allow_conditional: bool = False,
) -> dict:
    """Collect a fresh read-only GitHub snapshot via 304 gate + 30-day delta index + nodes(ids) hydration."""
    started = time.time()
    me = viewer or graphql(VIEWER_QUERY)["viewer"]["login"]
    window_days = 0 if include_older else DEFAULT_WINDOW_DAYS

    # 0. Free 304 Not Modified gate on background refreshes when no CI is pending and cache is recent.
    prev_etags = (previous or {}).get("etags") if isinstance(previous, dict) else None
    etags: dict[str, str] = dict(prev_etags) if isinstance(prev_etags, dict) else {}
    etags_probed = False
    has_pending_ci = any(
        c.get("state") == "pending"
        for pr in ((previous or {}).get("prs") or [])
        for c in (pr.get("checks") or [])
    )
    prev_indexed_at = float((previous or {}).get("indexed_at") or (previous or {}).get("taken_at") or 0.0)
    prev_window_days = int((previous or {}).get("window_days") or 0) if previous else -1
    if (
        allow_conditional
        and previous is not None
        and prev_window_days == window_days
        and not has_pending_ci
        and (started - prev_indexed_at) < CONDITIONAL_MAX_AGE_S
        and etags.get("notifications")
        and etags.get("events")
    ):
        unchanged, etags = _check_activity_etags(me, etags)
        etags_probed = True
        if unchanged:
            out = dict(previous)
            out["taken_at"] = time.time()
            out["took_s"] = round(time.time() - started, 2)
            out["etags"] = etags
            out["skipped_304"] = True
            out["hydrated"] = 0
            out["reused"] = len(out.get("prs") or [])
            prev_rl = out.get("rate_limit")
            if isinstance(prev_rl, dict):
                out["rate_limit"] = {**prev_rl, "points_used": 0}
            return out

    date_clause = ""
    if window_days > 0:
        cutoff = (datetime.now(UTC) - timedelta(days=window_days)).strftime("%Y-%m-%d")
        date_clause = f" updated:>={cutoff}"
    q_mine = f"is:pr is:open author:{me} archived:false{date_clause} sort:updated-desc"
    q_rev = f"is:pr is:open review-requested:{me} archived:false{date_clause} sort:updated-desc"

    errors: list[str] = []
    rate_limit: dict | None = None

    # 1. Single lightweight index call (2 GraphQL points for up to 100 mine + 100 reviewing).
    idx_data = graphql(COMBINED_INDEX_QUERY, qm=q_mine, qr=q_rev)
    rate_limit = _merge_rate_limit(rate_limit, idx_data.get("rateLimit"))

    indexed: dict[str, dict] = {}
    for bucket_key, source in (("mine", "mine"), ("rev", "review_requested")):
        for node in (idx_data.get(bucket_key) or {}).get("nodes") or []:
            entry = _index_entry(node, source)
            if entry:
                indexed.setdefault(entry["key"], entry)

    prev_by_key = {p["key"]: p for p in (previous or {}).get("prs") or []}
    prs: dict[str, dict] = {}
    to_hydrate: list[dict] = []
    for key, entry in indexed.items():
        prev = prev_by_key.get(key)
        if prev is not None and not _needs_rehydrate(prev, entry, now=started):
            reused = dict(prev)
            reused["source"] = entry["source"]
            if entry["base_oid"]:
                reused["base_oid"] = entry["base_oid"]
            prs[key] = reused
        else:
            to_hydrate.append(entry)

    reused_count = len(prs)
    hydrated_list, hydrate_errors, hydrate_rl = _hydrate_nodes(to_hydrate)
    errors.extend(hydrate_errors)
    rate_limit = _merge_rate_limit(rate_limit, hydrate_rl)
    for pr in hydrated_list:
        entry = indexed.get(pr["key"])
        if entry:
            pr["index_rollup_state"] = entry["rollup_state"]
        prs[pr["key"]] = pr
    # If hydration partially failed for a PR we already had cached, keep the previous copy.
    for entry in to_hydrate:
        if entry["key"] not in prs and entry["key"] in prev_by_key:
            prs[entry["key"]] = prev_by_key[entry["key"]]

    hydrated_repos = {p["repo"] for p in hydrated_list}
    stack_repos = sorted({
        p["repo"]
        for p in prs.values()
        if (p.get("base") and p.get("trunk") and p["base"] != p["trunk"])
        or any(c.get("from") and c["from"] != p.get("trunk") for c in (p.get("base_changes") or []))
    })

    prev_merged = (previous or {}).get("merged") or []
    prev_merged_at = float((previous or {}).get("merged_at") or (previous or {}).get("taken_at") or 0.0)
    prev_merged_repos = set((previous or {}).get("merged_repos") or [])
    merged_fresh = bool(previous) and (started - prev_merged_at) < MERGED_CACHE_TTL_S

    repos_to_fetch = [
        r for r in stack_repos if not merged_fresh or r not in prev_merged_repos or r in hydrated_repos
    ]
    merged_by_repo: dict[str, list[dict]] = {}
    if merged_fresh:
        for item in prev_merged:
            if item.get("repo") in stack_repos and item.get("repo") not in repos_to_fetch:
                merged_by_repo.setdefault(item["repo"], []).append(item)

    if repos_to_fetch:
        with ThreadPoolExecutor(max_workers=2) as pool:
            merged_lists = list(pool.map(lambda r: (r, _try(_merged_prs, r)), repos_to_fetch))
        for repo, (value, error) in merged_lists:
            if error:
                errors.append(f"merged {repo}: {error}")
                merged_by_repo[repo] = [m for m in prev_merged if m.get("repo") == repo]
            elif value is not None:
                items, m_rl = value
                merged_by_repo[repo] = items
                rate_limit = _merge_rate_limit(rate_limit, m_rl)

    # Seed ETags after a full index so the next background refresh can exit early on 304 (0 points).
    if not etags_probed and (not etags.get("notifications") or not etags.get("events") or hydrated_list):
        _, etags = _check_activity_etags(me, etags)

    merged = [item for repo in stack_repos for item in merged_by_repo.get(repo, [])]
    now_ts = time.time()
    return {
        "viewer": me,
        "taken_at": now_ts,
        "indexed_at": now_ts,
        "took_s": round(now_ts - started, 2),
        "window_days": window_days,
        "prs": sorted(prs.values(), key=lambda p: (p["repo"], p["number"])),
        "merged": merged,
        "merged_at": now_ts if repos_to_fetch else prev_merged_at,
        "merged_repos": stack_repos,
        "etags": etags,
        "skipped_304": False,
        "hydrated": len(hydrated_list),
        "reused": reused_count,
        "rate_limit": rate_limit,
        "errors": errors,
    }


def _try(fn, *args):
    try:
        return fn(*args), None
    except Exception as error:  # noqa: BLE001
        return None, str(error)[:240]


# --- Stack grouping ---


def _merged_parent_candidates(prs: Sequence[dict], merged: Sequence[dict]):
    by_head = {}
    for m in sorted(merged, key=lambda item: item.get("merged_at") or ""):
        by_head[(m["repo"], m["head"])] = m
    out = []
    for pr in prs:
        names = [pr["base"]] + [c["from"] for c in pr.get("base_changes") or [] if c.get("from")]
        for name in names:
            parent = by_head.get((pr["repo"], name))
            if parent and name != pr.get("trunk") and parent["number"] != pr["number"]:
                out.append((pr, parent))
                break
    return out


def build_stacks(prs: Sequence[dict], merged: Sequence[dict] = ()):
    """Group PRs into stacks (parent -> child trees) and standalone PRs."""
    by_key = {p["key"]: p for p in prs}
    by_head = {(p["repo"], p["head"]): p for p in prs}
    rel = {p["key"]: {"parent": None, "children": [], "pairs": [], "merged_parent": None} for p in prs}

    for pr in prs:
        parent = by_head.get((pr["repo"], pr["base"]))
        if parent and parent["key"] != pr["key"] and pr["base"] != pr.get("trunk"):
            rel[pr["key"]]["parent"] = parent["key"]
            rel[parent["key"]]["children"].append(pr["key"])

    for pr, parent in _merged_parent_candidates(prs, merged):
        if rel[pr["key"]]["parent"]:
            continue
        carries = (pr.get("contains_merged_parent") or {}).get(parent["key"])
        rel[pr["key"]]["merged_parent"] = {
            "key": parent["key"],
            "url": parent["url"],
            "head": parent["head"],
            "retargeted": pr["base"] != parent["head"],
            "carries_old_commits": carries,
            "squash": bool(parent.get("squash")),
        }

    # Cross-repo PR pairs referenced in body text.
    known = {(p["repo"], p["number"]): p["key"] for p in prs}
    for pr in prs:
        for match in PR_URL_RE.finditer(pr.get("body") or ""):
            other = known.get((match.group(1), int(match.group(2))))
            if other and other != pr["key"] and by_key[other]["repo"] != pr["repo"]:
                for a, b in ((pr["key"], other), (other, pr["key"])):
                    if b not in rel[a]["pairs"]:
                        rel[a]["pairs"].append(b)

    root = {k: k for k in by_key}

    def find(k):
        while root[k] != k:
            root[k] = root[root[k]]
            k = root[k]
        return k

    for key, r in rel.items():
        for other in ([r["parent"]] if r["parent"] else []) + r["pairs"]:
            root[find(key)] = find(other)

    comps = {}
    for key in sorted(by_key, key=lambda k: (by_key[k]["repo"], by_key[k]["number"])):
        comps.setdefault(find(key), []).append(key)

    def walk(key, depth, seen, members):
        if key in seen:
            return
        seen.add(key)
        members.append({"key": key, "depth": depth})
        for child in sorted(rel[key]["children"], key=lambda item: by_key[item]["number"]):
            walk(child, depth + 1, seen, members)

    groups = []
    for keys in comps.values():
        members, seen = [], set()
        for key in keys:
            if not rel[key]["parent"]:
                walk(key, 0, seen, members)
        for key in keys:
            walk(key, 0, seen, members)

        stacked = len(keys) > 1 or any(rel[k]["merged_parent"] for k in keys)
        groups.append({
            "id": members[0]["key"],
            "kind": "stack" if stacked else "standalone",
            "members": members,
            "repos": sorted({by_key[k]["repo"] for k in keys}),
        })
    groups.sort(key=lambda g: (g["kind"] != "stack", g["id"]))
    return groups, rel


# --- Deterministic status evaluation ---


def _withholds(body: str) -> bool:
    text = (body or "").lower()
    return "withhold" in text or "not approving" in text or "approval withheld" in text


def ci_summary(pr: dict) -> dict:
    real = [c for c in pr.get("checks") or [] if (c.get("name") or "").lower() not in META_CHECKS]
    failing = [{"name": c["name"], "url": c.get("url") or ""} for c in real if c.get("state") == "fail"]
    pending = [{"name": c["name"], "url": c.get("url") or ""} for c in real if c.get("state") == "pending"]
    if failing:
        state = "red"
    elif pending:
        state = "pending"
    elif not real:
        state = "none"
    else:
        state = "green"
    return {"state": state, "failing": failing, "pending": pending, "total": len(real)}


def review_summary(pr: dict, viewer: str, uses_pullfrog: bool) -> dict:
    head = pr.get("head_oid") or ""
    reviews = sorted(pr.get("reviews") or [], key=lambda r: r.get("at") or "")
    pf_reviews = [r for r in reviews if is_pullfrog(r.get("author"))]
    pf_on_head = [r for r in pf_reviews if r.get("commit") == head]
    approved_on_head = False
    for r in pf_on_head:
        if r.get("state") == "APPROVED":
            approved_on_head = True
        elif r.get("state") == "CHANGES_REQUESTED" or (r.get("state") == "COMMENTED" and _withholds(r.get("body", ""))):
            approved_on_head = False
    pf_verdicts = [r for r in pf_reviews if r.get("state") in ("APPROVED", "CHANGES_REQUESTED")]
    pf_latest = pf_verdicts[-1] if pf_verdicts else None
    pf_check = next((c for c in pr.get("checks") or [] if (c.get("name") or "").lower() == "pullfrog"), None)
    pf_running = bool(pf_check and pf_check.get("state") == "pending")
    if pf_running:
        pf_state = "pending"
    elif approved_on_head:
        pf_state = "approved"
    elif pf_latest and pf_latest.get("state") == "CHANGES_REQUESTED":
        pf_state = "changes_requested"
    elif pf_reviews:
        pf_state = "commented"
    else:
        pf_state = "none"

    human_latest = {}
    for r in reviews:
        who = r.get("author") or ""
        if who and who != viewer and not is_bot(who) and r.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            human_latest[who] = r["state"]

    threads = pr.get("threads") or []
    unresolved = [t for t in threads if not t.get("resolved")]
    pf_open_threads = [t for t in unresolved if is_pullfrog(t.get("author"))]
    return {
        "uses_pullfrog": uses_pullfrog,
        "pullfrog": pf_state,
        "pullfrog_running": pf_running,
        "pullfrog_approved_on_head": approved_on_head,
        "pullfrog_open_threads": len(pf_open_threads),
        "approved_by": sorted(w for w, s in human_latest.items() if s == "APPROVED"),
        "changes_requested_by": sorted(w for w, s in human_latest.items() if s == "CHANGES_REQUESTED"),
        "unresolved_threads": len(unresolved),
    }


def evaluate_pr(pr: dict, relation: dict, viewer: str, uses_pullfrog: bool) -> dict:
    """Return deterministic status, label, tone, reason, checks, and review summary."""
    ci = ci_summary(pr)
    rev = review_summary(pr, viewer, uses_pullfrog)
    mine = (pr.get("author") or "").lower() == viewer.lower()
    review_req = any((who or "").lower() == viewer.lower() for who in pr.get("review_requested") or [])

    def out(status: str, label: str, tone: str, reason: str):
        return {"status": status, "label": label, "tone": tone, "reason": reason, "ci": ci, "review": rev}

    if not mine and (review_req or pr.get("source") == "review_requested") and not pr.get("draft"):
        via = "" if review_req else " (via team)"
        return out("needs_your_review", "needs your review", "pending", f"{pr['author']} requested review{via}")

    mp = relation.get("merged_parent")
    if mp and (mp.get("carries_old_commits") or not mp.get("retargeted")):
        return out("conflict", "conflict", "failing", f"parent {mp['key']} merged; rebase onto {pr.get('trunk', 'main')}")

    if pr.get("mergeable") == "CONFLICTING":
        return out("conflict", "conflict", "failing", f"conflicts with {pr['base']}")

    if relation.get("parent") and (pr.get("behind_by") or 0) > 0:
        return out("conflict", "conflict", "failing", f"behind parent {pr['base']} by {pr['behind_by']} commit(s)")

    if ci["state"] == "red":
        names = ", ".join(c["name"] for c in ci["failing"][:3])
        return out("ci_failed", "ci failed", "failing", f"failed: {names}")

    if rev["uses_pullfrog"] and mine and (
        rev["pullfrog_open_threads"] > 0
        or (rev["pullfrog"] == "changes_requested" and not rev["pullfrog_approved_on_head"])
    ):
        bits = []
        if rev["pullfrog"] == "changes_requested":
            bits.append("pullfrog requested changes")
        if rev["pullfrog_open_threads"]:
            bits.append(f"{rev['pullfrog_open_threads']} open thread(s)")
        return out("changes_requested", "changes requested", "failing", "; ".join(bits))

    if rev["changes_requested_by"]:
        return out("changes_requested", "changes requested", "failing", "changes by " + ", ".join(rev["changes_requested_by"]))

    if pr.get("draft"):
        return out("draft", "draft", "muted", "draft pull request")

    if ci["state"] == "pending":
        return out("pending", "ci running", "pending", f"{len(ci['pending'])} of {ci['total']} checks running")

    if rev["uses_pullfrog"] and mine and not rev["pullfrog_approved_on_head"]:
        reason = "pullfrog reviewing head" if rev["pullfrog_running"] else "awaiting pullfrog approval on head"
        return out("pending", "review pending", "pending", reason)

    holds = []
    if relation.get("parent"):
        holds.append(f"waiting on parent {relation['parent']}")
    if pr.get("base") != pr.get("trunk") and not relation.get("parent"):
        holds.append(f"base {pr['base']} is not {pr.get('trunk')}")
    if pr.get("merge_state") not in ("CLEAN", "HAS_HOOKS", "UNSTABLE", "UNKNOWN"):
        holds.append(f"merge state {str(pr.get('merge_state')).lower()}")
    if holds:
        return out("pending", "waiting", "pending", "; ".join(holds))

    return out("ready_to_merge", "ready to merge", "ready", "checks green and ready to merge")


def quick_actions_for(pr: dict, ev: dict, relation: dict) -> list[dict]:
    """Contextual agent-first quick prompts to drop into the chat composer."""
    ref = f"{pr['repo']}#{pr['number']}"
    actions = []
    status = ev["status"]

    if status == "conflict":
        if relation.get("parent") or relation.get("merged_parent"):
            target = pr["trunk"] if relation.get("merged_parent") else pr["base"]
            actions.append({
                "id": "rebase-parent",
                "label": "Rebase on parent",
                "prompt": f"Rebase PR {ref} onto {target}, resolve any conflicts, and push.",
            })
        else:
            actions.append({
                "id": "resolve-conflicts",
                "label": "Resolve conflicts",
                "prompt": f"Rebase PR {ref} onto {pr['base']}, resolve the merge conflicts, and push.",
            })

    if ev["ci"]["state"] == "red":
        failing = ", ".join(c["name"] for c in ev["ci"]["failing"][:3])
        actions.append({
            "id": "fix-ci",
            "label": "Fix failing CI",
            "prompt": f"Inspect the failing CI checks on PR {ref} ({failing}), fix them, and push.",
        })

    if status == "changes_requested" or ev["review"]["unresolved_threads"] > 0:
        actions.append({
            "id": "address-threads",
            "label": "Address review threads",
            "prompt": f"Read and address the open review threads on PR {ref}, reply with what changed, and push.",
        })

    if status == "needs_your_review":
        actions.append({
            "id": "review-pr",
            "label": "Review this PR",
            "prompt": f"Review PR {ref} ({pr['title']}) and summarize any bugs, risks, or suggested changes.",
        })

    if relation.get("parent") and not any(a["id"] == "rebase-parent" for a in actions):
        actions.append({
            "id": "rebase-parent",
            "label": "Rebase on parent",
            "prompt": f"Rebase PR {ref} onto its parent branch {pr['base']} and push.",
        })

    if status == "ready_to_merge" and not actions:
        actions.append({
            "id": "check-merge",
            "label": "Check merge readiness",
            "prompt": f"Verify PR {ref} is still green and ready to merge.",
        })

    if not actions:
        actions.append({
            "id": "check-status",
            "label": "Check PR status",
            "prompt": f"Check the latest CI and review status on PR {ref} and tell me what's left.",
        })
    return actions[:3]


# --- Automatic fallback inference from state.db (strictly ?mode=ro) ---


def _connect_ro(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def _created_by_call(con: sqlite3.Connection, sid: str, tool_call_id: str) -> bool:
    row = con.execute(
        "SELECT tool_calls FROM messages WHERE session_id = ? AND role = 'assistant' AND tool_calls LIKE ? LIMIT 1",
        (sid, f"%{tool_call_id}%"),
    ).fetchone()
    if not row:
        return False
    try:
        calls = json.loads(row["tool_calls"])
    except (TypeError, ValueError):
        return "gh pr create" in (row["tool_calls"] or "")
    for c in calls if isinstance(calls, list) else []:
        if c.get("id") == tool_call_id or c.get("call_id") == tool_call_id:
            return "gh pr create" in json.dumps(c.get("function", c))
    return False


def _rank_inferred_owner(
    chats: dict[str, dict],
    latest_by_chat: dict[str, tuple[str, str, bool]],
    session_by_id: dict[str, tuple[str, str, bool, float]],
) -> dict | None:
    if not chats:
        return None
    for entry in chats.values():
        latest = latest_by_chat.get(entry["chat"]) if entry["source"] == "portal" else None
        if latest is None:
            best = max(
                (session_by_id[s] for s in entry["sessions"] if s in session_by_id),
                key=lambda item: item[3],
                default=None,
            )
            latest = best[:3] if best else (next(iter(entry["sessions"])), "", False)
        entry["session"], entry["title"], entry["archived"] = latest
    ranked = sorted(
        chats.values(),
        key=lambda c: (
            c["created"],
            not c["archived"],
            c["source"] in ("portal", "desktop"),
            c["mentions"],
            c["last_at"],
        ),
        reverse=True,
    )
    winner = ranked[0]
    return {
        "session": winner["session"],
        "title": winner["title"],
        "source": winner["source"],
        "archived": winner["archived"],
        "explicit": False,
    }


def infer_pr_owners(prs: list[dict], state_db: Path) -> dict[str, dict | None]:
    """Infer owning Portal/interactive chat for each PR from state.db (?mode=ro) via batched messages_fts."""
    if not state_db.is_file() or not prs:
        return {}
    out: dict[str, dict | None] = {pr["key"]: None for pr in prs}
    source_placeholders = ",".join("?" for _ in INTERACTIVE_SOURCES)
    source_params = tuple(sorted(INTERACTIVE_SOURCES))
    fts_sql = (
        "SELECT m.role, m.content, m.tool_calls, m.tool_call_id, m.timestamp, "
        "s.id AS sid, s.source, s.chat_id "
        "FROM messages_fts f JOIN messages m ON m.id = f.rowid "
        f"JOIN sessions s ON s.id = m.session_id WHERE messages_fts MATCH ? AND s.source IN ({source_placeholders})"
    )
    with closing(_connect_ro(state_db)) as con:
        # Preload session metadata once so we don't fire per-PR session lookup queries in a loop.
        latest_by_chat: dict[str, tuple[str, str, bool]] = {}
        session_by_id: dict[str, tuple[str, str, bool, float]] = {}
        try:
            for srow in con.execute(
                "SELECT id, chat_id, title, archived, COALESCE(last_activity_at, started_at, 0) AS ts "
                "FROM sessions ORDER BY ts DESC"
            ):
                sid = srow["id"]
                info = (sid, srow["title"] or "", bool(srow["archived"]))
                session_by_id[sid] = (*info, float(srow["ts"] or 0))
                cid = srow["chat_id"]
                if cid and cid not in latest_by_chat:
                    latest_by_chat[cid] = info
        except sqlite3.Error:
            pass

        matchers: list[tuple[str, str, re.Pattern[str]]] = []
        for pr in prs:
            url = pr.get("url") or f"https://github.com/{pr['repo']}/pull/{pr['number']}"
            phrase = url.removeprefix("https://")
            matchers.append((pr["key"], phrase, re.compile(re.escape(phrase) + r"(?!\d)")))

        chats_by_pr: dict[str, dict[str, dict]] = {}
        created_cache: dict[tuple[str, str], bool] = {}

        def _process_rows(rows, chunk: list[tuple[str, str, re.Pattern[str]]]) -> None:
            for row in rows:
                content = row["content"] or ""
                tool_calls = row["tool_calls"] or ""
                combined = content + tool_calls
                matched_keys = [
                    key for key, phrase, exact in chunk if phrase in combined and exact.search(combined)
                ]
                if not matched_keys:
                    continue
                is_created = False
                if row["role"] == "tool" and row["tool_call_id"]:
                    ckey = (row["sid"], row["tool_call_id"])
                    if ckey not in created_cache:
                        created_cache[ckey] = _created_by_call(con, row["sid"], row["tool_call_id"])
                    is_created = created_cache[ckey]
                # Ignore bulk PR dumps (e.g. `gh pr list`, triage digests, Slack channel scrapes)
                # so unrelated chats that merely listed many PRs don't claim ownership.
                if not is_created:
                    distinct_prs = set(PR_URL_RE.findall(content))
                    if row["role"] == "tool" and len(distinct_prs) > 2:
                        continue
                    if row["role"] != "tool" and len(distinct_prs) > 4:
                        continue
                chat_key = row["chat_id"] if row["source"] == "portal" and row["chat_id"] else row["sid"]
                for pr_key in matched_keys:
                    pr_chats = chats_by_pr.setdefault(pr_key, {})
                    entry = pr_chats.setdefault(chat_key, {
                        "chat": chat_key,
                        "source": row["source"],
                        "sessions": set(),
                        "mentions": 0,
                        "created": False,
                        "last_at": row["timestamp"] or 0,
                    })
                    entry["sessions"].add(row["sid"])
                    entry["mentions"] += 1
                    entry["last_at"] = max(entry["last_at"], row["timestamp"] or 0)
                    if is_created:
                        entry["created"] = True

        for i in range(0, len(matchers), 40):
            chunk = matchers[i : i + 40]
            query = " OR ".join(f'"{phrase}"' for _, phrase, _ in chunk)
            try:
                rows = con.execute(fts_sql, (query, *source_params)).fetchall()
            except sqlite3.Error:
                for item in chunk:
                    try:
                        rows = con.execute(fts_sql, (f'"{item[1]}"', *source_params)).fetchall()
                    except sqlite3.Error:
                        continue
                    _process_rows(rows, [item])
                continue
            _process_rows(rows, chunk)

        for pr_key, pr_chats in chats_by_pr.items():
            out[pr_key] = _rank_inferred_owner(pr_chats, latest_by_chat, session_by_id)
    return out


def _load_seed_snapshot(seed_db: Path) -> dict | None:
    """Read the latest snapshot from a shepherd.db cache, strictly ?mode=ro."""
    if not seed_db or not seed_db.is_file():
        return None
    try:
        with closing(_connect_ro(seed_db)) as con:
            row = con.execute("SELECT view FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            return None
        data = json.loads(zlib.decompress(row["view"]))
        return data if isinstance(data, dict) and isinstance(data.get("prs"), list) else None
    except Exception as error:  # noqa: BLE001
        log.warning("prs: could not read seed snapshot %s: %s", seed_db, error)
        return None


def _session_meta(state_db: Path | None) -> dict[str, tuple[str, bool, str]]:
    """Map session id -> (title, archived, chat_id) from state.db (?mode=ro) for links and group lookup."""
    if not state_db or not state_db.is_file():
        return {}
    try:
        with closing(_connect_ro(state_db)) as con:
            rows = con.execute(
                "SELECT id, title, archived, chat_id FROM sessions WHERE source = 'portal' "
                "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 4000"
            ).fetchall()
        return {r["id"]: (r["title"] or "", bool(r["archived"]), r["chat_id"] or "") for r in rows}
    except sqlite3.Error:
        return {}


def _load_disk_cache(cache_path: Path | None) -> tuple[dict, dict[str, dict | None] | None, str | None] | None:
    """Read a persisted gzipped PR snapshot cache from disk."""
    if not cache_path or not cache_path.is_file():
        return None
    try:
        with gzip.open(cache_path, "rt", encoding="utf-8") as fh:
            payload = json.load(fh)
        raw = payload.get("raw") if isinstance(payload, dict) else None
        if not isinstance(raw, dict) or not isinstance(raw.get("prs"), list):
            return None
        inferred = payload.get("inferred")
        state_db = payload.get("state_db")
        return raw, inferred if isinstance(inferred, dict) else None, state_db if isinstance(state_db, str) else None
    except Exception as error:  # noqa: BLE001
        log.warning("prs: could not read disk cache %s: %s", cache_path, error)
        return None


def _save_disk_cache(
    cache_path: Path,
    raw: dict,
    inferred: dict[str, dict | None] | None,
    state_db: Path | None = None,
) -> None:
    """Atomically write the latest PR snapshot + inferred owners to a gzipped cache file."""
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".prs-cache-", suffix=".tmp", dir=str(cache_path.parent))
        tmp_path = Path(tmp_name)
        try:
            os.fchmod(fd, 0o600)
            payload = {"raw": raw, "inferred": inferred, "state_db": str(state_db) if state_db else None}
            with os.fdopen(fd, "wb") as raw_fh, gzip.GzipFile(fileobj=raw_fh, mode="wb", compresslevel=5) as gz:
                gz.write(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
            os.replace(tmp_path, cache_path)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise
    except Exception as error:  # noqa: BLE001
        log.warning("prs: could not write disk cache %s: %s", cache_path, error)


def _attach_group_lead(
    owner: dict | None,
    meta: dict[str, tuple[str, bool, str]],
    chat_groups: dict[str, dict] | None,
) -> dict | None:
    """Attach the owning chat's group primary (lead) session when one is configured."""
    if not owner or owner.get("source") != "portal" or not chat_groups:
        return owner
    sid = owner.get("session")
    if not sid:
        return owner
    entry = meta.get(sid)
    chat_id = entry[2] if entry else ""
    group = (chat_groups.get(chat_id) if chat_id else None) or chat_groups.get(sid)
    lead = group.get("lead_session") if group else None
    if not lead:
        return owner
    lead_entry = meta.get(lead)
    return {
        **owner,
        "group_name": group.get("name") or "",
        "lead_session": lead,
        "lead_title": lead_entry[0] if lead_entry else "",
        "lead_archived": lead_entry[1] if lead_entry else False,
    }


def assemble_view(
    raw: dict,
    *,
    explicit_links: Sequence[dict] = (),
    inferred_owners: dict[str, dict | None] | None = None,
    session_titles: dict[str, tuple] | None = None,
    chat_groups: dict[str, dict] | None = None,
    viewer: str | None = None,
    readonly: bool = False,
    stale: bool = False,
    refreshing: bool = False,
    error: str | None = None,
) -> dict:
    """Normalize a snapshot + explicit session links into the Portal PR API payload."""
    me = viewer or raw.get("viewer") or ""
    raw_prs = list(raw.get("prs") or [])
    merged = list(raw.get("merged") or [])
    meta: dict[str, tuple[str, bool, str]] = {
        sid: (entry[0], bool(entry[1]), entry[2] if len(entry) > 2 else "")
        for sid, entry in (session_titles or {}).items()
    }

    # Explicit links by PR key (newest link wins as primary owner, while keeping every linked session).
    explicit_by_pr: dict[str, list[dict]] = {}
    for link in sorted(explicit_links, key=lambda item: item.get("linked_at") or 0, reverse=True):
        key = f"{link['repo']}#{link['number']}"
        explicit_by_pr.setdefault(key, []).append(link)

    groups, rel = build_stacks(raw_prs, merged)
    uses_pullfrog = {
        p["repo"]
        for p in raw_prs
        if any(is_pullfrog(r.get("author")) for r in p.get("reviews") or [])
        or any((c.get("name") or "").lower() == "pullfrog" for c in p.get("checks") or [])
    }

    depth_of = {m["key"]: m["depth"] for g in groups for m in g["members"]}
    group_of = {m["key"]: g["id"] for g in groups for m in g["members"]}

    items: dict[str, dict] = {}
    for pr in raw_prs:
        key = pr["key"]
        relation = rel[key]
        ev = evaluate_pr(pr, relation, me, pr["repo"] in uses_pullfrog)

        # Resolve owning chat: explicit link > inferred owner > precomputed link in seed snapshot.
        owner = None
        exp = explicit_by_pr.get(key)
        if exp:
            sid = exp[0]["session"]
            title, archived, _ = meta.get(sid, ("", False, ""))
            owner = {"session": sid, "title": title, "source": "portal", "archived": archived, "explicit": True}
        elif inferred_owners is not None and key in inferred_owners:
            owner = inferred_owners[key]
        else:
            pre = (pr.get("link") or {}).get("owner")
            if pre and pre.get("session"):
                sid = pre["session"]
                title, archived, _ = meta.get(sid, (pre.get("title") or "", bool(pre.get("archived")), ""))
                owner = {
                    "session": sid,
                    "title": title,
                    "source": pre.get("source") or "portal",
                    "archived": archived,
                    "explicit": False,
                }
        owner = _attach_group_lead(owner, meta, chat_groups)

        items[key] = {
            "key": key,
            "repo": pr["repo"],
            "number": pr["number"],
            "title": pr["title"],
            "url": pr["url"],
            "author": pr["author"],
            "mine": (pr.get("author") or "").lower() == me.lower(),
            "draft": bool(pr.get("draft")),
            "base": pr.get("base") or pr.get("trunk") or "main",
            "head": pr.get("head") or "",
            "trunk": pr.get("trunk") or "main",
            "updated_at": pr.get("updated_at") or "",
            "status": ev["status"],
            "status_label": ev["label"],
            "tone": ev["tone"],
            "reason": ev["reason"],
            "checks": ev["ci"],
            "review": ev["review"],
            "owner": owner,
            "stack_id": group_of[key],
            "depth": depth_of[key],
            "parent_key": relation["parent"],
            "child_keys": list(relation["children"]),
            "merged_parent": relation["merged_parent"],
            "quick_actions": quick_actions_for(pr, ev, relation),
        }

    # Include explicitly linked PRs that are no longer open (e.g., merged) so their chat still shows a purple chip!
    for key, links in explicit_by_pr.items():
        if key in items:
            continue
        link = links[0]
        state = (link.get("state") or "open").lower()
        status = "merged" if state == "merged" else "pending"
        tone = "merged" if state == "merged" else "pending"
        label = "merged" if state == "merged" else state
        sid = link["session"]
        title, archived, _ = meta.get(sid, ("", False, ""))
        merged_owner = _attach_group_lead(
            {"session": sid, "title": title, "source": "portal", "archived": archived, "explicit": True},
            meta,
            chat_groups,
        )
        items[key] = {
            "key": key,
            "repo": link["repo"],
            "number": link["number"],
            "title": link.get("title") or f"{link['repo']}#{link['number']}",
            "url": link["url"],
            "author": me,
            "mine": True,
            "draft": False,
            "base": link.get("base") or "main",
            "head": link.get("branch") or "",
            "trunk": link.get("base") or "main",
            "updated_at": "",
            "status": status,
            "status_label": label,
            "tone": tone,
            "reason": "merged" if state == "merged" else "linked to this chat",
            "checks": {"state": "none", "failing": [], "pending": [], "total": 0},
            "review": {
                "uses_pullfrog": False,
                "pullfrog": "none",
                "pullfrog_running": False,
                "pullfrog_approved_on_head": False,
                "pullfrog_open_threads": 0,
                "approved_by": [],
                "changes_requested_by": [],
                "unresolved_threads": 0,
            },
            "owner": merged_owner,
            "stack_id": key,
            "depth": 0,
            "parent_key": None,
            "child_keys": [],
            "merged_parent": None,
            "quick_actions": [],
        }

    # Attach compact stack-node summaries so any popover can jump across parent -> self -> children.
    def node_ref(k: str) -> dict:
        p = items[k]
        owner = p["owner"]
        return {
            "key": p["key"],
            "number": p["number"],
            "repo": p["repo"],
            "title": p["title"],
            "url": p["url"],
            "status": p["status"],
            "status_label": p["status_label"],
            "tone": p["tone"],
            "depth": p["depth"],
            "session": owner["session"] if owner and owner["source"] == "portal" else None,
            "session_title": owner["title"] if owner else "",
            "lead_session": owner.get("lead_session") if owner and owner["source"] == "portal" else None,
            "lead_title": owner.get("lead_title") or "" if owner else "",
            "group_name": owner.get("group_name") or "" if owner else "",
        }

    group_members = {g["id"]: [m["key"] for m in g["members"]] for g in groups}
    for key, p in items.items():
        members = group_members.get(p["stack_id"], [key])
        p["stack"] = [node_ref(k) for k in members] if len(members) > 1 or p["merged_parent"] else []

    # Build session -> [pr keys] index (both explicit links and inferred portal owners).
    by_session: dict[str, list[str]] = {}
    for key, p in items.items():
        owner = p.get("owner")
        if owner and owner.get("session") and owner.get("source") == "portal":
            by_session.setdefault(owner["session"], []).append(key)
    for key, links in explicit_by_pr.items():
        for link in links:
            lst = by_session.setdefault(link["session"], [])
            if key not in lst:
                lst.append(key)

    ordered_prs = list(items.values())
    stacks_out = [
        {
            "id": g["id"],
            "kind": g["kind"],
            "repos": g["repos"],
            "members": [{"key": m["key"], "depth": m["depth"]} for m in g["members"]],
        }
        for g in groups
    ]
    return {
        "viewer": me,
        "taken_at": raw.get("taken_at") or time.time(),
        "stale": stale,
        "refreshing": refreshing,
        "readonly": readonly,
        "window_days": int(raw.get("window_days") or 0),
        "error": error or (raw.get("errors") or [None])[0],
        "prs": ordered_prs,
        "stacks": stacks_out,
        "by_session": by_session,
    }


def review_chat_prompt(pr: dict) -> tuple[str, str]:
    """Title and initial prompt for starting a review chat on a coworker's PR."""
    repo_short = pr["repo"].split("/")[-1]
    title = f"Review {repo_short}#{pr['number']}: {pr['title']}"[:80]
    prompt = (
        f"Review PR {pr['repo']}#{pr['number']} ({pr['url']})\n\n"
        f"Title: {pr['title']}\n"
        f"Author: {pr['author']}\n"
        f"Branches: {pr['base']} <- {pr['head']}\n\n"
        "Inspect the diff, CI status, and any open review threads, then summarize bugs, risks, and whether it looks ready."
    )
    return title, prompt


class PRService:
    """Caches read-only GitHub PR snapshots with disk persistence, delta refresh, and rate-limit backoff."""

    def __init__(
        self,
        store,
        *,
        home=None,
        viewer: str | None = None,
        seed_db: Path | None = None,
        cache_path: Path | None = None,
        ttl: float = DEFAULT_PR_TTL_S,
        readonly: bool = False,
        collector=None,
        on_update=None,
        clock=time.monotonic,
    ):
        self.store = store
        self._home_source = home
        self.viewer = viewer
        self.seed_db = Path(seed_db) if seed_db else None
        self.cache_path = Path(cache_path) if cache_path else None
        self.ttl = ttl
        self.readonly = readonly
        self.collector = collector or collect_live
        self.on_update = on_update
        self.clock = clock
        self._raw: dict | None = None
        self._inferred: dict[str, dict | None] | None = None
        self._inferred_db: Path | None = None
        self._inferred_mtime: float | None = None
        self._at = 0.0
        self._running: asyncio.Future | None = None
        self._last_error: str | None = None
        self._disk_loaded = False
        self._include_older = False
        self._rate_limit_strikes = 0
        self._backoff_until = 0.0

    @property
    def home(self) -> Path | None:
        raw = self._home_source() if callable(self._home_source) else self._home_source
        return Path(str(raw)) if raw is not None else None

    def _state_db(self) -> Path | None:
        h = self.home
        return (h / "state.db") if h else None

    def invalidate_home(self) -> None:
        self._inferred = None
        self._inferred_db = None
        self._inferred_mtime = None

    def _effective_ttl(self, now: float) -> float:
        ttl = self.ttl
        if self._backoff_until > now:
            return max(ttl, self._backoff_until - self._at)
        rl = (self._raw or {}).get("rate_limit")
        remaining = rl.get("remaining") if isinstance(rl, dict) else None
        if isinstance(remaining, int) and remaining < LOW_RATE_LIMIT_THRESHOLD:
            reset_ts = _parse_iso_ts(rl.get("resetAt")) if isinstance(rl, dict) else 0.0
            until_reset = max(0.0, reset_ts - time.time()) if reset_ts else 900.0
            return max(ttl, min(until_reset + 15.0, 3600.0))
        has_pending_ci = any(
            c.get("state") == "pending"
            for pr in ((self._raw or {}).get("prs") or [])
            for c in (pr.get("checks") or [])
        )
        if has_pending_ci and (remaining is None or remaining >= 1000):
            return min(ttl, ACTIVE_CI_TTL_S)
        return ttl

    def _note_rate_limit_error(self, error_text: str | None) -> None:
        if _is_rate_limit_error(error_text):
            self._rate_limit_strikes = min(self._rate_limit_strikes + 1, 4)
            wait_s = min(300.0 * (2 ** (self._rate_limit_strikes - 1)), 1800.0)
            self._backoff_until = self.clock() + wait_s
            log.warning("prs: GitHub rate limit hit; backing off background refresh for %.0fs", wait_s)

    def _is_refreshing(self) -> bool:
        return self._running is not None and not self._running.done()

    def _start_collect(self, *, manual: bool = False) -> asyncio.Future:
        run = self._running
        if run is None or run.done():
            run = self._running = asyncio.ensure_future(self._collect(manual=manual))
            run.add_done_callback(self._on_collect_done)
        return run

    def _on_collect_done(self, task: asyncio.Future) -> None:
        if self._running is task:
            self._running = None
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._last_error = str(error)
            self._note_rate_limit_error(self._last_error)
            log.warning("prs: background refresh failed: %s", error)

    async def _hydrate_from_disk(self) -> bool:
        if self._disk_loaded or self._raw is not None:
            return self._raw is not None
        self._disk_loaded = True
        if self.cache_path is not None:
            cached = await asyncio.to_thread(_load_disk_cache, self.cache_path)
            if cached is not None:
                raw, inferred, cached_db = cached
                self._raw = raw
                state_db = self._state_db()
                if inferred is not None and (cached_db is None or (state_db and cached_db == str(state_db))):
                    self._inferred = inferred
                    self._inferred_db = state_db
                else:
                    self._inferred = None
                    self._inferred_db = None
                age = max(0.0, time.time() - float(raw.get("taken_at") or 0))
                self._at = self.clock() - age
                self._last_error = None
                return True
        if self.seed_db is not None:
            seed = await asyncio.to_thread(_load_seed_snapshot, self.seed_db)
            if seed is not None:
                self._raw = seed
                self._inferred = None
                self._inferred_db = None
                self._at = self.clock()
                self._last_error = None
                return True
        return False

    async def warm(self) -> None:
        """Preload disk cache on startup; only hit GitHub if no cached snapshot exists yet."""
        await self._hydrate_from_disk()
        if self._raw is None:
            self._start_collect(manual=False)

    async def snapshot(self, *, refresh: bool = False, passive: bool = False, include_older: bool = False) -> dict:
        if include_older:
            self._include_older = True
            if self._raw is not None and int(self._raw.get("window_days") or 0) > 0:
                refresh = True
        raw, stale, refreshing, error = await self._load_raw(refresh=refresh, passive=passive)
        state_db = self._state_db()
        if state_db != self._inferred_db:
            self._inferred = (
                await asyncio.to_thread(infer_pr_owners, raw.get("prs") or [], state_db)
                if state_db and state_db.is_file()
                else None
            )
            self._inferred_db = state_db
        explicit = await asyncio.to_thread(self.store.session_prs)
        chat_groups = await asyncio.to_thread(self.store.chat_groups)
        meta = await asyncio.to_thread(_session_meta, state_db)
        return assemble_view(
            raw,
            explicit_links=explicit,
            inferred_owners=self._inferred,
            session_titles=meta,
            chat_groups=chat_groups,
            viewer=self.viewer or raw.get("viewer"),
            readonly=self.readonly,
            stale=stale,
            refreshing=refreshing,
            error=error,
        )

    async def for_session(self, session: str, *, refresh: bool = False, passive: bool = False) -> list[dict]:
        view = await self.snapshot(refresh=refresh, passive=passive)
        keys = view["by_session"].get(session) or []
        by_key = {p["key"]: p for p in view["prs"]}
        return [by_key[k] for k in keys if k in by_key]

    async def _load_raw(self, *, refresh: bool = False, passive: bool = False) -> tuple[dict, bool, bool, str | None]:
        if not refresh and self._raw is None:
            await self._hydrate_from_disk()

        if passive and not refresh:
            if self._raw is not None:
                return self._raw, False, self._is_refreshing(), self._last_error
            return (
                {"viewer": self.viewer or "", "taken_at": time.time(), "prs": [], "merged": []},
                True,
                self._is_refreshing(),
                self._last_error,
            )

        now = self.clock()
        if not refresh and self._raw is not None:
            if (now - self._at) < self._effective_ttl(now):
                return self._raw, False, self._is_refreshing(), self._last_error
            # Stale-while-revalidate: return cached snapshot immediately and refresh in background.
            self._start_collect(manual=False)
            return self._raw, True, True, self._last_error

        run = self._start_collect(manual=refresh)
        try:
            await asyncio.shield(run)
        except Exception as error:  # noqa: BLE001
            self._last_error = str(error)
            self._note_rate_limit_error(self._last_error)
            if self._raw is not None:
                return self._raw, True, False, self._last_error
            return {"viewer": self.viewer or "", "taken_at": time.time(), "prs": [], "merged": []}, True, False, self._last_error
        return (
            self._raw or {"viewer": self.viewer or "", "taken_at": time.time(), "prs": [], "merged": []},
            False,
            False,
            self._last_error,
        )

    async def _collect(self, *, manual: bool = False):
        viewer = self.viewer or (self._raw.get("viewer") if self._raw else None) or None
        if self.collector is collect_live:
            raw = await asyncio.to_thread(
                collect_live,
                viewer,
                previous=self._raw,
                include_older=self._include_older,
                allow_conditional=not manual,
            )
        else:
            raw = await asyncio.to_thread(self.collector, viewer)
        state_db = self._state_db()
        db_mtime = state_db.stat().st_mtime if state_db and state_db.is_file() else None
        pr_keys = {p["key"] for p in raw.get("prs") or []}
        if (
            self._inferred is not None
            and state_db == self._inferred_db
            and db_mtime == self._inferred_mtime
            and pr_keys.issubset(self._inferred.keys())
        ):
            inferred = {k: self._inferred.get(k) for k in pr_keys}
        elif state_db and state_db.is_file():
            inferred = await asyncio.to_thread(infer_pr_owners, raw.get("prs") or [], state_db)
        else:
            inferred = {}
        self._raw = raw
        self._inferred = inferred
        self._inferred_db = state_db
        self._inferred_mtime = db_mtime
        self._at = self.clock()
        self._last_error = (raw.get("errors") or [None])[0]
        if self._last_error and _is_rate_limit_error(self._last_error):
            self._note_rate_limit_error(self._last_error)
        elif not self._last_error:
            self._rate_limit_strikes = 0
            self._backoff_until = 0.0
        if self.cache_path is not None:
            await asyncio.to_thread(_save_disk_cache, self.cache_path, raw, inferred, state_db)
        if self.on_update is not None:
            try:
                res = self.on_update()
                if asyncio.iscoroutine(res):
                    await res
            except Exception as error:  # noqa: BLE001
                log.warning("prs: update callback failed: %s", error)
