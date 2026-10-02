"""The page-file models and their reader: what `result/pages/<n>.json` and `result/result.json` hold, and the proof
a consumer needs before it trusts a result directory (canonical evidence design §3 and §5).

A leaf module, so that a reader of the accepted result (the KIE evidence loader, a viewer) can parse and verify the
files without importing the converter, whose modules load the cut and with it docling. `kei_exp.result` writes
these models.

Coordinate spaces (design §3.1): `*_pt` is the PDF page, top-left, points; a segment's `bbox_px` is the space the
engine read — the crop image it received, or, for a native page whose engine read the PDF itself, the page's own
points; a crop's `source_px` is the unit's native raster (a book page's PNG, half-open pixels) and
`image_px` the crop image's size; `origin_pt` and `pt_per_px` map crop pixels to the unit's own points (page points
for the PDF page unit, book-page points for a book page).
"""
import hashlib
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from kei_exp.canonical import canonical_json
from kei_exp.geometry import PixelBox, PointBox

RESULT_VERSION = 5  # in the manifest and the recipe; bumped when the files can change for the same inputs
# 5: native table cells with offsets into the unchanged parent text and physical-page geometry
# 4: a generation identity in the manifest and every page file, the sha256 of every page file in the manifest with a
#    digest over them, units named by kind, the crop transform as named pairs beside the record's diagnostics, and
#    the extent of a segment's evidence made explicit
# 3: no segment ids, page digests, embedded ingest pages or Markdown ranges; a VLM's text is its Markdown as generated
# 2: the visible page's origin in a unit's placement, VLM text through html_to_text, a segment's own Markdown

MANIFEST = "result.json"


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class CropResult(_Base):
    """What came back for one Crop of the cut."""
    crop: int                          # input ordinal of the crop, unique across the run
    kind: str                          # regions.Region: page | column | band | figure
    order: int                         # reading order within the unit; restarts per unit
    bbox_pt: PointBox                  # on the PDF page
    ink: float | None
    origin_pt: tuple[float, float]     # the crop's pixel (0, 0) in the unit's points, as the renderer rounded
    pt_per_px: tuple[float, float]     # unit points per crop pixel on each axis, as the renderer rounded
    source_px: PixelBox | None         # the rectangle cut from the unit's native raster; None for a pdfium crop
    image_px: tuple[int, int]
    input_tokens: int | None
    output_tokens: int | None
    seconds: float | None              # generation time when the backend reports one
    stop: str | None                   # the VLM's stop reason; None for Surya and native text
    capped: bool                       # the kept output used up its token cap
    incomplete: str | None             # the record's reason, verbatim


class Unit(_Base):
    """What was rendered and cut: the PDF page itself (index 0) or one book page of the ingest (its Page.index)."""
    index: int
    kind: Literal["pdf_page", "book_page"]
    bbox_pt: PointBox                  # where the unit sits on the PDF page
    crops: list[CropResult]

    @model_validator(mode="after")
    def _kind_follows_index(self) -> Self:
        if (self.kind == "pdf_page") != (self.index == 0):
            raise ValueError(f"unit {self.index} is {self.kind}: index 0 is the PDF page itself, any other a book page")
        return self


class TableCell(_Base):
    cell_id: str
    row: int = Field(ge=0)
    column: int = Field(ge=0)
    rowspan: int = Field(ge=1)
    colspan: int = Field(ge=1)
    role: str | None
    text: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    bbox_pt: PointBox | None

    @model_validator(mode="after")
    def _identity(self) -> Self:
        if self.cell_id != f"r{self.row}_c{self.column}" or self.end < self.start:
            raise ValueError("invalid table cell identity or text range")
        return self


class PageTable(_Base):
    rows: int = Field(ge=0)
    columns: int = Field(ge=0)
    cells: list[TableCell]
    producer: str

    @model_validator(mode="after")
    def _grid(self) -> Self:
        occupied: set[tuple[int, int]] = set()
        for cell in self.cells:
            if cell.row + cell.rowspan > self.rows or cell.column + cell.colspan > self.columns:
                raise ValueError("table cell extends beyond its grid")
            positions = {(r, c) for r in range(cell.row, cell.row + cell.rowspan)
                         for c in range(cell.column, cell.column + cell.colspan)}
            if occupied & positions:
                raise ValueError("overlapping table cells")
            occupied |= positions
        return self


class PageSegment(_Base):
    """One immutable piece of evidence on the PDF page; frozen, since spans index its text."""
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)
    text: str                          # plain text; spans count code points; never rewritten
    html: str | None                   # the block's HTML (tables verbatim): Surya's, or Docling's item on a native
                                       # page; None for a segment covering a whole input
    markdown: str | None               # the transcriber's own Markdown of a whole input; None for a block
    label: str
    confidence: float | None
    status: Literal["ok", "error", "skipped"]
    unit: int
    crop: int | None                   # None for a whole-page segment
    bbox_px: tuple[float, float, float, float] | None   # the engine's box as it gave it, in the space the engine
                                       # read: image pixels for a rendered crop or page; for a native page, whose
                                       # engine read the PDF itself, already the page's own points; None without one
    bbox_pt: PointBox                                   # derived through the image's transform and the unit's placement
    extent: Literal["block", "input"]  # block: the engine's box of one block; input: the whole input, the transcriber
                                       # returned no boxes, and bbox_pt is the input's extent, deliberately coarse
    table: PageTable | None = None      # absent on version 4; cells refine, never replace, this segment

    @model_validator(mode="after")
    def _extent_follows_the_box(self) -> Self:
        if (self.extent == "input") != (self.bbox_px is None):
            raise ValueError(f"a segment of extent {self.extent!r} with bbox_px {self.bbox_px}: input means no engine box")
        if self.table:
            for cell in self.table.cells:
                if cell.end > len(self.text) or self.text[cell.start:cell.end] != cell.text:
                    raise ValueError("table cell text does not match its parent segment")
        return self


class PageResult(_Base):
    generation: str                    # the manifest's; a page file of another generation is another result
    page: int                          # the PDF page, 1-based
    size_pt: tuple[float, float]
    units: list[Unit]
    segments: list[PageSegment]        # reading order: units, then crops by their order, then blocks; a
                                       # native page's blocks (no crop) read among its artwork crops
    markdown: str
    complete: bool                     # no record of this page is incomplete: the seam's facts are the one definition
    warnings: list[str]

    @model_validator(mode="after")
    def _cell_geometry(self) -> Self:
        width, height = self.size_pt
        for segment in self.segments:
            for cell in segment.table.cells if segment.table else []:
                if cell.bbox_pt is not None:
                    x0, y0, x1, y1 = cell.bbox_pt
                    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
                        raise ValueError("table cell geometry is outside its physical page")
        return self


class PageEntry(_Base):
    """One page file as the manifest lists it: the hash of its bytes and whether it is complete."""
    sha256: str
    complete: bool


class Result(_Base):
    """result/result.json, the manifest, written last: the generation and the content digest that identify what
    was produced, the recipe and its fingerprint that identify what was asked, and every page file with its hash."""
    result_version: int
    generation: str                    # minted when the result is first written; every page file names it
    digest: str                        # over the page files' hashes: the content identity of the generation
    fingerprint: str                   # over the recipe: the identity of what was asked
    recipe: dict                       # the source hash, the selection, the ingest digest, the settings, the versions
    source_name: str
    page_count: int
    effective: dict                    # data-dependent values outside the recipe: the VLM image cap, the Surya scale
    started: str | None                # when the transcriber was called, ISO 8601 UTC; None when not recorded
    seconds: float | None              # the transcriber's wall time; None when not recorded
    status: Literal["success", "incomplete"]
    incomplete: str | None
    pages: dict[int, PageEntry]        # every page file written, by PDF page
    tokens: dict[str, int | None]


class ResultError(Exception):
    """A result directory a consumer must not trust, naming the file and the field that say why."""


@dataclass(frozen=True)
class LoadedResult:
    """A verified result: the manifest and every page file it lists."""
    manifest: Result
    pages: dict[int, PageResult]


def segment_id(page: int, index: int) -> str:
    """The canonical identity of a page segment: the physical, one-based PDF page and its zero-based position in that
    page file's `segments`. Extraction evidence and FREE's anchors (`a_p{page}_s{index}`) are named by it; it is
    valid within one generation only."""
    return f"p{page}_s{index}"


def page_path(directory: Path, number: int) -> Path:
    return directory / "pages" / f"{number}.json"


def result_digest(hashes: Mapping[int, str]) -> str:
    """The content identity of a generation: the hash of its page files' hashes, in page order."""
    return hashlib.sha256(canonical_json({"pages": {str(n): hashes[n] for n in sorted(hashes)}})).hexdigest()


def read_manifest(directory: Path) -> Result:
    """The manifest, parsed and validated, of the result version this reader was written for."""
    path = directory / MANIFEST
    try:
        raw = path.read_bytes()
    except FileNotFoundError as error:
        raise ResultError(f"{path} is missing: the run has not finished, or this is not its result directory") from error
    try:
        manifest = Result.model_validate_json(raw)
    except ValidationError as error:
        raise ResultError(f"{path} is not a valid manifest: {error}") from error
    if manifest.result_version != RESULT_VERSION:
        raise ResultError(f"{path} was written at result_version {manifest.result_version}, not the {RESULT_VERSION} "
                          "this reader reads")
    return manifest


def read_page(directory: Path, number: int, manifest: Result) -> PageResult:
    """The page file of `number`, proven to belong to `manifest`: listed, parsing, naming its page, of the manifest's
    generation, hashing to the manifest's entry, and as complete as the entry says."""
    return _page(directory, number, manifest, _page_bytes(directory, number))


def load_result(directory: Path, *, source_sha256: str | None = None, ingest_digest: str | None = None,
                transcriber: str | None = None, page_source: str | None = None, pages: Collection[int] | None = None,
                require_complete: bool = False) -> LoadedResult:
    """The manifest and every page file it lists, verified before any consumer trusts them (design §5).

    Schema and version; the recipe's binding to what the caller expects (the source's hash, the ingest digest, the
    transcriber, the page source), each only when asked for; the completeness rules (`success` exactly when nothing
    is incomplete); coverage (the listed pages are an ascending subset of the document's, the files present are
    exactly the listed ones, and `pages`, when given, is exactly that set); the integrity of every page file
    against the manifest and of the digest against the page files. Every refusal is a `ResultError` naming the
    file and the field.
    """
    manifest = read_manifest(directory)
    if require_complete and manifest.status != "success":
        raise ResultError(f"the run is incomplete, and nothing truncated is imported: {manifest.incomplete}")
    for key, expected in (("source_sha256", source_sha256), ("ingest_digest", ingest_digest),
                          ("transcriber", transcriber), ("page_source", page_source)):
        if expected is not None and manifest.recipe.get(key) != expected:
            raise ResultError(f"recipe {key} is {manifest.recipe.get(key)!r}, not the {expected!r} this result is read as")
    listed = sorted(manifest.pages)
    if not listed:
        raise ResultError(f"{directory / MANIFEST} lists no pages")
    if listed[0] < 1 or listed[-1] > manifest.page_count:
        raise ResultError(f"the manifest lists pages {listed}, not an ascending subset of 1..{manifest.page_count}")
    if pages is not None and set(pages) != set(listed):
        raise ResultError(f"the manifest lists pages {listed}, not the {sorted(pages)} this result is read for")
    incomplete = [page_path(directory, n) for n in listed if not manifest.pages[n].complete]
    if (manifest.status == "success") != (manifest.incomplete is None and not incomplete):
        detail = f"{', '.join(map(str, incomplete))} not complete" if incomplete else f"incomplete {manifest.incomplete!r}"
        raise ResultError(f"{directory / MANIFEST} says status {manifest.status!r} with {detail}: the status does not "
                          "follow from the entries")
    for number in sorted(_present(directory) - set(listed)):
        raise ResultError(f"{page_path(directory, number)} is present but not listed in the manifest")
    read = {number: _page(directory, number, manifest, _page_bytes(directory, number)) for number in listed}
    digest = result_digest({number: entry.sha256 for number, entry in manifest.pages.items()})
    if digest != manifest.digest:
        raise ResultError(f"{directory / MANIFEST} claims digest {manifest.digest}, but its page files digest to {digest}")
    return LoadedResult(manifest, read)


def _present(directory: Path) -> set[int]:
    """The page numbers with a `pages/<n>.json` file, whatever the manifest says."""
    pages = directory / "pages"
    if not pages.is_dir():
        return set()
    return {int(path.stem) for path in pages.glob("*.json") if path.stem.isdigit()}


def _page_bytes(directory: Path, number: int) -> bytes:
    path = page_path(directory, number)
    try:
        return path.read_bytes()
    except FileNotFoundError as error:
        raise ResultError(f"{path} is listed in the manifest but missing") from error


def _page(directory: Path, number: int, manifest: Result, raw: bytes) -> PageResult:
    path = page_path(directory, number)
    entry = manifest.pages.get(number)
    if entry is None:
        raise ResultError(f"{path} is present but not listed in the manifest")
    try:
        page = PageResult.model_validate_json(raw)
    except ValidationError as error:
        raise ResultError(f"{path} is not a valid page file: {error}") from error
    if page.page != number:
        raise ResultError(f"{path} says page {page.page}, not {number}")
    if page.generation != manifest.generation:
        raise ResultError(f"{path} belongs to generation {page.generation!r}, not the manifest's {manifest.generation!r}")
    if (found := hashlib.sha256(raw).hexdigest()) != entry.sha256:
        raise ResultError(f"{path} hashes to {found}, not the sha256 {entry.sha256} the manifest records")
    if page.complete != entry.complete:
        raise ResultError(f"{path} says complete={page.complete}, but the manifest's entry says {entry.complete}")
    return page
