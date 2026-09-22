"""The debug report: one schema for every transcriber, written from the run's outcome before it is judged."""
import json
from collections.abc import Iterable
from importlib.metadata import version
from pathlib import Path

from kei_exp.files import publish
from kei_exp.progress import Emit
from kei_exp.transcription.types import Execution, Transcription


def _total(values: Iterable[int | None]) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None


def write_report(outcome: Transcription, execution: Execution, started: str, seconds: float, directory: Path,
                 emit: Emit) -> None:
    """report.json and page-N.png for one run. Images are saved exactly as the adapter handed them."""
    directory.mkdir(parents=True, exist_ok=True)
    entries = []
    for page in outcome.pages:
        pixels = None
        if page.image is not None:
            page.image.save(directory / f"page-{page.page}.png")
            pixels = list(page.image.size)
        if page.stats:
            emit({"type": "page_stats", "page": page.page, "image": pixels, **page.stats})
        entries.append({
            "page": page.page, "region": page.region, "image_pixels": pixels, "seconds": page.seconds,
            "input_tokens": page.input_tokens, "output_tokens": page.output_tokens, "stop": page.stop,
            "capped": page.capped, "incomplete": page.incomplete, "source_page": page.source_page,
            "markdown": page.markdown, "text": page.text, **page.payload,
        })
    report = {
        "transcriber": execution.transcriber, "model": execution.model, "repo": execution.repo, "url": execution.url,
        "source": execution.pdf.name, "pages_requested": list(execution.pages) if execution.pages else None,
        "cut": execution.cut, "crop_dpi": execution.crop_dpi, "layout_model": execution.layout_model,
        "page_source": execution.page_source, "stream": execution.stream,
        "started": started, "seconds": round(seconds, 3),
        "status": "incomplete" if outcome.incomplete else "success", "incomplete": outcome.incomplete,
        **outcome.header,
        "tokens": {"input": _total(page.input_tokens for page in outcome.pages),
                   "output": _total(page.output_tokens for page in outcome.pages)},
        "versions": {"docling": version("docling"), "surya-ocr": version("surya-ocr")},
        "pages": entries,
    }
    with publish(directory / "report.json") as part:  # renamed into place: the API reads it while a run ends
        part.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    emit({"type": "log", "text": f"Debug files: {directory.resolve()}"})
