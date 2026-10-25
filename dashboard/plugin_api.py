"""Backend half: nothing runs here any more.

The portal is a messaging platform now, so its web server, sign-in and chat hub
run inside the gateway with the adapter (see `__init__.py`). This route stays so
the dashboard can still show the plugin.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/status")
async def status():
    return {"running": False, "served_by": "gateway"}
