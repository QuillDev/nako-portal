"""Message search through the authenticated HTTP/link path and the offline reader."""
import importlib.util
import sqlite3
from types import SimpleNamespace

import pytest
from conftest import ROOT
from portal.offline import Offline
from portal.search import search_sessions


@pytest.fixture
def search_home(tmp_path):
    home = tmp_path / "search"
    home.mkdir()
    with sqlite3.connect(home / "state.db") as db:
        db.executescript("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT, ended_at REAL, archived INTEGER);
            CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
                                   timestamp REAL, display_kind TEXT, active INTEGER);
            INSERT INTO sessions VALUES
                ('normal', 'First conversation', 'portal', NULL, 0),
                ('archived', 'Older conversation', 'portal', NULL, 1),
                ('ended', 'Ended', 'portal', 1, 0),
                ('outside', 'Other source', 'slack', NULL, 0),
                ('hidden', 'Hidden message', 'portal', NULL, 0),
                ('inactive', 'Inactive message', 'portal', NULL, 0),
                ('tool', 'Tool message', 'portal', NULL, 0);
            INSERT INTO messages VALUES
                (1, 'normal', 'user', 'Remember the apricot plan', 1, NULL, 1),
                (2, 'normal', 'assistant', 'An apricot reply', 2, NULL, NULL),
                (3, 'archived', 'assistant', 'Archived APRICOT notes', 3, NULL, 1),
                (4, 'ended', 'assistant', 'apricot', 99, NULL, 1),
                (5, 'outside', 'user', 'apricot', 99, NULL, 1),
                (6, 'hidden', 'assistant', 'apricot', 99, 'hidden', 1),
                (7, 'inactive', 'assistant', 'apricot', 99, NULL, 0),
                (8, 'tool', 'tool', 'apricot', 99, NULL, 1),
                (9, 'normal', 'assistant', 'Secret notes\n SECRET:APRICOT_PASSWORD\nVisible apricot\nMEDIA:/private.png', 4, NULL, 1);
        """)
    return home


async def search(world, query):
    response = await world.http.get(world.url("/api/search"), params={"q": query})
    assert response.status == 200, await response.text()
    return await response.json()


async def test_search_normal_archived_visibility_and_secret_redaction(world, search_home):
    world.hermes.search_home = search_home
    await world.sign_up()
    rows = await search(world, "Apricot")
    assert [row["id"] for row in rows] == ["normal", "archived"]
    assert rows[0] == {"id": "normal", "title": "First conversation", "archived": False,
                       "at": 4, "snippet": "Secret notes Visible apricot"}
    assert rows[1]["archived"] is True
    assert await search(world, "APRICOT_PASSWORD") == []
    assert await search(world, "/private.png") == []


async def test_search_auth_required_and_short_query(world, search_home):
    world.hermes.search_home = search_home
    response = await world.http.get(world.url("/api/search?q=apricot"))
    assert response.status == 401
    await world.sign_up()
    assert await search(world, " a ") == []
    assert await search(world, "") == []


async def test_search_offline_fallback(world, search_home):
    world.link.offline = Offline(search_home, projection=False)
    await world.sign_up()
    await world.gateway.stop(world.hub)
    rows = await search(world, "apricot")
    assert [row["id"] for row in rows] == ["normal", "archived"]


@pytest.mark.parametrize("index", ["none", "fts", "incompatible"])
def test_literal_search_and_fts_fallback(search_home, index):
    with sqlite3.connect(search_home / "state.db") as db:
        if index == "fts":
            db.execute("CREATE VIRTUAL TABLE messages_fts USING fts5(content)")
            db.execute("INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages")
        elif index == "incompatible":
            db.execute("CREATE TABLE messages_fts (content TEXT)")
        db.execute("INSERT INTO messages VALUES (10, 'normal', 'assistant', ?, 5, NULL, 1)",
                   ('Literal 50% under_score back\\slash and " OR *',))
    assert len(search_sessions(search_home, "apricot")) == 2
    for query in ("50%", "under_score", "back\\slash", '" OR *'):
        rows = search_sessions(search_home, query)
        assert len(rows) == 1
        assert rows[0]["at"] == 5
    assert search_sessions(search_home, "50_") == []
    assert search_sessions(search_home, "under%score") == []


def test_limit_latest_match_and_old_schema(tmp_path):
    with sqlite3.connect(tmp_path / "state.db") as db:
        db.executescript("CREATE TABLE sessions (id TEXT, title TEXT, source TEXT, ended_at REAL);"
                         "CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);")
        for i in range(30):
            db.execute("INSERT INTO sessions VALUES (?, 'Title', 'portal', NULL)", (str(i),))
            db.execute("INSERT INTO messages VALUES (?, ?, 'assistant', 'needle', ?)", (i, str(i), i))
    rows = search_sessions(tmp_path, "needle")
    assert len(rows) == 20
    assert [row["at"] for row in rows] == list(reversed(range(10, 30)))
    assert all(row["archived"] is False for row in rows)


def test_hermes_backend_uses_selected_profile(search_home):
    spec = importlib.util.spec_from_file_location("search_test_plugin", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    backend = SimpleNamespace(_home=lambda: search_home)
    assert len(plugin.HermesBackend.search_sessions(backend, "apricot")) == 2


def test_offline_searches_profile_homes_and_missing_database(search_home):
    assert search_sessions(search_home / "missing", "apricot") == []
    profile = search_home / "profiles" / "work"
    profile.mkdir(parents=True)
    with sqlite3.connect(profile / "state.db") as db:
        db.executescript("CREATE TABLE sessions (id TEXT, title TEXT, source TEXT, ended_at REAL);"
                         "CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);"
                         "INSERT INTO sessions VALUES ('work', 'Work', 'portal', NULL);"
                         "INSERT INTO messages VALUES (1, 'work', 'user', 'apricot', 10);")
    assert [row["id"] for row in Offline(search_home).search_sessions("apricot")] == ["work", "normal", "archived"]
