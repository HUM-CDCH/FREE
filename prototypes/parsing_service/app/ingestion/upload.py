"""Uploaded source document handling (size caps, PDF checks, source store)."""

from __future__ import annotations

import os
import tempfile
from contextlib import suppress
from pathlib import Path

from fastapi import HTTPException, UploadFile

from app.ingestion.validation import ALLOWED_PDF_CONTENT_TYPES, assert_pdf_file
from app.storage.blobs import deduplicate_task_source, store_source_by_hash
from app.storage.hashing import compute_sha256
from app.storage.paths import SOURCE_FILENAME, safe_display_filename

MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def copy_upload_to_path(
    upload: UploadFile, destination: Path, max_bytes: int | None = None
) -> int:
    """Stream an UploadFile to destination with a hard byte cap and atomic move."""
    max_bytes = MAX_UPLOAD_BYTES if max_bytes is None else max_bytes
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent)
    )
    total = 0
    try:
        with os.fdopen(fd, "wb") as buffer:
            while True:
                chunk = upload.file.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("Uploaded PDF exceeds the maximum allowed size.")
                buffer.write(chunk)
        os.replace(tmp_name, destination)
        return total
    except Exception:
        with suppress(FileNotFoundError, PermissionError):
            os.unlink(tmp_name)
        raise


def upload_error_status(exc: Exception) -> int:
    return 413 if "exceeds the maximum allowed size" in str(exc) else 400


def validate_upload_mime(file: UploadFile) -> None:
    content_type = (file.content_type or "").partition(";")[0].strip().lower()
    if content_type and content_type not in ALLOWED_PDF_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Uploaded source document must be a PDF, not {content_type}.",
        )


def save_uploaded_source(file: UploadFile, task_dir: Path) -> tuple[Path, str, str]:
    """Persist an uploaded source PDF into the task dir and the source store."""
    display_name = safe_display_filename(file.filename)
    if not display_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a PDF.")
    validate_upload_mime(file)

    source_path = task_dir / SOURCE_FILENAME
    try:
        copy_upload_to_path(file, source_path)
        assert_pdf_file(source_path)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=upload_error_status(exc),
            detail=f"Uploaded file must be a PDF: {exc}",
        ) from exc

    content_sha256 = compute_sha256(source_path)
    try:
        source_blob = store_source_by_hash(source_path, content_sha256)
        deduplicate_task_source(source_path, source_blob)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=507,
            detail="Could not store source PDF.",
        ) from exc
    return source_path, display_name, content_sha256
