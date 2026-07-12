"""Canonical parser policy and cache identity."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

CANONICAL_PIPELINE = "docling_doctags_canonical"
CANONICAL_POLICY_REVISION = 4
CANONICAL_OCR_DPI = 150
CANONICAL_OCR_DEVICE_POLICY = "auto"
CANONICAL_OCR_MODEL = "PP-OCRv6_medium_det"
DOCTAGS_CONVERTER_REVISION = 2
MAX_INGESTION_PAGES = 100


def _package_version(package_name: str) -> str:
    try:
        return version(package_name)
    except PackageNotFoundError:
        return "unavailable"


def canonical_preprocessing_config(
    *,
    resolved_ocr_device: str = "unresolved",
) -> dict[str, int | str]:
    """Return every policy input capable of changing canonical text."""
    return {
        "pipeline": CANONICAL_PIPELINE,
        "policy_revision": CANONICAL_POLICY_REVISION,
        "doctags_converter_revision": DOCTAGS_CONVERTER_REVISION,
        "docling_version": _package_version("docling"),
        "ocr_fallback_dpi": CANONICAL_OCR_DPI,
        "ocr_fallback_device_policy": CANONICAL_OCR_DEVICE_POLICY,
        "resolved_ocr_device": resolved_ocr_device,
        "paddleocr_model": CANONICAL_OCR_MODEL,
        "paddleocr_version": _package_version("paddleocr"),
        "table_parser": "docling_inventory_camelot_fallback",
        "camelot_version": _package_version("camelot-py"),
    }
