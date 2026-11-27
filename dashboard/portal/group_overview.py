"""Group overview: live thread status, summaries, and artifacts read strictly read-only from state.db.

Nothing here writes to Hermes's session store (`state.db` is always opened `?mode=ro`). Messages
are scanned incrementally per session so repeated refreshes stay cheap. Live hub turns, pending
approval requests, and explicit agent-attached metadata from Portal's store layer cleanly on top.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlparse

from .hub import CRON_DELIVERY, FROM_THREAD, INBOX, NEEDS_YOU, REVIEWS, WORKING

# A running turn that has reported nothing for this long is considered stalled (needs attention).
SILENT_AFTER = 10 * 60
# A user prompt with no reply and no running turn after this long looks dropped (needs attention).
DROPPED_AFTER = 5 * 60
# Past this window, an unanswered user prompt is old history rather than a live stall.
DROPPED_UNTIL = 2 * 86400
# An open tool call without a result for this long is stalled, unless it is waiting on CI.
TOOL_STALL_AFTER = 30 * 60
SCAN_LIMIT = 4000

STATUS_NEEDS_YOU = "needs_you"
STATUS_WORKING = "working"
STATUS_WAITING = "waiting"
STATUS_IDLE = "idle"
STATUS_DONE = "done"

VALID_TASK_STATES = (STATUS_NEEDS_YOU, STATUS_WORKING, STATUS_WAITING, STATUS_IDLE, STATUS_DONE)
STATUS_ORDER = {
    STATUS_NEEDS_YOU: 0,
    STATUS_WORKING: 1,
    STATUS_WAITING: 2,
    STATUS_IDLE: 3,
    STATUS_DONE: 4,
}

PULL = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")
URL = re.compile(r"https?://[^\s<>()\[\]{}\"'`|]+")
REVIEW_TITLE = re.compile(r"(?:^|[\s·:|/-])review\b", re.IGNORECASE)
CI_WAIT = re.compile(
    r"gh\s+(?:pr\s+checks|run\s+(?:watch|view|list))|wait[-_]for[-_]ci|checks?\s+--watch|until\s+.*\bgh\b|sleep\s+\d{2,}",
    re.IGNORECASE,
)
CI_PROSE = re.compile(
    r"\b(?:waiting (?:on|for) (?:ci|checks|the checks|the build|review)|ci is (?:running|pending)|once ci|"
    r"checks are (?:running|pending)|when ci (?:is )?(?:green|finishes|passes)|watching ci)\b",
    re.IGNORECASE,
)
SIGN_OFF = re.compile(r"<signoff>.*?</signoff>", re.DOTALL | re.IGNORECASE)
MEDIA_LINE = re.compile(r"^\s*MEDIA:[^\n]+$", re.MULTILINE)
MARKUP = re.compile(r"\*\*|__|`+|^#+\s*", re.MULTILINE)
CD_PREFIX = re.compile(r"^\s*cd\s+((?:\"[^\"]+\")|(?:'[^']+')|[^\s;&|]+)")
GIT_C = re.compile(r"\bgit\s+-C\s+((?:\"[^\"]+\")|(?:'[^']+')|[^\s;&|]+)")
WORKTREE_ADD = re.compile(r"\bgit(?:\s+-C\s+\S+)?\s+worktree\s+add\s+(?:(?:-b|-B)\s+(\S+)\s+)?(?:--?\S+\s+)*(\S+)")
NEW_BRANCH = re.compile(r"\bgit\s+(?:checkout\s+-[bB]|switch\s+-[cC])\s+(\S+)")
PUSH_BRANCH = re.compile(r"\bgit\s+push\s+(?:-u|--set-upstream)\s+\S+\s+(?:HEAD:)?([\w./-]+)")
KEY_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{24,}$")


def connect_ro(path: Path):
    """Open SQLite strictly read-only."""
    return closing(sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True, timeout=10))


def preview_hosts_for(origin: str) -> tuple[str, ...]:
    """Domains whose links count as previews when none are explicitly configured."""
    host = (urlparse(origin or "").hostname or "").lower()
    labels = host.split(".")
    return (".".join(labels[1:]),) if len(labels) >= 3 else ()


def pull_requests(text: str) -> list[dict]:
    seen = {}
    for owner, repo, number in PULL.findall(text or ""):
        key = f"{owner}/{repo}#{number}"
        seen.setdefault(
            key,
            {
                "key": key,
                "repo": f"{owner}/{repo}",
                "number": int(number),
                "url": f"https://github.com/{owner}/{repo}/pull/{number}",
            },
        )
    return list(seen.values())


def preview_links(text: str, hosts: tuple[str, ...], exclude: tuple[str, ...] = ()) -> list[dict]:
    found = {}
    for raw in URL.findall(text or ""):
        url = raw.rstrip(".,;:!?*_")
        try:
            parsed = urlparse(url)
            host, port = (parsed.hostname or "").lower(), parsed.port
        except ValueError:
            continue
        if not host or host.endswith("github.com") or host in exclude:
            continue
        loopback = host in ("localhost", "127.0.0.1") or host.endswith(".localhost")
        if not loopback and not any(host.endswith("." + h) for h in hosts):
            continue
        if loopback and not port and not host.endswith(".localhost"):
            continue
        if any(KEY_SEGMENT.match(seg) for seg in parsed.path.split("/")):
            continue
        label = host if not port else f"{host}:{port}"
        found.pop(label, None)
        found[label] = {"url": url, "label": label}
    return list(found.values())


def _unquote(path: str) -> str:
    return path[1:-1] if path[:1] in "\"'" and path[-1:] == path[:1] else path


def tool_places(tool_calls) -> tuple[list[str], list[str]]:
    try:
        calls = json.loads(tool_calls) if isinstance(tool_calls, str) else tool_calls or []
    except ValueError:
        return [], []
    paths, branches = [], []
    for call in calls if isinstance(calls, list) else []:
        function = (call or {}).get("function") or {}
        try:
            args = json.loads(function.get("arguments") or "{}")
        except ValueError:
            continue
        if not isinstance(args, dict):
            continue
        for key in ("workdir", "cwd"):
            if isinstance(args.get(key), str) and args[key].startswith("/"):
                paths.append(args[key])
        command = args.get("command") if isinstance(args.get("command"), str) else ""
        if command:
            if match := CD_PREFIX.match(command):
                paths.append(_unquote(match.group(1)))
            paths.extend(_unquote(p) for p in GIT_C.findall(command))
            for branch, where in WORKTREE_ADD.findall(command):
                paths.append(_unquote(where))
                if branch:
                    branches.append(branch)
            branches.extend(NEW_BRANCH.findall(command))
            branches.extend(PUSH_BRANCH.findall(command))
    return [p for p in paths if p.startswith("/")], branches


def checkout_branch(path: str) -> str | None:
    """Read the current git branch from `.git/HEAD` without invoking git."""
    here = Path(path)
    home = Path.home()
    for _ in range(8):
        if here == home:
            return None
        dot = here / ".git"
        try:
            if dot.is_file():
                line = dot.read_text(errors="replace").strip()
                gitdir = Path(line.split(":", 1)[1].strip()) if line.startswith("gitdir:") else None
                head = (gitdir if gitdir and gitdir.is_absolute() else here / (gitdir or "")) / "HEAD"
            elif dot.is_dir():
                head = dot / "HEAD"
            else:
                head = None
            if head is not None:
                ref = head.read_text(errors="replace").strip()
                return ref.split("refs/heads/", 1)[1] if ref.startswith("ref: refs/heads/") else None
        except OSError:
            return None
        if here.parent == here:
            return None
        here = here.parent
    return None


def clean_snippet(text: str, limit: int = 160) -> str:
    """One-line human-readable summary snippet from an assistant reply."""
    if not text:
        return ""
    body = SIGN_OFF.sub("", text)
    body = MEDIA_LINE.sub("", body)
    body = FROM_THREAD.sub("", body)
    body = URL.sub("", body)
    body = MARKUP.sub("", body)
    lines = [" ".join(line.split()) for line in body.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    joined = " ".join(lines)
    if len(joined) <= limit:
        return joined
    cut = joined[: limit - 1].rsplit(" ", 1)[0]
    return (cut or joined[: limit - 1]) + "…"


def classify_thread(
    *,
    archived: bool,
    busy: bool,
    queued: bool,
    paused: bool,
    activity_at: float | None,
    now: float,
    last_role: str | None,
    last_at: float | None,
    last_text: str,
    open_tool: tuple[str, float] | None,
    hub_status: str | None = None,
    has_request: bool = False,
    explicit_state: str | None = None,
) -> tuple[str, str]:
    """Infer semantic group status (`needs_you`, `working`, `waiting`, `idle`, `done`) and a short reason."""
    if has_request:
        return STATUS_NEEDS_YOU, "Needs approval"
    if paused:
        return STATUS_NEEDS_YOU, "Paused after restart"
    if busy or hub_status == WORKING:
        if open_tool and CI_WAIT.search(open_tool[0] or ""):
            return STATUS_WAITING, "Waiting on CI"
        if open_tool and now - open_tool[1] > TOOL_STALL_AFTER:
            return STATUS_NEEDS_YOU, "Tool stalled"
        if activity_at and now - activity_at > SILENT_AFTER and hub_status != WORKING:
            return STATUS_NEEDS_YOU, "No progress"
        return STATUS_WORKING, ""
    if queued:
        return STATUS_WORKING, "Queued"
    if explicit_state in VALID_TASK_STATES:
        return explicit_state, ""
    if archived:
        return STATUS_DONE, "Archived"
    if last_role == "user" and last_at and DROPPED_AFTER < now - last_at < DROPPED_UNTIL:
        return STATUS_NEEDS_YOU, "No reply"
    if last_role == "assistant":
        reply = SIGN_OFF.sub("", last_text or "").strip()
        if CI_PROSE.search(reply[-600:]):
            return STATUS_WAITING, "Waiting on CI"
        if reply.rstrip("`*_ )\n").endswith("?"):
            return STATUS_NEEDS_YOU, "Asked you"
    if hub_status == NEEDS_YOU:
        return STATUS_NEEDS_YOU, "Needs input"
    return STATUS_IDLE, ""


def is_background_thread(*, archived: bool, title: str, parent: dict | None, chat_id: str | None) -> bool:
    if archived:
        return True
    if chat_id in (REVIEWS, INBOX):
        return True
    return bool(parent is not None and REVIEW_TITLE.search(title or ""))


def _tail_info(tail):
    results = {row[3] for row in tail if row[0] == "tool" and row[3]}
    open_tool = None
    for role, _content, tool_calls, _call_id, at in tail:
        if role == "assistant" and tool_calls:
            try:
                calls = json.loads(tool_calls)
            except ValueError:
                calls = []
            for call in calls if isinstance(calls, list) else []:
                if (call or {}).get("id") in results or (call or {}).get("call_id") in results:
                    continue
                function = call.get("function") or {}
                try:
                    args = json.loads(function.get("arguments") or "{}")
                except ValueError:
                    args = {}
                command = args.get("command") if isinstance(args, dict) else None
                open_tool = (command if isinstance(command, str) else function.get("name") or "", at or 0.0)
            break
        if role in ("user", "assistant"):
            break

    last_role, last_at, last_text = None, None, ""
    last_assistant = ""
    for role, content, tool_calls, _call_id, at in tail:
        if role == "assistant" and content and not last_assistant:
            last_assistant = content
        if last_role is not None:
            if last_assistant:
                break
            continue
        if role == "assistant" and not content and tool_calls:
            continue
        if role == "user" and CRON_DELIVERY.match(content or ""):
            last_role, last_at, last_text = "assistant", at, ""
            continue
        if role in ("user", "assistant"):
            last_role, last_at, last_text = role, at, content or ""
    return last_role, last_at, last_text, last_assistant, open_tool


class _Scan:
    __slots__ = ("last_id", "prs", "previews", "paths", "branches", "parent", "first_user")

    def __init__(self):
        self.last_id = 0
        self.prs: dict[str, dict] = {}
        self.previews: dict[str, dict] = {}
        self.paths: list[str] = []
        self.branches: list[str] = []
        self.parent: dict | None = None
        self.first_user: int | None = None


class GroupInspector:
    """Reads live group thread status, summaries, and artifacts strictly read-only from `state.db`."""

    def __init__(self, home: Path, *, preview_hosts=(), own_hosts=(), clock=time.time):
        self.state = Path(home) / "state.db"
        self.preview_hosts = tuple(h.lower().lstrip(".") for h in preview_hosts if h)
        self.own_hosts = tuple(h.lower() for h in own_hosts if h)
        self.clock = clock
        self._lock = threading.Lock()
        self._scans: dict[str, _Scan] = {}

    @property
    def available(self) -> bool:
        return self.state.exists()

    def _scan_messages(self, db: sqlite3.Connection, sid: str) -> _Scan:
        scan = self._scans.get(sid)
        if scan is None:
            scan = self._scans[sid] = _Scan()
        rows = db.execute(
            "SELECT id, role, content, tool_calls, timestamp FROM messages WHERE session_id = ? AND id > ? "
            "AND role IN ('user', 'assistant') AND active = 1 AND COALESCE(observed, 0) = 0 ORDER BY id LIMIT ?",
            (sid, scan.last_id, SCAN_LIMIT),
        ).fetchall()
        for row_id, role, content, tool_calls, at in rows:
            scan.last_id = row_id
            text = content or ""
            if role == "user" and scan.first_user is None:
                scan.first_user = row_id
                match = FROM_THREAD.match(text)
                if match:
                    scan.parent = {"id": match.group(2), "title": match.group(1)}
            for pr in pull_requests(text):
                scan.prs[pr["key"]] = {**pr, "at": at or 0.0}
            for link in preview_links(text, self.preview_hosts, self.own_hosts):
                scan.previews.pop(link["label"], None)
                scan.previews[link["label"]] = link
            if role == "assistant" and tool_calls:
                paths, branches = tool_places(tool_calls)
                for path in paths:
                    if path in scan.paths:
                        scan.paths.remove(path)
                    scan.paths.append(path)
                del scan.paths[:-8]
                scan.branches.extend(branches)
                del scan.branches[:-8]
            if len(scan.previews) > 8:
                for label in list(scan.previews)[:-8]:
                    scan.previews.pop(label)
        return scan

    def _branch(self, scan: _Scan, git_branch: str | None, cwd: str | None) -> str | None:
        candidates = [cwd, *scan.paths] if cwd else list(scan.paths)
        for path in reversed(candidates):
            branch = checkout_branch(path)
            if branch:
                return branch
        return git_branch or (scan.branches[-1] if scan.branches else None)

    def inspect_chats(
        self,
        chats: set[str],
        *,
        hub_status: dict[str, str] | None = None,
        request_sessions: set[str] | None = None,
        thread_meta: dict[str, dict] | None = None,
    ) -> dict[str, dict]:
        """Inspect all sessions whose `chat_id` is in `chats`. Returns `{session_id: thread_info}`."""
        if not chats or not self.available:
            return {}
        now = self.clock()
        hub_status = hub_status or {}
        request_sessions = request_sessions or set()
        thread_meta = thread_meta or {}

        with self._lock, connect_ro(self.state) as db:
            placeholders = ",".join("?" for _ in chats)
            sessions = db.execute(
                "SELECT id, chat_id, title, archived, auto_archived, pinned, message_count, "
                "COALESCE(last_activity_at, started_at), last_activity_description, started_at, git_branch, cwd "
                f"FROM sessions WHERE chat_id IN ({placeholders}) AND source = 'portal' "
                "AND COALESCE(hidden, 0) = 0 ORDER BY COALESCE(last_activity_at, started_at) DESC",
                tuple(chats),
            ).fetchall()
            try:
                leases = dict(db.execute("SELECT conversation_id, acquired_at FROM session_turn_leases WHERE expires_at > ?", (now,)))
            except sqlite3.OperationalError:
                leases = {}
            admissions: dict[str, set[str]] = {}
            try:
                for target, st in db.execute(
                    "SELECT target_session_id, status FROM session_admissions WHERE status IN ('queued', 'started', 'unknown')"
                ):
                    admissions.setdefault(target, set()).add(st)
            except sqlite3.OperationalError:
                pass

            out: dict[str, dict] = {}
            for row in sessions:
                (
                    sid,
                    chat_id,
                    title,
                    archived_raw,
                    auto_archived,
                    pinned_raw,
                    count,
                    active,
                    activity_desc,
                    started,
                    git_branch,
                    cwd,
                ) = row
                archived = bool(archived_raw or auto_archived)
                pinned = bool(pinned_raw)
                scan = self._scan_messages(db, sid)
                tail = db.execute(
                    "SELECT role, substr(content, 1, 4000), tool_calls, tool_call_id, timestamp FROM messages "
                    "WHERE session_id = ? AND active = 1 AND COALESCE(observed, 0) = 0 ORDER BY id DESC LIMIT 12",
                    (sid,),
                ).fetchall()
                status_set = admissions.get(sid, set())
                busy = sid in leases or "started" in status_set
                last_role, last_at, last_text, last_assistant, open_tool = _tail_info(tail)
                meta = thread_meta.get(chat_id) or {}
                explicit_state = meta.get("task_state")
                status, reason = classify_thread(
                    archived=archived,
                    busy=busy,
                    queued="queued" in status_set,
                    paused="unknown" in status_set,
                    activity_at=active,
                    now=now,
                    last_role=last_role,
                    last_at=last_at,
                    last_text=last_text,
                    open_tool=open_tool,
                    hub_status=hub_status.get(sid),
                    has_request=sid in request_sessions,
                    explicit_state=explicit_state,
                )
                summary = meta.get("summary") or clean_snippet(last_assistant)
                activity = (activity_desc or "").strip() if (busy or status == STATUS_WORKING) else ""
                prs = [
                    {"key": p["key"], "url": p["url"]}
                    for p in sorted(scan.prs.values(), key=lambda p: -p["at"])[:4]
                ]
                previews = list(scan.previews.values())[-3:][::-1]
                branch = self._branch(scan, git_branch, cwd)
                extra_links = list(meta.get("links") or [])
                out[sid] = {
                    "id": sid,
                    "chat": chat_id,
                    "title": title or "untitled",
                    "status": status,
                    "task_state": explicit_state,
                    "reason": reason,
                    "activity": activity,
                    "summary": summary,
                    "last_active": active or started or 0.0,
                    "started_at": started or 0.0,
                    "message_count": count or 0,
                    "pinned": pinned,
                    "archived": archived,
                    "background": is_background_thread(
                        archived=archived,
                        title=title or "",
                        parent=scan.parent,
                        chat_id=chat_id,
                    ),
                    "prs": prs,
                    "previews": previews,
                    "branch": branch,
                    "links": extra_links,
                    "parent": scan.parent,
                }
            return out


def sort_threads(threads: list[dict]) -> list[dict]:
    """Order threads: needs_you -> working -> waiting -> idle -> done, then most recently active."""
    return sorted(
        threads,
        key=lambda t: (STATUS_ORDER.get(t["status"], 9), -(t.get("last_active") or 0.0), t["id"]),
    )


def summarize_counts(threads: list[dict]) -> dict[str, int]:
    counts = {
        "total": len(threads),
        "active": 0,
        "background": 0,
        STATUS_NEEDS_YOU: 0,
        STATUS_WORKING: 0,
        STATUS_WAITING: 0,
        STATUS_IDLE: 0,
        STATUS_DONE: 0,
    }
    for t in threads:
        if t.get("background"):
            counts["background"] += 1
        else:
            counts["active"] += 1
        st = t.get("status")
        if st in counts:
            counts[st] += 1
    return counts
