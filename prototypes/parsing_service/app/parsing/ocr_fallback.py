"""Internal page-level OCR fallback for canonical ingestion.

PaddleOCR is not a user-selectable primary parser. This adapter is invoked only
for pages whose Docling DocTags-derived text is unavailable or unusable.
"""

from __future__ import annotations

import datetime
import importlib
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.models.parser import CANONICAL_OCR_MODEL
from app.parsing.render import convert_pdf_to_images
from app.storage.atomic_json import write_text_atomic
from app.storage.paths import document_artifacts_dir, service_relative_ref

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OcrFallbackOutput:
    parser: str = "paddleocr_fallback"
    status: str = "skipped"
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    pages: dict[int, str] = field(default_factory=dict)
    output_ref: str | None = None
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _duration_ms(start: float) -> int:
    try:
        return int((time.time() - start) * 1000)
    except (OverflowError, ValueError):
        return 0


def _write_text(path: Path, content: str) -> None:
    write_text_atomic(path, content)


def _extract_markdown_from_result(result: Any) -> str:
    markdown = getattr(result, "markdown", None)
    if isinstance(markdown, dict):
        return str(markdown.get("markdown_texts") or "")
    return ""


def run_paddleocr_fallback(
    *,
    source_pdf: Path,
    content_sha256: str,
    page_numbers: list[int],
    dpi: int,
    device: str,
    artifact_root: Path | None = None,
) -> OcrFallbackOutput:
    if not page_numbers:
        return OcrFallbackOutput(warnings=["ocr_fallback_not_required"])

    started_at = _utc_now()
    start = time.time()
    fallback_dir = (
        artifact_root or document_artifacts_dir(content_sha256)
    ) / "paddleocr_fallback"
    image_dir = fallback_dir / "images"
    warnings: list[str] = []
    try:
        image_paths = convert_pdf_to_images(
            str(source_pdf), str(image_dir), dpi=dpi, page_numbers=page_numbers
        )
        paddleocr_module = importlib.import_module("paddleocr")
        pipeline = paddleocr_module.PPStructureV3(
            text_detection_model_name=CANONICAL_OCR_MODEL,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device=device,
        )
        if len(image_paths) != len(page_numbers):
            raise RuntimeError("OCR rendering did not return every requested page.")
        pages: dict[int, str] = {}
        for page_number, image_path in zip(page_numbers, image_paths, strict=True):
            texts: list[str] = []
            for result in pipeline.predict(image_path):
                text = _extract_markdown_from_result(result)
                if text:
                    texts.append(text)
            page_text = "\n\n".join(texts).strip()
            pages[page_number] = page_text
            _write_text(fallback_dir / f"page_{page_number:02d}.md", page_text)

        index_path = fallback_dir / "document.md"
        _write_text(
            index_path,
            "\n\n".join(pages[page] for page in sorted(pages)).strip(),
        )
        return OcrFallbackOutput(
            status="success",
            started_at=started_at,
            finished_at=_utc_now(),
            duration_ms=_duration_ms(start),
            pages=pages,
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
            finished_at=_utc_now(),
            duration_ms=_duration_ms(start),
            warnings=warnings,
            error=(
                "ocr_fallback_unavailable" if unavailable else "ocr_fallback_failed"
            ),
        )
    finally:
        # Raster images are transient inputs, not canonical artifacts.
        shutil.rmtree(image_dir, ignore_errors=True)
