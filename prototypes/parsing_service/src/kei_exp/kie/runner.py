"""Run ingest and OCR, then assemble their evidence and publish the run report.

Each document has `ingest/`, `ocr/` and `report.json` under its run directory. Ingest publication uses
`ingest.staging/` and `ingest.old/` for recovery. One writer per document run directory; concurrent runs
must use different run ids. The Markdown CLI and API also enter here and share the same OCR stage.
"""

import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from pydantic import ValidationError

from kei_exp.files import publish
from kei_exp.kie import ingest_cache
from kei_exp.kie.document import Document, Segment
from kei_exp.kie.evidence import EvidenceError, load_evidence
from kei_exp.kie.ingest_model import IngestArtifact, IngestConfig
from kei_exp.kie.run_model import EvidenceReport, PipelineConfig, RunReport
from kei_exp.kie.stages import ingest, ocr
from kei_exp.pagefile import ResultError
from kei_exp.pages import BookPages
from kei_exp.progress import Emit, print_event
from kei_exp.transcription.types import ConversionError, Execution, RunParams

RUNS_ROOT: Final = Path("runs/kie")
REPORT_NAME: Final = "report.json"

# UTC to the microsecond, so two runs started in the same second do not write into one directory, which the
# recovery would then read as an interrupted publication (spec 5).
_RUN_ID_FORMAT: Final = "%Y%m%dT%H%M%S.%fZ"
_SEPARATORS: Final = tuple(separator for separator in (os.sep, os.altsep, "/") if separator)


class RunError(Exception):
    """A run that cannot go on, named by the document and the step it stopped in."""


def document_dir(runs_root: Path, run_id: str, doc_id: str) -> Path:
    """The one directory a document's run writes in (spec 5)."""
    return runs_root / run_id / doc_id


def run(pdf: Path, cfg: PipelineConfig, *, run_id: str | None = None, runs_root: Path = RUNS_ROOT,
        on_spread: ingest.OnSpread | None = None, emit: Emit = print_event) -> RunReport:
    """Run ingest and OCR, keeping the accepted page files under this document's `ocr/` directory."""
    started = time.perf_counter()
    identifier = _run_id(run_id)
    doc_id = _component(pdf.stem, f"document id of {pdf.name}")
    doc_dir = document_dir(runs_root, identifier, doc_id)
    try:
        doc_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise RunError(f"the run directory {doc_dir} for {pdf.name} could not be made: {error}") from error
    try:
        step, artifact = ingest_cache.ingest_step(pdf, cfg.ingest, doc_dir, on_spread)
    except ingest_cache.IngestCacheError as error:
        raise RunError(str(error)) from error
    evidence: EvidenceReport | None = None
    if cfg.ocr is not None:
        ocr_started = time.perf_counter()
        result_dir = doc_dir / "ocr"
        try:
            execution = ocr.resolve(RunParams(pdf=pdf, model="surya", page_source="ingest",
                                             result_dir=result_dir, **cfg.ocr.model_dump(exclude_none=True)))
            book = BookPages(ingest_cache.IngestPaths(doc_dir).accepted, artifact.pages, artifact.envelope.digest)
            ocr.run(execution, emit, book=book)
            found = load_evidence(result_dir, artifact)
        except (ConversionError, ResultError, EvidenceError, ValueError, OSError) as error:
            raise RunError(f"stage 'ocr' on {pdf.name} failed: {error}") from error
        _assemble(artifact, found.segments, pdf)
        evidence = found.report.model_copy(update={"seconds": time.perf_counter() - ocr_started})
    report = RunReport(run_id=identifier, doc_id=doc_id, seconds=time.perf_counter() - started, ingest=step,
                       ocr=evidence)
    _publish_report(report, doc_dir, pdf)
    return report


def convert(execution: Execution, emit: Emit = print_event) -> str:
    """Run the same stages for the Markdown CLI and API, using PDF pages or cached book pages."""
    book = None
    if execution.page_source == "ingest":
        directory = execution.ingest_dir or RUNS_ROOT / execution.pdf.stem
        doc_dir = directory / execution.pdf.stem
        emit({"type": "phase", "name": "ingest", "total": None})
        try:
            doc_dir.mkdir(parents=True, exist_ok=True)
            step, artifact = ingest_cache.ingest_step(
                execution.pdf, IngestConfig.model_validate(execution.ingest or {}), doc_dir,
                lambda spread, spreads: emit({"type": "spread", "spread": spread, "total": spreads}))
        except (ingest_cache.IngestCacheError, OSError) as error:
            raise ConversionError(f"Ingest failed: {error}") from error
        did = "skipped, cached" if step.skipped else "ran"
        emit({"type": "log", "text": f"Ingest {did} in {step.seconds:.1f} s: {len(artifact.pages)} book pages from "
                                     f"{artifact.source.spreads} spreads under {doc_dir / 'ingest'}"})
        book = BookPages(ingest_cache.IngestPaths(doc_dir).accepted, artifact.pages, artifact.envelope.digest)
    return ocr.run(execution, emit, book=book)


def _assemble(artifact: IngestArtifact, segments: list[Segment], pdf: Path) -> Document:
    """The document as it stands: the ingest's pages, and the segments once the evidence has been read (spec 3.7).

    What this adds to the artifact's own validation is the document level: page indices unique across the
    whole document, every segment on a page the document has and inside its image.
    """
    try:
        return Document(source=artifact.source, pages=artifact.pages, segments=segments)
    except ValidationError as error:
        raise RunError(f"the artifacts of {pdf.name} do not assemble into a document: {error}") from error


def _publish_report(report: RunReport, doc_dir: Path, pdf: Path) -> None:
    """Write `<doc_dir>/report.json`: one report per document run, beside that document's ingest directory.

    Published by rename, so a reader finds either the previous report or the whole new one. It is written
    after the work, and a failure here is a failure to record what happened rather than a reason to undo
    it: the artifact stays accepted, and the error says so. Aggregating several documents is not this file's
    business, and no run writes outside its own document directory.
    """
    try:
        with publish(doc_dir / REPORT_NAME) as part:
            part.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    except OSError as error:
        raise RunError(
            f"the run report of {pdf.name} could not be written to {doc_dir / REPORT_NAME} ({error}); "
            f"its ingest artifact is published and stays accepted"
        ) from error


def validate_run_id(given: str) -> str:
    """The given run id, or `RunError` when it does not name a directory this run may make.

    Public because a caller that takes a run id from a person can refuse it before a run begins, rather than
    letting a run start and fail on it. The rule itself stays here, with the directory layout it protects.
    """
    return _component(given, "run id")


def _run_id(given: str | None) -> str:
    """The run id: the one given, or a new one naming the moment this run started (spec 5)."""
    return datetime.now(UTC).strftime(_RUN_ID_FORMAT) if given is None else validate_run_id(given)


def _component(value: str, what: str) -> str:
    """One path component, so that neither a run id nor a document id can name a directory outside the run."""
    if not value or value in (os.curdir, os.pardir) or any(separator in value for separator in _SEPARATORS):
        raise RunError(f"{what} {value!r} is not a single path component")
    return value
