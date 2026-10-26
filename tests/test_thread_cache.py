"""The adapter's transcript reads, against stand-ins shaped like Hermes's session store."""

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


class Store:
    """Rows of one portal chat, with Hermes's revision: it moves on appends and in-place rewrites."""

    def __init__(self):
        self.rows = []
        self.rewrites = 0

    def add(self, role, content):
        self.rows.append({"id": len(self.rows) + 1, "role": role, "content": content})

    def rewrite(self, index, content):
        self.rows[index]["content"] = content
        self.rewrites += 1

    def conversation_revision(self, session, include_ancestors=False):
        return ((session,), len(self.rows), self.rows[-1]["id"] if self.rows else 0, self.rewrites)

    def get_messages_as_conversation(self, session, include_ancestors=False, include_row_ids=False):
        return [dict(row) for row in self.rows]

    def get_session_title(self, session):
        return "a chat"


@pytest.fixture
def backend(tmp_path, monkeypatch):
    def module(name, **attrs):
        mod = type(sys)(name)
        mod.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, mod)

    module("hermes_constants", set_hermes_home_override=lambda path: None, reset_hermes_home_override=lambda token: None)
    module("tui_gateway")
    module("tui_gateway.server", _history_to_messages=lambda history, profile_home=None: [{"role": m["role"], "text": m["content"]} for m in history])
    with sqlite3.connect(tmp_path / "state.db") as db:
        db.execute("CREATE TABLE sessions (id TEXT, source TEXT)")
        db.execute("INSERT INTO sessions VALUES ('chat-1', 'portal')")
    spec = importlib.util.spec_from_file_location("nako_portal_thread_test", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    store = Store()
    adapter = type("Adapter", (), {"_session_store": type("SessionStore", (), {"_db": store})()})()
    return plugin.HermesBackend(adapter, tmp_path), store


def texts(backend):
    return [m["text"] for m in backend.thread("chat-1")["messages"]]


def test_a_transcript_reads_fresh_after_every_kind_of_change(backend):
    backend, store = backend
    store.add("user", "fix the build")
    store.add("assistant", "on it")
    assert texts(backend) == ["fix the build", "on it"]
    assert texts(backend) == ["fix the build", "on it"]

    store.add("assistant", "done")
    assert texts(backend) == ["fix the build", "on it", "done"]
    # An in-place rewrite keeps the count and the last id; Hermes's revision still moves.
    store.rewrite(0, "fix the build, please")
    assert texts(backend) == ["fix the build, please", "on it", "done"]
    # An undo drops rows.
    store.rows.pop()
    assert texts(backend) == ["fix the build, please", "on it"]


def test_a_chat_that_isnt_a_portal_thread_reads_as_missing(backend):
    backend, _ = backend
    assert backend.thread("someone-elses") is None
