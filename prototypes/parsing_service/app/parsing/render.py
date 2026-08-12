"""PDF page rasterization with render budgets."""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, cast

import pypdfium2 as pdfium  # type: ignore[import-not-found]

DEFAULT_MAX_RENDER_PAGES = 100
DEFAULT_MAX_RENDER_PAGE_PIXELS = 50_000_000
DEFAULT_MAX_RENDER_TOTAL_PIXELS = 250_000_000
MAX_RENDER_DPI = 300


@dataclass(frozen=True)
class _RenderBudget:
    max_pages: int = DEFAULT_MAX_RENDER_PAGES
    max_page_pixels: int = DEFAULT_MAX_RENDER_PAGE_PIXELS
    max_total_pixels: int = DEFAULT_MAX_RENDER_TOTAL_PIXELS
    page_numbers: list[int] | None = None


def _selected_page_indexes(
    pdf: Any,
    page_numbers: list[int] | None,
) -> Sequence[int]:
    document_page_count = len(pdf)
    if page_numbers is None:
        return range(document_page_count)
    if len(page_numbers) != len(set(page_numbers)):
        raise ValueError("PDF page selections must be unique.")
    if any(not 1 <= page <= document_page_count for page in page_numbers):
        raise ValueError("PDF page selection is outside the document range.")
    return [page - 1 for page in page_numbers]


def _page_pixel_count(pdf: Any, index: int, scale: float) -> int:
    page = pdf.get_page(index)
    try:
        width_pt, height_pt = cast(Any, page).get_size()
    finally:
        with suppress(Exception):
            cast(Any, page).close()
    return math.ceil(width_pt * scale) * math.ceil(height_pt * scale)


def _validate_render_budget(
    pdf: Any,
    dpi: int,
    budget: _RenderBudget,
) -> Sequence[int]:
    """Validate a document against the limits and return the pages to render."""
    selected_indexes = _selected_page_indexes(pdf, budget.page_numbers)
    page_count = len(selected_indexes)
    if page_count > budget.max_pages:
        raise ValueError(
            f"PDF has too many pages to render: {page_count} > {budget.max_pages}."
        )

    scale = dpi / 72.0
    total_pixels = 0
    for index in selected_indexes:
        page_pixels = _page_pixel_count(pdf, index, scale)
        if page_pixels > budget.max_page_pixels:
            raise ValueError(
                f"PDF page {index + 1} is too large to render: "
                f"{page_pixels} pixels > {budget.max_page_pixels}."
            )
        total_pixels += page_pixels
        if total_pixels > budget.max_total_pixels:
            raise ValueError(
                "PDF render budget exceeded: "
                f"{total_pixels} pixels > {budget.max_total_pixels}."
            )
    return selected_indexes


def _render_pdf_page(pdf: Any, index: int, output_dir: str, dpi: int) -> str:
    page = pdf.get_page(index)
    bitmap = None
    pil_image = None
    try:
        bitmap = cast(Any, page).render(
            scale=dpi / 72.0,
            rotation=0,
            fill_color=(255, 255, 255, 255),
        )
        pil_image = bitmap.to_pil()
        image_path = os.path.join(output_dir, f"page_{index + 1:02d}.png")
        pil_image.save(image_path)
        return os.path.abspath(image_path)
    finally:
        for resource in (pil_image, bitmap, page):
            if resource is not None:
                with suppress(Exception):
                    cast(Any, resource).close()


def convert_pdf_to_images(
    pdf_path: str,
    output_dir: str,
    dpi: int = 150,
    **options: Any,
) -> list[str]:
    """Convert selected PDF pages to PNG images."""
    budget = _RenderBudget(**options)
    if dpi < 1:
        raise ValueError("dpi must be greater than zero.")
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as exc:
        raise OSError(
            f"Could not create image output directory: {output_dir}"
        ) from exc

    pdf = pdfium.PdfDocument(pdf_path)
    try:
        return [
            _render_pdf_page(pdf, index, output_dir, dpi)
            for index in _validate_render_budget(pdf, dpi, budget)
        ]
    finally:
        pdf.close()
