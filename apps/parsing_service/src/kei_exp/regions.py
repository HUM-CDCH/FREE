"""The OCR stage's crop data: a region of a source page, the crop rendered from it, the report's description of a
crop, and the layout detectors a cut may run on.

A leaf beside `kei_exp.geometry`: no pdfium and no docling, so the transcriber contract, the result writer and the API
can name crops and layout models without importing the detector. The cut that finds regions and renders crops is
`kei_exp.cut`.
"""
from dataclasses import asdict, dataclass
from collections.abc import Collection, Iterable

from PIL import Image

from kei_exp.geometry import CropTransform, PointBox

DEFAULT_LAYOUT_MODEL = "layout_heron_101"
LAYOUT_MODELS = {
    "layout_heron_default": "Heron",
    "layout_heron_101": "Heron-101",
    "layout_egret_xlarge": "Egret XLarge",
}


@dataclass(frozen=True)
class Region:
    kind: str    # page | column | band | figure | text (a native block whose glyphs are undecodable)
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


def anchor(native: list[PointBox], box: PointBox, furniture: Collection[int] = ()) -> int:
    """Where an OCR region of one page reads among that page's native items, which keep their own order (no
    sorting of native columns by y): the index of the native item it precedes, len(native) after the last.

    The items at the `furniture` indices (running heads and feet) keep their places but never place the artwork:
    Docling reads them apart from the body, so a full-width footer must not draw a column's artwork past the next
    column. Only a page with nothing but furniture places it among them.

    Body items in its horizontal span bound it: after the last one above it, before the first one below it, and
    in between after any item not wholly to its right (an earlier column). Artwork no body item spans (a marginal
    figure) follows the last body item wholly above it; with none above, artwork beside body text heads a column
    of its own and, as Docling reads column heads left to right, follows the body wholly to its left; else it
    reads before the body.
    """
    body = [(index, other) for index, other in enumerate(native) if index not in furniture] or list(enumerate(native))
    aligned = [(index, other) for index, other in body if max(box[0], other[0]) < min(box[2], other[2])]
    following = [index for index, other in aligned if other[1] >= box[3]]
    preceding = [index for index, other in aligned if other[3] <= box[1]]
    if preceding and (not following or preceding[-1] < following[0]):
        start, end = preceding[-1] + 1, following[0] if following else len(native)
        return max([start] + [index + 1 for index, other in body if start <= index < end and other[0] < box[2]])
    if following:
        return following[0]
    above = [index for index, other in body if other[3] <= box[1]]
    left = [(index, other) for index, other in body if other[2] <= box[0]]
    if above:
        return above[-1] + 1
    if any(other[1] < box[3] and box[1] < other[3] for _, other in left):
        return left[-1][0] + 1
    return body[0][0] if body else 0


def splice[T](native: list[T], regions: Iterable[tuple[int, list[T]]]) -> list[T]:
    """The native items with each region's items inserted at its anchor, regions of one anchor in the order given;
    each region's own items keep the engine's order."""
    insertions: dict[int, list[T]] = {}
    for at, items in regions:
        insertions.setdefault(at, []).extend(items)
    ordered = []
    for index in range(len(native) + 1):
        ordered.extend(insertions.get(index, []))
        if index < len(native):
            ordered.append(native[index])
    return ordered
