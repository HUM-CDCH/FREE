"""The portable JSON kei's workflows take and return (spec, *Studio → kei handoff*, Contract).

Studio's DBOS client enqueues `convert`, `extract` and `deleteRuns` by name with portable serialization, one JSON
object each; each returns `{"ok": true, ...}` or `{"ok": false, "code", "reason", "retryable"}`. No PDF, page or
artifact bytes enter workflow history. tests/fixtures/contracts/ holds the examples both sides check.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Literal

from dbos import error as dbos_error
from pydantic import BaseModel, ConfigDict, Field

from kei_exp.failures import CODES, REASON_CHARS, KeiFailure, failure_of
from kei_exp.runs import COMPONENT  # a file-layout rule; the DBOS-free API reads it from runs too

CONVERT_PREFIX, EXTRACT_PREFIX, GC_PREFIX = "kei-convert:", "kei-extract:", "kei-gc:"
FailureCode = Literal[*CODES]  # the one list is failures.CODES
RunId = Annotated[str, Field(pattern=COMPONENT.pattern)]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConvertInput(_Contract):
    source: str = Field(min_length=1)  # the staged PDF, relative to KEI_SOURCE_INBOX, which kei reads only
    source_sha256: Sha256
    source_name: str = Field(min_length=1, max_length=512)
    page_source: Literal["pdf", "ingest"] = "pdf"
    ingest: dict | None = None         # spread settings; page_source ingest only
    model: str | None = None           # the Ingestion Model Choice's ocr role: a kei_exp.models.MODELS key
    layout_model: str | None = None    # its layout role: a kei_exp.cut.LAYOUT_MODELS key
    cut: Literal["auto", "none"] = "auto"
    debug: bool = False


class ConvertOk(_Contract):
    ok: Literal[True]
    run_id: RunId
    generation: str
    page_count: int
    source_sha256: Sha256
    page_source: Literal["pdf", "ingest"]


class ExtractInput(_Contract):
    run_id: RunId
    generation: str = Field(min_length=1)  # the parse the extraction was admitted against
    request: dict                          # {schema, options}; validated as kie.extract.run.ExtractRequest


class ExtractOk(_Contract):
    ok: Literal[True]
    run_id: RunId
    extraction_id: RunId
    generation: str
    artifact_sha256: Sha256
    model: str                   # the fields model: the model that read the values
    models: dict[str, str]       # per role


class DeleteRunsInput(_Contract):
    runs: list[RunId] = Field(default_factory=list)   # a pattern per item: "../x" is a ValidationError
    history: list[str] = Field(default_factory=list)  # kei workflow ids whose history may go


class DeleteRunsOk(_Contract):
    ok: Literal[True]
    deleted_runs: list[str]
    kept_runs: list[str]
    deleted_history: list[str]
    kept_history: list[str]


class Failure(_Contract):
    ok: Literal[False]
    code: FailureCode
    reason: str
    retryable: bool


def failure(code: str, reason: str, *, retryable: bool) -> dict:
    return Failure(ok=False, code=code, reason=reason[:REASON_CHARS], retryable=retryable).model_dump()


def settled(steps: Callable[[], dict], *, default: str) -> dict:
    """What `steps` returned, or the portable failure of what they finally raised. Called from workflow code, so it
    must stay deterministic: the step errors it maps are replayed from their checkpoints. DBOS's own errors
    (and cancellation, a BaseException) propagate.

    A step that used up its retries raises DBOSMaxStepRetriesExceeded, not its own error: only transient failures
    are retried (failures.should_retry), so the code comes from the last error it recorded (model_unavailable for a
    backend that never became ready) and the failure is retryable."""
    try:
        return steps()
    except dbos_error.DBOSMaxStepRetriesExceeded as exhausted:
        code, reason = failure_of(exhausted.errors[-1] if exhausted.errors else exhausted, default)
        return failure(code, reason, retryable=True)
    except dbos_error.DBOSException:
        raise
    except Exception as error:  # noqa: BLE001 - every step failure becomes the typed outcome Studio records
        code, reason = failure_of(error, default)
        return failure(code, reason, retryable=False)


def extraction_id_of(workflow_id: str) -> str:
    extraction_id = workflow_id.removeprefix(EXTRACT_PREFIX)
    if extraction_id == workflow_id or not COMPONENT.fullmatch(extraction_id):
        raise KeiFailure("invalid_request", f"{workflow_id!r} is not {EXTRACT_PREFIX}<extraction id>")
    return extraction_id
