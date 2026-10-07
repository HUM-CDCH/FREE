"""The transcriber contract: what a run was asked for, what will run, and what a backend gives back.

The types below and their docstrings state it. The backends beside this module
(`native`, `surya`, `vlm`) implement `Transcriber` and nothing else; which one runs is `kei_exp.kie.stages.ocr`'s
decision, and this module never imports them, so an adapter can be read without the stage that registers it.
"""
import os
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Protocol

from PIL import Image

from kei_exp.files import load_dotenv
from kei_exp.geometry import PointBox
from kei_exp.progress import Emit
from kei_exp.regions import DEFAULT_LAYOUT_MODEL, Crop

load_dotenv()
DEFAULT_URL = os.environ.get("KEI_VLLM_URL", "http://localhost:8000/v1/chat/completions")
# The version of the rules by which a transcriber turns what its engine read into canonical text, per transcriber
# kind, recorded in the recipe: a change here writes other text for the same PDF, so it must not share a fingerprint.
# native 2: a list item publishes its source text with the printed marker (Docling strips it from `text`).
# native 3: a block merged across a column break publishes every box it is printed in (`PageSegment.boxes_pt`).
# hybrid 1: native pages with textless artwork read by OCR, spliced at the artwork's place. A hybrid page also
# publishes native blocks and OCR text, so a hybrid recipe records those kinds' rules too (`kei_exp.result.recipe`).
TEXT_RULES: dict[str, int] = {"native": 3, "hybrid": 1}
# The RunParams fields each transcriber kind honours beyond pdf, model, url, cut, layout_model, crop_dpi, pages and
# debug_dir: every adapter's `knobs`, and what the API lists per model without constructing an adapter.
TRANSCRIBER_KNOBS: dict[str, frozenset[str]] = {
    "vlm": frozenset({"stream", "max_output_tokens", "max_image_size"}),
    "surya": frozenset({"stream"}),  # live tokens per page; the image and token budgets are Surya's own
    "native": frozenset(),
}


@dataclass(frozen=True)
class OcrRegion:
    """Textless embedded artwork to read, in its PDF page's top-left points."""
    page: int
    bbox: PointBox


@dataclass(frozen=True)
class RunParams:
    """Everything one conversion depends on; the CLI flags and the API form both map onto it."""
    pdf: Path
    model: str = "granite_vision"
    url: str = DEFAULT_URL
    cut: str = "auto"                        # auto | none
    layout_model: str = DEFAULT_LAYOUT_MODEL
    crop_dpi: int = 250
    max_image_size: int | None = None
    max_output_tokens: int | None = None
    stream: bool = False
    pages: tuple[int, int] | None = None     # 1-based inclusive; None = every page
    debug_dir: Path | None = None
    result_dir: Path | None = None           # where the accepted page files and manifest go; None = not written
    page_source: str = "pdf"                 # pdf | ingest: the PDF's pages, or the book pages the KIE ingest cuts from them
    ingest_dir: Path | None = None           # the ingest's run directory; None = runs/kie/<pdf stem>
    source_name: str | None = None           # the source's own name (an upload's filename); None = the path's
    ingest: dict | None = None               # IngestConfig settings for page_source ingest (split, gutter overrides);
                                             # None = the defaults. Bound into the parse through the ingest digest


@dataclass(frozen=True)
class Execution:
    """What will actually run, resolved once from RunParams: the transcriber and the settings it honours.

    A native execution has no model, repo, url, layout model or crop dpi and cuts nothing, whatever the request
    asked for; params.json and the debug report record these fields as they are.
    """
    pdf: Path
    transcriber: str                         # vlm | surya | native, a registry key; or hybrid, which the OCR stage
                                             # runs as native text plus the model's transcriber on ocr_regions
    model: str | None                        # record key; None when no model runs
    repo: str | None                         # the model's vLLM id
    url: str | None
    cut: str                                 # auto | none
    layout_model: str | None                 # the cut's layout detector; None without a cut
    crop_dpi: int | None
    max_image_size: int | None
    max_output_tokens: int | None
    stream: bool
    pages: tuple[int, int] | None            # 1-based inclusive; None = every page, always in PDF pages (spreads)
    debug_dir: Path | None
    result_dir: Path | None
    page_source: str                 # pdf | ingest; a native execution reads the PDF
    ingest_dir: Path | None
    source_name: str | None = None
    ingest: dict | None = None               # the requested IngestConfig settings; None for defaults and native runs
    ocr_regions: tuple[OcrRegion, ...] = ()   # hybrid only: native text plus these image/form crops


class ConversionError(RuntimeError):
    """A run that produced no trustworthy output; the message is what the CLI prints before exit 1."""


class IncompleteConversionError(ConversionError):
    """The recognition itself came back incomplete (a capped page, a block that errored): about this document
    at this budget, and another attempt at the same budget would fail identically. `kei_exp.failures.classify`
    matches this type, not the message text, to keep it out of the retried set; every caller that already
    catches `ConversionError` catches this too."""


@dataclass(frozen=True)
class PageRecord:
    """What one transcriber input (a crop, or a whole page) came back as.

    `page` is the input ordinal: the input's 1-based position in what the transcriber was given, a crop number
    with cuts or a position in the selected page range without. Which PDF page, unit and crop it names is the
    OCR stage's business, not the adapter's.
    """
    page: int                      # input ordinal
    region: dict | None            # region_info(crop); None for whole pages
    image: Image.Image | None      # exactly what the model received, in the mode to save; None when not kept
    seconds: float | None          # generation time when the backend reports one
    input_tokens: int | None
    output_tokens: int | None
    stop: str | None               # VLM stop reason; None for Surya
    capped: bool                   # the kept output used up its token cap
    payload: dict                  # {"prediction": ...} for VLMs; Surya's blocks and image_bbox
    stats: dict                    # extra page_stats event fields, exactly as rendered today; empty means no event
    markdown: str                  # this input's Markdown, whatever the outcome
    text: str                      # plain text: block HTML through html_to_text, a DocTags export, a VLM's Markdown as is
    incomplete: str | None         # why this input's output is not trustworthy; None when it is
    source_page: int | None        # the backend's page number for a whole page; None for a crop
    ocr: tuple["OcrRecord", ...] = ()  # hybrid supplements; each keeps its own engine space and render transform


@dataclass(frozen=True)
class OcrRecord:
    """One image-only OCR input and its unchanged backend outcome, attached to its native page."""
    ordinal: int                   # the crop: its position in Execution.ocr_regions, 1-based
    crop: Crop
    record: PageRecord
    anchor: int                    # reads before this index of the native page's blocks (len: after the last)


@dataclass(frozen=True)
class Transcription:
    """A transcriber's outcome. Adapters never write files and never decide acceptance.

    Completeness is judged from the records; `unattributed` holds only what no record can carry (a capped
    request Surya could not attribute to a page, a Docling status without a page).
    """
    header: dict                   # backend facts for the report: prompt, scale, max_size, max_output_tokens,
                                   # generation_params, errors (plus docling_status for VLMs)
    pages: list[PageRecord]
    unattributed: str | None = None

    @property
    def incomplete(self) -> str | None:
        """Why the run is incomplete, every record's reason then the run's own; None when nothing was lost."""
        reasons = [record.incomplete for record in self.pages if record.incomplete]
        if self.unattributed:
            reasons.append(self.unattributed)
        return "; ".join(reasons) or None


class Transcriber(Protocol):
    """One backend behind the OCR stage: registered under kind, honouring only its knobs."""
    kind: str                      # registry key: the value of Model.kind that selects it, or "native"
    knobs: frozenset[str]          # RunParams fields honoured: its kind's row of TRANSCRIBER_KNOBS

    def transcribe(self, execution: Execution, crops: list[Crop] | None, emit: Emit) -> Transcription: ...


class _TextOf(HTMLParser):
    """The text of block HTML: data and entities as given, a newline where a block ends, a tab where a cell does."""
    BLOCKS = frozenset({"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th"):
            self.parts.append("\t")
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def html_to_text(html: str) -> str:
    """Plain text of Surya's block HTML, never normalised: a cleaned reading is a separate view with a mapping."""
    parser = _TextOf()
    parser.feed(html)
    parser.close()
    return "".join(parser.parts).rstrip()
