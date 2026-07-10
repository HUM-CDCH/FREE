"""Shared HTTP helpers translating storage errors into API responses."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.storage.manifests import (
    TaskNotFoundError,
    load_task_metadata,
    save_task_metadata,
)
from app.storage.paths import task_dir_for


def http_task_dir(task_id: str) -> Path:
    try:
        return task_dir_for(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def load_metadata(task_id: str) -> dict[str, Any]:
    task_dir = http_task_dir(task_id)
    try:
        return load_task_metadata(task_dir)
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not read task metadata.",
        ) from exc


def save_metadata(task_id: str, data: dict[str, Any]) -> None:
    task_dir = http_task_dir(task_id)
    try:
        save_task_metadata(task_dir, data)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not write task metadata.",
        ) from exc


def require_completed(metadata: dict[str, Any], what: str) -> None:
    if metadata["status"] != "completed":
        raise HTTPException(
            status_code=400,
            detail=f"Task is in status '{metadata['status']}' and {what} is not ready.",
        )
