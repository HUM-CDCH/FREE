"""Internal page-level OCR fallback for canonical ingestion.

PaddleOCR is not a user-selectable primary parser. This adapter is invoked only
for pages whose Docling DocTags-derived text is unavailable or unusable.

Geometry convention: rendered page images are post-/Rotate (pdfium applies the
page's own rotation), and ParsedPage.width_pt/height_pt are also post-rotation,
so OCR pixel boxes scaled by 72/dpi land directly in the canonical top-left
BoundingBox space — no per-page rotation math is needed.
"""

from __future__ import annotations

import importlib
import logging
import math
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.models.parser import CANONICAL_OCR_MODEL
from app.parsing.render import convert_pdf_to_images
from app.storage.atomic_json import write_text_atomic
from app.storage.paths import document_artifacts_dir, service_relative_ref
from app.timing import duration_ms, utc_now

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OcrFallbackOutput:
    """Per-page OCR text plus recognized lines.

    page_lines values match the ParsedPage.blocks dict shape:
    {"type": "ocr_line", "text": str, "confidence": float,
     "bbox": [x0, y0, x1, y1]} with bbox in top-left-origin PDF points.
    """

    parser: str = "paddleocr_fallback"
    status: str = "skipped"
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    pages: dict[int, str] = field(default_factory=dict)
    page_lines: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    output_ref: str | None = None
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass(frozen=True)
class _OcrFallbackRequest:
    source_pdf: Path
    content_sha256: str
    page_numbers: list[int]
    dpi: int
    device: str
    artifact_root: Path | None = None


def _extract_markdown_from_result(result: Any) -> str:
    markdown = getattr(result, "markdown", None)
    if isinstance(markdown, dict):
        return str(markdown.get("markdown_texts") or "")
    return ""


def _valid_line_geometry(values: list[float], confidence: float) -> bool:
    if len(values) != 4:
        return False
    if not all(math.isfinite(value) and value >= 0 for value in values):
        return False
    if not math.isfinite(confidence):
        return False
    if values[0] >= values[2]:
        return False
    return values[1] < values[3]


def _extract_lines_from_result(
    result: Any, scale: float, warnings: list[str]
) -> list[dict[str, Any]]:
    """Read per-line text/confidence/geometry from a PPStructureV3 result.

    rec_boxes are [x0, y0, x1, y1] top-left-origin image pixels; scale is
    72/dpi to convert into PDF points. On any shape mismatch, returns [] with
    a warning rather than risking misaligned geometry.
    """
    try:
        ocr_res = result["overall_ocr_res"]
        texts = list(ocr_res["rec_texts"])
        scores = list(ocr_res["rec_scores"])
        boxes = list(ocr_res["rec_boxes"])
    except Exception:
        ocr_res = None
        texts, scores, boxes = [], [], []
    if ocr_res is None or not (len(texts) == len(scores) == len(boxes)):
        if "ocr_line_geometry_unavailable" not in warnings:
            warnings.append("ocr_line_geometry_unavailable")
        return []
    lines: list[dict[str, Any]] = []
    for text, score, box in zip(texts, scores, boxes, strict=True):
        try:
            values = [float(value) for value in box]
            confidence_value = float(score)
            if not _valid_line_geometry(values, confidence_value):
                raise ValueError("invalid OCR line geometry")
            bbox = [round(value * scale, 2) for value in values]
            confidence = min(max(confidence_value, 0.0), 1.0)
        except (TypeError, ValueError):
            if "ocr_line_geometry_unavailable" not in warnings:
                warnings.append("ocr_line_geometry_unavailable")
            continue
        lines.append(
            {
                "type": "ocr_line",
                "text": str(text),
                "confidence": confidence,
                "bbox": bbox,
            }
        )
    return lines


def run_paddleocr_fallback(**options: Any) -> OcrFallbackOutput:
    """Run page-level PaddleOCR over the requested physical pages."""
    request = _OcrFallbackRequest(**options)
    if not request.page_numbers:
        return OcrFallbackOutput(warnings=["ocr_fallback_not_required"])

    started_at = utc_now()
    start = time.time()
    fallback_dir = (
        request.artifact_root
        or document_artifacts_dir(request.content_sha256)
    ) / "paddleocr_fallback"
    image_dir = fallback_dir / "images"
    warnings: list[str] = []
    try:
        image_paths = convert_pdf_to_images(
            str(request.source_pdf),
            str(image_dir),
            dpi=request.dpi,
            page_numbers=request.page_numbers,
        )
        paddleocr_module = importlib.import_module("paddleocr")
        pipeline = paddleocr_module.PPStructureV3(
            text_detection_model_name=CANONICAL_OCR_MODEL,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device=request.device,
        )
        if len(image_paths) != len(request.page_numbers):
            raise RuntimeError("OCR rendering did not return every requested page.")
        scale = 72.0 / request.dpi
        pages: dict[int, str] = {}
        page_lines: dict[int, list[dict[str, Any]]] = {}
        for page_number, image_path in zip(
            request.page_numbers,
            image_paths,
            strict=True,
        ):
            texts: list[str] = []
            lines: list[dict[str, Any]] = []
            for result in pipeline.predict(image_path):
                text = _extract_markdown_from_result(result)
                if text:
                    texts.append(text)
                lines.extend(_extract_lines_from_result(result, scale, warnings))
            page_text = "\n\n".join(texts).strip()
            pages[page_number] = page_text
            page_lines[page_number] = lines
            write_text_atomic(fallback_dir / f"page_{page_number:02d}.md", page_text)

        index_path = fallback_dir / "document.md"
        write_text_atomic(
            index_path,
            "\n\n".join(pages[page] for page in sorted(pages)).strip(),
        )
        return OcrFallbackOutput(
            status="success",
            started_at=started_at,
            finished_at=utc_now(),
            duration_ms=duration_ms(start),
            pages=pages,
            page_lines=page_lines,
            output_ref=service_relative_ref(index_path),
            warnings=warnings,
        )
    except Exception as exc:
        unavailable = isinstance(exc, ModuleNotFoundError)
        logger.exception(
            "PaddleOCR fallback dependency is unavailable"
            if unavailable
            else "PaddleOCR fallback failed"
        )
        return OcrFallbackOutput(
            status="failed",
            started_at=started_at,
            finished_at=utc_now(),
            duration_ms=duration_ms(start),
            warnings=warnings,
            error=(
                "ocr_fallback_unavailable" if unavailable else "ocr_fallback_failed"
            ),
        )
    finally:
        # Raster images are transient inputs, not canonical artifacts.
        shutil.rmtree(image_dir, ignore_errors=True)
