"""Read-only message search shared by the gateway and offline reader."""

import re
import sqlite3
from contextlib import closing
from pathlib import Path

_HIDDEN_LINE = re.compile(r"^\s*(?:SECRET|MEDIA):", re.IGNORECASE)
_LINE_BREAKS = frozenset("\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029")
_PAGE_LIMIT = 20


def copyable_text(text):
    if not text:
        return ""
    return "\n".join(line for line in text.splitlines() if not _HIDDEN_LINE.match(line)).strip()


def _fts_is_complete(db):
    """True when state_meta does not mark the FTS indexes stale or mid-backfill."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_meta'").fetchone():
        return True
    rows = db.execute(
        "SELECT key, value FROM state_meta WHERE key IN ('fts_stale', 'fts_rebuild_high_water')"
    ).fetchall()
    for key, value in rows:
        if key == "fts_stale":
            return False
        if value is not None:
            try:
                if int(value) > 0:
                    return False
            except (TypeError, ValueError):
                return False
    return True


def _trigram_status(db, fts_complete):
    """Return (available, authoritative) for messages_fts_trigram."""
    if not fts_complete:
        return False, False
    row = db.execute("SELECT sql FROM sqlite_master WHERE name='messages_fts_trigram'").fetchone()
    if not row or not isinstance(row[0], str):
        return False, False
    ddl = " ".join(row[0].lower().split())
    if "fts5" not in ddl or "trigram" not in ddl or "case_sensitive 1" in ddl or "case_sensitive=1" in ddl:
        return False, False
    has_trigger = bool(
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='messages_fts_trigram_insert'"
        ).fetchone()
    )
    return True, has_trigger


_DELEGATE_OR_INVALID_CONFIG = (
    "s.model_config IS NOT NULL AND CASE WHEN json_valid(s.model_config) "
    "THEN json_extract(s.model_config, '$._delegate_from') IS NOT NULL ELSE 1 END"
)


def _has_excluded_delegates(db, session_columns):
    if "model_config" not in session_columns:
        return False
    try:
        return bool(
            db.execute(
                "SELECT 1 FROM sessions s WHERE s.source='portal' AND s.ended_at IS NULL "
                f"AND {_DELEGATE_OR_INVALID_CONFIG} LIMIT 1"
            ).fetchone()
        )
    except sqlite3.OperationalError:
        return True


def search_sessions(home, query):
    raw_query = query.strip()
    query = raw_query.casefold()
    state = Path(home) / "state.db"
    if len(query) < 2 or not state.is_file():
        return []
    with closing(sqlite3.connect(state.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(messages)")}
        session_columns = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
        if not columns or not session_columns:
            return []
        multiline = any(ch in _LINE_BREAKS for ch in query)

        def matches_visible(text):
            if not text:
                return 0
            if multiline:
                return int(query in copyable_text(text).casefold())
            folded = text.casefold()
            if query not in folded:
                return 0
            if "secret:" not in folded and "media:" not in folded:
                return 1
            return int(query in copyable_text(text).casefold())

        db.create_function("matches_visible", 1, matches_visible, deterministic=True)
        where = "s.source='portal' AND s.ended_at IS NULL AND m.role IN ('user', 'assistant')"
        if "display_kind" in columns:
            where += " AND COALESCE(m.display_kind, '')!='hidden'"
        if "active" in columns:
            where += " AND COALESCE(m.active, 1)=1"
        archived = "COALESCE(s.archived, 0)" if "archived" in session_columns else "0"
        at = "COALESCE(m.timestamp, 0)" if "timestamp" in columns else "m.id"
        # Sort only lightweight keys (session, id, rowid, timestamp), then hydrate the <=20 winning rows.
        select_ids = f"SELECT s.id, m.id, m.rowid, {at} FROM messages m JOIN sessions s ON s.id=m.session_id WHERE {where}"
        order = f" ORDER BY {at} DESC, m.id DESC"
        visible = " AND matches_visible(m.content)"
        picked = {}

        def collect(sql, params=()):
            count = set()
            for sid, mid, rowid, timestamp in db.execute(sql, params):
                count.add(sid)
                prev = picked.get(sid)
                if prev is None or (timestamp, mid) > (prev[0], prev[1]):
                    picked[sid] = (timestamp, mid, rowid)
                if len(count) >= _PAGE_LIMIT:
                    break

        fts_complete = _fts_is_complete(db)
        trigram_complete = False
        trigram_ok, trigram_authoritative = _trigram_status(db, fts_complete)
        # FTS5 trigram uses simple case folding; skip it when casefold() expands characters (e.g. 'ß' -> 'ss').
        if len(raw_query) >= 3 and not multiline and "\x00" not in query and query == raw_query.lower() and trigram_ok:
            try:
                # Quoting the entire phrase makes FTS operators and punctuation literal.
                collect(
                    select_ids
                    + " AND m.id IN (SELECT rowid FROM messages_fts_trigram WHERE messages_fts_trigram MATCH ?)"
                    + visible
                    + order,
                    ('content : "' + query.replace('"', '""') + '"',),
                )
                trigram_complete = trigram_authoritative
            except sqlite3.OperationalError:
                pass  # Older/incompatible indexes fall through below.

        if trigram_complete and _has_excluded_delegates(db, session_columns):
            # Hermes's trigram view excludes delegate-child sessions; scan only those if any exist.
            try:
                collect(select_ids + f" AND {_DELEGATE_OR_INVALID_CONFIG}" + visible + order)
            except sqlite3.OperationalError:
                trigram_complete = False

        if not trigram_complete:
            if (
                fts_complete
                and len(picked) < _PAGE_LIMIT
                and "\x00" not in query
                and db.execute("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").fetchone()
            ):
                try:
                    collect(
                        select_ids
                        + " AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"
                        + visible
                        + order,
                        ('"' + query.replace('"', '""') + '"',),
                    )
                except sqlite3.OperationalError:
                    pass  # Older/incompatible indexes still have the table scan below.
            # Fall back to substring scan when FTS didn't already fill the page (or isn't present).
            if len(picked) < _PAGE_LIMIT:
                collect(select_ids + visible + order)

        if not picked:
            return []

        top = sorted(picked.items(), key=lambda item: (item[1][0], item[0]), reverse=True)[:_PAGE_LIMIT]
        rowids = [rowid for _, (_, _, rowid) in top]
        placeholders = ",".join("?" for _ in rowids)
        details = {
            rowid: (title, text, shelved)
            for rowid, title, text, shelved in db.execute(
                f"SELECT m.rowid, s.title, m.content, {archived} "
                f"FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.rowid IN ({placeholders})",
                rowids,
            )
        }
        results = []
        for sid, (timestamp, _, rowid) in top:
            row = details.get(rowid)
            if row is None:
                continue
            title, text, shelved = row
            clean = " ".join(copyable_text(text).split())
            start = max(0, clean.casefold().find(query) - 60)
            snippet = ("…" if start else "") + clean[start:start + 220]
            if start + 220 < len(clean):
                snippet += "…"
            results.append({
                "id": sid,
                "title": copyable_text(title) or "untitled",
                "snippet": snippet,
                "archived": bool(shelved),
                "at": timestamp,
            })
        return results
