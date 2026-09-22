"""Page sources: what the cut and the API previews render from, a PDF's own pages or the book pages the KIE ingest
cut out of its scanned spreads. Sizes and boxes are top-left page points (72 per inch); page numbers keep their
document identity, selecting a subset never renumbers. Sources neither run the ingest nor verify its artifacts.
"""
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Self

import pypdfium2 as pdfium
from PIL import Image

from kei_exp._pdfium import pdfium_lock
from kei_exp.geometry import CropTransform, PixelBox, PointBox, unit_to_page_points
from kei_exp.kie.model import Page as IngestPage


class RenderablePage(Protocol):
    def get_size(self) -> tuple[float, float]:
        """Width and height in points."""
        ...

    def render(self, dpi: float, bbox: PointBox | None = None, *, grayscale: bool = True) -> Image.Image:
        """The page, or bbox of it, at dpi; mode L when grayscale (a bilevel book page is L either way).
        ValueError: a box covering no pixel."""
        ...

    def crop_transform(self, dpi: float, bbox: PointBox | None = None) -> CropTransform:
        """How the image `render(dpi, bbox)` produces maps back to page points, rounding included."""
        ...


class PageSource(Protocol):
    @property
    def count(self) -> int: ...

    def page(self, number: int) -> RenderablePage:
        """A document page, numbered 1..count; IndexError outside that range."""
        ...


class PdfPages:
    """The pages of a PDF, open for the `with` block. Each native call, not the block, holds the PDFium lock."""

    def __init__(self, path: Path):
        self.path = path
        self._document: pdfium.PdfDocument | None = None

    def __enter__(self) -> Self:
        with pdfium_lock:
            self._document = pdfium.PdfDocument(str(self.path))
        return self

    def __exit__(self, *_exc) -> None:
        with pdfium_lock:
            document, self._document = self._document, None
            if document is not None:
                document.close()

    @property
    def count(self) -> int:
        assert self._document is not None
        with pdfium_lock:
            return len(self._document)

    def page(self, number: int) -> "PdfPage":
        assert self._document is not None
        with pdfium_lock:
            if not 1 <= number <= len(self._document):
                raise IndexError(f"no page {number}")
            return PdfPage(self._document, number)


@dataclass(frozen=True)
class PdfPage:
    """A page number in an open PdfPages; the native page handle lives only for one call."""
    _document: pdfium.PdfDocument
    _number: int

    def get_size(self) -> tuple[float, float]:
        with pdfium_lock:
            page = self._document[self._number - 1]
            try:
                return page.get_size()
            finally:
                page.close()

    def crop_transform(self, dpi: float, bbox: PointBox | None = None) -> CropTransform:
        """pdfium renders the page into a canvas of ceil(W * s) x ceil(H * s) pixels and ceils the crop offsets
        (pypdfium2 page.py: `crop = [ceil(c * scale) ...]`), so a pixel is W / ceil(W * s) points, not 1 / s, and a
        crop's pixel (0, 0) sits at ceil(left * s) pixels: 0.05 pt requested at 250 dpi is 0.287 pt rendered."""
        width, height = self.get_size()
        scale = dpi / 72
        pt_per_px_x, pt_per_px_y = width / math.ceil(width * scale), height / math.ceil(height * scale)
        left, top = (0.0, 0.0) if bbox is None else (bbox[0], bbox[1])
        return CropTransform(math.ceil(left * scale) * pt_per_px_x, math.ceil(top * scale) * pt_per_px_y,
                             pt_per_px_x, pt_per_px_y, None)

    def render(self, dpi: float, bbox: PointBox | None = None, *, grayscale: bool = True) -> Image.Image:
        with pdfium_lock:
            page = self._document[self._number - 1]
            try:
                crop = (0.0, 0.0, 0.0, 0.0)
                if bbox is not None:
                    width, height = page.get_size()
                    left, top, right, bottom = bbox
                    if left >= right or top >= bottom:
                        raise ValueError(f"invalid page box {bbox}")
                    crop = (left, height - bottom, width - right, top)
                bitmap = page.render(scale=dpi / 72, crop=crop, grayscale=grayscale)
                try:
                    with bitmap.to_pil() as view:
                        return view.convert("L") if grayscale else view.copy()
                finally:
                    bitmap.close()
            finally:
                page.close()


@dataclass(frozen=True)
class BookPage:
    """A book page as the KIE ingest wrote it: a bilevel PNG placed at dpi_x by dpi_y, so 1 pt is dpi / 72 px,
    with the ingest page's own numbers (its rectangle on the spread, the spread's placement on the PDF page)."""
    path: Path
    ingest: IngestPage

    @property
    def dpi_x(self) -> float:
        return self.ingest.dpi_x

    @property
    def dpi_y(self) -> float:
        return self.ingest.dpi_y

    def get_size(self) -> tuple[float, float]:
        return self.ingest.width_px * 72 / self.dpi_x, self.ingest.height_px * 72 / self.dpi_y

    def native_box(self, bbox: PointBox | None = None) -> PixelBox:
        """The rectangle of native pixels `bbox` covers: cut on the page's own grid (within half a native pixel)
        and at the page's edge, since PIL would pad past it with black. ValueError: a box covering no pixel."""
        if bbox is None:
            return (0, 0, self.ingest.width_px, self.ingest.height_px)
        left, top, right, bottom = bbox
        box = (max(0, round(left * self.dpi_x / 72)), max(0, round(top * self.dpi_y / 72)),
               min(self.ingest.width_px, round(right * self.dpi_x / 72)),
               min(self.ingest.height_px, round(bottom * self.dpi_y / 72)))
        if box[0] >= box[2] or box[1] >= box[3]:
            raise ValueError(f"bbox {bbox} covers no pixel of {self.path.name}")
        return box

    def _output_size(self, box: PixelBox, dpi: float) -> tuple[int, int]:
        """The scale is exactly `dpi` but for whole-pixel rounding of the output size."""
        width, height = box[2] - box[0], box[3] - box[1]
        return max(1, round(width * dpi / self.dpi_x)), max(1, round(height * dpi / self.dpi_y))

    def crop_transform(self, dpi: float, bbox: PointBox | None = None) -> CropTransform:
        """The native box's corner in points and, per axis, the native pixels one output pixel stands for."""
        box = self.native_box(bbox)
        width, height = self._output_size(box, dpi)
        return CropTransform(box[0] * 72 / self.dpi_x, box[1] * 72 / self.dpi_y,
                             (box[2] - box[0]) / width * 72 / self.dpi_x, (box[3] - box[1]) / height * 72 / self.dpi_y,
                             box)

    def render(self, dpi: float, bbox: PointBox | None = None, *, grayscale: bool = True) -> Image.Image:
        """Grayscale of bbox (or the whole page) at dpi, resampled by area from the native pixels of `native_box`."""
        box = self.native_box(bbox)
        with Image.open(self.path) as image:
            gray = (image if bbox is None else image.crop(box)).convert("L")
        size = self._output_size(box, dpi)
        return gray if size == gray.size else gray.resize(size, Image.Resampling.BOX)

    def to_page_points(self, bbox: PointBox) -> PointBox:
        """Book-page top-left points onto the PDF page's top-left points, through the ingest page's rectangle on
        the spread and the spread's placement (`geometry.unit_to_page_points`)."""
        page = self.ingest
        return unit_to_page_points(page.placement, page.source_rect, (page.spread_width_px, page.spread_height_px),
                                   (self.dpi_x, self.dpi_y), bbox)


class BookPages:
    """The book pages of a published ingest artifact, in artifact order (contiguous indices 1..N), and the
    artifact's digest when the caller has it (the ingest identity a run's recipe names)."""

    def __init__(self, directory: Path, pages: Sequence[IngestPage], digest: str | None = None):
        self.directory = directory
        self._pages = tuple(pages)
        self.digest = digest

    @property
    def count(self) -> int:
        return len(self._pages)

    def page(self, number: int) -> BookPage:
        if not 1 <= number <= self.count:
            raise IndexError(f"no page {number}")
        page = self._pages[number - 1]
        return BookPage(self.directory / page.image, page)

    def numbers_in(self, spreads: tuple[int, int] | None) -> list[int]:
        """Book-page indices of an inclusive PDF-spread range, in artifact order."""
        if spreads is None:
            return [page.index for page in self._pages]
        first, last = spreads
        return [page.index for page in self._pages if first <= page.spread <= last]
