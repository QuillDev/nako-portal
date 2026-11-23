"""Compatibility status route for the gateway dashboard's plugin listing.

The portal is a messaging platform now, so its web server, sign-in and chat hub
run in the standalone server (`dashboard/serve.py`). Only the adapter runs inside
the gateway; this route does not inspect the standalone server's health.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/status")
async def status():
    return {"running": False, "served_by": "standalone"}
