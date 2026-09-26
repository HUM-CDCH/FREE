"""HTTP front for the run store: routes over `kei_exp.runs`.

Run: uv run uvicorn kei_exp.api:app --port 8001   (vLLM holds :8000)
Env: KEI_VLLM_URL (chat completions URL, default DEFAULT_URL), KEI_MAX_UPLOAD_BYTES, KEI_MAX_PAGES;
the run directory is KEI_RUNS, read by `runs`.

Nothing here keeps run state. A route validates what HTTP gave it, asks `runs` for a job or a summary,
and renders the answer; the queue, the worker, the timing and the files on disk belong to that module, so a run
that starts on one request and is watched from another is one owner's business rather than a shared global.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from kei_exp import runs
from kei_exp.canonical import sha256_file
from kei_exp.cut import DEFAULT_LAYOUT_MODEL, LAYOUT_MODELS
from kei_exp.files import load_dotenv
from kei_exp.jobs import store
from kei_exp.jobs.app import ADMISSION_LIMIT, DATABASE_URL, SLOT, deferring_installed
from kei_exp.kie.extract import models as extraction_models
from kei_exp.kie.extract.models import ROLES
from kei_exp.kie.extract.run import ExtractRequest
from kei_exp.kie.stages.ocr import TRANSCRIBERS, check_ingest, check_knobs
from kei_exp.models import DEFAULT_OCR_MODEL, MODELS
from kei_exp.pagefile import ResultError, read_manifest
from kei_exp.pages import PdfPages
from kei_exp.runtime import loaded_model
from kei_exp.transcription.types import DEFAULT_URL, RunParams

load_dotenv()
VLLM_URL = os.environ.get("KEI_VLLM_URL", DEFAULT_URL)
# Admission's two limits on what one request may cost: a document this service will not take, refused before it
# reaches the queue. Neither is a judgement about the document's content, which is the worker's business.
MAX_UPLOAD_BYTES = int(os.environ.get("KEI_MAX_UPLOAD_BYTES", str(200 * 1024 * 1024)))
MAX_PAGES = int(os.environ.get("KEI_MAX_PAGES", "2000"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    runs.RUNS.mkdir(parents=True, exist_ok=True)
    store.open_pool(DATABASE_URL)  # fail fast: the API needs PostgreSQL, and a route is a bad place to find that out
    async with AsyncExitStack() as stack:
        # Registered before the connector so teardown runs in reverse: the connector is uninstalled first (it is
        # what admit() needs to defer at all), the pool is closed only after, once nothing can use it any more.
        stack.callback(store.close_pool)
        stack.enter_context(deferring_installed(DATABASE_URL))
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


def _stage(pdf: UploadFile, target: Path) -> None:
    """Copy the upload to `target`, stopping the moment it passes MAX_UPLOAD_BYTES (413).

    Counted while copying rather than from a declared length: `Content-Length` describes the whole multipart
    body and a client need not be honest about it, while this is the number of bytes that would actually
    reach the run directory. The partial copy is removed by the caller's `finally`, as every refusal's is.
    """
    written = 0
    with target.open("wb") as handle:
        while chunk := pdf.file.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "the upload is larger than this service's limit of "
                                         f"{MAX_UPLOAD_BYTES} bytes")
            handle.write(chunk)


@app.post("/api/runs", status_code=202)
def create_run(
    pdf: Annotated[UploadFile, File()],
    model: str = Form(...),
    cut: str = Form("auto"),
    layout_model: str = Form(DEFAULT_LAYOUT_MODEL),
    page_source: str = Form("pdf"),
    ingest: str | None = Form(None),
    crop_dpi: int = Form(250),
    max_image_size: int | None = Form(None),
    max_output_tokens: int | None = Form(None),
    stream: bool | None = Form(None),
    page_from: int | None = Form(None),
    page_to: int | None = Form(None),
    debug: bool = Form(False),
) -> dict:
    """Record the request, persist its source and commit it to the queue: upload -> validation -> admit -> 202.

    Admission is cheap on purpose. It judges only what the request and the PDF's own shape can tell it — a known
    model, settings its transcriber honours, a readable PDF within the size and page limits, a page range inside
    the document — and records what was asked for. It resolves nothing and asks no model server anything: the
    native-vs-OCR decision reads every selected page's text layer, and the server can be swapped while a run
    waits in the queue, so BOTH belong to the attempt that actually runs. `runs.execution_for` and
    `kei_exp.jobs.tasks._serving` make them there, and that resolution is the authoritative one — `transcriber`
    and `repo` below name the requested model's record, which is what was asked for, not what will run.
    """
    if model not in MODELS:
        raise HTTPException(400, f"unknown model {model!r}")
    record = MODELS[model]
    if cut not in ("auto", "none"):
        raise HTTPException(400, "cut must be auto or none")
    if layout_model not in LAYOUT_MODELS:
        raise HTTPException(400, f"unknown layout model {layout_model!r}")
    if page_source not in ("pdf", "ingest"):
        raise HTTPException(400, "page_source must be pdf or ingest")
    setting = None
    if ingest is not None:  # the spread layout's own settings (split, gutter overrides), fingerprinted by ingest
        try:
            setting = json.loads(ingest)
        except json.JSONDecodeError as error:
            raise HTTPException(400, f"the ingest setting is not JSON: {error}") from error
        if not isinstance(setting, dict):
            raise HTTPException(400, "the ingest setting must be a JSON object")
        try:
            check_ingest(page_source, setting)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
    if crop_dpi <= 0 or (max_image_size is not None and max_image_size <= 0) \
            or (max_output_tokens is not None and max_output_tokens <= 0):
        raise HTTPException(400, "crop_dpi, max_image_size and max_output_tokens must be positive")
    if stream is None:
        stream = "stream" in TRANSCRIBERS[record.kind].knobs  # live text from every transcriber that has it
    runs.RUNS.mkdir(parents=True, exist_ok=True)
    upload = runs.RUNS / f".upload-{secrets.token_hex(4)}.pdf"  # judged before the run has a directory and a name
    try:
        _stage(pdf, upload)
        try:
            with PdfPages(upload) as source_pages:
                count = source_pages.count
        except Exception as error:  # noqa: BLE001 - pdfium raises its own error types
            raise HTTPException(400, f"not a readable PDF: {error}")
        if count > MAX_PAGES:
            raise HTTPException(400, f"the PDF has {count} pages, more than this service's limit of {MAX_PAGES}")
        pages = None
        if page_from is not None or page_to is not None:  # zero is outside the document, not a default
            pages = (1 if page_from is None else page_from, count if page_to is None else page_to)
            if not 1 <= pages[0] <= pages[1] <= count:
                raise HTTPException(400, f"page range {pages[0]}-{pages[1]} outside 1-{count}")
        try:  # the one judgement of `resolve` that reads no PDF: knobs this model's transcriber does not honour
            check_knobs(RunParams(pdf=upload, source_name=pdf.filename, model=model, url=VLLM_URL, cut=cut,
                                  crop_dpi=crop_dpi, layout_model=layout_model, max_image_size=max_image_size,
                                  max_output_tokens=max_output_tokens, stream=stream, pages=pages,
                                  debug_dir=None, page_source=page_source))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        run_id = runs.new_id(model)
        directory = runs.RUNS / run_id
        directory.mkdir(parents=True)
        source = directory / "input.pdf"
        upload.rename(source)
    finally:
        upload.unlink(missing_ok=True)  # still there only when the run was refused, or failed before its rename
    record_json = {
        "id": run_id, "created": runs.now(), "source_name": pdf.filename, "page_count": count,
        "source_sha256": sha256_file(source),
        # The requested model's record, not a resolution: the worker resolves this row, and its execution may
        # name another transcriber entirely (a PDF with a text layer runs natively, with no model at all).
        "transcriber": record.kind, "model": model, "repo": record.repo, "url": VLLM_URL,
        "cut": cut, "crop_dpi": crop_dpi, "layout_model": layout_model,
        "page_source": page_source, "ingest": setting,
        "max_image_size": max_image_size, "max_output_tokens": max_output_tokens,
        "stream": stream, "pages": list(pages) if pages else None, "debug": debug,
    }
    runs.write_json(directory / "params.json", record_json)  # a convenience copy; the row admission commits is
    # the run's request of record. No status.json: a new run's status lives in the store, not on disk.
    try:
        store.admit(run_id, record_json, slot=SLOT, limit=ADMISSION_LIMIT)
    except store.Full as error:  # refused before anything was written: safe to clean up
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(429, str(error)) from error
    except store.Duplicate as error:  # two submissions minted one id: astronomically unlikely, never silent.
        shutil.rmtree(directory, ignore_errors=True)  # refused before anything was written: safe to clean up
        raise HTTPException(409, str(error)) from error
    except store.NotMigrated as error:  # the table admit() queried does not exist: nothing could have committed
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(503, f"the run store's schema is not applied ({error}); "
                                 f"run `kei-jobs schema --apply`") from error
    except store.Unavailable as error:
        # UNLIKE Full/Duplicate/NotMigrated: PostgreSQL can commit the admission and then lose the connection
        # before this process reads the acknowledgement, so admit() surfaces that the same way it surfaces a
        # submission that never reached the database at all — Unavailable does not tell the two apart. Deleting
        # the directory here on the strength of a guess would, on the "it actually committed" branch of that
        # guess, strand a queued job whose input.pdf no longer exists. A stranded directory is recoverable by an
        # operator; a queued job missing its source is not. Leave it in place and let the run resurface on its
        # own once the database answers again, exactly like a submission that never committed at all.
        raise HTTPException(503, f"the run store is unreachable: {error}") from error
    return {"id": run_id, "status": "queued", "params": record_json, "page_count": count}


def run_dir(run_id: str) -> Path:
    directory = runs.directory_of(run_id)
    if directory is None:
        raise HTTPException(404, "no such run")
    return directory


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    directory = run_dir(run_id)
    try:
        row = store.record(run_id)
    except store.Unavailable as error:
        if not runs.is_legacy(directory):
            raise HTTPException(503, "the run store is unavailable", headers={"Retry-After": "1"}) from error
        row = None
    found = runs.summary_of(row) if row else runs.summary(directory)
    if found is None:
        raise HTTPException(404, "no such run")
    return {**found, "params": runs.read_json(directory / "params.json")}


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


def _extraction_status(row: store.ExtractionRow) -> dict:
    # The row keeps a failed attempt's stamp while its retry is queued or running: the job's status decides.
    status = runs.STATUS_OF.get(row.job_status or "", "unknown")
    ended = status in ("done", "failed", "cancelled")
    return {"id": row.id, "status": status, "created": row.created.isoformat(),
            "finished": row.finished.isoformat() if ended and row.finished else None,
            "error": row.error if status == "failed" else None}


@app.post("/api/runs/{run_id}/extract", status_code=202)
def create_extraction(run_id: str, request: ExtractRequest) -> dict:
    """Admit one extraction over the run's complete canonical result: the schema is the caller's, the
    generation the run's, and the pair reruns extraction alone, never OCR.

    The generation read here is pinned on the row and reported in the 202, so the job runs over exactly the
    parse this answer named: a result rewritten in between (a re-queued conversion) fails the extraction and
    asks for a resubmission rather than grounding its evidence in a generation the client never saw.
    """
    directory = run_dir(run_id)
    try:
        manifest = read_manifest(directory / "result")
    except ResultError as error:
        raise HTTPException(409, f"the run has no complete result to extract from: {error}") from error
    if manifest.status != "success":
        raise HTTPException(409, f"the run's result is incomplete: {manifest.incomplete}")
    extraction_id = f"x-{secrets.token_hex(6)}"
    try:
        store.admit_extraction(extraction_id, run_id, request.model_dump(by_alias=True),
                               generation=manifest.generation, limit=ADMISSION_LIMIT)
    except LookupError as error:
        raise HTTPException(404, "the run is not in the store: a historical file-only run cannot be "
                                 "extracted") from error
    except store.Full as error:
        raise HTTPException(429, str(error)) from error
    except store.Duplicate as error:
        raise HTTPException(409, str(error)) from error
    except store.NotMigrated as error:
        raise HTTPException(503, f"the run store's schema is not applied ({error}); run "
                                 "`kei-jobs schema --apply`") from error
    except store.Unavailable as error:
        raise HTTPException(503, f"the run store is unreachable: {error}") from error
    return {"id": extraction_id, "run_id": run_id, "status": "queued", "generation": manifest.generation}


@app.get("/api/runs/{run_id}/extractions/{extraction_id}")
def get_extraction(run_id: str, extraction_id: str) -> dict:
    """What a client polls: the job's status, and the artifact once it is done."""
    directory = run_dir(run_id)
    try:
        row = store.extraction(extraction_id)
    except store.Unavailable as error:
        raise HTTPException(503, "the run store is unavailable", headers={"Retry-After": "1"}) from error
    if row is None or row.run_id != run_id:
        raise HTTPException(404, "no such extraction")
    status = _extraction_status(row)
    artifact = directory / "extractions" / extraction_id / "result.json"
    result = None
    if status["status"] == "done" and artifact.is_file():
        result = json.loads(artifact.read_text(encoding="utf-8"))
    return {**status, "run_id": run_id, "result": result}
