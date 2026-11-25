"""Offline SQLite transcript projection, lineage, tool-result merging, and multi-profile reads."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest
from portal.offline import RESULT_CHARS, Offline, raw_thread, with_results


def _create_db(home: Path, *, legacy: bool = False) -> sqlite3.Connection:
    home.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(home / "state.db")
    db.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, chat_id TEXT, parent_session_id TEXT, ended_at REAL, archived INTEGER)"
    )
    if legacy:
        db.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL)"
        )
    else:
        db.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, display_kind TEXT, active INTEGER DEFAULT 1)"
        )
    return db


def test_raw_thread_follows_compaction_lineage_and_filters_hidden_or_inactive(tmp_path):
    db = _create_db(tmp_path)
    db.execute("INSERT INTO sessions VALUES ('s1', 'portal', 'Old title', 'chat-1', NULL, NULL, 0)")
    db.execute("INSERT INTO sessions VALUES ('s2', 'portal', 'Current title', 'chat-1', 's1', NULL, 0)")
    db.executemany(
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, display_kind, active) VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("s1", "user", "first question", None, None, None, 100.0, None, 1),
            ("s1", "assistant", "hidden note", None, None, None, 101.0, "hidden", 1),
            ("s1", "assistant", "retracted", None, None, None, 102.0, None, 0),
            ("s1", "assistant", "first answer", None, None, None, 103.0, None, 1),
            ("s2", "user", "   ", None, None, None, 104.0, None, 1),
            ("s2", "user", "follow up", None, None, None, 105.0, None, 1),
            ("s2", "assistant", "final answer", None, None, None, 106.0, None, 1),
        ],
    )
    db.commit()
    db.close()

    thread = raw_thread(tmp_path, "s2")
    assert thread["title"] == "Current title"
    assert [(m["role"], m["text"]) for m in thread["messages"]] == [
        ("user", "first question"),
        ("assistant", "first answer"),
        ("user", "follow up"),
        ("assistant", "final answer"),
    ]


@pytest.mark.parametrize("visible", [(0, 0), (0, 1), (1, 0), (1, 1)])
def test_compacted_notifications_keep_their_original_senders(tmp_path, visible):
    from portal.hub import _as_notification

    db = _create_db(tmp_path)
    db.execute("ALTER TABLE messages ADD COLUMN message_uid TEXT")
    db.execute("ALTER TABLE messages ADD COLUMN absorbed_message_uids TEXT")
    db.execute("ALTER TABLE messages ADD COLUMN display_metadata TEXT")
    db.execute("INSERT INTO sessions VALUES ('s', 'portal', 'Notifications', 'inbox', NULL, NULL, 0)")
    alert = '[Cron delivery: build]\nfailed\n\nsee the report'
    ask = 'which build?\n\ncan you check?'
    db.executemany(
        "INSERT INTO messages (session_id, role, content, timestamp, active, message_uid, absorbed_message_uids) "
        "VALUES ('s', 'user', ?, ?, ?, ?, ?)",
        [(alert, 1, visible[0], 'notice', None), (ask, 2, visible[1], 'ask', None),
         (alert + '\n\n' + ask, 3, 1, 'notice', '["ask"]'),
         ('only surviving text', 4, 1, 'other', '["missing"]')],
    )
    db.commit()
    db.close()

    messages = [_as_notification(m) for m in raw_thread(tmp_path, 's')['messages']]
    assert [(m['role'], m['text'], m['timestamp']) for m in messages] == [
        ('assistant', 'failed\n\nsee the report', 1), ('user', ask, 2), ('user', 'only surviving text', 4),
    ]


def test_raw_thread_handles_cyclic_lineage_and_legacy_schema(tmp_path):
    db = _create_db(tmp_path, legacy=True)
    db.execute("INSERT INTO sessions VALUES ('a', 'portal', 'Loop', 'c', 'b', NULL, 0)")
    db.execute("INSERT INTO sessions VALUES ('b', 'portal', 'Loop', 'c', 'a', NULL, 0)")
    db.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('a', 'user', 'hello', 10.0)"
    )
    db.commit()
    db.close()

    thread = raw_thread(tmp_path, "a")
    assert [m["text"] for m in thread["messages"]] == ["hello"]


def test_raw_thread_extracts_tool_contexts_tolerates_bad_args_and_attaches_results(tmp_path):
    db = _create_db(tmp_path)
    db.execute("INSERT INTO sessions VALUES ('s1', 'portal', 'Tools', 'chat-1', NULL, NULL, 0)")
    calls = json.dumps([
        {"id": "c1", "function": {"name": "terminal", "arguments": json.dumps({"command": "pytest -q\nsecond line"})}},
        {"id": "c2", "function": {"name": "custom", "arguments": json.dumps({"note": "fallback value"})}},
        {"id": "c3", "function": {"name": "broken", "arguments": "{not-json"}},
    ])
    db.executemany(
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, display_kind, active) VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("s1", "assistant", "", None, calls, None, 100.0, None, 1),
            ("s1", "tool", "ok " + "x" * (RESULT_CHARS + 50), "c1", None, "terminal", 101.0, None, 1),
            ("s1", "tool", "done", "c2", None, "custom", 102.0, None, 1),
            ("s1", "tool", "err", "c3", None, "broken", 103.0, None, 1),
        ],
    )
    db.commit()
    db.close()

    msgs = raw_thread(tmp_path, "s1")["messages"]
    assert [(m["name"], m["context"]) for m in msgs] == [
        ("terminal", "pytest -q"),
        ("custom", "fallback value"),
        ("broken", ""),
    ]
    assert len(msgs[0]["result"]) == RESULT_CHARS
    assert msgs[1]["result"] == "done"
    assert msgs[2]["result"] == "err"


def test_with_results_serializes_non_strings_and_preserves_existing_results():
    projected = [
        {"role": "tool", "tool_call_id": "c1", "name": "t1"},
        {"role": "tool", "tool_call_id": "c2", "name": "t2", "result": "already there"},
    ]
    history = [
        {"role": "tool", "tool_call_id": "c1", "content": {"count": 3}},
        {"role": "tool", "tool_call_id": "c2", "content": "ignored"},
    ]
    out = with_results(projected, history)
    assert json.loads(out[0]["result"]) == {"count": 3}
    assert out[1]["result"] == "already there"


def test_offline_reads_across_profiles_and_falls_back_on_projection_failure(tmp_path):
    root_db = _create_db(tmp_path)
    root_db.execute("INSERT INTO sessions VALUES ('root-chat', 'portal', 'Root', 'c-root', NULL, NULL, 0)")
    root_db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('root-chat', 'user', 'shared needle', 100.0)")
    root_db.commit()
    root_db.close()

    work = tmp_path / "profiles" / "work"
    work_db = _create_db(work)
    work_db.execute("INSERT INTO sessions VALUES ('work-chat', 'portal', 'Work', 'c-work', NULL, NULL, 0)")
    work_db.execute("INSERT INTO sessions VALUES ('slack-chat', 'slack', 'Slack', 'c-slack', NULL, NULL, 0)")
    work_db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('work-chat', 'user', 'shared needle newer', 200.0)")
    work_db.commit()
    work_db.close()

    # Projection child fails when Hermes isn't importable -> cleanly falls back to raw_thread.
    offline = Offline(tmp_path, python=sys.executable, projection=True)

    assert offline.chat_of("work-chat") == "c-work"
    assert offline.chat_of("slack-chat") is None
    assert offline.title_of("work-chat") == "Work"
    assert offline.title_of("slack-chat") == "Slack"
    assert offline.title_of("missing") is None
    assert offline.thread("slack-chat") is None

    # Projection child fails (no Hermes installed) -> cleanly falls back to raw_thread.
    thread = offline.thread("work-chat")
    assert thread["title"] == "Work"
    assert [m["text"] for m in thread["messages"]] == ["shared needle newer"]

    hits = offline.search_sessions("shared needle")
    assert [h["id"] for h in hits] == ["work-chat", "root-chat"]
