"""Gateway half: "portal" as a messaging platform, like Discord or Slack.

Conversations themselves don't pass through here: the backend half mirrors
Desktop sessions directly. This adapter is how the rest of Hermes *sends* to
the portal: cron deliveries (`deliver=portal`) and `send_message` land in the
portal's inbox on this machine, and the backend turns each into a push alert.

Like a Discord DM, the portal has one chat those posts belong to. The adapter
keeps a gateway session open for it, so Hermes's cron mirror appends every post
there and a reply from the portal has all of them in context.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

log = logging.getLogger("hermes.portal")
HOME_CHANNEL = "inbox"
CHAT_TITLE = "Notifications"


def _store_module():
    name = "nako_portal_store"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / "dashboard" / "portal" / "store.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _deliver(chat_id, text):
    from hermes_constants import get_hermes_home

    store = _store_module().Store(get_hermes_home() / "nako-portal" / "portal.db")
    try:
        return store.deliver(str(chat_id or HOME_CHANNEL), str(text))
    finally:
        store.db.close()


def _ensure_chat(session_store):
    """The portal's one chat, created on first use. Cron's mirror only appends to a session that
    already exists for portal:inbox, so without it every post would reach the inbox and no chat."""
    if session_store is None:
        return None
    from gateway.config import Platform
    from gateway.session import SessionSource

    source = SessionSource(platform=Platform("portal"), chat_id=HOME_CHANNEL, chat_name="Nako", chat_type="dm")
    entry = session_store.get_or_create_session(source, touch_activity=False)
    db = getattr(session_store, "_db", None)
    if db is not None and not db.get_session_title(entry.session_id):
        db.set_session_title(entry.session_id, CHAT_TITLE)
    return entry.session_id


def _check():
    return True


def _validate(config):
    return True


def _env_enablement():
    return {"home_channel": {"chat_id": HOME_CHANNEL, "name": "Portal inbox"}}


async def _standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
    import asyncio

    text = "\n".join([message, *(f"MEDIA:{path}" for path in media_files or [])])
    row = await asyncio.to_thread(_deliver, chat_id, text)
    return {"success": True, "message_id": str(row)}


def _adapter(config):
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult

    class PortalAdapter(BasePlatformAdapter):
        def __init__(self, cfg):
            super().__init__(cfg, Platform("portal"))

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            self._mark_connected()
            self._chat()
            return True

        def _chat(self):
            try:
                return _ensure_chat(getattr(self, "_session_store", None))
            except Exception:
                log.exception("portal: could not open the notifications chat")
                return None

        async def disconnect(self) -> None:
            self._mark_disconnected()

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            import asyncio

            row = await asyncio.to_thread(_deliver, chat_id, content)
            self._chat()
            return SendResult(success=True, message_id=str(row))

        async def send_typing(self, chat_id, metadata=None):
            return None

        async def get_chat_info(self, chat_id):
            return {"name": "Portal inbox", "type": "dm"}

    return PortalAdapter(config)


def register(ctx):
    ctx.register_platform(
        name="portal",
        label="Nako",
        adapter_factory=_adapter,
        check_fn=_check,
        validate_config=_validate,
        env_enablement_fn=_env_enablement,
        standalone_sender_fn=_standalone_send,
        cron_deliver_env_var="PORTAL_HOME_CHANNEL",
        max_message_length=0,
        emoji="🪟",
        pii_safe=True,
        platform_hint="You are writing to the user's private Nako app inbox. It renders markdown.",
    )
