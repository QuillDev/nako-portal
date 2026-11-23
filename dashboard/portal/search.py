"""Read-only message search shared by the gateway and offline reader."""

import re
import sqlite3
from contextlib import closing
from pathlib import Path


def copyable_text(text):
    return "\n".join(line for line in (text or "").splitlines()
                     if not re.match(r"^\s*(?:SECRET|MEDIA):", line, re.IGNORECASE)).strip()


def search_sessions(home, query):
    query = query.strip().casefold()
    state = Path(home) / "state.db"
    if len(query) < 2 or not state.is_file():
        return []
    with closing(sqlite3.connect(state.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(messages)")}
        session_columns = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
        if not columns or not session_columns:
            return []
        db.create_function("search_text", 1, lambda text: copyable_text(text).casefold(), deterministic=True)
        where = "s.source='portal' AND s.ended_at IS NULL AND m.role IN ('user', 'assistant')"
        if "display_kind" in columns:
            where += " AND COALESCE(m.display_kind, '')!='hidden'"
        if "active" in columns:
            where += " AND COALESCE(m.active, 1)=1"
        archived = "COALESCE(s.archived, 0)" if "archived" in session_columns else "0"
        at = "COALESCE(m.timestamp, 0)" if "timestamp" in columns else "m.id"
        select = f"SELECT s.id, s.title, m.content, {archived}, {at} FROM messages m JOIN sessions s ON s.id=m.session_id WHERE {where}"
        order = f" ORDER BY {at} DESC, m.id DESC"
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        visible = " AND search_text(m.content) LIKE ? ESCAPE '\\'"
        args = (f"%{escaped}%",)
        found = {}

        def collect(sql, params):
            count = set()
            for sid, title, text, shelved, timestamp in db.execute(sql, params):
                count.add(sid)
                if sid not in found or timestamp > found[sid]["at"]:
                    clean = " ".join(copyable_text(text).split())
                    start = max(0, clean.casefold().find(query) - 60)
                    snippet = ("…" if start else "") + clean[start:start + 220]
                    if start + 220 < len(clean):
                        snippet += "…"
                    found[sid] = {"id": sid, "title": copyable_text(title) or "untitled", "snippet": snippet,
                                  "archived": bool(shelved), "at": timestamp}
                if len(count) >= 20:
                    break

        if db.execute("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").fetchone():
            try:
                # Quoting the entire phrase makes FTS operators and punctuation literal.
                collect(select + " AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)" + visible + order,
                        ('"' + query.replace('"', '""') + '"', *args))
            except sqlite3.OperationalError:
                pass  # Older/incompatible indexes still have the table scan below.
        # Fall back to substring scan when FTS didn't already fill the page (or isn't present).
        if len(found) < 20:
            collect(select + visible + order, args)
        return sorted(found.values(), key=lambda row: (row["at"], row["id"]), reverse=True)[:20]
