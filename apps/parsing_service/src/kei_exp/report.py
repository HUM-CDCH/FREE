"""The debug report: one schema for every transcriber, written from the run's outcome before it is judged."""
import json
import logging
from collections.abc import Iterable
from importlib.metadata import version
from pathlib import Path

from PIL import Image

from kei_exp.files import publish
from kei_exp.progress import Emit
from kei_exp.regions import region_info
from kei_exp.transcription.types import Execution, PageRecord, Transcription

logger = logging.getLogger(__name__)


def _total(values: Iterable[int | None]) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None


class Debug:
    """One run's debug report, collected batch by batch (`kei_exp.kie.stages.ocr.transcribe`): each batch's images
    are saved while they are open, before the batch releases them, and report.json is written from the run's
    outcome last. Diagnostics only: the first failure is logged and reported as a `log` event, nothing more is
    written, and nothing is raised, so it never stops an accepted result."""

    def __init__(self, directory: Path, emit: Emit) -> None:
        self.directory = directory
        self.emit = emit
        self.pixels: dict[int, list[int]] = {}  # the size of each record's saved page-N.png, by input ordinal
        self.failed = False

    def save(self, records: Iterable[PageRecord] = (), crops: Iterable[tuple[int, Image.Image]] = ()) -> None:
        """page-N.png of each record that kept its image, exactly as the adapter handed it; ocr-N.png of each of
        a hybrid run's OCR crops, by its ordinal."""
        if self.failed:
            return
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            for record in records:
                if record.image is not None:
                    record.image.save(self.directory / f"page-{record.page}.png")
                    self.pixels[record.page] = list(record.image.size)
            for ordinal, image in crops:
                image.save(self.directory / f"ocr-{ordinal}.png")
        except Exception as error:  # noqa: BLE001 - diagnostics only
            self._fail(error)

    def write(self, outcome: Transcription, execution: Execution, started: str, seconds: float) -> None:
        if self.failed:
            return
        try:
            write_report(outcome, execution, started, seconds, self.directory, self.emit, self.pixels)
        except Exception as error:  # noqa: BLE001 - diagnostics only; the accepted result is already written
            self._fail(error)

    def _fail(self, error: Exception) -> None:
        self.failed = True
        logger.error("debug report not written to %s: %s", self.directory, error)
        self.emit({"type": "log", "text": f"Debug report not written: {error}"})


def write_report(outcome: Transcription, execution: Execution, started: str, seconds: float, directory: Path,
                 emit: Emit, saved: dict[int, list[int]] | None = None) -> None:
    """report.json for one run, and page-N.png of every record still holding its image, saved exactly as the
    adapter handed it. `saved`: the sizes of page images already saved and released (`Debug.save`); a hybrid
    run's ocr-N.png were saved with their batches."""
    directory.mkdir(parents=True, exist_ok=True)
    entries = []
    for page in outcome.pages:
        supplements = []
        for supplement in page.ocr:
            _, _, image_px = supplement.crop
            record = supplement.record
            supplements.append({"crop": supplement.ordinal, "region": region_info(supplement.crop),
                                "image_pixels": list(image_px), "incomplete": record.incomplete,
                                "input_tokens": record.input_tokens, "output_tokens": record.output_tokens,
                                "markdown": record.markdown, "text": record.text, **record.payload})
        image_pixels = (saved or {}).get(page.page)
        if page.image is not None:
            page.image.save(directory / f"page-{page.page}.png")
            image_pixels = list(page.image.size)
        if page.stats:
            emit({"type": "page_stats", "page": page.page, "image": image_pixels, **page.stats})
        entries.append({
            "page": page.page, "region": page.region, "image_pixels": image_pixels, "seconds": page.seconds,
            "input_tokens": page.input_tokens, "output_tokens": page.output_tokens, "stop": page.stop,
            "capped": page.capped, "incomplete": page.incomplete, "source_page": page.source_page,
            "markdown": page.markdown, "text": page.text, **page.payload,
            **({"ocr": supplements} if supplements else {}),
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
