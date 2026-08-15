"""Task lifecycle routes: create a canonical parsing task and poll status."""

from __future__ import annotations

import datetime
import shutil
import uuid

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from filelock import FileLock, Timeout

from app.api.deps import http_task_dir, load_metadata, save_metadata
from app.api.schemas import TaskCreatedResponse, TaskStatusResponse
from app.ingestion.upload import save_uploaded_source
from app.storage.paths import task_lock_path
from app.workers._task_state import new_task_metadata, retry_task_metadata
from app.workers.gpu import gpu_available
from app.workers.parse_worker import run_extraction_task

router = APIRouter()


@router.post("/tasks", status_code=202, response_model=TaskCreatedResponse)
async def create_task(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
):
    task_id = str(uuid.uuid4())
    task_dir = http_task_dir(task_id)

    try:
        task_dir.mkdir(parents=True, exist_ok=True)
        source_path, source_name, content_sha256 = await run_in_threadpool(
            save_uploaded_source, file, task_dir
        )

        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        resolved_device = "gpu:0" if gpu_available() else "cpu"
        metadata = new_task_metadata(
            task_id=task_id,
            content_sha256=content_sha256,
            source_name=source_name,
            resolved_ocr_device=resolved_device,
            queued_at=now,
        )
        save_metadata(task_id, metadata)
    except HTTPException:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise
    except (OSError, ValueError) as exc:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise HTTPException(
            status_code=500,
            detail="Could not create parsing task.",
        ) from exc

    background_tasks.add_task(run_extraction_task, task_id)

    return TaskCreatedResponse(
        task_id=task_id,
        document_id=metadata["document_id"],
        content_sha256=content_sha256,
        status="pending",
        created_at=metadata["created_at"],
    )


@router.get("/tasks/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    return load_metadata(task_id)


@router.post(
    "/tasks/{task_id}/retry",
    status_code=202,
    response_model=TaskCreatedResponse,
)
async def retry_task(task_id: str, background_tasks: BackgroundTasks):
    http_task_dir(task_id)
    try:
        with FileLock(str(task_lock_path(task_id))).acquire(timeout=0):
            metadata = load_metadata(task_id)
            if metadata.get("status") != "failed":
                raise HTTPException(
                    status_code=409,
                    detail="Only a failed parsing task can be retried.",
                )
            queued_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
            metadata = retry_task_metadata(metadata, queued_at=queued_at)
            save_metadata(task_id, metadata)
    except Timeout as exc:
        raise HTTPException(
            status_code=409,
            detail="Parsing task is already running.",
        ) from exc

    background_tasks.add_task(run_extraction_task, task_id)
    return TaskCreatedResponse(
        task_id=task_id,
        document_id=metadata["document_id"],
        content_sha256=metadata["content_sha256"],
        status="pending",
        created_at=metadata["created_at"],
    )
