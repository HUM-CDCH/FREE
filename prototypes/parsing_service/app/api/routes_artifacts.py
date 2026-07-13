"""Download routes for bounded canonical ingestion archives."""

from __future__ import annotations

import os
import tempfile
import zipfile
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from filelock import FileLock

from app.api.deps import http_task_dir, load_metadata, require_completed
from app.storage.blobs import (
    DEFAULT_ARCHIVE_MAX_BYTES,
    validate_task_capacity,
)
from app.storage.manifests import read_parsed_document
from app.storage.paths import (
    SERVICE_ROOT,
    document_store_dir,
    task_lock_path,
    task_store_lock_path,
)

router = APIRouter()


def _safe_service_artifact(ref: str) -> Path:
    service_root = SERVICE_ROOT.resolve()
    candidate = SERVICE_ROOT / ref
    if candidate.is_symlink():
        raise ValueError("Artifact reference may not be a symlink.")
    path = candidate.resolve()
    if not path.is_relative_to(service_root):
        raise ValueError("Artifact reference escaped the service root.")
    return path


def _archive_entries(task_dir: Path) -> list[tuple[Path, Path]]:
    parsed_document = read_parsed_document(task_dir)
    document_root = document_store_dir(
        parsed_document.document.content_sha256
    ).resolve()
    entries: list[tuple[Path, Path]] = []

    parsed_path = task_dir / "parsed_document.json"
    if parsed_path.is_file() and not parsed_path.is_symlink():
        entries.append((parsed_path, Path("parsed_document.json")))

    output_dir = task_dir / "output"
    if output_dir.exists():
        for path in sorted(output_dir.rglob("*")):
            if path.is_file() and not path.is_symlink():
                entries.append((path, Path("output") / path.relative_to(output_dir)))

    refs = {
        ref
        for ref in (
            parsed_document.artifacts.raw_docling_json_ref,
            parsed_document.artifacts.raw_doctags_ref,
            parsed_document.artifacts.llm_markdown_ref,
            *parsed_document.artifacts.debug_refs,
        )
        if ref
    }
    for ref in sorted(refs):
        path = _safe_service_artifact(ref)
        if not path.is_file() or not path.is_relative_to(document_root):
            raise ValueError("Canonical artifact reference is unavailable.")
        entries.append((path, Path("canonical") / path.relative_to(document_root)))
    return entries


def _write_task_archive(task_dir: Path, zip_path: Path) -> None:
    task_id = task_dir.name
    with FileLock(str(task_lock_path(task_id))):
        if zip_path.exists():
            return
        entries = _archive_entries(task_dir)
        total_input = sum(path.stat().st_size for path, _ in entries)
        if total_input > DEFAULT_ARCHIVE_MAX_BYTES:
            raise ValueError("Archive inputs exceed the configured quota.")

        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{zip_path.name}.", suffix=".tmp", dir=str(zip_path.parent)
        )
        os.close(fd)
        try:
            with zipfile.ZipFile(
                tmp_name,
                "w",
                compression=zipfile.ZIP_DEFLATED,
            ) as archive:
                for path, archive_name in entries:
                    archive.write(path, archive_name)
            archive_size = Path(tmp_name).stat().st_size
            if archive_size > DEFAULT_ARCHIVE_MAX_BYTES:
                raise ValueError("Generated archive exceeds the configured quota.")
            with FileLock(str(task_store_lock_path())):
                # The temporary archive is already inside task_dir and therefore
                # already included in current task-store usage.
                validate_task_capacity(task_dir)
                os.replace(tmp_name, zip_path)
        except Exception:
            with suppress(FileNotFoundError):
                os.unlink(tmp_name)
            raise


@router.get(
    "/tasks/{task_id}/download",
    response_class=FileResponse,
    responses={
        200: {
            "content": {
                "application/zip": {"schema": {"type": "string", "format": "binary"}}
            },
            "description": "Canonical ingestion archive.",
        }
    },
)
async def download_task_zip(task_id: str):
    metadata = load_metadata(task_id)
    require_completed(metadata, "output archive")

    task_dir = http_task_dir(task_id)
    zip_path = task_dir / f"{task_id}.zip"
    try:
        await run_in_threadpool(_write_task_archive, task_dir, zip_path)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(
            status_code=500,
            detail="Failed to generate output ZIP.",
        ) from exc

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"ingestion_results_{task_id[:8]}.zip",
    )
