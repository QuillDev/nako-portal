"""Durable mesh deliveries, scoped to the transcript that explicitly attached them."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import stat
from pathlib import Path, PureWindowsPath

from .media import shown_files

MAX_FILE = 25 * 1024 * 1024
SESSION = re.compile(r"^[\w.-]{1,120}$")
MAX_FILES = 32


def valid_path(raw):
    if not isinstance(raw, str) or not raw or len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        return False
    win = PureWindowsPath(raw)
    # No device paths, UNC shares, traversal or NTFS alternate streams.
    if raw.startswith(("\\\\", "//")) or ".." in raw.replace("\\", "/").split("/"):
        return False
    if win.drive:
        return bool(re.match(r"^[A-Za-z]:[\\/]", raw)) and ":" not in raw[2:]
    return raw.startswith(("/", "~/")) and ":" not in raw


def read_attachment(raw):
    """Read an explicit local delivery, never a symlink, device or unbounded stream."""
    if not valid_path(raw):
        raise ValueError("Invalid attachment path")
    path = Path(raw).expanduser()
    if not path.is_absolute() or any(p.is_symlink() or getattr(p, "is_junction", lambda: False)() for p in (path, *path.parents)):
        raise ValueError("Attachments must be regular local files, not links")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
            raise ValueError("Attachments must be regular files under 25 MiB")
        data = source.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError("Attachments must be under 25 MiB")
    return {"path": raw, "data": base64.b64encode(data).decode()}


def decode_attachment(item):
    if not isinstance(item, dict) or not valid_path(item.get("path")):
        raise ValueError("Invalid attachment path")
    encoded = item.get("data")
    if not isinstance(encoded, str) or len(encoded) > ((MAX_FILE + 2) // 3) * 4:
        raise ValueError("Attachments must be under 25 MiB")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("Invalid attachment data") from error
    if len(data) > MAX_FILE:
        raise ValueError("Attachments must be under 25 MiB")
    return item["path"], data


class Attachments:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _key(self, session):
        if not SESSION.fullmatch(session):
            raise ValueError("Invalid attachment session")
        return self.root / (hashlib.sha256(session.encode()).hexdigest() + ".json")

    def view(self, session):
        try:
            return json.loads(self._key(session).read_text())
        except (FileNotFoundError, ValueError):
            return {"files": {}}

    def sessions(self):
        for path in self.root.glob("*.json"):
            view = json.loads(path.read_text())
            opened = view.get("opened") or {}
            if opened.get("session") and view.get("files"):
                yield opened

    def _write(self, path, data):
        temp = path.with_name(path.name + "." + secrets.token_hex(8))
        try:
            with temp.open("xb") as target:
                target.write(data)
            temp.chmod(0o600)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

    def save(self, session, opened=None, item=None):
        view = self.view(session)
        if opened is not None:
            if "archived" not in opened and "archived" in (view.get("opened") or {}):
                opened = {**opened, "archived": view["opened"]["archived"]}
            view["opened"] = opened
        if item is not None:
            raw, data = decode_attachment(item)
            allowed = shown_files((view.get("opened") or {}).get("messages") or [])
            if raw not in allowed:
                raise ValueError("That file wasn't attached in this chat")
            name = re.sub(r"[^\w. -]", "_", PureWindowsPath(raw).name)[:160] or "file"
            key = hashlib.sha256(data).hexdigest() + "/" + name
            (self.root / key).parent.mkdir(exist_ok=True, mode=0o700)
            self._write(self.root / key, data)
            view["files"][raw] = key
        self._write(self._key(session), json.dumps(view).encode())

    def file(self, session, raw):
        view = self.view(session)
        key = view.get("files", {}).get(raw)
        if raw not in shown_files((view.get("opened") or {}).get("messages") or []):
            return None
        return self._blob(key)

    def delivered(self, session):
        """Only bytes received for this destination may appear in an attributed user row.

        The attribution line alone is not authority: a person can type that text too.
        """
        return {str(path) for key in self.view(session).get("files", {}).values() if (path := self._blob(key)) is not None}

    def _blob(self, key):
        if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}/[^/\\]+", key):
            return None
        path = self.root / key
        return path if path.is_file() and not path.is_symlink() else None
