"""Read-only HTTP over the runs directory and the model registries; kei's work runs in its DBOS worker
(`kei_exp.workflows`).

Run: uv run uvicorn kei_exp.api:app --port 8001   (vLLM holds :8000)
Env: KEI_VLLM_URL (chat completions URL, default DEFAULT_URL); the run directory is KEI_RUNS, read by `runs`.

Nothing here keeps state or opens a database: a route validates what HTTP gave it and serves a model listing or a
file a run has published. A run's and an extraction's status are their kei workflows', which Studio reads from DBOS.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from kei_exp import runs
from kei_exp.cut import DEFAULT_LAYOUT_MODEL, LAYOUT_MODELS
from kei_exp.files import load_dotenv
from kei_exp.kie.extract import models as extraction_models
from kei_exp.kie.extract.models import ROLES
from kei_exp.kie.stages.ocr import TRANSCRIBERS
from kei_exp.models import DEFAULT_OCR_MODEL, MODELS
from kei_exp.runtime import loaded_model
from kei_exp.transcription.types import DEFAULT_URL

load_dotenv()
VLLM_URL = os.environ.get("KEI_VLLM_URL", DEFAULT_URL)


@asynccontextmanager
async def lifespan(_: FastAPI):
    runs.RUNS.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="kei-exp", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["*"], allow_headers=["*"])


@app.get("/api/models")
def list_models() -> list[dict]:
    return [{"key": key, "repo": record.repo, "vlm": record.vlm, "context": record.context,
             "max_new_tokens": record.max_new_tokens, "knobs": sorted(TRANSCRIBERS[record.kind].knobs)}
            for key, record in MODELS.items()]


@app.get("/api/extraction-models")
def list_extraction_models() -> dict:
    """The extraction models this deployment serves, each with the roles it may take and whether its server answers
    with it now, and the default per role: what a run may choose in `options.models`."""
    models = []
    for key, record in extraction_models.EXTRACT_MODELS.items():
        reachable, repo = loaded_model(record.url)
        models.append({"key": key, "repo": record.repo, "roles": [role for role in ROLES if role in record.roles],
                       "reachable": reachable, "serving": repo == record.repo})
    return {"defaults": extraction_models.DEFAULTS, "models": models}


@app.get("/api/ingestion-models")
def list_ingestion_models() -> dict:
    """The OCR and layout models a new parse may run on, and the default per role; shaped like
    /api/extraction-models. An OCR model is `serving` only while the OCR server has it loaded, which is what this
    listing observed, not a promise. Layout detectors run inside this service and are always selectable. A page with
    a text layer uses neither."""
    _, served = loaded_model(VLLM_URL)
    return {
        "defaults": {"ocr": DEFAULT_OCR_MODEL, "layout": DEFAULT_LAYOUT_MODEL},
        "models": {
            "ocr": [{"key": key, "label": record.repo, "serving": record.repo == served}
                    for key, record in MODELS.items()],
            "layout": [{"key": key, "label": label, "serving": True} for key, label in LAYOUT_MODELS.items()],
        },
    }


def run_dir(run_id: str) -> Path:
    directory = runs.directory_of(run_id)
    if directory is None:
        raise HTTPException(404, "no such run")
    return directory


@app.get("/api/runs/{run_id}/result")
def run_result(run_id: str) -> FileResponse:
    """The manifest of the accepted result (kei_exp.result.Result), published once the run has an outcome."""
    path = run_dir(run_id) / "result" / "result.json"
    if not path.exists():
        raise HTTPException(404, "no result yet")
    return FileResponse(path, media_type="application/json")


@app.get("/api/runs/{run_id}/pages/{number}")
def run_page_result(run_id: str, number: int) -> FileResponse:
    """The accepted result of one PDF page (kei_exp.result.PageResult): its units, crops and segments."""
    path = run_dir(run_id) / "result" / "pages" / f"{number}.json"
    if not path.exists():
        raise HTTPException(404, "no result for this page yet")
    return FileResponse(path, media_type="application/json")


@app.get("/api/runs/{run_id}/extractions/{extraction_id}")
def run_extraction(run_id: str, extraction_id: str) -> FileResponse:
    """A published extraction artifact. Its status is its kei `extract` workflow's, which Studio reads from DBOS."""
    if not runs.COMPONENT.fullmatch(extraction_id):  # runs, not workflows.contracts: that module imports dbos
        raise HTTPException(404, "no such extraction")
    path = run_dir(run_id) / "extractions" / extraction_id / "result.json"
    if not path.is_file():
        raise HTTPException(404, "no such extraction")
    return FileResponse(path, media_type="application/json")
