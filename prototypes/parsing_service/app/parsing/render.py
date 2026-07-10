"""PDF page rasterization with render budgets."""

from __future__ import annotations

import math
import os
from contextlib import suppress
from typing import Any, cast

import pypdfium2 as pdfium  # type: ignore[import-not-found]

DEFAULT_MAX_RENDER_PAGES = 100
DEFAULT_MAX_RENDER_PAGE_PIXELS = 50_000_000
DEFAULT_MAX_RENDER_TOTAL_PIXELS = 250_000_000
MAX_RENDER_DPI = 300


def validate_pdf_render_budget(
    pdf,
    dpi: int,
    *,
    max_pages: int = DEFAULT_MAX_RENDER_PAGES,
    max_page_pixels: int = DEFAULT_MAX_RENDER_PAGE_PIXELS,
    max_total_pixels: int = DEFAULT_MAX_RENDER_TOTAL_PIXELS,
    page_numbers: list[int] | None = None,
) -> None:
    if page_numbers is not None:
        if len(page_numbers) != len(set(page_numbers)):
            raise ValueError("PDF page selections must be unique.")
        if any(page < 1 or page > len(pdf) for page in page_numbers):
            raise ValueError("PDF page selection is outside the document range.")
        selected_indexes = [page - 1 for page in page_numbers]
    else:
        selected_indexes = list(range(len(pdf)))
    page_count = len(selected_indexes)
    if page_count > max_pages:
        raise ValueError(
            f"PDF has too many pages to render: {page_count} > {max_pages}."
        )

    scale = dpi / 72.0
    total_pixels = 0
    for index in selected_indexes:
        page = pdf.get_page(index)
        try:
            width_pt, height_pt = cast(Any, page).get_size()
        finally:
            with suppress(Exception):
                cast(Any, page).close()
        page_pixels = math.ceil(width_pt * scale) * math.ceil(height_pt * scale)
        if page_pixels > max_page_pixels:
            raise ValueError(
                f"PDF page {index + 1} is too large to render: "
                f"{page_pixels} pixels > {max_page_pixels}."
            )
        total_pixels += page_pixels
        if total_pixels > max_total_pixels:
            raise ValueError(
                f"PDF render budget exceeded: {total_pixels} pixels > {max_total_pixels}."
            )


def convert_pdf_to_images(
    pdf_path: str,
    output_dir: str,
    dpi: int = 150,
    *,
    max_pages: int = DEFAULT_MAX_RENDER_PAGES,
    max_page_pixels: int = DEFAULT_MAX_RENDER_PAGE_PIXELS,
    max_total_pixels: int = DEFAULT_MAX_RENDER_TOTAL_PIXELS,
    page_numbers: list[int] | None = None,
) -> list[str]:
    """
    Converts a PDF file into a sequence of PNG images (one per page).

    Args:
        pdf_path: Path to the input PDF file.
        output_dir: Directory where the output images will be saved.
        dpi: Dots Per Inch for rendering resolution (default 150).

    Returns:
        List of absolute file paths to the generated images.
    """
    if dpi < 1:
        raise ValueError("dpi must be greater than zero.")
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")

    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as exc:
        raise OSError(f"Could not create image output directory: {output_dir}") from exc
    scale = dpi / 72.0

    pdf = pdfium.PdfDocument(pdf_path)
    image_paths = []

    try:
        validate_pdf_render_budget(
            pdf,
            dpi,
            max_pages=max_pages,
            max_page_pixels=max_page_pixels,
            max_total_pixels=max_total_pixels,
            page_numbers=page_numbers,
        )
        selected_indexes = (
            [page - 1 for page in page_numbers]
            if page_numbers is not None
            else list(range(len(pdf)))
        )
        for i in selected_indexes:
            page = pdf.get_page(i)
            bitmap = None
            pil_image = None
            try:
                bitmap = cast(Any, page).render(
                    scale=scale,
                    rotation=0,
                    fill_color=(255, 255, 255, 255),
                )
                pil_image = bitmap.to_pil()

                filename = f"page_{i + 1:02d}.png"
                image_path = os.path.join(output_dir, filename)
                pil_image.save(image_path)
                image_paths.append(os.path.abspath(image_path))
            finally:
                if pil_image is not None:
                    with suppress(Exception):
                        pil_image.close()
                if bitmap is not None:
                    with suppress(Exception):
                        bitmap.close()
                with suppress(Exception):
                    cast(Any, page).close()
    finally:
        pdf.close()

    return image_paths
