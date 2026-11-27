"""GitHub PR tracking for Portal: read-only GitHub snapshots, stack grouping, status evaluation,
and chat-to-PR linking (explicit links in portal.db with automatic fallback from state.db).

Every GitHub call goes through `gh_json`, which refuses any write (REST method other than GET,
REST fields without explicit GET, or GraphQL mutations).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import sqlite3
import subprocess
import time
import zlib
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

log = logging.getLogger("hermes.portal.prs")

GH = shutil.which("gh") or "/usr/bin/gh"
REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$")
PR_URL_RE = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
PR_KEY_RE = re.compile(r"^([\w.-]+/[\w.-]+)#(\d+)$")

INTERACTIVE_SOURCES = {"portal", "desktop", "slack", "discord", "tui", "cli"}
META_CHECKS = ("pullfrog", "protect-branch", "vercel", "vercel preview comments")

PR_FIELDS = """
 number title url isDraft createdAt updatedAt body
 baseRefName headRefName baseRefOid headRefOid baseRef{target{oid}}
 mergeable mergeStateStatus reviewDecision additions deletions changedFiles
 author{login}
 repository{nameWithOwner defaultBranchRef{name}}
 reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{slug}}}}
 commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state contexts(first:100){nodes{
   __typename
   ... on CheckRun{name conclusion status detailsUrl completedAt}
   ... on StatusContext{context state targetUrl}
 }}}}}}
 reviews(last:40){nodes{author{login} state submittedAt commit{oid} body url}}
 reviewThreads(first:100){nodes{isResolved isOutdated path line
   comments(first:1){nodes{author{login} body url createdAt}}}}
 timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], last:5){nodes{
   ... on BaseRefChangedEvent{previousRefName currentRefName createdAt}}}
"""

SEARCH_QUERY = (
    "query($q:String!, $after:String){\n"
    "  search(query:$q, type:ISSUE, first:10, after:$after){\n"
    "    pageInfo{hasNextPage endCursor}\n"
    f"    nodes{{ ... on PullRequest {{ {PR_FIELDS} }} }}\n"
    "  }\n"
    "}"
)

MERGED_QUERY = """
query($owner:String!, $name:String!){
  repository(owner:$owner, name:$name){
    pullRequests(states:MERGED, last:30, orderBy:{field:UPDATED_AT, direction:ASC}){
      nodes{ number title url headRefName headRefOid baseRefName mergedAt
             mergeCommit{oid parents(first:2){totalCount}} }
    }
  }
}"""

VIEWER_QUERY = "query{ viewer{ login } }"


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


def graphql(query: str, **variables):
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        if value is None:
            continue
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


def _merged_prs(repo: str) -> list[dict]:
    owner, name = repo.split("/", 1)
    nodes = graphql(MERGED_QUERY, owner=owner, name=name)["repository"]["pullRequests"]["nodes"]
    return [{
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


def collect_live(viewer: str | None = None) -> dict:
    """Collect a fresh read-only GitHub snapshot for `viewer` (defaults to `gh` viewer)."""
    started = time.time()
    me = viewer or graphql(VIEWER_QUERY)["viewer"]["login"]
    searches = (
        ("mine", f"is:pr is:open author:{me} archived:false"),
        ("review_requested", f"is:pr is:open review-requested:{me} archived:false"),
    )
    prs, errors = {}, []
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda s: (s, _try(_search_prs, s[1], s[0])), searches))
    for (source, _), (value, error) in results:
        if error:
            errors.append(f"search {source}: {error}")
            continue
        for pr in value or []:
            prs.setdefault(pr["key"], pr)

    repos = sorted({p["repo"] for p in prs.values()})
    merged = []
    if repos:
        with ThreadPoolExecutor(max_workers=6) as pool:
            merged_lists = list(pool.map(lambda r: (r, _try(_merged_prs, r)), repos))
        for repo, (value, error) in merged_lists:
            if error:
                errors.append(f"merged {repo}: {error}")
            merged += value or []

    return {
        "viewer": me,
        "taken_at": time.time(),
        "took_s": round(time.time() - started, 1),
        "prs": sorted(prs.values(), key=lambda p: (p["repo"], p["number"])),
        "merged": merged,
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


def infer_pr_owners(prs: list[dict], state_db: Path) -> dict[str, dict | None]:
    """Infer owning Portal/interactive chat for each PR from state.db (?mode=ro) via messages_fts."""
    if not state_db.is_file() or not prs:
        return {}
    out: dict[str, dict | None] = {}
    with closing(_connect_ro(state_db)) as con:
        for pr in prs:
            url = pr.get("url") or f"https://github.com/{pr['repo']}/pull/{pr['number']}"
            phrase = url.removeprefix("https://")
            exact = re.compile(re.escape(phrase) + r"(?!\d)")
            try:
                rows = con.execute(
                    "SELECT m.role, m.content, m.tool_calls, m.tool_call_id, m.timestamp, "
                    "s.id AS sid, s.source, s.chat_id, s.title, s.archived "
                    "FROM messages_fts f JOIN messages m ON m.id = f.rowid "
                    "JOIN sessions s ON s.id = m.session_id WHERE messages_fts MATCH ?",
                    (f'"{phrase}"',),
                ).fetchall()
            except sqlite3.Error:
                out[pr["key"]] = None
                continue
            chats = {}
            for row in rows:
                if row["source"] not in INTERACTIVE_SOURCES:
                    continue
                if not exact.search((row["content"] or "") + (row["tool_calls"] or "")):
                    continue
                chat_key = row["chat_id"] if row["source"] == "portal" and row["chat_id"] else row["sid"]
                entry = chats.setdefault(chat_key, {
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
                if row["role"] == "tool" and row["tool_call_id"] and _created_by_call(con, row["sid"], row["tool_call_id"]):
                    entry["created"] = True
            if not chats:
                out[pr["key"]] = None
                continue
            for entry in chats.values():
                latest = None
                if entry["source"] == "portal":
                    latest = con.execute(
                        "SELECT id, title, archived FROM sessions WHERE chat_id = ? "
                        "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1",
                        (entry["chat"],),
                    ).fetchone()
                if latest is None:
                    placeholders = ",".join("?" * len(entry["sessions"]))
                    latest = con.execute(
                        f"SELECT id, title, archived FROM sessions WHERE id IN ({placeholders}) "
                        "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1",
                        tuple(entry["sessions"]),
                    ).fetchone()
                entry["session"] = latest["id"] if latest else next(iter(entry["sessions"]))
                entry["title"] = (latest["title"] if latest else "") or ""
                entry["archived"] = bool(latest["archived"]) if latest else False
            ranked = sorted(
                chats.values(),
                key=lambda c: (c["created"], c["source"] in ("portal", "desktop"), c["mentions"], c["last_at"]),
                reverse=True,
            )
            winner = ranked[0]
            out[pr["key"]] = {
                "session": winner["session"],
                "title": winner["title"],
                "source": winner["source"],
                "archived": winner["archived"],
                "explicit": False,
            }
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


def _session_titles(state_db: Path | None) -> dict[str, tuple[str, bool]]:
    """Map session id -> (title, archived) from state.db (?mode=ro) for enriching explicit links."""
    if not state_db or not state_db.is_file():
        return {}
    try:
        with closing(_connect_ro(state_db)) as con:
            rows = con.execute(
                "SELECT id, title, archived FROM sessions WHERE source = 'portal' "
                "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 2000"
            ).fetchall()
        return {r["id"]: (r["title"] or "", bool(r["archived"])) for r in rows}
    except sqlite3.Error:
        return {}


def assemble_view(
    raw: dict,
    *,
    explicit_links: Sequence[dict] = (),
    inferred_owners: dict[str, dict | None] | None = None,
    session_titles: dict[str, tuple[str, bool]] | None = None,
    viewer: str | None = None,
    readonly: bool = False,
    stale: bool = False,
    error: str | None = None,
) -> dict:
    """Normalize a snapshot + explicit session links into the Portal PR API payload."""
    me = viewer or raw.get("viewer") or ""
    raw_prs = list(raw.get("prs") or [])
    merged = list(raw.get("merged") or [])
    titles = session_titles or {}

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
            title, archived = titles.get(sid, ("", False))
            owner = {"session": sid, "title": title, "source": "portal", "archived": archived, "explicit": True}
        elif inferred_owners is not None and key in inferred_owners:
            owner = inferred_owners[key]
        else:
            pre = (pr.get("link") or {}).get("owner")
            if pre and pre.get("session"):
                sid = pre["session"]
                title, archived = titles.get(sid, (pre.get("title") or "", bool(pre.get("archived"))))
                owner = {
                    "session": sid,
                    "title": title,
                    "source": pre.get("source") or "portal",
                    "archived": archived,
                    "explicit": False,
                }

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
        title, archived = titles.get(sid, ("", False))
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
            "owner": {"session": sid, "title": title, "source": "portal", "archived": archived, "explicit": True},
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
            "session": p["owner"]["session"] if p["owner"] and p["owner"]["source"] == "portal" else None,
            "session_title": p["owner"]["title"] if p["owner"] else "",
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
        "readonly": readonly,
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
    """Caches read-only GitHub PR snapshots and combines them with Portal's explicit session PR links."""

    def __init__(
        self,
        store,
        *,
        home: Path | None = None,
        viewer: str | None = None,
        seed_db: Path | None = None,
        ttl: float = 120.0,
        readonly: bool = False,
        collector=None,
        clock=time.monotonic,
    ):
        self.store = store
        self._home_source = home
        self.viewer = viewer
        self.seed_db = Path(seed_db) if seed_db else None
        self.ttl = ttl
        self.readonly = readonly
        self.collector = collector or collect_live
        self.clock = clock
        self._raw: dict | None = None
        self._inferred: dict[str, dict | None] | None = None
        self._inferred_db: Path | None = None
        self._at = 0.0
        self._running: asyncio.Future | None = None
        self._last_error: str | None = None

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

    async def snapshot(self, *, refresh: bool = False) -> dict:
        raw, stale, error = await self._load_raw(refresh=refresh)
        state_db = self._state_db()
        if state_db != self._inferred_db:
            self._inferred = (
                await asyncio.to_thread(infer_pr_owners, raw.get("prs") or [], state_db)
                if state_db and state_db.is_file()
                else None
            )
            self._inferred_db = state_db
        explicit = await asyncio.to_thread(self.store.session_prs)
        titles = await asyncio.to_thread(_session_titles, state_db)
        return assemble_view(
            raw,
            explicit_links=explicit,
            inferred_owners=self._inferred,
            session_titles=titles,
            viewer=self.viewer or raw.get("viewer"),
            readonly=self.readonly,
            stale=stale,
            error=error,
        )

    async def for_session(self, session: str, *, refresh: bool = False) -> list[dict]:
        view = await self.snapshot(refresh=refresh)
        keys = view["by_session"].get(session) or []
        by_key = {p["key"]: p for p in view["prs"]}
        return [by_key[k] for k in keys if k in by_key]

    async def _load_raw(self, *, refresh: bool = False) -> tuple[dict, bool, str | None]:
        now = self.clock()
        if not refresh and self._raw is not None and (now - self._at) < self.ttl:
            return self._raw, False, self._last_error

        # Fast-path initial hydration from a read-only seed DB (e.g. shepherd.db) before hitting GitHub.
        if not refresh and self._raw is None and self.seed_db is not None:
            seed = await asyncio.to_thread(_load_seed_snapshot, self.seed_db)
            if seed is not None:
                self._raw = seed
                self._inferred = None
                self._at = now
                self._last_error = None
                return seed, False, None

        run = self._running
        if run is None or run.done():
            run = self._running = asyncio.ensure_future(self._collect())
        try:
            await asyncio.shield(run)
        except Exception as error:  # noqa: BLE001
            self._last_error = str(error)
            if self._raw is not None:
                return self._raw, True, self._last_error
            return {"viewer": self.viewer or "", "taken_at": time.time(), "prs": [], "merged": []}, True, self._last_error
        finally:
            if self._running is run and run.done():
                self._running = None
        return self._raw or {"viewer": self.viewer or "", "taken_at": time.time(), "prs": [], "merged": []}, False, self._last_error

    async def _collect(self):
        raw = await asyncio.to_thread(self.collector, self.viewer)
        state_db = self._state_db()
        inferred = await asyncio.to_thread(infer_pr_owners, raw.get("prs") or [], state_db) if state_db and state_db.is_file() else {}
        self._raw = raw
        self._inferred = inferred
        self._inferred_db = state_db
        self._at = self.clock()
        self._last_error = (raw.get("errors") or [None])[0]
