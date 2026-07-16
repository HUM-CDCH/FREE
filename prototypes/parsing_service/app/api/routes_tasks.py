"""Task lifecycle routes: create a canonical parsing task and poll status."""

from __future__ import annotations

import datetime
import shutil
import uuid

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.api.deps import http_task_dir, load_metadata, save_metadata
from app.api.schemas import TaskCreatedResponse, TaskStatusResponse
from app.ingestion.upload import save_uploaded_source
from app.models.parser import (
    CANONICAL_OCR_DEVICE_POLICY,
    CANONICAL_OCR_DPI,
    canonical_preprocessing_config,
)
from app.storage.hashing import document_id_from_hash
from app.storage.paths import SOURCE_FILENAME
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
        document_id = document_id_from_hash(content_sha256)
        resolved_device = "gpu:0" if gpu_available() else "cpu"
        metadata = {
            "task_id": task_id,
            "document_id": document_id,
            "content_sha256": content_sha256,
            "source_path": SOURCE_FILENAME,
            "source_store_path": f"data/sources/{content_sha256}.pdf",
            "source_kind": "upload",
            "status": "pending",
            "created_at": now,
            "updated_at": now,
            "params": {
                **canonical_preprocessing_config(resolved_ocr_device=resolved_device),
                "source_name": source_name,
            },
            "stats": {},
            "parser_runs": [],
            "selected_parser": None,
            "canonical_parsed_document_ref": None,
            "error_code": None,
            "error": None,
        }
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

    background_tasks.add_task(
        run_extraction_task,
        task_id=task_id,
        source_path=str(source_path),
        dpi=CANONICAL_OCR_DPI,
        pipeline=None,
        device=CANONICAL_OCR_DEVICE_POLICY,
    )

    return TaskCreatedResponse(
        task_id=task_id,
        document_id=document_id,
        content_sha256=content_sha256,
        status="pending",
        created_at=metadata["created_at"],
    )


@router.get("/tasks/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    return load_metadata(task_id)
