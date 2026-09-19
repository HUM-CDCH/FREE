"""FastAPI surface for the simple Docling parsing service."""

from __future__ import annotations

import datetime
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from . import parallel_parsing
from .contracts import TaskCreatedResponse, TaskStatusResponse
from .storage import (
    MAX_UPLOAD_BYTES,
    TaskNotFoundError,
    TaskStorage,
    UploadTooLargeError,
    canonical_task_id,
)
from .tasks import (
    DEFAULT_QUEUE_CAPACITY,
    ParserUnavailableError,
    QueueCapacityError,
    TaskManager,
    new_task_metadata,
)
from .worker_pool import PartitionWorkerPool


TASK_REQUEST_LIMIT_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024
RETRY_AFTER_SECONDS = 5

_UNSET = object()
"""Distinguishes "no override, build the default pool" from an explicit
`pool=None` (partitioning disabled) in `create_app`."""


def _positive_int_env(name: str, default: int) -> int:
    """Read a positive-integer env var, falling back to `default` when the
    variable is unset, blank, non-numeric, or not positive."""

    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


class TaskRequestLimitMiddleware:
    """Reject an obviously oversized multipart envelope before it is parsed."""

    def __init__(self, app: ASGIApp, max_bytes: int = TASK_REQUEST_LIMIT_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        limited = (
            scope["type"] == "http"
            and scope["method"] == "POST"
            and scope["path"] == "/tasks"
        )
        length: int | None = None
        if limited:
            values = [value for name, value in scope["headers"] if name == b"content-length"]
            if len(values) == 1:
                try:
                    length = int(values[0].decode("ascii"))
                except ValueError:
                    pass
        if length is not None and length > self.max_bytes:
            await JSONResponse(
                {"detail": "Request body exceeds the 101 MiB limit."},
                status_code=413,
            )(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _http_metadata(storage: TaskStorage, task_id: str) -> dict[str, Any]:
    try:
        canonical_task_id(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return storage.load_metadata(task_id)
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Could not read task metadata.") from exc


def _require_completed(metadata: dict[str, Any], what: str) -> None:
    if metadata.get("status") != "completed":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Task is in status '{metadata.get('status')}' and {what} is not ready."
            ),
        )


def create_app(
    parser: Any | None = None,
    data_root: str | Path | None = None,
    queue_capacity: int = DEFAULT_QUEUE_CAPACITY,
    *,
    parallel_min_pages: int | None = None,
    parallel_target_partition_pages: int | None = None,
    parallel_max_workers: int | None = None,
    parallel_search_radius: int | None = None,
    pool: Any | None = _UNSET,
) -> FastAPI:
    service_root = Path(__file__).resolve().parents[1]
    storage = TaskStorage(data_root or service_root / "data" / "tasks")

    # Large-document partitioning is opt-in: PARALLEL_PARSE_MIN_PAGES
    # defaults high enough that no document partitions until an operator
    # explicitly lowers it (see design.md's Migration Plan). A pool is only
    # constructed when partitioning is actually possible; ProcessPoolExecutor
    # spawns no OS processes until the first partition is dispatched, so
    # building one costs nothing while every task stays under threshold.
    # Each `parallel_*` keyword lets a caller (tests, mainly) override the
    # corresponding env var explicitly instead of mutating process env.
    if parallel_min_pages is None:
        parallel_min_pages = _positive_int_env("PARALLEL_PARSE_MIN_PAGES", parallel_parsing.DEFAULT_MIN_PAGES)
    if parallel_target_partition_pages is None:
        parallel_target_partition_pages = _positive_int_env(
            "PARALLEL_PARSE_TARGET_PARTITION_PAGES", parallel_parsing.DEFAULT_TARGET_PARTITION_PAGES
        )
    if parallel_max_workers is None:
        parallel_max_workers = _positive_int_env("PARALLEL_PARSE_MAX_WORKERS", parallel_parsing.DEFAULT_MAX_WORKERS)
    if parallel_search_radius is None:
        parallel_search_radius = _positive_int_env(
            "PARALLEL_PARSE_SPLIT_SEARCH_RADIUS", parallel_parsing.DEFAULT_SPLIT_SEARCH_RADIUS
        )
    if pool is _UNSET:
        pool = PartitionWorkerPool(parallel_max_workers) if parallel_max_workers > 1 else None

    manager = TaskManager(
        storage,
        parser,
        capacity=queue_capacity,
        pool=pool,
        parallel_min_pages=parallel_min_pages,
        parallel_target_partition_pages=parallel_target_partition_pages,
        parallel_max_workers=parallel_max_workers,
        parallel_search_radius=parallel_search_radius,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()
            shutdown = getattr(pool, "shutdown", None)
            if callable(shutdown):
                shutdown()

    application = FastAPI(title="FREE Parsing Service", lifespan=lifespan)
    application.state.storage = storage
    application.state.task_manager = manager
    application.add_middleware(TaskRequestLimitMiddleware)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:8055",
            "http://127.0.0.1:8055",
        ],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.get("/", response_class=HTMLResponse)
    async def serve_index() -> str:
        return (
            "<!doctype html><html><head><title>FREE Parsing Service</title></head>"
            "<body><h1>FREE Parsing Service</h1><p>Docling parser is online.</p>"
            "</body></html>"
        )

    @application.get("/status")
    async def get_system_status() -> dict[str, Any]:
        return {
            "status": "online",
            "parser_worker_health": manager.health,
            "parser_worker_state": manager.state,
            "gpu_available": False,
            "active_device_default": None,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    @application.post("/tasks", status_code=202, response_model=TaskCreatedResponse)
    async def create_task(file: UploadFile = File(...)) -> TaskCreatedResponse:
        if not manager.ready:
            raise HTTPException(
                status_code=503,
                detail="Parser worker is not ready to accept tasks.",
                headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
            )
        task_id = str(uuid.uuid4())
        owns_directory = False
        try:
            storage.create_task_dir(task_id)
            owns_directory = True
            _source, source_name, content_sha256, byte_size = await run_in_threadpool(
                storage.store_upload,
                task_id,
                file.file,
                filename=file.filename,
                content_type=file.content_type,
                max_bytes=MAX_UPLOAD_BYTES,
            )
            metadata = new_task_metadata(
                task_id=task_id,
                source_name=source_name,
                content_sha256=content_sha256,
                byte_size=byte_size,
            )
            await manager.admit(metadata)
        except UploadTooLargeError as exc:
            raise HTTPException(
                status_code=413,
                detail=f"Uploaded file must be a PDF: {exc}",
            ) from exc
        except TypeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except QueueCapacityError as exc:
            raise HTTPException(
                status_code=503,
                detail="Parser queue is temporarily unavailable.",
                headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
            ) from exc
        except ParserUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail="Parser worker is not ready to accept tasks.",
                headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
            ) from exc
        except ValueError as exc:
            detail = str(exc)
            if detail != "Uploaded file must be a PDF.":
                detail = f"Uploaded file must be a PDF: {detail}"
            raise HTTPException(status_code=400, detail=detail) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail="Could not create parsing task."
            ) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Could not create parsing task.") from exc
        finally:
            # Once metadata was admitted the task directory belongs to the worker.
            if owns_directory:
                try:
                    admitted = storage.load_metadata(task_id).get("status") in {
                        "pending",
                        "running",
                        "cancelling",
                        "cancelled",
                        "completed",
                        "failed",
                    }
                except (TaskNotFoundError, OSError, ValueError):
                    admitted = False
                if not admitted:
                    storage.remove_task_dir(task_id)

        return TaskCreatedResponse(
            task_id=task_id,
            document_id=metadata["document_id"],
            content_sha256=content_sha256,
            status="pending",
            created_at=metadata["created_at"],
        )

    @application.get("/tasks/{task_id}", response_model=TaskStatusResponse)
    async def get_task_status(task_id: str) -> dict[str, Any]:
        return _http_metadata(storage, task_id)

    @application.post(
        "/tasks/{task_id}/cancel",
        response_model=TaskStatusResponse,
    )
    async def cancel_task(task_id: str) -> dict[str, Any]:
        _http_metadata(storage, task_id)
        try:
            return await manager.cancel(task_id)
        except TaskNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Task not found") from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=500,
                detail="Could not update task cancellation state.",
            ) from exc

    @application.api_route(
        "/tasks/{task_id}/pdf",
        methods=["GET", "HEAD"],
        response_class=FileResponse,
    )
    async def get_task_pdf(task_id: str) -> FileResponse:
        _http_metadata(storage, task_id)
        source = storage.source_path(task_id)
        if not source.is_file() or source.is_symlink():
            raise HTTPException(status_code=404, detail="Task source PDF not found")
        return FileResponse(source, media_type="application/pdf")

    @application.get("/tasks/{task_id}/markdown")
    async def get_task_markdown(task_id: str) -> Response:
        metadata = _http_metadata(storage, task_id)
        _require_completed(metadata, "markdown")
        try:
            markdown = storage.read_markdown(task_id)
        except (FileNotFoundError, OSError, ValueError) as exc:
            raise HTTPException(
                status_code=500,
                detail="Canonical Markdown is unavailable.",
            ) from exc
        return Response(markdown, media_type="text/markdown")

    @application.get("/tasks/{task_id}/source")
    @application.get("/tasks/{task_id}/document")
    async def get_task_document(task_id: str) -> dict[str, Any]:
        metadata = _http_metadata(storage, task_id)
        _require_completed(metadata, "parsed document")
        try:
            return storage.read_parsed_document(task_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=500,
                detail="Could not read parsed document JSON.",
            ) from exc

    @application.get(
        "/tasks/{task_id}/download",
        response_class=FileResponse,
    )
    async def download_task_zip(task_id: str) -> FileResponse:
        metadata = _http_metadata(storage, task_id)
        _require_completed(metadata, "output archive")
        package = storage.package_path(task_id)
        if not package.is_file() or package.is_symlink():
            raise HTTPException(status_code=500, detail="Failed to generate output ZIP.")
        return FileResponse(
            package,
            media_type="application/zip",
            filename=f"ingestion_results_{canonical_task_id(task_id)[:8]}.zip",
        )

    return application


app = create_app()


__all__ = ["app", "create_app"]
