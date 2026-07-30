"""Source document content validation (trust boundary)."""

from __future__ import annotations

import os

PDF_MAGIC = b"%PDF-"
V2_PDF_REQUIRED_ERROR_CODE = "v2_source_not_pdf"
V2_PAGE_MAPPING_ERROR_CODE = "v2_physical_page_mapping_unavailable"
ALLOWED_PDF_CONTENT_TYPES = {
    "application/pdf",
    "application/x-pdf",
    "application/octet-stream",
    "binary/octet-stream",
}


def _looks_like_pdf(path: str | os.PathLike[str]) -> bool:
    try:
        with open(path, "rb") as handle:
            return handle.read(len(PDF_MAGIC)) == PDF_MAGIC
    except OSError:
        return False


def assert_pdf_file(path: str | os.PathLike[str]) -> None:
    if not _looks_like_pdf(path):
        raise ValueError("Input does not appear to be a PDF document.")


def assert_v2_pdf_file(path: str | os.PathLike[str]) -> None:
    """Apply the v2 PDF-only admission error without exposing internals."""
    if not _looks_like_pdf(path):
        raise ValueError(f"{V2_PDF_REQUIRED_ERROR_CODE}: Source Document must be a PDF")


def assert_v2_page_mapping_verified(verified: bool) -> None:
    """Reject document-level parser output before a v2 generation is published."""
    if not verified:
        raise ValueError(
            f"{V2_PAGE_MAPPING_ERROR_CODE}: physical-page mapping could not be verified"
        )
