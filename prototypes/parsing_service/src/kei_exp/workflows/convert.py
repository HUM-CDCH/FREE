"""kei `convert`: a staged PDF into a run's canonical result (spec, *kei worker*).

Three checkpointed steps: resolve_models (the admitted Ingestion Model Choice or kei's default, once, so a recovered
attempt keeps it), prepare_run (the run directory, the verified source, params.json, the page limit) and convert_run
(resolve native vs OCR, adopt another run's result of the same recipe or probe the OCR server and convert). The
result is published by rename inside the conversion; a re-executed convert_run publishes a new generation over it,
and its output names the one it published. No worker output.md: the manifest and page files are the product; the
standalone CLI keeps its Markdown.
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
from pathlib import Path

from dbos import DBOS, WorkflowSerializationFormat
from pydantic import ValidationError

from kei_exp import reuse, runs, runtime
from kei_exp.failures import STEP_RETRY, KeiFailure, TransientBackendError
from kei_exp.kie import runner
from kei_exp.kie.ingest_model import IngestConfig
from kei_exp.kie.stages.ocr import check_ingest, check_knobs
from kei_exp.models import DEFAULT_OCR_MODEL, MODELS
from kei_exp.pagefile import read_manifest
from kei_exp.pages import PdfPages
from kei_exp.progress import Event
from kei_exp.regions import DEFAULT_LAYOUT_MODEL, LAYOUT_MODELS
from kei_exp.transcription.types import DEFAULT_URL, ConversionError, RunParams
from kei_exp.workflows import config
from kei_exp.workflows.cancel import CancelCheck
from kei_exp.workflows.contracts import ConvertInput, ConvertOk, failure, settled

logger = logging.getLogger(__name__)
VLLM_URL = os.environ.get("KEI_VLLM_URL", DEFAULT_URL)
MAX_PAGES = int(os.environ.get("KEI_MAX_PAGES", "2000"))
MAX_SOURCE_BYTES = int(os.environ.get("KEI_MAX_UPLOAD_BYTES", str(200 * 1024 * 1024)))


@DBOS.step(name="resolve_models")
def resolve_models(model: str | None, layout_model: str | None) -> dict:
    """The models this parse runs on: the admitted choice per role, or kei's default, which is the listing's
    (GET /api/ingestion-models). Whether the OCR server serves the model is decided when the conversion runs."""
    ocr, layout = model or DEFAULT_OCR_MODEL, layout_model or DEFAULT_LAYOUT_MODEL
    if ocr not in MODELS:
        raise KeiFailure("invalid_request", f"unknown model {ocr!r}")
    if layout not in LAYOUT_MODELS:
        raise KeiFailure("invalid_request", f"unknown layout model {layout!r}")
    return {"model": ocr, "layout_model": layout}


@DBOS.step(name="prepare_run")
def prepare_run(workflow_id: str, request: dict, models: dict) -> dict:
    """The run directory with its verified source and params.json; returns the params, which replay reuses."""
    run_id = runs.run_id_for(workflow_id)
    source = _staged(request["source"])
    directory, staging = runs.RUNS / run_id, runs.RUNS / f".prepare-{run_id}"
    for leftover in (staging, directory):  # an earlier execution of this same step, stopped before its checkpoint
        if leftover.exists():
            shutil.rmtree(leftover)
    staging.mkdir(parents=True)
    try:
        target = staging / "input.pdf"
        digest = _copy(source, target)
        if digest != request["source_sha256"]:
            raise KeiFailure("source_mismatch", f"the staged PDF hashes to {digest}, not {request['source_sha256']}")
        try:
            with PdfPages(target) as pages:
                count = pages.count
        except Exception as error:  # pdfium raises its own error types
            raise KeiFailure("source_unreadable", f"not a readable PDF: {error}") from error
        if count > MAX_PAGES:
            raise KeiFailure("too_many_pages", f"the PDF has {count} pages, more than this service's limit of {MAX_PAGES}")
        try:
            check_ingest(request["page_source"], request["ingest"])
            check_knobs(RunParams(pdf=target, model=models["model"], url=VLLM_URL, cut=request["cut"],
                                  layout_model=models["layout_model"], stream=False,
                                  page_source=request["page_source"]))
        except ValueError as error:
            raise KeiFailure("invalid_request", str(error)) from error
        record = MODELS[models["model"]]
        params = {"id": run_id, "workflow_id": workflow_id, "created": runs.now(),
                  "source_name": request["source_name"], "page_count": count, "source_sha256": digest,
                  "transcriber": record.kind, "model": models["model"], "repo": record.repo, "url": VLLM_URL,
                  "cut": request["cut"], "crop_dpi": 250, "layout_model": models["layout_model"],
                  "page_source": request["page_source"], "ingest": request["ingest"], "max_image_size": None,
                  "max_output_tokens": None, "stream": False, "pages": None, "debug": request["debug"]}
        runs.write_json(staging / "params.json", params)
        staging.rename(directory)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return params


def _staged(relative: str) -> Path:
    """The staged PDF `relative` names, refused unless it stays inside the inbox and is a regular file."""
    root = runs.INBOX.resolve()
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise KeiFailure("invalid_request", f"{relative!r} is not a path inside the source inbox")
    path = (root / candidate).resolve()
    if not path.is_relative_to(root):
        raise KeiFailure("invalid_request", f"{relative!r} leads outside the source inbox")
    if not path.is_file():
        raise KeiFailure("source_missing", f"no staged PDF at {relative!r}")
    return path


def _copy(source: Path, target: Path) -> str:
    digest, written = hashlib.sha256(), 0
    with source.open("rb") as reader, target.open("wb") as writer:
        while chunk := reader.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_SOURCE_BYTES:
                raise KeiFailure("invalid_request", f"the staged PDF is larger than {MAX_SOURCE_BYTES} bytes")
            digest.update(chunk)
            writer.write(chunk)
    return digest.hexdigest()


def serving(execution) -> None:
    """Refuse a served execution whose model server is not there (transient) or holds another model (not)."""
    if execution.model is None:
        return
    reachable, repo = runtime.loaded_model(execution.url)
    if not reachable:
        raise TransientBackendError(f"the model server at {execution.url} is unreachable")
    if repo != execution.repo:
        raise ConversionError(f"the model server has {repo!r} loaded, not the {execution.repo!r} this run needs")


def _log(event: Event) -> None:
    if event["type"] == "phase":
        logger.info("phase %s (%s)", event["name"], event.get("total"))
    elif event["type"] == "spread":
        logger.info("ingest: reading spread %s/%s", event["spread"], event["total"])
    elif event["type"] == "log":
        logger.info("%s", event["text"])


@DBOS.step(name="convert_run", **STEP_RETRY)
def convert_run(workflow_id: str, params: dict) -> dict:
    check = CancelCheck(workflow_id)
    check(force=True)  # before anything reads the PDF
    directory = runs.RUNS / params["id"]
    execution = runs.execution_for(directory, params)

    def before_ocr() -> None:  # an adopted result needs no model server
        serving(execution)
        check(force=True)  # resolution read the text layer; the conversion is the model work
    reusing = {} if execution.debug_dir is not None else {  # a debug report describes work done: it reuses none
        "seed": lambda doc_dir: reuse.seed_ingest(doc_dir, params["source_sha256"],
                                                  IngestConfig.model_validate(execution.ingest or {}), own=directory),
        "adopt": lambda fingerprint: reuse.adopt_result(
            fingerprint, directory / "result", source_sha256=params["source_sha256"],
            source_name=params["source_name"], own=directory) is not None}
    runner.convert(execution, emit=check.sink(_log), before_ocr=before_ocr, **reusing)
    manifest = read_manifest(directory / "result")
    return ConvertOk(ok=True, run_id=params["id"], generation=manifest.generation, page_count=manifest.page_count,
                     source_sha256=manifest.recipe["source_sha256"],
                     page_source=manifest.recipe["page_source"]).model_dump()


@DBOS.workflow(name="convert", max_recovery_attempts=config.MAX_RECOVERY_ATTEMPTS,
               serialization_type=WorkflowSerializationFormat.PORTABLE)
def convert_workflow(request: dict) -> dict:
    try:
        parsed = ConvertInput.model_validate(request)
    except ValidationError as error:
        return failure("invalid_request", str(error), retryable=False)
    workflow_id = DBOS.workflow_id

    def steps() -> dict:
        models = resolve_models(parsed.model, parsed.layout_model)
        params = prepare_run(workflow_id, parsed.model_dump(), models)
        return convert_run(workflow_id, params)
    return settled(steps, default="conversion_failed")
