"""Run ingest and OCR, then assemble their evidence and publish the run report.

Each document has `ingest/`, `ocr/` and `report.json` under its run directory. Ingest publication uses
`ingest.staging/` and `ingest.old/` for recovery. One writer per document run directory; concurrent runs
must use different run ids. The Markdown CLI and API also enter here and share the same OCR stage.
"""

import os
import shutil
import time
import warnings
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from pydantic import ValidationError

from kei_exp.canonical import canonical_json, sha256_file
from kei_exp.files import publish
from kei_exp.kie.artifacts import CacheMiss, fingerprint, load_ingest
from kei_exp.kie.evidence import EvidenceError, load_evidence
from kei_exp.kie.model import (
    Document,
    EvidenceReport,
    IngestArtifact,
    IngestConfig,
    IngestError,
    IngestStep,
    PipelineConfig,
    RunReport,
    Segment,
)
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


@dataclass(frozen=True)
class IngestPaths:
    """The three directories the ingest can have inside a document's run directory, and its artifact (spec 5)."""

    doc_dir: Path

    @property
    def accepted(self) -> Path:
        return self.doc_dir / "ingest"

    @property
    def staging(self) -> Path:
        return self.doc_dir / "ingest.staging"

    @property
    def previous(self) -> Path:
        return self.doc_dir / "ingest.old"

    def artifact(self, generation: Path) -> Path:
        """The artifact file inside one generation, accepted, staged or superseded."""
        return generation / "ingest.json"


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
    step, artifact = ingest_step(pdf, cfg.ingest, doc_dir, on_spread)
    evidence: EvidenceReport | None = None
    if cfg.ocr is not None:
        ocr_started = time.perf_counter()
        result_dir = doc_dir / "ocr"
        try:
            execution = ocr.resolve(RunParams(pdf=pdf, model="surya", page_source="ingest",
                                             result_dir=result_dir, **cfg.ocr.model_dump(exclude_none=True)))
            book = BookPages(IngestPaths(doc_dir).accepted, artifact.pages, artifact.envelope.digest)
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
            step, artifact = ingest_step(execution.pdf, IngestConfig.model_validate(execution.ingest or {}), doc_dir,
                                        lambda spread, spreads: emit(
                                            {"type": "log", "text": f"Ingest: reading spread {spread}/{spreads}"}))
        except (RunError, OSError) as error:
            raise ConversionError(f"Ingest failed: {error}") from error
        did = "skipped, cached" if step.skipped else "ran"
        emit({"type": "log", "text": f"Ingest {did} in {step.seconds:.1f} s: {len(artifact.pages)} book pages from "
                                     f"{artifact.source.spreads} spreads under {doc_dir / 'ingest'}"})
        book = BookPages(IngestPaths(doc_dir).accepted, artifact.pages, artifact.envelope.digest)
    return ocr.run(execution, emit, book=book)


def ingest_step(pdf: Path, cfg: IngestConfig, doc_dir: Path,
                on_spread: ingest.OnSpread | None = None) -> tuple[IngestStep, IngestArtifact]:
    """Ingest `pdf` into its run directory, or prove the accepted artifact and skip the work (spec 5)."""
    started = time.perf_counter()
    paths = IngestPaths(doc_dir)
    try:
        _recover(paths)
        skippable = _skippable(paths, cfg, pdf)
        artifact = skippable if skippable is not None else _produce(paths, pdf, cfg, on_spread)
    except (CacheMiss, IngestError, OSError) as error:
        raise RunError(f"stage 'ingest' on {pdf.name} failed: {error}") from error
    # On a skip the stage's own report is the one stored when it last ran, and `seconds` is this invocation's.
    return IngestStep(skipped=skippable is not None, seconds=time.perf_counter() - started, report=artifact.report), artifact


def _recover(paths: IngestPaths) -> None:
    """Undo an interrupted publication, before anything is decided about the cache (spec 5).

    `ingest.old` exists only between the two renames of a publication, so finding one means an earlier run
    died between them. Which generation survives is not decided by which name it carries: the accepted
    directory is verified first and wins if it is whole, and only then is the superseded one removed, so the
    only proven generation is never discarded to tidy up. Staging is never a generation, whatever it holds:
    an interrupted stage leaves a partial directory behind, and publishing it would accept an artifact whose
    pages were never all written.
    """
    if paths.staging.exists():
        shutil.rmtree(paths.staging)
    if not paths.previous.exists():
        return
    if _proven(paths, paths.accepted) is not None:
        shutil.rmtree(paths.previous)
        return
    if _proven(paths, paths.previous) is None:
        # Neither generation can be proven, so nothing is lost by clearing the way for the run that follows.
        shutil.rmtree(paths.previous)
        return
    if paths.accepted.exists():
        shutil.rmtree(paths.accepted)
    paths.previous.rename(paths.accepted)


def _proven(paths: IngestPaths, generation: Path) -> IngestArtifact | None:
    """The artifact of one generation, or None when it cannot be proven and so is no generation at all."""
    try:
        return load_ingest(paths.artifact(generation))
    except CacheMiss:
        return None


def _skippable(paths: IngestPaths, cfg: IngestConfig, pdf: Path) -> IngestArtifact | None:
    """The accepted artifact when the whole skip rule holds for it, else None and the stage runs (spec 5).

    Every part is checked rather than trusted: `load_ingest` proves the artifact and its page images are what
    the envelope vouches for, and the comparison here proves they were produced from this recipe — this
    stage, at this version, from this configuration and these bytes.
    """
    artifact = _proven(paths, paths.accepted)
    if artifact is None:
        return None
    pdf_sha256 = sha256_file(pdf)
    recipe = fingerprint(ingest.STAGE_VERSION, cfg, pdf_sha256)
    envelope = artifact.envelope
    stamped = (envelope.stage, envelope.stage_version, envelope.fingerprint, envelope.upstream)
    # Ingest reads no upstream stage, so the upstream digests it must agree with are the empty set (spec 3.8).
    if stamped != ("ingest", ingest.STAGE_VERSION, recipe, {}):
        return None
    # The fingerprint is a claim about the recipe, and it sits in the envelope, which the digest excludes: a
    # hand-edited one would otherwise let a stale artifact skip. The config and the source hash say the same
    # thing from inside the digest, which `load_ingest` has just proven, so they are what is compared.
    if canonical_json(artifact.config) != canonical_json(cfg) or artifact.source.sha256 != pdf_sha256:
        return None
    return artifact


def _produce(paths: IngestPaths, pdf: Path, cfg: IngestConfig,
             on_spread: ingest.OnSpread | None) -> IngestArtifact:
    """Run the stage into staging, prove what it wrote there, and publish it as the accepted generation.

    The stage's returned artifact is not evidence about the files, so it is compared with the artifact loaded
    back from staging: a stage that returned more, less or other than it wrote is caught here, while the
    accepted generation is still untouched. The comparison is of the persisted form, because that is what
    "the one it wrote" means: a setting that is inactive in the chosen mode is dropped on the way out and
    comes back as its default on the way in (spec 5), so the two models differ where the two files do not.
    """
    returned = ingest.run(pdf, cfg, paths.staging, on_spread=on_spread)
    try:
        staged = load_ingest(paths.artifact(paths.staging))
    except CacheMiss as error:
        raise RunError(f"stage 'ingest' wrote an artifact for {pdf.name} that does not verify: {error}") from error
    if canonical_json(staged) != canonical_json(returned):
        raise RunError(
            f"stage 'ingest' returned an artifact for {pdf.name} that is not the one it wrote to {paths.staging}"
        )
    _publish(paths, pdf)
    return staged


def _publish(paths: IngestPaths, pdf: Path) -> None:
    """Swap the staged generation in: two renames, with the previous one put back if the second fails (spec 5).

    A reader already traversing the directory during the swap is not covered by this and is not part of the
    guarantee; a process that dies between the two renames is, because `_recover` reads the same two names on
    the next run.
    """
    superseded = paths.accepted.exists()
    if superseded:
        paths.accepted.rename(paths.previous)
    try:
        paths.staging.rename(paths.accepted)
    except OSError:
        if superseded:
            paths.previous.rename(paths.accepted)
        raise
    if superseded:
        _discard(paths, pdf)


def _discard(paths: IngestPaths, pdf: Path) -> None:
    """Remove the superseded generation, which is cleanup after the fact and not part of publication.

    The new generation is already the accepted one, so a failure here is reported and left to the next run's
    recovery, rather than undoing a publication that succeeded.
    """
    try:
        shutil.rmtree(paths.previous)
    except OSError as error:
        warnings.warn(
            f"the superseded ingest generation of {pdf.name} at {paths.previous} could not be "
            f"removed ({error}); the new one is published and the next run removes what is left",
            RuntimeWarning,
            stacklevel=2,
        )


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
