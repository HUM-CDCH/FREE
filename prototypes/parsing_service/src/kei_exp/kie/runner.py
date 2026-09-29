"""Run the OCR stage over a PDF's own pages or over the book pages its cached ingest cut from scanned spreads.

Each document's ingest lives in `<ingest_dir>/<doc>/ingest/`; its publication uses `ingest.staging/` and
`ingest.old/` for recovery (`kie.ingest_cache`). One writer per document directory. The worker and the Markdown CLI
enter here.
"""

from pathlib import Path
from typing import Final

from kei_exp.kie import ingest_cache
from kei_exp.kie.ingest_model import IngestConfig
from kei_exp.kie.stages import ocr
from kei_exp.pages import BookPages
from kei_exp.progress import Emit, print_event
from kei_exp.transcription.types import ConversionError, Execution

RUNS_ROOT: Final = Path("runs/kie")


def convert(execution: Execution, emit: Emit = print_event) -> str:
    """Run the same stages for the Markdown CLI and the worker, using PDF pages or cached book pages."""
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
