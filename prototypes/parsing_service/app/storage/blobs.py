"""Content-addressed storage and retention cleanup."""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from contextlib import suppress
from pathlib import Path

from app.storage import paths
from app.storage.atomic_json import read_json
from app.storage.hashing import compute_sha256

SOURCE_GRACE_SECONDS = 3600
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
    for metadata_path in base.glob("*/metadata.json"):
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
    cutoff = (time.time() if now is None else now) - SOURCE_GRACE_SECONDS
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
        os.replace(tmp_name, destination)
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


def _iter_string_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _iter_string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_string_values(item)


def _referenced_generation_dirs(
    *,
    data_dir: Path,
    document_store: Path,
) -> set[Path]:
    manifests = list(document_store.glob("*/parsed_document.json"))
    manifests.extend(data_dir.glob("*/parsed_document.json"))
    referenced: set[Path] = set()
    for manifest in manifests:
        try:
            payload = read_json(manifest)
        except ValueError:
            continue
        for value in _iter_string_values(payload):
            candidate = (paths.SERVICE_ROOT / value).resolve()
            try:
                relative = candidate.relative_to(document_store.resolve())
            except ValueError:
                continue
            parts = relative.parts
            if len(parts) >= 3 and parts[1] == "generations":
                referenced.add(
                    (document_store / parts[0] / parts[1] / parts[2]).resolve()
                )
    return referenced


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
    referenced = _referenced_generation_dirs(
        data_dir=tasks,
        document_store=base,
    )
    removed = 0
    for document_dir in base.iterdir():
        if not document_dir.is_dir() or not paths.is_sha256_hex(document_dir.name):
            continue
        pending = document_dir / ".pending"
        if pending.exists():
            for generation in list(pending.iterdir()):
                if generation.is_dir():
                    try:
                        shutil.rmtree(generation)
                    except OSError:
                        continue
                    removed += 1
        generations = document_dir / "generations"
        if not generations.exists():
            continue
        for generation in list(generations.iterdir()):
            if generation.is_dir() and generation.resolve() not in referenced:
                try:
                    shutil.rmtree(generation)
                except OSError:
                    continue
                removed += 1
    return removed


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
