"""One geometry for the parsing result: the box types, the crop transform every renderer records, and the projections
between the spaces a box can be in (canonical evidence design §3.1): the crop image the engine saw (pixels), the unit
the crop was cut from (its own top-left points, and for a book page its native pixels), and the PDF page (top-left
points, 72 per inch). A leaf: no pdfium and no docling, so a reader of the result can import it without the
converter. The renderers' own rounding rules stay with the renderers (`pages.py`); what is shared is the record
they leave and the arithmetic every consumer applies to it.
"""
import math
from typing import NamedTuple, Protocol

PointBox = tuple[float, float, float, float]   # left, top, right, bottom, in top-left points
PixelBox = tuple[int, int, int, int]           # half-open pixel rectangle, [left, right) x [top, bottom)


def ordered_box[Box: tuple](box: Box) -> Box:
    """A box whose left is before its right and whose top is before its bottom; anything else is empty."""
    left, top, right, bottom = box
    if left >= right or top >= bottom:
        raise ValueError(f"bbox {list(box)} is empty; half-open means left < right and top < bottom")
    return box


class CropTransform(NamedTuple):
    """How an image a unit rendered maps back to the unit's points: where pixel (0, 0) sits, how many points a
    pixel is on each axis, and, for a native raster, the rectangle the image was cut from. Recorded rather than
    recomputed, because every renderer rounds: pdfium ceils crop offsets and canvas sizes, a book page cuts on
    its own grid and resizes to whole pixels."""
    origin_x: float
    origin_y: float
    pt_per_px_x: float
    pt_per_px_y: float
    source_px: PixelBox | None

    def to_unit_points(self, bbox_px: tuple[float, float, float, float]) -> PointBox:
        left, top, right, bottom = bbox_px
        return (self.origin_x + left * self.pt_per_px_x, self.origin_y + top * self.pt_per_px_y,
                self.origin_x + right * self.pt_per_px_x, self.origin_y + bottom * self.pt_per_px_y)


def unit_pixels(bbox_px: tuple[float, float, float, float], source_px: PixelBox, image_px: tuple[int, int]) -> PixelBox:
    """A crop-image box on the unit's native raster, through the crop's recorded rectangle and image size.

    The scale per axis is the recorded pair and nothing else: the renderer cut `source_px` from the raster and
    resized it to whole pixels, so `image_px` is exactly what the engine saw. Going through points and back would
    add two roundings for nothing. The box rounds outward (floor left and top, ceil right and bottom), as every
    transformed box does (stage 0 design §3.1).
    """
    left, top, right, bottom = source_px
    width, height = image_px
    sx, sy = (right - left) / width, (bottom - top) / height
    x0, y0, x1, y1 = bbox_px
    return (math.floor(left + x0 * sx), math.floor(top + y0 * sy), math.ceil(left + x1 * sx), math.ceil(top + y1 * sy))


def clamp(box: PixelBox, within: PixelBox) -> PixelBox | None:
    """Where a rounded box lands: clamped into `within`, the crop it was read from, or None when nothing is left.

    A box is clamped to its crop rather than to the page, because pixels outside the crop were never shown to the
    engine; the crop lies inside the page, so every placed box does too. The clamp comes after the rounding,
    because float error on a boundary can ceil one pixel past the crop's edge. Alternatives (a tolerance beyond
    which a box is an engine error to reject; no clamp at all) replace this function.
    """
    left, top, right, bottom = box
    within_left, within_top, within_right, within_bottom = within
    placed = (max(left, within_left), max(top, within_top), min(right, within_right), min(bottom, within_bottom))
    return placed if placed[0] < placed[2] and placed[1] < placed[3] else None


class Placed(Protocol):
    """A spread's placement on its PDF page as the ingest records it (`kie.ingest_model.Placement`): the six
    coefficients of the image matrix, the visible page's lower-left corner in user space, and the page height."""
    a: float
    b: float
    c: float
    d: float
    e: float
    f: float
    origin_x_pt: float
    origin_y_pt: float
    page_height_pt: float


def unit_to_page_points(placement: Placed, source_rect: PixelBox, spread_px: tuple[int, int],
                        dpi: tuple[float, float], bbox: PointBox) -> PointBox:
    """Book-page top-left points onto the PDF page's top-left points.

    Through the spread's pixels (the page's rectangle on it), the PDF image space (whose top row is v = 1) and the
    placement matrix into user space, then against the visible page's lower-left corner (the CropBox's, recorded
    by the ingest), flipped. The bounding box of the four corners: exact for an axis-aligned scan, and for a
    rotated placement wider than the box by its height times the sine of the angle.
    """
    left, top = source_rect[0], source_rect[1]
    spread_width, spread_height = spread_px
    dpi_x, dpi_y = dpi
    xs, ys = [], []
    for x_pt, y_pt in ((bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])):
        u = (x_pt * dpi_x / 72 + left) / spread_width
        v = 1 - (y_pt * dpi_y / 72 + top) / spread_height
        xs.append(placement.a * u + placement.c * v + placement.e - placement.origin_x_pt)
        ys.append(placement.origin_y_pt + placement.page_height_pt - (placement.b * u + placement.d * v + placement.f))
    return (min(xs), min(ys), max(xs), max(ys))
