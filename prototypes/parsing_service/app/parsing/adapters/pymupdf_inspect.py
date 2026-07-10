from __future__ import annotations

import datetime
import logging
import math
import time
from pathlib import Path
from typing import Literal

import fitz  # type: ignore[import-not-found]
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


class PdfPageInspection(BaseModel):
    model_config = ConfigDict(frozen=True)

    page: int = Field(ge=1)
    width_pt: float = Field(ge=0)
    height_pt: float = Field(ge=0)
    rotation: int
    native_text: str = ""
    char_count: int = Field(default=0, ge=0)
    word_count: int = Field(default=0, ge=0)
    warnings: list[str] = Field(default_factory=list)


class PdfInspection(BaseModel):
    model_config = ConfigDict(frozen=True)

    parser: str = "pymupdf_inspect"
    parser_version: str | None = None
    status: Literal["completed", "failed"]
    started_at: str
    finished_at: str
    duration_ms: int = Field(ge=0)
    page_count: int = Field(default=0, ge=0)
    pages: list[PdfPageInspection] = Field(default_factory=list)
    is_encrypted: bool | None = None
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _parser_version() -> str | None:
    version = getattr(fitz, "__version__", None)
    return str(version) if version else None


def inspect_pdf(
    source_path: Path,
    *,
    max_pages: int | None = None,
    render_dpi: int | None = None,
    max_page_pixels: int | None = None,
    max_total_pixels: int | None = None,
) -> PdfInspection:
    """Inspect page metadata and text, rejecting oversized inputs before extraction."""
    started = _utc_now()
    start = time.perf_counter()
    parser_version = _parser_version()
    try:
        document = fitz.open(source_path)
    except Exception:
        logger.exception("PyMuPDF could not open the source document")
        finished = _utc_now()
        return PdfInspection(
            parser_version=parser_version,
            status="failed",
            started_at=started,
            finished_at=finished,
            duration_ms=int((time.perf_counter() - start) * 1000),
            error="pdf_open_failed",
        )

    try:
        is_encrypted = bool(getattr(document, "is_encrypted", False))
        page_count = int(document.page_count)
        warnings: list[str] = []
        pages: list[PdfPageInspection] = []
        if is_encrypted:
            warnings.append("PDF is encrypted; page inspection was skipped.")
        if max_pages is not None and page_count > max_pages:
            warnings.append(
                f"PDF page count exceeds the ingestion limit: {page_count} > {max_pages}."
            )
        if is_encrypted or (max_pages is not None and page_count > max_pages):
            return PdfInspection(
                parser_version=parser_version,
                status="completed",
                started_at=started,
                finished_at=_utc_now(),
                duration_ms=int((time.perf_counter() - start) * 1000),
                page_count=page_count,
                pages=[],
                is_encrypted=is_encrypted,
                warnings=warnings,
            )

        geometry: list[tuple[float, float, int, list[str]]] = []
        total_pixels = 0
        scale = (render_dpi or 72) / 72.0
        for index in range(page_count):
            page_number = index + 1
            try:
                page = document.load_page(index)
                width = float(page.rect.width)
                height = float(page.rect.height)
                rotation = int(page.rotation)
                geometry.append((width, height, rotation, []))
                if max_page_pixels is not None or max_total_pixels is not None:
                    page_pixels = math.ceil(width * scale) * math.ceil(height * scale)
                    if max_page_pixels is not None and page_pixels > max_page_pixels:
                        return PdfInspection(
                            parser_version=parser_version,
                            status="failed",
                            started_at=started,
                            finished_at=_utc_now(),
                            duration_ms=int((time.perf_counter() - start) * 1000),
                            page_count=page_count,
                            is_encrypted=is_encrypted,
                            error=f"pdf_page_render_budget_exceeded:{page_number}",
                        )
                    total_pixels += page_pixels
                    if max_total_pixels is not None and total_pixels > max_total_pixels:
                        return PdfInspection(
                            parser_version=parser_version,
                            status="failed",
                            started_at=started,
                            finished_at=_utc_now(),
                            duration_ms=int((time.perf_counter() - start) * 1000),
                            page_count=page_count,
                            is_encrypted=is_encrypted,
                            error="pdf_total_render_budget_exceeded",
                        )
            except Exception:
                logger.exception(
                    "PyMuPDF page geometry inspection failed for page %s",
                    page_number,
                )
                geometry.append((0.0, 0.0, 0, [f"page_geometry_failed:{page_number}"]))

        for index, (width, height, rotation, page_warnings) in enumerate(geometry):
            page_number = index + 1
            if page_warnings:
                pages.append(
                    PdfPageInspection(
                        page=page_number,
                        width_pt=width,
                        height_pt=height,
                        rotation=rotation,
                        warnings=page_warnings,
                    )
                )
                continue
            try:
                page = document.load_page(index)
                native_text_result = page.get_text("text")
                native_text = (
                    native_text_result if isinstance(native_text_result, str) else ""
                )
                try:
                    words = page.get_text("words") or []
                except Exception:
                    logger.exception(
                        "PyMuPDF word-box extraction failed for page %s",
                        page_number,
                    )
                    words = []
                    page_warnings.append(f"native_word_boxes_unavailable:{page_number}")
                pages.append(
                    PdfPageInspection(
                        page=page_number,
                        width_pt=width,
                        height_pt=height,
                        rotation=rotation,
                        native_text=native_text,
                        char_count=len(native_text),
                        word_count=len(words),
                        warnings=page_warnings,
                    )
                )
            except Exception:
                logger.exception(
                    "PyMuPDF text inspection failed for page %s",
                    page_number,
                )
                pages.append(
                    PdfPageInspection(
                        page=page_number,
                        width_pt=width,
                        height_pt=height,
                        rotation=rotation,
                        warnings=[f"page_text_inspection_failed:{page_number}"],
                    )
                )

        finished = _utc_now()
        return PdfInspection(
            parser_version=parser_version,
            status="completed",
            started_at=started,
            finished_at=finished,
            duration_ms=int((time.perf_counter() - start) * 1000),
            page_count=page_count,
            pages=pages,
            is_encrypted=is_encrypted,
            warnings=warnings,
        )
    finally:
        document.close()
