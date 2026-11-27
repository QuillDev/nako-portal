"""Dynamic backend home routing: GroupInspector, PRService, and Offline follow the active backend's state.db."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest
from portal.group_overview import GroupInspector
from portal.link import GatewayLink
from portal.offline import Offline
from portal.prs import PRService
from portal.store import Store


def _make_state_db(home: Path, *, sid: str, chat_id: str, title: str, text: str) -> None:
    """Create a SQLite state.db with the exact Bun/Python shared schema."""
    home.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(home / "state.db")
    try:
        con.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                chat_id TEXT,
                parent_session_id TEXT,
                started_at REAL NOT NULL,
                ended_at REAL,
                message_count INTEGER NOT NULL DEFAULT 0,
                cwd TEXT,
                title TEXT,
                last_activity_at REAL,
                last_activity_description TEXT,
                git_branch TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                auto_archived INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                hidden INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                tool_call_id TEXT,
                tool_calls TEXT,
                tool_name TEXT,
                timestamp REAL NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                observed INTEGER NOT NULL DEFAULT 0
            );
            CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
            CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, COALESCE(new.content, ''));
            END;
            """
        )
        now = time.time()
        con.execute(
            "INSERT INTO sessions (id, source, chat_id, started_at, message_count, title, last_activity_at) VALUES (?, 'portal', ?, ?, 1, ?, ?)",
            (sid, chat_id, now, title, now),
        )
        con.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
            (sid, text, now),
        )
        con.commit()
    finally:
        con.close()


@pytest.mark.asyncio
async def test_backend_home_switches_group_inspector_prs_and_offline(tmp_path):
    py_home = tmp_path / "py-home"
    bun_home = tmp_path / "bun-home"
    _make_state_db(
        py_home,
        sid="20261127_100000_py01",
        chat_id="chat-py",
        title="Python PR thread",
        text="opened https://github.com/QuillDev/demo/pull/10",
    )
    _make_state_db(
        bun_home,
        sid="20261127_100001_bun1",
        chat_id="chat-bun",
        title="Bun PR thread",
        text="opened https://github.com/QuillDev/demo/pull/10",
    )

    store = Store(tmp_path / "portal.db")
    link = GatewayLink("code", store=store, default_home=py_home)
    link.homes["bun"] = bun_home
    def active_home():
        return link.active_home or py_home

    inspector = GroupInspector(active_home)
    offline = Offline(active_home, projection=False)
    fake_raw = {
        "viewer": "QuillDev",
        "taken_at": time.time(),
        "prs": [
            {
                "key": "QuillDev/demo#10",
                "repo": "QuillDev/demo",
                "number": 10,
                "title": "Demo PR",
                "url": "https://github.com/QuillDev/demo/pull/10",
                "state": "open",
                "draft": False,
                "author": "QuillDev",
                "head": "feat/demo",
                "base": "main",
                "updated_at": "2026-11-27T20:00:00Z",
                "review_decision": "",
                "reviews": [],
                "checks": [],
            }
        ],
        "merged": [],
        "errors": [],
    }
    prs = PRService(store, home=active_home, viewer="QuillDev", collector=lambda _v: fake_raw)

    # While active backend is python, all three readers see py_home.
    assert link.active_home == py_home
    py_inspected = inspector.inspect_chats({"chat-py", "chat-bun"})
    assert set(py_inspected.keys()) == {"20261127_100000_py01"}
    assert offline.title_of("20261127_100000_py01") == "Python PR thread"
    assert offline.title_of("20261127_100001_bun1") is None
    py_view = await prs.snapshot(refresh=True)
    assert py_view["prs"][0]["owner"]["session"] == "20261127_100000_py01"
    assert py_view["prs"][0]["owner"]["title"] == "Python PR thread"

    # Flip active backend to bun -> all three readers immediately follow bun_home.
    link.active = "bun"
    assert link.active_home == bun_home
    bun_inspected = inspector.inspect_chats({"chat-py", "chat-bun"})
    assert set(bun_inspected.keys()) == {"20261127_100001_bun1"}
    assert offline.title_of("20261127_100001_bun1") == "Bun PR thread"
    assert offline.title_of("20261127_100000_py01") is None
    bun_view = await prs.snapshot(refresh=False)
    assert bun_view["prs"][0]["owner"]["session"] == "20261127_100001_bun1"
    assert bun_view["prs"][0]["owner"]["title"] == "Bun PR thread"
