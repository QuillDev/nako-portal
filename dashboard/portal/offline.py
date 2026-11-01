"""A chat's transcript read straight from Hermes's session store, for when no gateway is connected.

The gateway is what normally reads transcripts (`HermesBackend.thread`). When it's down (it
crashed, an update stopped it, it was never started), the portal server still has to show what a
chat did: the person reading it in the app, or another machine's agent following a task it handed
over. So the server reads `state.db` itself.

Hermes's own display projection is used when Hermes can be imported, in a short-lived child
process (the server never imports Hermes, and a half-updated Hermes can't break it). If that
fails, the rows are projected here from the table alone: prompts, replies and tool calls with
their results, in the same shape.

Run as `python offline.py <hermes home> <session>`: prints the transcript as JSON.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

# A tool result kept with its call, for readers that ask for results (an agent following a task).
RESULT_CHARS = 2000
CONTEXT_CHARS = 80
READ_TIMEOUT = 60


def with_results(messages, history):
    """Tool rows of a projected transcript, each with the start of its result from the raw history."""
    results = {}
    for row in history or []:
        if isinstance(row, dict) and row.get("role") == "tool" and row.get("tool_call_id"):
            content = row.get("content")
            if not isinstance(content, str):
                content = json.dumps(content, default=str)
            results[row["tool_call_id"]] = content[:RESULT_CHARS]
    out = []
    for message in messages:
        if message.get("role") == "tool" and message.get("tool_call_id") in results and "result" not in message:
            message = {**message, "result": results[message["tool_call_id"]]}
        out.append(message)
    return out


def _homes(home):
    """The home and its profiles' homes: a chat may live in any profile the gateway served."""
    home = Path(home)
    profiles = home / "profiles"
    found = [home]
    if profiles.is_dir():
        found += sorted(p for p in profiles.iterdir() if (p / "state.db").is_file())
    return found


def _query(home, sql, args=()):
    state = Path(home) / "state.db"
    if not state.is_file():
        return []
    with closing(sqlite3.connect(f"file:{state}?mode=ro", uri=True, timeout=10)) as db:
        return db.execute(sql, args).fetchall()


def _context(args):
    """A one-line preview of a call's arguments, like the one the app shows beside the tool's name."""
    if not isinstance(args, dict):
        return ""
    for key in ("command", "path", "query", "url", "code", "name", "action", "text"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().splitlines()[0][:CONTEXT_CHARS]
    for value in args.values():
        if isinstance(value, str) and value.strip():
            return value.strip().splitlines()[0][:CONTEXT_CHARS]
    return ""


def _lineage(home, session):
    """The session and the ones it continues (compaction starts a child), oldest first."""
    chain, seen = [], set()
    current = session
    while current and current not in seen:
        seen.add(current)
        chain.append(current)
        rows = _query(home, "SELECT parent_session_id FROM sessions WHERE id=?", (current,))
        current = rows[0][0] if rows else None
    return list(reversed(chain))


def raw_thread(home, session):
    """The transcript from the table alone, when Hermes can't be imported."""
    columns = {row[1] for row in _query(home, "PRAGMA table_info(messages)")}
    active = " AND COALESCE(active, 1)=1" if "active" in columns else ""
    kind = ", display_kind" if "display_kind" in columns else ", NULL"
    history, messages, calls = [], [], {}
    for sid in _lineage(home, session):
        rows = _query(
            home,
            f"SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp{kind} FROM messages WHERE session_id=?{active} ORDER BY id",
            (sid,),
        )
        for row_id, role, content, call_id, tool_calls, tool_name, timestamp, display_kind in rows:
            history.append({"role": role, "content": content, "tool_call_id": call_id})
            if display_kind == "hidden":
                continue
            if role == "assistant" and tool_calls:
                try:
                    for call in json.loads(tool_calls) or []:
                        function = call.get("function") or {}
                        try:
                            args = json.loads(function.get("arguments") or "{}")
                        except (TypeError, ValueError):
                            args = {}
                        calls[call.get("id")] = (function.get("name"), args)
                except (TypeError, ValueError, AttributeError):
                    pass
            if role == "tool":
                name, args = calls.get(call_id, (None, {}))
                tool = {"role": "tool", "name": name or tool_name or "tool", "context": _context(args), "timestamp": timestamp}
                if call_id:
                    tool["tool_call_id"] = call_id
                if args:
                    tool["args"] = args
                messages.append(tool)
                continue
            if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
                continue
            messages.append({"role": role, "text": content, "row_id": row_id, "timestamp": timestamp})
    title = _query(home, "SELECT title FROM sessions WHERE id=?", (session,))
    return {"title": (title[0][0] or "") if title else "", "messages": with_results(messages, history)}


def hermes_thread(home, session):
    """The transcript in Hermes's own display projection, as the gateway would read it."""
    os.environ["HERMES_HOME"] = str(home)
    from hermes_state import SessionDB
    from tui_gateway.server import _history_to_messages

    db = SessionDB(Path(home) / "state.db", read_only=True)
    try:
        history = db.get_messages_as_conversation(session, include_ancestors=True, include_row_ids=True, include_compacted=True)
    except TypeError:  # a Hermes from before display reads
        history = db.get_messages_as_conversation(session, include_ancestors=True, include_row_ids=True)
    messages = _history_to_messages(history, profile_home=Path(home))
    return {"title": db.get_session_title(session) or "", "messages": with_results(messages, history)}


class Offline:
    """The hub backend's read calls, answered from the session store while no gateway is there."""

    def __init__(self, home, *, python=None, projection=True):
        self.home = Path(home)
        self.python = python or sys.executable
        # Off in tests that have no Hermes to import: the table projection alone.
        self.projection = projection

    def _home_of(self, session):
        for home in _homes(self.home):
            if _query(home, "SELECT 1 FROM sessions WHERE id=? AND source='portal'", (session,)):
                return home
        return None

    def chat_of(self, session):
        home = self._home_of(session)
        rows = _query(home, "SELECT chat_id FROM sessions WHERE id=?", (session,)) if home else []
        return rows[0][0] if rows and rows[0][0] else None

    def title_of(self, session):
        for home in _homes(self.home):
            rows = _query(home, "SELECT title FROM sessions WHERE id=?", (session,))
            if rows:
                return rows[0][0] or ""
        return None

    def thread(self, session):
        home = self._home_of(session)
        if home is None:
            return None
        if self.projection:
            try:
                done = subprocess.run(
                    [self.python, str(Path(__file__).resolve()), str(home), str(session)],
                    capture_output=True,
                    text=True,
                    timeout=READ_TIMEOUT,
                    stdin=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if done.returncode == 0:
                    return json.loads(done.stdout)
            except (OSError, subprocess.SubprocessError, ValueError):
                pass
        return raw_thread(home, session)


def main(argv):
    home, session = argv[1], argv[2]
    # This folder's modules (server, hub, link...) mustn't shadow Hermes's own on import.
    here = Path(__file__).resolve().parent
    sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != here]
    try:
        thread = hermes_thread(home, session)
    except Exception:
        return 1
    sys.stdout.write(json.dumps(thread, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
