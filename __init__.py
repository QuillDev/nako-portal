"""Gateway half: "portal" as a messaging platform, like Discord or Slack.

Conversations themselves don't pass through here: the backend half mirrors
Desktop sessions directly. This adapter is how the rest of Hermes *sends* to
the portal: cron deliveries (`deliver=portal`) and `send_message` land in the
portal's inbox on this machine, and the backend turns each into a push alert.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

log = logging.getLogger("hermes.portal")
HOME_CHANNEL = "inbox"


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
            return True

        async def disconnect(self) -> None:
            self._mark_disconnected()

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            import asyncio

            row = await asyncio.to_thread(_deliver, chat_id, content)
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
