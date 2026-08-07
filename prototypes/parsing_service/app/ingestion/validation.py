"""Source document content validation (trust boundary)."""

from __future__ import annotations

import os

PDF_MAGIC = b"%PDF-"
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
