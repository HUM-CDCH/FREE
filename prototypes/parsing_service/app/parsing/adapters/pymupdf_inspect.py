from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import fitz  # type: ignore[import-not-found]
from pydantic import BaseModel, ConfigDict, Field

from app.timing import utc_now

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
    image_count: int | None = Field(default=None, ge=0)
    drawing_count: int | None = Field(default=None, ge=0)
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


@dataclass(frozen=True)
class _InspectionLimits:
    max_pages: int | None = None
    render_dpi: int | None = None
    max_page_pixels: int | None = None
    max_total_pixels: int | None = None


@dataclass(frozen=True)
class _InspectionRun:
    started_at: str
    started: float
    parser_version: str | None

    @classmethod
    def begin(cls) -> _InspectionRun:
        return cls(
            started_at=utc_now(),
            started=time.perf_counter(),
            parser_version=_parser_version(),
        )

    def finish(
        self,
        status: Literal["completed", "failed"],
        **details: Any,
    ) -> PdfInspection:
        return PdfInspection(
            parser_version=self.parser_version,
            status=status,
            started_at=self.started_at,
            finished_at=utc_now(),
            duration_ms=int((time.perf_counter() - self.started) * 1000),
            **details,
        )


@dataclass(frozen=True)
class _PageGeometry:
    page: int
    width_pt: float
    height_pt: float
    rotation: int
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class _GeometryInspection:
    pages: list[_PageGeometry]
    error: str | None = None


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
    run = _InspectionRun.begin()
    limits = _InspectionLimits(
        max_pages=max_pages,
        render_dpi=render_dpi,
        max_page_pixels=max_page_pixels,
        max_total_pixels=max_total_pixels,
    )
    try:
        document = fitz.open(source_path)
    except Exception:
        logger.exception("PyMuPDF could not open the source document")
        return run.finish("failed", error="pdf_open_failed")

    try:
        return _inspect_document(document, limits, run)
    finally:
        document.close()


def _inspect_document(
    document: Any,
    limits: _InspectionLimits,
    run: _InspectionRun,
) -> PdfInspection:
    is_encrypted = bool(getattr(document, "is_encrypted", False))
    page_count = int(document.page_count)
    warnings, should_skip = _preflight_warnings(
        is_encrypted,
        page_count,
        limits,
    )
    if should_skip:
        return run.finish(
            "completed",
            page_count=page_count,
            pages=[],
            is_encrypted=is_encrypted,
            warnings=warnings,
        )

    geometry = _inspect_geometry(document, page_count, limits)
    if geometry.error is not None:
        return run.finish(
            "failed",
            page_count=page_count,
            is_encrypted=is_encrypted,
            error=geometry.error,
        )

    pages = [
        _inspect_page(document, index, page_geometry)
        for index, page_geometry in enumerate(geometry.pages)
    ]
    return run.finish(
        "completed",
        page_count=page_count,
        pages=pages,
        is_encrypted=is_encrypted,
        warnings=warnings,
    )


def _preflight_warnings(
    is_encrypted: bool,
    page_count: int,
    limits: _InspectionLimits,
) -> tuple[list[str], bool]:
    warnings: list[str] = []
    if is_encrypted:
        warnings.append("PDF is encrypted; page inspection was skipped.")
    over_page_limit = (
        limits.max_pages is not None and page_count > limits.max_pages
    )
    if over_page_limit:
        warnings.append(
            "PDF page count exceeds the ingestion limit: "
            f"{page_count} > {limits.max_pages}."
        )
    return warnings, is_encrypted or over_page_limit


def _inspect_geometry(
    document: Any,
    page_count: int,
    limits: _InspectionLimits,
) -> _GeometryInspection:
    geometry: list[_PageGeometry] = []
    total_pixels = 0
    budgeted = (
        limits.max_page_pixels is not None or limits.max_total_pixels is not None
    )
    scale = (limits.render_dpi or 72) / 72.0
    for index in range(page_count):
        page_number = index + 1
        try:
            page = document.load_page(index)
            page_geometry = _PageGeometry(
                page=page_number,
                width_pt=float(page.rect.width),
                height_pt=float(page.rect.height),
                rotation=int(page.rotation),
            )
        except Exception:
            logger.exception(
                "PyMuPDF page geometry inspection failed for page %s",
                page_number,
            )
            geometry.append(
                _PageGeometry(
                    page=page_number,
                    width_pt=0.0,
                    height_pt=0.0,
                    rotation=0,
                    warnings=(f"page_geometry_failed:{page_number}",),
                )
            )
            continue

        if budgeted:
            page_pixels = math.ceil(page_geometry.width_pt * scale) * math.ceil(
                page_geometry.height_pt * scale
            )
            if (
                limits.max_page_pixels is not None
                and page_pixels > limits.max_page_pixels
            ):
                return _GeometryInspection(
                    geometry, f"pdf_page_render_budget_exceeded:{page_number}"
                )
            total_pixels += page_pixels
            if (
                limits.max_total_pixels is not None
                and total_pixels > limits.max_total_pixels
            ):
                return _GeometryInspection(
                    geometry, "pdf_total_render_budget_exceeded"
                )
        geometry.append(page_geometry)
    return _GeometryInspection(geometry)


def _safe_count(
    count: Callable[[], int],
    page_number: int,
    warning: str,
    warnings: list[str],
    default: int | None = None,
) -> int | None:
    """Count a page inventory, degrading to a warning when PyMuPDF cannot."""
    try:
        return count()
    except Exception:
        logger.exception("PyMuPDF %s for page %s", warning, page_number)
        warnings.append(f"{warning}:{page_number}")
        return default


def _inspect_page(
    document: Any,
    index: int,
    geometry: _PageGeometry,
) -> PdfPageInspection:
    shape = {
        "page": geometry.page,
        "width_pt": geometry.width_pt,
        "height_pt": geometry.height_pt,
        "rotation": geometry.rotation,
    }
    if geometry.warnings:
        return PdfPageInspection(**shape, warnings=list(geometry.warnings))

    warnings: list[str] = []
    try:
        page = document.load_page(index)
        native_text_result = page.get_text("text")
        native_text = (
            native_text_result if isinstance(native_text_result, str) else ""
        )
    except Exception:
        logger.exception("PyMuPDF text inspection failed for page %s", geometry.page)
        return PdfPageInspection(
            **shape,
            warnings=[f"page_text_inspection_failed:{geometry.page}"],
        )

    return PdfPageInspection(
        **shape,
        native_text=native_text,
        char_count=len(native_text),
        word_count=_safe_count(
            lambda: len(page.get_text("words") or []),
            geometry.page,
            "native_word_boxes_unavailable",
            warnings,
            0,
        )
        or 0,
        image_count=_safe_count(
            lambda: len(page.get_images(full=True)),
            geometry.page,
            "image_inventory_unavailable",
            warnings,
        ),
        drawing_count=_safe_count(
            lambda: len(page.get_drawings()),
            geometry.page,
            "drawing_inventory_unavailable",
            warnings,
        ),
        warnings=warnings,
    )
