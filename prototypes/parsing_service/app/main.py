"""FastAPI application factory: app configuration and router registration only."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes_artifacts import router as artifacts_router
from app.api.routes_documents import router as documents_router
from app.api.routes_system import router as system_router
from app.api.routes_tasks import router as tasks_router
from app.storage.paths import DEFAULT_DATA_DIR
from app.workers.gpu import check_gpu_available, set_gpu_available
from app.workers.parse_worker import cleanup_loop, reconcile_interrupted_tasks

logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Detecting GPU availability...")
    set_gpu_available(await run_in_threadpool(check_gpu_available))
    await run_in_threadpool(reconcile_interrupted_tasks)

    cleanup_task = asyncio.create_task(cleanup_loop())
    yield
    cleanup_task.cancel()
    with suppress(asyncio.CancelledError):
        await cleanup_task


app = FastAPI(
    title="Canonical Docling DocTags Ingestion Service",
    description="Secure PDF ingestion service producing one Docling DocTags-backed ParsedDocument per source hash.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(system_router)
app.include_router(tasks_router)
app.include_router(documents_router)
app.include_router(artifacts_router)
