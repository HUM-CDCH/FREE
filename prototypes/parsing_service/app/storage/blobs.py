"""Content-addressed storage and retention cleanup."""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from contextlib import suppress
from pathlib import Path

from app.storage import paths
from app.storage._generation_pruning import (
    prune_orphan_document_generations as _prune_orphan_document_generations,
)
from app.storage.atomic_json import read_json
from app.storage.hashing import compute_sha256

DEFAULT_DOCUMENT_RETENTION_SECONDS = 7 * 24 * 3600


def _store_dir(source_store_dir: str | os.PathLike[str] | None) -> Path:
    return (
        Path(source_store_dir)
        if source_store_dir is not None
        else paths.DEFAULT_SOURCE_STORE_DIR
    )


def referenced_source_hashes(
    data_dir: str | os.PathLike[str] | None = None,
) -> set[str]:
    base = Path(data_dir) if data_dir is not None else paths.DEFAULT_DATA_DIR
    if not base.exists():
        return set()

    hashes: set[str] = set()
    for metadata_path in base.glob(f"*/{paths.METADATA_FILENAME}"):
        try:
            metadata = read_json(metadata_path)
        except ValueError:
            continue
        content_hash = metadata.get("content_sha256")
        if isinstance(content_hash, str) and paths.is_sha256_hex(content_hash):
            hashes.add(content_hash)
    return hashes


def prune_source_store(
    *,
    data_dir: str | os.PathLike[str] | None = None,
    source_store_dir: str | os.PathLike[str] | None = None,
    now: float | None = None,
) -> int:
    """Delete unreferenced source blobs after the publication grace."""
    base = _store_dir(source_store_dir)
    if not base.exists():
        return 0

    # ponytail: mtime grace instead of leases; revisit if multi-process
    referenced = referenced_source_hashes(data_dir)
    cutoff = (time.time() if now is None else now) - 3600
    removed = 0
    for path in base.glob("*.pdf"):
        try:
            modified = path.stat().st_mtime
        except OSError:
            continue
        if (
            paths.is_sha256_hex(path.stem)
            and path.stem not in referenced
            and modified <= cutoff
        ):
            with suppress(FileNotFoundError, PermissionError):
                path.unlink()
                removed += 1
    return removed


def store_source_by_hash(
    source_pdf: str | os.PathLike[str],
    content_sha256: str,
) -> Path:
    """Verify and atomically publish one content-addressed source blob."""
    source = Path(source_pdf)
    if compute_sha256(source) != content_sha256:
        raise ValueError("Source bytes do not match content_sha256.")
    destination = paths.source_store_path(content_sha256)
    if destination.exists():
        return destination

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{content_sha256}.", suffix=".tmp", dir=str(destination.parent)
    )
    try:
        with os.fdopen(fd, "wb") as tmp_file, open(source, "rb") as src_file:
            shutil.copyfileobj(src_file, tmp_file)
        try:
            os.replace(tmp_name, destination)
        except PermissionError:
            if not destination.exists():
                raise
        return destination
    finally:
        with suppress(FileNotFoundError, PermissionError):
            os.unlink(tmp_name)


def deduplicate_task_source(task_source: Path, source_blob: Path) -> None:
    """Replace a task copy with a hard link when both stores share a filesystem."""
    if task_source.resolve() == source_blob.resolve():
        return
    temporary = task_source.with_name(f".{task_source.name}.dedupe.tmp")
    with suppress(FileNotFoundError):
        temporary.unlink()
    try:
        os.link(source_blob, temporary)
        os.replace(temporary, task_source)
    except OSError:
        with suppress(FileNotFoundError):
            temporary.unlink()


def _document_store(
    document_store_dir: str | os.PathLike[str] | None = None,
) -> Path:
    return (
        Path(document_store_dir)
        if document_store_dir is not None
        else paths.DEFAULT_DOCUMENT_STORE_DIR
    )


def prune_orphan_document_generations(
    *,
    data_dir: str | os.PathLike[str] | None = None,
    document_store_dir: str | os.PathLike[str] | None = None,
) -> int:
    """Remove crash-abandoned generations while the document-store lock is held."""
    base = _document_store(document_store_dir)
    tasks = Path(data_dir) if data_dir is not None else paths.DEFAULT_DATA_DIR
    if not base.exists():
        return 0
    return _prune_orphan_document_generations(
        data_dir=tasks,
        document_store=base,
    )


def _document_mtime(document_dir: Path) -> float:
    parsed_document = document_dir / paths.PARSED_DOCUMENT_FILENAME
    target = parsed_document if parsed_document.exists() else document_dir
    try:
        return target.stat().st_mtime
    except OSError:
        return 0.0


def prune_document_store(
    *,
    data_dir: str | os.PathLike[str] | None = None,
    document_store_dir: str | os.PathLike[str] | None = None,
    retention_seconds: int = DEFAULT_DOCUMENT_RETENTION_SECONDS,
    now: float | None = None,
) -> int:
    """Remove unreferenced canonical documents after the retention period."""
    base = _document_store(document_store_dir)
    if not base.exists():
        return 0

    referenced = referenced_source_hashes(data_dir)
    cutoff = (time.time() if now is None else now) - retention_seconds
    removed = 0
    for document_dir in base.iterdir():
        if (
            not document_dir.is_dir()
            or not paths.is_sha256_hex(document_dir.name)
            or document_dir.name in referenced
            or _document_mtime(document_dir) > cutoff
        ):
            continue
        try:
            shutil.rmtree(document_dir)
        except OSError:
            continue
        removed += 1
    return removed
