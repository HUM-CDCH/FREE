"""Download routes for canonical ingestion archives."""

from __future__ import annotations

from pathlib import Path
import zipfile

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse

from app.api.deps import http_task_dir, load_metadata, require_completed
from app.storage.canonical_package import PackageLease, assemble_task_package
from app.storage.manifests import read_committed_markdown, read_parsed_document

router = APIRouter()


def _write_v2_task_package(
    task_dir: Path, package_path: Path
) -> tuple[Path, PackageLease]:
    parsed_document = read_parsed_document(task_dir)
    try:
        markdown = read_committed_markdown(task_dir, parsed_document)
    except (FileNotFoundError, OSError, ValueError) as exc:
        raise ValueError("Canonical Markdown is unavailable.") from exc
    return assemble_task_package(
        task_dir,
        parsed_document,
        markdown,
        task_id=task_dir.name,
        output_path=package_path,
    )

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
async def download_task_zip(
    task_id: str,
    background_tasks: BackgroundTasks,
):
    metadata = load_metadata(task_id)
    require_completed(metadata, "output archive")

    task_dir = http_task_dir(task_id)
    zip_path = task_dir / f"{task_id}.zip"
    try:
        package_path, lease = _write_v2_task_package(task_dir, zip_path)
        background_tasks.add_task(lease.release)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(
            status_code=500,
            detail="Failed to generate output ZIP.",
        ) from exc

    return FileResponse(
        package_path,
        media_type="application/zip",
        filename=f"ingestion_results_{task_id[:8]}.zip",
    )
