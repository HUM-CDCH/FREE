"""Task lifecycle routes: create a canonical parsing task and poll status."""

from __future__ import annotations

import datetime
import shutil
import uuid

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from filelock import FileLock

from app.api.deps import http_task_dir, load_metadata, save_metadata
from app.api.schemas import TaskCreatedResponse, TaskStatusResponse
from app.ingestion.upload import save_uploaded_source
from app.ingestion.url_fetch import download_source, public_url_ref
from app.models.parser import (
    CANONICAL_OCR_DEVICE_POLICY,
    CANONICAL_OCR_DPI,
    canonical_preprocessing_config,
)
from app.storage.blobs import (
    release_source_lease,
    validate_task_capacity,
)
from app.storage.hashing import document_id_from_hash
from app.storage.manifests import json_payload_size
from app.storage.paths import SOURCE_FILENAME, task_store_lock_path
from app.workers.gpu import gpu_available
from app.workers.parse_worker import run_extraction_task

router = APIRouter()


@router.post("/tasks", status_code=202, response_model=TaskCreatedResponse)
async def create_task(
    background_tasks: BackgroundTasks,
    file: UploadFile | None = File(None),
    url: str | None = Form(None),
):
    if not file and not url:
        raise HTTPException(
            status_code=400, detail="Must provide either 'file' upload or 'url' path."
        )
    if file and url:
        raise HTTPException(
            status_code=400, detail="Provide either 'file' or 'url', not both."
        )

    task_id = str(uuid.uuid4())
    task_dir = http_task_dir(task_id)
    task_dir.mkdir(parents=True, exist_ok=True)
    content_sha256: str | None = None

    try:
        if file:
            source_path, source_name, content_sha256 = await run_in_threadpool(
                save_uploaded_source, file, task_dir
            )
        elif url:
            source_path, source_name, content_sha256 = await download_source(
                url, task_dir
            )
        else:  # pragma: no cover - guarded above
            raise HTTPException(
                status_code=400,
                detail="Must provide either 'file' upload or 'url' path.",
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
            "source_kind": "url" if url else "upload",
            "submitted_url": public_url_ref(url),
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
        with FileLock(str(task_store_lock_path())):
            validate_task_capacity(
                task_dir,
                additional_bytes=json_payload_size(metadata),
                replacing_paths=(task_dir / "metadata.json",),
            )
            save_metadata(task_id, metadata)
    except HTTPException:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise
    except (OSError, ValueError) as exc:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise HTTPException(
            status_code=507,
            detail="Could not reserve task storage.",
        ) from exc
    finally:
        if content_sha256 is not None:
            release_source_lease(content_sha256, task_id)

    if content_sha256 is None:  # Defensive narrowing after the ingestion branches.
        raise HTTPException(
            status_code=500, detail="Source ingestion did not complete."
        )

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
