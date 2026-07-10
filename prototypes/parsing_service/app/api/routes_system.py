"""System routes: prototype control page and health status."""

from __future__ import annotations

import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from app.storage.paths import SERVICE_ROOT
from app.workers.gpu import gpu_available

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = SERVICE_ROOT / "static" / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Index HTML not found")
    try:
        return index_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not read the prototype control page.",
        ) from exc


@router.get("/status")
async def get_system_status():
    available = gpu_available()
    return {
        "status": "online",
        "gpu_available": available,
        "active_device_default": "gpu:0" if available else "cpu",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
