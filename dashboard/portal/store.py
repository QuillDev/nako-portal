"""The portal's own data: passkeys, sign-in sessions, setup links, push subscriptions, inbox.

Conversations are NOT stored here: they live in the Hermes session database and
are read through the backend, so Desktop and the portal show one transcript.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path

LOGIN_TTL = 30 * 24 * 3600
LOGIN_RENEW_INTERVAL = 5 * 60
# The colors a chat group can have, in the order new groups take them.
GROUP_COLORS = ("blue", "green", "yellow", "orange", "red", "teal", "purple", "grey")
GROUP_NAME_MAX = 60
MODEL_PICKS_MAX = 100
MODEL_PRESET_NAME_MAX = 40
SETUP_TTL = 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS credentials (
    id BLOB PRIMARY KEY,
    cose_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL,
    label TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_used_at REAL
);
CREATE TABLE IF NOT EXISTS logins (
    token_hash TEXT PRIMARY KEY,
    credential_id BLOB NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS setup_links (
    token_hash TEXT PRIMARY KEY,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys_json TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_group_members (
    chat TEXT PRIMARY KEY,
    group_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _text(value, field, *, most=200, required=True):
    if not isinstance(value, str) or len(value) > most or (required and not value.strip()):
        raise ValueError(f"A model pick needs a {field}")
    return value


def _model_route(value, *, tuned):
    """A provider and model, plus the effort and speed when the pick is tuned."""
    if not isinstance(value, dict):
        raise ValueError("A model pick needs a provider and model")  # noqa: TRY004 - Store validation is surfaced by the request guard as HTTP 400.
    route = {"provider": _text(value.get("provider"), "provider"), "model": _text(value.get("model"), "model")}
    if tuned:
        route["effort"] = _text(value.get("effort", ""), "effort", most=40, required=False)
        route["speed"] = _text(value.get("speed", ""), "speed", most=40, required=False)
    return route


def _model_preset(value):
    if not isinstance(value, dict):
        raise ValueError("A preset needs a name and a model")  # noqa: TRY004 - Store validation is surfaced by the request guard as HTTP 400.
    name = _text(value.get("name"), "name", most=MODEL_PRESET_NAME_MAX).strip()
    return {
        "id": _text(value.get("id"), "id", most=64),
        "name": name,
        "icon": _text(value.get("icon", ""), "icon", most=32, required=False),
        "pick": _model_route(value.get("pick"), tuned=True),
    }


class Store:
    def __init__(self, path: Path, clock=time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        self.clock = clock
        self.lock = threading.Lock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        os.chmod(self.path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)

    def _run(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    # Passkeys

    def has_credentials(self) -> bool:
        return bool(self._run("SELECT 1 FROM credentials LIMIT 1"))

    def add_credential(self, credential_id: bytes, cose_key: bytes, sign_count: int, label: str) -> None:
        self._run(
            "INSERT INTO credentials (id, cose_key, sign_count, label, created_at) VALUES (?, ?, ?, ?, ?)",
            (credential_id, cose_key, sign_count, label, self.clock()),
        )

    def credential(self, credential_id: bytes):
        rows = self._run("SELECT id, cose_key, sign_count, label FROM credentials WHERE id=?", (credential_id,))
        if not rows:
            return None
        cid, key, count, label = rows[0]
        return {"id": cid, "cose_key": key, "sign_count": count, "label": label}

    def credentials(self):
        rows = self._run("SELECT id, label, created_at, last_used_at FROM credentials ORDER BY created_at")
        return [{"id": r[0], "label": r[1], "created_at": r[2], "last_used_at": r[3]} for r in rows]

    def used_credential(self, credential_id: bytes, sign_count: int) -> None:
        self._run(
            "UPDATE credentials SET sign_count=?, last_used_at=? WHERE id=?", (sign_count, self.clock(), credential_id)
        )

    def remove_credential(self, credential_id: bytes) -> None:
        self._run("DELETE FROM credentials WHERE id=?", (credential_id,))
        self._run("DELETE FROM logins WHERE credential_id=?", (credential_id,))

    # Sign-in sessions

    def start_login(self, credential_id: bytes) -> str:
        token = secrets.token_urlsafe(32)
        now = self.clock()
        self._run(
            "INSERT INTO logins (token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_hash(token), credential_id, now, now + LOGIN_TTL),
        )
        return token

    def login(self, token: str | None):
        """The signed-in passkey, renewing at most once per five minutes of use."""
        if not token:
            return None
        now = self.clock()
        rows = self._run(
            "SELECT l.credential_id, l.expires_at FROM logins l "
            "JOIN credentials c ON c.id=l.credential_id WHERE l.token_hash=?", (_hash(token),)
        )
        if not rows or rows[0][1] < now:
            return None
        credential_id = rows[0][0]
        if rows[0][1] <= now + LOGIN_TTL - LOGIN_RENEW_INTERVAL:
            self._run("UPDATE logins SET expires_at=? WHERE token_hash=?", (now + LOGIN_TTL, _hash(token)))
        return credential_id

    def end_login(self, token: str | None) -> None:
        if token:
            self._run("DELETE FROM logins WHERE token_hash=?", (_hash(token),))

    # Setup links: the only way to add the first passkey.

    def new_setup_link(self) -> str:
        token = secrets.token_urlsafe(32)
        self._run(
            "INSERT INTO setup_links (token_hash, expires_at) VALUES (?, ?)", (_hash(token), self.clock() + SETUP_TTL)
        )
        return token

    def setup_link_valid(self, token: str | None) -> bool:
        if not token:
            return False
        rows = self._run("SELECT expires_at FROM setup_links WHERE token_hash=?", (_hash(token),))
        return bool(rows) and rows[0][0] >= self.clock()

    def use_setup_link(self, token: str) -> bool:
        with self.lock:
            cursor = self.db.execute(
                "DELETE FROM setup_links WHERE token_hash=? AND expires_at>=?", (_hash(token), self.clock())
            )
            return cursor.rowcount == 1

    # Small settings

    def meta(self, key, default=None):
        rows = self._run("SELECT value FROM meta WHERE key=?", (key,))
        return json.loads(rows[0][0]) if rows else default

    def set_meta(self, key, value):
        self._run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, json.dumps(value)))

    # Model presets and favorites: the owner's picks in the model picker, kept here so every
    # device sees the same ones and a cleared browser loses none of them.

    def model_picks(self):
        return {"presets": self.meta("model_presets", []), "favorites": self.meta("model_favorites", [])}

    def put_model_preset(self, preset):
        """Add a preset, or replace the one with its id."""
        preset = _model_preset(preset)
        with self.lock:
            presets = self._meta_locked("model_presets")
            ids = [p["id"] for p in presets]
            if preset["id"] in ids:
                presets[ids.index(preset["id"])] = preset
            elif len(presets) >= MODEL_PICKS_MAX:
                raise ValueError(f"Keep it to {MODEL_PICKS_MAX} presets")
            else:
                presets.append(preset)
            self._set_meta_locked("model_presets", presets)
        return self.model_picks()

    def remove_model_preset(self, preset_id):
        with self.lock:
            presets = self._meta_locked("model_presets")
            self._set_meta_locked("model_presets", [p for p in presets if p["id"] != preset_id])
        return self.model_picks()

    def toggle_model_favorite(self, favorite):
        """Star a model (with or without tuning), or unstar it if it's already starred."""
        favorite = _model_route(favorite, tuned="effort" in (favorite or {}))
        with self.lock:
            favorites = self._meta_locked("model_favorites")
            kept = [f for f in favorites if f != favorite]
            if len(kept) == len(favorites):
                if len(kept) >= MODEL_PICKS_MAX:
                    raise ValueError(f"Keep it to {MODEL_PICKS_MAX} favorites")
                kept.append(favorite)
            self._set_meta_locked("model_favorites", kept)
        return self.model_picks()

    def _meta_locked(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else []

    def _set_meta_locked(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, json.dumps(value)))

    # Chat groups: named, colored sets of chats, kept by each chat's thread id (it outlives a
    # session rotating under it). A chat is in at most one group.

    def groups(self):
        rows = self._run("SELECT id, name, color FROM chat_groups ORDER BY created_at")
        return [{"id": r[0], "name": r[1], "color": r[2]} for r in rows]

    def group(self, ref):
        """A group by id, or by name ignoring case."""
        ref = str(ref or "").strip()
        rows = self._run(
            "SELECT id, name, color FROM chat_groups WHERE id=? OR name=? COLLATE NOCASE ORDER BY id=? DESC LIMIT 1", (ref, ref, ref)
        )
        if not rows:
            raise ValueError(f"No group called {ref!r}")
        return {"id": rows[0][0], "name": rows[0][1], "color": rows[0][2]}

    @staticmethod
    def _group_name(name):
        name = " ".join(str(name or "").split())[:GROUP_NAME_MAX]
        if not name:
            raise ValueError("Give the group a name")
        return name

    @staticmethod
    def _group_color(color):
        if color not in GROUP_COLORS:
            raise ValueError(f"Pick a color from {', '.join(GROUP_COLORS)}")
        return color

    def create_group(self, name, color=None):
        name = self._group_name(name)
        with self.lock:
            if self.db.execute("SELECT 1 FROM chat_groups WHERE name=? COLLATE NOCASE", (name,)).fetchone():
                raise ValueError(f"There's already a group called {name!r}")
            if color is None:
                used = [r[0] for r in self.db.execute("SELECT color FROM chat_groups")]
                color = min(GROUP_COLORS, key=lambda c: (used.count(c), GROUP_COLORS.index(c)))
            group = {"id": secrets.token_hex(6), "name": name, "color": self._group_color(color)}
            self.db.execute(
                "INSERT INTO chat_groups (id, name, color, created_at) VALUES (?, ?, ?, ?)",
                (group["id"], name, group["color"], self.clock()),
            )
        return group

    def update_group(self, ref, name=None, color=None):
        group = self.group(ref)
        if name is not None:
            name = self._group_name(name)
            clash = self._run("SELECT 1 FROM chat_groups WHERE name=? COLLATE NOCASE AND id<>?", (name, group["id"]))
            if clash:
                raise ValueError(f"There's already a group called {name!r}")
            group["name"] = name
        if color is not None:
            group["color"] = self._group_color(color)
        self._run("UPDATE chat_groups SET name=?, color=? WHERE id=?", (group["name"], group["color"], group["id"]))
        return group

    def delete_group(self, ref):
        """Remove a group. Its chats stay; they're just no longer grouped."""
        group = self.group(ref)
        with self.lock:
            self.db.execute("DELETE FROM chat_group_members WHERE group_id=?", (group["id"],))
            self.db.execute("DELETE FROM chat_groups WHERE id=?", (group["id"],))
        return group

    def set_chat_group(self, chat, ref):
        """Put a chat in a group (moving it out of any other), or take it out with ref None."""
        if ref is None:
            self._run("DELETE FROM chat_group_members WHERE chat=?", (chat,))
            return None
        group = self.group(ref)
        self._run("INSERT OR REPLACE INTO chat_group_members (chat, group_id) VALUES (?, ?)", (chat, group["id"]))
        return group

    def chat_groups(self):
        """chat -> its group."""
        groups = {g["id"]: g for g in self.groups()}
        rows = self._run("SELECT chat, group_id FROM chat_group_members")
        return {chat: groups[gid] for chat, gid in rows if gid in groups}

    # Push subscriptions

    def add_push(self, endpoint: str, keys: dict) -> None:
        self._run(
            "INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, ?)",
            (endpoint, json.dumps(keys), self.clock()),
        )

    def pushes(self):
        rows = self._run("SELECT endpoint, keys_json FROM push_subscriptions")
        return [{"endpoint": r[0], "keys": json.loads(r[1])} for r in rows]

    def remove_push(self, endpoint: str) -> None:
        self._run("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))

    # Inbox: messages the gateway delivers to the portal (cron results, send_message).

    def deliver(self, chat: str, text: str) -> int:
        with self.lock:
            cursor = self.db.execute(
                "INSERT INTO inbox (chat, text, created_at) VALUES (?, ?, ?)", (chat, text, self.clock())
            )
            return int(cursor.lastrowid or 0)

    def inbox(self, limit=200):
        rows = self._run("SELECT id, chat, text, created_at FROM inbox ORDER BY id DESC LIMIT ?", (limit,))
        return [{"id": r[0], "chat": r[1], "text": r[2], "created_at": r[3]} for r in rows]

    def inbox_after(self, cursor=0, limit=50):
        """The next replay batch, oldest first, without skipping an older backlog."""
        rows = self._run(
            "SELECT id, chat, text, created_at FROM inbox WHERE id>? ORDER BY id ASC LIMIT ?", (cursor, limit)
        )
        return [{"id": r[0], "chat": r[1], "text": r[2], "created_at": r[3]} for r in rows]
