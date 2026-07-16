"""Content-addressed storage and retention cleanup."""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from collections.abc import Iterable
from contextlib import suppress
from pathlib import Path

from filelock import FileLock

from app.storage import paths
from app.storage.atomic_json import read_json
from app.storage.hashing import compute_sha256

DEFAULT_SOURCE_STORE_MAX_BYTES = 1024 * 1024 * 1024
SOURCE_GRACE_SECONDS = 3600
DEFAULT_DOCUMENT_STORE_MAX_BYTES = 4 * 1024 * 1024 * 1024
DEFAULT_DOCUMENT_MAX_BYTES = 512 * 1024 * 1024
DEFAULT_DOCUMENT_RETENTION_SECONDS = 7 * 24 * 3600
DEFAULT_TASK_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_TASK_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024


def _store_dir(source_store_dir: str | os.PathLike[str] | None) -> Path:
    return (
        Path(source_store_dir)
        if source_store_dir is not None
        else paths.DEFAULT_SOURCE_STORE_DIR
    )


def source_store_usage(
    source_store_dir: str | os.PathLike[str] | None = None,
) -> int:
    base = _store_dir(source_store_dir)
    if not base.exists():
        return 0
    total = 0
    for path in base.glob("*.pdf"):
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


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


def _prune_source_store_unlocked(
    *,
    data_dir: str | os.PathLike[str] | None,
    base: Path,
    max_total_bytes: int,
    now: float | None = None,
) -> int:
    # ponytail: mtime grace instead of leases; revisit if multi-process
    referenced = referenced_source_hashes(data_dir)
    cutoff = (time.time() if now is None else now) - SOURCE_GRACE_SECONDS
    candidates: list[tuple[float, int, Path]] = []
    total = 0
    for path in base.glob("*.pdf"):
        try:
            stat = path.stat()
        except OSError:
            continue
        total += stat.st_size
        if (
            paths.is_sha256_hex(path.stem)
            and path.stem not in referenced
            and stat.st_mtime <= cutoff
        ):
            candidates.append((stat.st_mtime, stat.st_size, path))

    removed = 0
    for _, size, path in sorted(candidates):
        if total <= max_total_bytes:
            break
        with suppress(FileNotFoundError, PermissionError):
            path.unlink()
            total -= size
            removed += 1
    return removed


def prune_source_store(
    *,
    data_dir: str | os.PathLike[str] | None = None,
    source_store_dir: str | os.PathLike[str] | None = None,
    max_total_bytes: int = DEFAULT_SOURCE_STORE_MAX_BYTES,
    now: float | None = None,
) -> int:
    """Delete old unreferenced source blobs under one store lock."""
    base = _store_dir(source_store_dir)
    if not base.exists():
        return 0
    lock = FileLock(str(paths.source_store_lock_path(base)))
    with lock:
        return _prune_source_store_unlocked(
            data_dir=data_dir,
            base=base,
            max_total_bytes=max_total_bytes,
            now=now,
        )


def store_source_by_hash(
    source_pdf: str | os.PathLike[str],
    content_sha256: str,
    *,
    max_total_bytes: int = DEFAULT_SOURCE_STORE_MAX_BYTES,
    data_dir: str | os.PathLike[str] | None = None,
) -> Path:
    """Authenticate and publish one source blob in a locked quota transaction."""
    source = Path(source_pdf)
    if compute_sha256(source) != content_sha256:
        raise ValueError("Source bytes do not match content_sha256.")
    destination = paths.source_store_path(content_sha256)
    base = destination.parent
    lock = FileLock(str(paths.source_store_lock_path(base)))

    with lock:
        if destination.exists():
            if compute_sha256(destination) == content_sha256:
                return destination
            destination.unlink()

        source_size = source.stat().st_size
        if source_store_usage(base) + source_size > max_total_bytes:
            _prune_source_store_unlocked(
                data_dir=data_dir,
                base=base,
                max_total_bytes=max(0, max_total_bytes - source_size),
            )
        if source_store_usage(base) + source_size > max_total_bytes:
            raise ValueError("Source store quota exceeded.")

        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{content_sha256}.", suffix=".tmp", dir=str(base)
        )
        try:
            with os.fdopen(fd, "wb") as tmp_file, open(source, "rb") as src_file:
                shutil.copyfileobj(src_file, tmp_file)
            with suppress(FileExistsError):
                os.link(tmp_name, destination)
            if compute_sha256(destination) != content_sha256:
                with suppress(FileNotFoundError):
                    destination.unlink()
                raise ValueError("Published source blob failed digest validation.")
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


def directory_usage(path: Path, *, reject_symlinks: bool = False) -> int:
    total = 0
    if not path.exists():
        return total
    for entry in path.rglob("*"):
        if entry.is_symlink():
            if reject_symlinks:
                raise ValueError("Storage generations may not contain symlinks.")
            continue
        if not entry.is_file():
            continue
        with suppress(OSError):
            total += entry.stat().st_size
    return total


def document_store_usage(
    document_store_dir: str | os.PathLike[str] | None = None,
) -> int:
    return directory_usage(_document_store(document_store_dir))


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
    max_total_bytes: int = DEFAULT_DOCUMENT_STORE_MAX_BYTES,
    retention_seconds: int = DEFAULT_DOCUMENT_RETENTION_SECONDS,
    now: float | None = None,
) -> int:
    """Remove expired, unreferenced canonical documents and enforce quota."""
    base = _document_store(document_store_dir)
    if not base.exists():
        return 0

    referenced = referenced_source_hashes(data_dir)
    cutoff = (time.time() if now is None else now) - retention_seconds
    candidates: list[tuple[float, int, Path]] = []
    total = 0
    for document_dir in base.iterdir():
        if not document_dir.is_dir() or not paths.is_sha256_hex(document_dir.name):
            continue
        size = directory_usage(document_dir)
        total += size
        if document_dir.name not in referenced:
            candidates.append((_document_mtime(document_dir), size, document_dir))

    removed = 0
    for modified_at, size, document_dir in sorted(candidates):
        if modified_at >= cutoff and total <= max_total_bytes:
            continue
        try:
            shutil.rmtree(document_dir)
        except (FileNotFoundError, PermissionError, OSError):
            continue
        total -= size
        removed += 1
    return removed


def reserve_document_capacity(
    *,
    content_sha256: str,
    data_dir: str | os.PathLike[str] | None = None,
    max_total_bytes: int = DEFAULT_DOCUMENT_STORE_MAX_BYTES,
    max_document_bytes: int = DEFAULT_DOCUMENT_MAX_BYTES,
) -> None:
    """Perform conservative admission before starting a canonical parse."""
    document_dir = paths.document_store_dir(content_sha256)
    existing_size = directory_usage(document_dir)
    required = max(0, max_document_bytes - existing_size)
    target = max(0, max_total_bytes - required)
    prune_document_store(data_dir=data_dir, max_total_bytes=target)
    if document_store_usage() + required > max_total_bytes:
        raise ValueError("Canonical document store quota exceeded.")


def validate_document_size(
    content_sha256: str,
    *,
    additional_bytes: int = 0,
    replacing_path: Path | None = None,
    max_document_bytes: int = DEFAULT_DOCUMENT_MAX_BYTES,
    max_total_bytes: int = DEFAULT_DOCUMENT_STORE_MAX_BYTES,
) -> None:
    """Validate exact projected bytes, including a pending canonical manifest."""
    document_dir = paths.document_store_dir(content_sha256)
    replaced = 0
    if replacing_path is not None and replacing_path.exists():
        replaced = replacing_path.stat().st_size
    projected_document = (
        directory_usage(document_dir, reject_symlinks=True)
        - replaced
        + additional_bytes
    )
    if projected_document > max_document_bytes:
        raise ValueError(
            "Canonical document exceeds the per-document quota: "
            f"{projected_document} > {max_document_bytes}."
        )
    projected_store = document_store_usage() - replaced + additional_bytes
    if projected_store > max_total_bytes:
        raise ValueError("Canonical document store quota exceeded.")


def task_directory_usage(task_dir: Path) -> int:
    return directory_usage(task_dir, reject_symlinks=True)


def task_store_usage(data_dir: Path | None = None) -> int:
    base = data_dir or paths.DEFAULT_DATA_DIR
    total = 0
    seen_inodes: set[tuple[int, int]] = set()
    if not base.exists():
        return 0
    for entry in base.rglob("*"):
        if entry.is_symlink() or not entry.is_file():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        inode = (stat.st_dev, stat.st_ino)
        if inode in seen_inodes:
            continue
        seen_inodes.add(inode)
        total += stat.st_size
    return total


def validate_task_capacity(
    task_dir: Path,
    *,
    additional_bytes: int = 0,
    replacing_path: Path | None = None,
    replacing_paths: Iterable[Path] = (),
    max_task_bytes: int = DEFAULT_TASK_MAX_BYTES,
    max_total_bytes: int = DEFAULT_TASK_STORE_MAX_BYTES,
) -> None:
    candidates = [*replacing_paths]
    if replacing_path is not None:
        candidates.append(replacing_path)
    replaced = sum(path.stat().st_size for path in set(candidates) if path.exists())
    task_projected = task_directory_usage(task_dir) - replaced + additional_bytes
    if task_projected > max_task_bytes:
        raise ValueError("Task storage quota exceeded.")
    total_projected = task_store_usage(task_dir.parent) - replaced + additional_bytes
    if total_projected > max_total_bytes:
        raise ValueError("Aggregate task storage quota exceeded.")
