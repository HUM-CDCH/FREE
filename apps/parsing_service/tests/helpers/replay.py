"""A recorded API run replayed as the converter's inputs to the writer.

The recorded run (tests/recorded) holds the run's parameters, its debug report (one entry per transcriber input:
the region it came from, the image size, the engine's output, the Markdown and text, tokens and reasons) and its
recipe. Replaying rebuilds the crops from the recorded regions (a blank image of the recorded size, the transform
from the fixture's page source, exactly as the cut would have recorded it), the records from the recorded outputs,
and the inventory from the recorded input order. No layout model and no model server run. Everything used here
exists at `e5ad72f`, where the golden outputs come from, and after it.
"""
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from kei_exp.kie.ingest_model import IngestConfig
from kei_exp.kie.stages import ingest
from kei_exp.pages import BookPages, PdfPages
from kei_exp.regions import Region
from kei_exp.result import Input, Inventory, Source
from kei_exp.transcription.types import Execution, PageRecord, Transcription

HEADER = ("prompt", "scale", "max_size", "max_output_tokens", "generation_params", "errors", "docling_status")
PAYLOAD = ("blocks", "image_bbox", "prediction")


@dataclass(frozen=True)
class Replay:
    execution: Execution
    inventory: Inventory
    outcome: Transcription
    source: Source
    ingest_digest: str | None
    book: BookPages | None


def book_pages(pdf: Path, workdir: Path) -> BookPages:
    """Run ingest directly: replay supplies the OCR records and needs only the book-page images."""
    accepted = workdir / "kie" / "replay" / pdf.stem / "ingest"
    artifact = ingest.run(pdf, IngestConfig(), accepted)
    return BookPages(accepted, artifact.pages, artifact.envelope.digest)


def execution_of(params: dict, pdf: Path, workdir: Path) -> Execution:
    pages = tuple(params["pages"]) if params["pages"] else None
    over_ingest = params["page_source"] == "ingest"
    return Execution(pdf=pdf, transcriber=params["transcriber"], model=params["model"], repo=params["repo"],
                     url=params["url"], cut=params["cut"], layout_model=params["layout_model"],
                     crop_dpi=params["crop_dpi"], max_image_size=params["max_image_size"],
                     max_output_tokens=params["max_output_tokens"], stream=params["stream"], pages=pages,
                     debug_dir=None, result_dir=workdir / "result", page_source=params["page_source"],
                     ingest_dir=workdir / "kie" / "replay" if over_ingest else None, source_name=params["source_name"])


def records_of(report: dict) -> list[PageRecord]:
    return [PageRecord(page=entry["page"], region=entry["region"], image=None, seconds=entry["seconds"],
                       input_tokens=entry["input_tokens"], output_tokens=entry["output_tokens"], stop=entry["stop"],
                       capped=entry["capped"], payload={key: entry[key] for key in PAYLOAD if key in entry},
                       stats={}, markdown=entry["markdown"], text=entry["text"], incomplete=entry["incomplete"],
                       source_page=entry["source_page"])
            for entry in report["pages"]]


def replay(recorded: dict, pdf: Path, workdir: Path) -> Replay:
    params, report = recorded["params"], recorded["report"]
    # An API run reads its private copy `input.pdf`, and the ingest digest covers the file's name (spec 3.7,
    # `ingest_model.Source.pdf_name`): the replay ingests the fixture under that name, so the digest is the
    # recorded one.
    pdf = Path(shutil.copyfile(pdf, workdir / "input.pdf"))
    execution = execution_of(params, pdf, workdir)
    source = Source.of(execution)
    assert source.sha256 == params["source_sha256"], "the fixture is not the PDF this run was recorded over"
    records = records_of(report)
    header = {key: report[key] for key in HEADER if key in report}
    outcome = Transcription(header, records, None)
    book = book_pages(pdf, workdir) if params["page_source"] == "ingest" else None
    if book is not None:
        assert book.digest == recorded["recipe"]["ingest_digest"], "the ingest of the fixture is not the recorded one"
    if execution.cut == "none" and book is None:  # whole PDF pages: the transcriber's inputs are the selected pages
        first = execution.pages[0] if execution.pages else 1
        numbers = list(range(first, first + len(records)))
        inventory = Inventory(numbers, [Input(n, page, 0, None) for n, page in enumerate(numbers, 1)], None)
        return Replay(execution, inventory, outcome, source, None, None)
    inputs: list[Input] = []
    with PdfPages(pdf) as pdf_pages:
        for record in records:
            region = record.region
            assert region is not None
            unit = region["source_page"]  # the cut's page number: a book page index over the ingest, else the PDF page
            page = book.page(unit) if book is not None else pdf_pages.page(unit)
            bbox = tuple(region["bbox"])
            rendered = Region(region["kind"], bbox, region["order"], region["ink"],
                              page.crop_transform(execution.crop_dpi, bbox))
            image = Image.new("L", tuple(report["pages"][record.page - 1]["image_pixels"]))
            spread = book.page(unit).ingest.spread if book is not None else unit
            inputs.append(Input(record.page, spread, unit if book is not None else 0, (unit, rendered, image)))
    pages = sorted({item.page for item in inputs})
    return Replay(execution, Inventory(pages, inputs, book), outcome, source,
                  book.digest if book is not None else None, book)
