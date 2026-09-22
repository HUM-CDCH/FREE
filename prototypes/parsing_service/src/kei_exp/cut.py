"""Layout-aware cuts: Docling layout boxes -> X-Y cut -> ink-profile snap -> region crops.

See docs/ingest-cuts.md. Coordinates are source page points. Page sources own rendering and resource
lifetimes; this module owns only layout preparation and its errors, not canonical post-OCR KIE layout.
"""
from collections.abc import Iterator
from dataclasses import asdict, dataclass, replace
from functools import lru_cache
from io import BytesIO
from itertools import pairwise
from math import inf
from typing import NamedTuple

import numpy as np
from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
from docling.datamodel.base_models import DocumentStream, InputFormat
from docling.datamodel.pipeline_options import (
    LayoutObjectDetectionOptions,
    PdfPipelineOptions,
)
from docling.document_converter import DocumentConverter, ImageFormatOption
from PIL import Image

from kei_exp.pages import CropTransform, PageSource, PointBox, RenderablePage

LAYOUT_DPI = 100          # The layout detector resizes to 640 px; 100 dpi keeps the ink profile usable.
DEFAULT_LAYOUT_MODEL = "layout_heron_101"
LAYOUT_MODELS = {
    "layout_heron_default": "Heron",
    "layout_heron_101": "Heron-101",
    "layout_egret_xlarge": "Egret XLarge",
}
# ponytail: fixed thresholds tuned on the Beier scan (9 pt column gaps, 90 pt gutter);
# derive them from the document's median line pitch if another corpus fails the checks.
MIN_GAP = 6               # pt: narrower gaps are word spacing or box jitter
SPAN = 0.6                # a block at least this fraction of its region's width may bridge columns
REACH = 8                 # pt: a crop may extend this far past its blocks toward a cut, for lines the layout missed
PAD = 4                   # pt around every crop
INK_FREE = 0.005          # max ink fraction for a profile column/row to count as blank
RETRY_COVERAGE = 0.9      # below this, retry layout on smaller views; ink may also be decoration or scan noise
COLUMN_COVERAGE = 0.97    # a few missing lines matter even when the rest of a column is complete
MARGIN_LABELS = {"page_header", "page_footer"}
TEXT_LABELS = {"text", "list_item", "section_header"}


class CutError(RuntimeError):
    pass


Span = tuple[float, float]


@dataclass(frozen=True)
class Region:
    kind: str    # page | column | band | figure
    bbox: PointBox
    order: int   # reading order within the source page
    ink: float   # share of the page's ink (dark pixels inside the scanner border) inside the crop
    transform: CropTransform | None = None  # how the rendered crop maps back to the page; set once it is rendered


Crop = tuple[int, Region, Image.Image]  # source page number, region, rendered crop


def region_info(crop: Crop | None) -> dict | None:
    """The report's description of a crop: its source page plus the Region fields, ink share included; the render
    transform belongs to the result files, not the debug report."""
    if crop is None:
        return None
    page, region, _ = crop
    return {"source_page": page, **{name: value for name, value in asdict(region).items() if name != "transform"}}


class Box(NamedTuple):
    l: float
    t: float
    r: float
    b: float
    label: str

    def extent(self, axis: int) -> Span:
        return (self.l, self.r) if axis == 0 else (self.t, self.b)


@lru_cache(maxsize=1)
def _layout_converter(layout_model: str) -> DocumentConverter:
    # ponytail: layout on CPU (1-2 s/page), so the GPU stays with the vLLM server that reserves most of it at
    # startup; make it a knob if a big card ever wants layout back on it.
    options = PdfPipelineOptions(do_ocr=False, do_table_structure=False,
                                 accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU),
                                 layout_options=LayoutObjectDetectionOptions.from_preset(
                                     layout_model, keep_empty_clusters=True))
    return DocumentConverter(format_options={InputFormat.IMAGE: ImageFormatOption(pipeline_options=options)})


def png_stream(name: str, image: Image.Image) -> DocumentStream:
    """PNG tagged 72 dpi so Docling treats 1 px as 1 pt and a scale of 1.0 means no resampling."""
    buffer = BytesIO()
    image.save(buffer, "PNG", dpi=(72, 72))
    return DocumentStream(name=name, stream=BytesIO(buffer.getvalue()))





def _layout(image: Image.Image, scale: float, origin: Span, layout_model: str) -> list[Box]:
    """Layout boxes of a rendered page, mapped back to source points."""
    result = _layout_converter(layout_model).convert(png_stream("page.png", image))
    layout = result.pages[0].predictions.layout
    assert layout is not None  # the layout stage is the only one this converter runs
    boxes = []
    for cluster in layout.clusters:
        l, t, r, b = cluster.bbox.as_tuple()
        boxes.append(Box(l * scale + origin[0], t * scale + origin[1], r * scale + origin[0], b * scale + origin[1],
                         cluster.label.value))
    return boxes


def _gaps(boxes: list[Box], axis: int) -> list[Span]:
    """Blank intervals wider than MIN_GAP between the merged extents of boxes along axis (0 = x, 1 = y)."""
    merged: list[list[float]] = []
    for lo, hi in sorted(box.extent(axis) for box in boxes):
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return [(a[1], b[0]) for a, b in pairwise(merged) if b[0] - a[1] > MIN_GAP]


class _Page:
    """One rendered source page: ink mask for snapping plus its layout boxes."""

    def __init__(self, page: RenderablePage, number: int, layout_model: str = DEFAULT_LAYOUT_MODEL):
        self.number = number
        self.layout_model = layout_model
        self.scale = 72 / LAYOUT_DPI
        gray = np.asarray(page.render(LAYOUT_DPI))
        ink = gray < 128
        # Scanner border: edge rows and columns that are mostly black.
        cols, rows = ink.mean(axis=0) <= 0.5, ink.mean(axis=1) <= 0.5
        x0, x1 = int(np.argmax(cols)), len(cols) - int(np.argmax(cols[::-1]))
        y0, y1 = int(np.argmax(rows)), len(rows) - int(np.argmax(rows[::-1]))
        if not cols.any() or not rows.any():
            raise CutError(f"page {number}: no content inside the scanner border")
        self.ink = ink[y0:y1, x0:x1]
        self.origin = (x0 * self.scale, y0 * self.scale)
        self.bounds = (x0 * self.scale, y0 * self.scale, x1 * self.scale, y1 * self.scale)
        self.image = Image.fromarray(gray[y0:y1, x0:x1])
        self.boxes = _layout(self.image, self.scale, self.origin, self.layout_model)

    def px(self, value: float, k: int) -> int:
        """Ink-mask index of a source coordinate along axis k (0 = x, 1 = y)."""
        return round((value - self.origin[k]) / self.scale)

    def ink_share(self, *bboxes: PointBox) -> float:
        """Share of the page's ink (dark pixels inside the scanner border) inside the union of bboxes."""
        covered = np.zeros_like(self.ink)
        for l, t, r, b in bboxes:
            covered[max(self.px(t, 1), 0):max(self.px(b, 1), 0), max(self.px(l, 0), 0):max(self.px(r, 0), 0)] = True
        total = int(self.ink.sum())
        return float((self.ink & covered).sum() / total) if total else 0.0

    def snap(self, gap: Span, axis: int, span: Span) -> float:
        """Midpoint of the widest ink-free run inside gap along axis, profiled over span on the other axis."""
        g0, g1 = self.px(gap[0], axis), self.px(gap[1], axis)
        s0, s1 = self.px(span[0], 1 - axis), self.px(span[1], 1 - axis)
        strip = self.ink[s0:s1, g0:g1] if axis == 0 else self.ink[g0:g1, s0:s1]
        blank = strip.mean(axis=axis) <= INK_FREE  # per column for x, per row for y
        edges = np.flatnonzero(np.diff(np.r_[0, blank, 0]))  # alternating run starts and ends
        if edges.size == 0:
            raise CutError(f"page {self.number}: layout gap {gap} on axis {axis} has no ink-free run")
        starts, ends = edges[::2], edges[1::2]
        widest = int(np.argmax(ends - starts))
        return self.origin[axis] + (g0 + (starts[widest] + ends[widest]) / 2) * self.scale

    def group(self, boxes: list[Box], axis: int, cuts: list[float], span: Span) -> list[tuple[list[Box], Span]]:
        """Boxes between consecutive cuts along axis inside span, assigned by centre so none is dropped; with extents."""
        groups = []
        for lo, hi in pairwise([span[0], *cuts, span[1]]):
            members = [box for box in boxes if lo <= sum(box.extent(axis)) / 2 < hi]
            if members:
                groups.append((members, (lo, hi)))
        assert sum(len(members) for members, _ in groups) == len(boxes)  # every box lands in exactly one group
        return groups

    def split(self, boxes: list[Box], axis: int, gaps: list[Span], span: Span) -> list[tuple[list[Box], Span]]:
        """Group boxes between cuts snapped inside gaps along axis, within span."""
        other = 1 - axis
        profile = (min(box.extent(other)[0] for box in boxes), max(box.extent(other)[1] for box in boxes))
        return self.group(boxes, axis, [self.snap(gap, axis, profile) for gap in gaps], span)

    def leaves(self, boxes: list[Box], xspan: Span, yspan: Span,
               kind: str = "page") -> list[tuple[list[Box], str, Span, Span]]:
        """Recursive X-Y cut: split at x-gaps; where wide blocks bridge columns, cut y around them, split again.

        Leaves carry their boxes, kind, and the x and y extents between the cuts (or page edges) around them.
        """
        gaps = _gaps(boxes, 0)
        if gaps:
            return [leaf for group, span in self.split(boxes, 0, gaps, xspan)
                    for leaf in self.leaves(group, span, yspan, "column")]
        width = max(box.r for box in boxes) - min(box.l for box in boxes)
        wide = {box for box in boxes if box.r - box.l >= SPAN * width}
        if wide and _gaps([box for box in boxes if box not in wide], 0):
            # Bands between y-gaps; consecutive bands without a wide block stay together.
            bands: list[list[Box]] = []
            for band, _ in self.group(boxes, 1, [gap[0] for gap in _gaps(boxes, 1)], yspan):
                if bands and wide.isdisjoint(band) and wide.isdisjoint(bands[-1]):
                    bands[-1] += band
                else:
                    bands.append(band)
            if len(bands) > 1:
                ygaps = [(max(b.b for b in above), min(b.t for b in below)) for above, below in pairwise(bands)]
                return [leaf for group, span in self.split(boxes, 1, ygaps, yspan)
                        for leaf in self.leaves(group, xspan, span, "band")]
        if any(box.label not in TEXT_LABELS for box in boxes):
            kind = "figure"
        return [(boxes, kind, xspan, yspan)]

    def region(self, kind: str, bbox: PointBox) -> Region:
        """A region of this page with its ink share; its order is assigned once the policy has had its say."""
        return Region(kind, bbox, 0, self.ink_share(bbox))

    def policy(self, regions: list[Region], coverage: float) -> list[Region]:
        """Final say on a page's cut, given the share of its ink that the regions cover together (0-1).

        Runs for every page, also when the layout model found no body block (regions == [], coverage 0).
        Ingredients: region.ink is each region's own share, self.bounds the page inside the scanner border,
        self.boxes the layout blocks, self.region(kind, bbox) builds a region for any box (the whole page is
        self.region("page", self.bounds)) and self.ink_share(*bboxes) measures a candidate. Order is assigned
        after this returns, so regions may be dropped, merged or added freely.
        """
        if coverage >= RETRY_COVERAGE:
            return self._candidate_regions(extend_columns=True)
        if not self.ink.any():
            return []

        # Smaller views give missed text more of the layout model's fixed input resolution.
        # Overlap protects blocks crossing tile edges; retain the original detections too.
        width, height = self.image.size
        tile_width, tile_height = round(width * 0.6), round(height * 0.6)
        for top in (0, height - tile_height):
            for left in (0, width - tile_width):
                tile = self.image.crop((left, top, left + tile_width, top + tile_height))
                origin = (self.origin[0] + left * self.scale, self.origin[1] + top * self.scale)
                self.boxes.extend(_layout(tile, self.scale, origin, self.layout_model))
        recovered = self._candidate_regions()
        recovered_coverage = self.ink_share(*(region.bbox for region in recovered))
        if not regions and not recovered:
            raise CutError(f"page {self.number}: layout found no body blocks after tiled layout")
        return recovered if recovered_coverage > coverage else regions

    def _extend_column(self, region: Region, yspan: Span) -> Region:
        """Recover missed column ends without changing the cuts or neighbouring regions."""
        l, t, r, b = region.bbox
        ct, cb = max(yspan[0], self.bounds[1]), min(yspan[1], self.bounds[3])
        x0, x1 = self.px(l, 0), self.px(r, 0)
        y0, y1 = self.px(ct, 1), self.px(cb, 1)
        ink = self.ink[y0:y1, x0:x1].sum()
        covered = self.ink[self.px(t, 1):self.px(b, 1), x0:x1].sum()
        if covered >= COLUMN_COVERAGE * ink:
            return region
        # A narrower full-height view still shrinks small text to the same detector resolution.
        # Overlapping vertical tiles enlarge missed lines while keeping the column and band cuts fixed.
        height = max(1, round((y1 - y0) * 0.6))
        boxes = []
        for top in (y0, y1 - height):
            view = self.image.crop((x0, top, x1, top + height))
            origin = (self.origin[0] + x0 * self.scale, self.origin[1] + top * self.scale)
            boxes.extend(box for box in _layout(view, self.scale, origin, self.layout_model)
                         if box.label in TEXT_LABELS)
        if not boxes:
            return region
        bbox = (l, min(t, max(ct, min(box.t for box in boxes) - PAD)),
                r, max(b, min(cb, max(box.b for box in boxes) + PAD)))
        return self.region(region.kind, bbox)

    def _candidate_regions(self, *, extend_columns: bool = False) -> list[Region]:
        """Crops from the current layout, optionally extending incomplete columns before numbering."""
        body = [box for box in self.boxes if box.label not in MARGIN_LABELS]
        regions: list[Region] = []
        if body:
            leaves = self.leaves(body, (min(box.l for box in body), max(box.r for box in body)), (-inf, inf))
            for boxes, kind, (cl, cr), (ct, cb) in leaves:
                # x toward the cuts but at most REACH past the blocks (a gutter stays out); y over the blocks plus
                # every running head or page number that fits between the cuts around the leaf, so those are
                # transcribed.
                cl, cr = max(cl, min(b.l for b in boxes) - REACH), min(cr, max(b.r for b in boxes) + REACH)
                inside = boxes + [b for b in self.boxes if b.label in MARGIN_LABELS
                                  and cl <= b.l and b.r <= cr and ct <= b.t and b.b <= cb]
                bbox = (max(cl - PAD, self.bounds[0]), max(min(b.t for b in inside) - PAD, self.bounds[1]),
                        min(cr + PAD, self.bounds[2]), min(max(b.b for b in inside) + PAD, self.bounds[3]))
                region = self.region(kind, bbox)
                if extend_columns and kind == "column":
                    region = self._extend_column(region, (ct, cb))
                regions.append(region)
        return regions

    def regions(self) -> list[Region]:
        """Reading-ordered crop regions: columns, bands around spanning blocks, figures, or the whole page."""
        regions = self._candidate_regions()
        regions = self.policy(regions, self.ink_share(*(region.bbox for region in regions)))
        return [replace(region, order=order) for order, region in enumerate(regions)]

def find_regions(page: RenderablePage, number: int, layout_model: str = DEFAULT_LAYOUT_MODEL) -> list[Region]:
    """Reading-ordered regions of one source page: columns of its pages, bands around spanning blocks, figures."""
    return _Page(page, number, layout_model).regions()


def render_region(page: RenderablePage, region: Region, dpi: int) -> Image.Image:
    """Only rendering geometry errors become cut failures; layout exceptions keep their identity."""
    try:
        return page.render(dpi, region.bbox)
    except ValueError as error:
        raise CutError(str(error)) from error


def cut_pages(pages: PageSource, numbers: list[int], dpi: int, *,
              layout_model: str = DEFAULT_LAYOUT_MODEL) -> Iterator[Crop]:
    """Cut the selected document pages in the supplied order, one crop at a time as it is rendered, so the caller
    can say what it has before the last page is cut; the caller owns the source and exhausts this inside its life."""
    if layout_model not in LAYOUT_MODELS:
        raise CutError(f"unknown layout model {layout_model!r}")
    for number in numbers:
        try:
            page = pages.page(number)
        except IndexError as error:
            raise CutError(str(error)) from error
        for region in find_regions(page, number, layout_model):
            rendered = replace(region, transform=page.crop_transform(dpi, region.bbox))
            yield number, rendered, render_region(page, region, dpi)


def whole_pages(pages: PageSource, numbers: list[int], dpi: int) -> Iterator[Crop]:
    """One crop per book page for uncut image input, as each is rendered; whole-PDF transcription keeps its
    backend path."""
    for number in numbers:
        page = pages.page(number)
        region = Region("page", (0.0, 0.0, *page.get_size()), 0, 1.0, page.crop_transform(dpi))
        yield number, region, render_region(page, region, dpi)
