"""kei `extract`: one step over a complete parse, retried like convert_run (spec, *kei worker*): the manifest must be
complete, the parse still the admitted generation, the models and recipe known; then the extraction and its
artifact, published by rename to extractions/<extraction id>/result.json (rewritten whole by a re-execution).
Cancellation is checked before any model call and then between records on every path: a recipe's Catalog before
each entry (its entries in KEI_CATALOG_CHUNKS chunks), the version 1 Catalog before each discovery call and before each
record's extraction and verification, Article before inventory, each record and each grounding batch, and the
unified Catalog before each of its calls. A model call that is already running finishes first. The unified Catalog
publishes its execution, discovery and finished entries' records write-once beside the result and reuses them when
this step runs again, so a retry after a transient failure resumes at the first unfinished entry; budgets it can no
longer honor are refused as `budget_refused`."""
from __future__ import annotations

import os
from collections.abc import Mapping

from dbos import DBOS, WorkflowSerializationFormat
from pydantic import ValidationError

from kei_exp import runs
from kei_exp.canonical import sha256_file
from kei_exp.failures import STEP_RETRY, KeiFailure
from kei_exp.kie.extract.models import chats_for
from kei_exp.kie.extract.run import ExtractRequest, StaleGeneration, extract, publish_extraction
from kei_exp.kie.extract.unified import BudgetRefused, RecordConflict
from kei_exp.pagefile import ResultError, read_manifest
from kei_exp.workflows import config
from kei_exp.workflows.cancel import CancelCheck
from kei_exp.workflows.contracts import ExtractInput, ExtractOk, extraction_id_of, failure, settled

# Each chunk is a thread with one model request in flight. Compose sets the count to NuExtract's --max-num-seqs
# (default 4); a value past this bound is a typo, and would open that many threads and connections per Catalog.
MAX_CATALOG_CHUNKS = 64


def catalog_chunks(environ: Mapping[str, str]) -> int:
    value = environ.get("KEI_CATALOG_CHUNKS", "1")
    try:
        chunks = int(value)
    except ValueError:
        chunks = 0
    if not 1 <= chunks <= MAX_CATALOG_CHUNKS:
        raise ValueError(f"KEI_CATALOG_CHUNKS must be an integer from 1 to {MAX_CATALOG_CHUNKS}, not {value!r}")
    return chunks


CATALOG_CHUNKS = catalog_chunks(os.environ)


@DBOS.step(name="extract_run", **STEP_RETRY)
def extract_run(workflow_id: str, run_id: str, generation: str, body: dict) -> dict:
    extraction_id = extraction_id_of(workflow_id)
    directory = runs.directory_of(run_id)
    if directory is None:
        raise KeiFailure("no_result", f"no run {run_id}")
    try:
        manifest = read_manifest(directory / "result")
    except ResultError as error:
        raise KeiFailure("no_result", f"the run has no complete result to extract from: {error}") from error
    if manifest.status != "success":
        raise KeiFailure("no_result", f"the run's result is incomplete: {manifest.incomplete}")
    try:
        request = ExtractRequest.model_validate(body)
    except ValidationError as error:
        raise KeiFailure("invalid_request", str(error)) from error
    # Built on the step's thread, so it keeps the workflow ID for the Catalog's chunk threads, which carry no DBOS
    # context; its throttle is locked, so several chunks may ask at once.
    check = CancelCheck(workflow_id)
    check(force=True)
    try:
        result = extract(directory, request, chats_for(request.options), generation=generation,
                         chunks=CATALOG_CHUNKS, before_entry=check, extraction_id=extraction_id)
    except StaleGeneration as error:
        raise KeiFailure("stale_generation", str(error)) from error
    except BudgetRefused as error:
        raise KeiFailure("budget_refused", str(error)) from error
    except RecordConflict as error:
        raise KeiFailure("extraction_failed", str(error)) from error
    # Observe cancellation during the final model call before publishing or refreshing the run's GC age.
    check(force=True)
    path = publish_extraction(directory, extraction_id, result)
    return ExtractOk(ok=True, run_id=run_id, extraction_id=extraction_id, generation=result["generation"],
                     artifact_sha256=sha256_file(path), model=result["model"], models=result["models"]).model_dump()


@DBOS.workflow(name="extract", max_recovery_attempts=config.MAX_RECOVERY_ATTEMPTS,
               serialization_type=WorkflowSerializationFormat.PORTABLE)
def extract_workflow(request: dict) -> dict:
    try:
        parsed = ExtractInput.model_validate(request)
    except ValidationError as error:
        return failure("invalid_request", str(error), retryable=False)
    workflow_id = DBOS.workflow_id
    return settled(lambda: extract_run(workflow_id, parsed.run_id, parsed.generation, parsed.request),
                   default="extraction_failed")
