"""Safe path construction for task and source-store storage."""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path, PureWindowsPath

SERVICE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATA_DIR = SERVICE_ROOT / "data" / "tasks"
DEFAULT_SOURCE_STORE_DIR = SERVICE_ROOT / "data" / "sources"
DEFAULT_DOCUMENT_STORE_DIR = SERVICE_ROOT / "data" / "documents"

METADATA_FILENAME = "metadata.json"
PARSED_DOCUMENT_FILENAME = "parsed_document.json"
SOURCE_FILENAME = "source.pdf"

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_GENERATION_RE = re.compile(r"[0-9a-f]{16}-[0-9a-f]{32}")


def validate_task_id(task_id: str) -> str:
    """Return a canonical UUID task id or raise ValueError."""
    try:
        parsed = uuid.UUID(str(task_id))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("Task id must be a UUID.") from exc
    return str(parsed)


def _ensure_under_base(path: Path, base: Path) -> Path:
    resolved_base = base.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_base)
    except ValueError as exc:
        raise ValueError("Resolved path escapes the storage directory.") from exc
    return resolved_path


def task_dir_for(task_id: str, data_dir: str | os.PathLike[str] | None = None) -> Path:
    """Return the safe task directory path under data/tasks."""
    canonical_task_id = validate_task_id(task_id)
    base = Path(data_dir) if data_dir is not None else DEFAULT_DATA_DIR
    base.mkdir(parents=True, exist_ok=True)
    return _ensure_under_base(base / canonical_task_id, base)


def safe_display_filename(raw_name: str | None) -> str:
    """Sanitize an input filename for display-only metadata.

    The returned name is never used to build storage paths.
    """
    if not raw_name:
        return SOURCE_FILENAME

    # Treat both POSIX and Windows separators as path components.
    basename = PureWindowsPath(str(raw_name)).name
    basename = Path(basename).name
    basename = basename.replace("\x00", "").strip()
    basename = _SAFE_NAME_RE.sub("_", basename)
    basename = re.sub(r"\s+", " ", basename).strip(" .")

    if not basename:
        basename = SOURCE_FILENAME
    if len(basename) > 180:
        stem = Path(basename).stem[:150]
        suffix = Path(basename).suffix[:20]
        basename = f"{stem}{suffix}"
    return basename


def is_sha256_hex(value: str) -> bool:
    return bool(_SHA256_RE.fullmatch(value))


def _validate_content_sha256(content_sha256: str) -> None:
    if not is_sha256_hex(content_sha256):
        raise ValueError("content_sha256 must be a lowercase SHA-256 hex digest.")


def _validate_generation_id(generation_id: str) -> None:
    if not _GENERATION_RE.fullmatch(generation_id):
        raise ValueError("Invalid canonical generation id.")


def source_store_path(
    content_sha256: str, source_store_dir: str | os.PathLike[str] | None = None
) -> Path:
    _validate_content_sha256(content_sha256)
    base = (
        Path(source_store_dir)
        if source_store_dir is not None
        else DEFAULT_SOURCE_STORE_DIR
    )
    base.mkdir(parents=True, exist_ok=True)
    return _ensure_under_base(base / f"{content_sha256}.pdf", base)


def document_store_dir(
    content_sha256: str, base_dir: str | os.PathLike[str] | None = None
) -> Path:
    _validate_content_sha256(content_sha256)
    base = Path(base_dir) if base_dir is not None else DEFAULT_DOCUMENT_STORE_DIR
    base.mkdir(parents=True, exist_ok=True)
    return _ensure_under_base(base / content_sha256, base)


def document_artifacts_dir(
    content_sha256: str, base_dir: str | os.PathLike[str] | None = None
) -> Path:
    artifacts_dir = document_store_dir(content_sha256, base_dir) / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    return artifacts_dir


def document_generation_dir(
    content_sha256: str,
    generation_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> Path:
    _validate_generation_id(generation_id)
    root = document_store_dir(content_sha256, base_dir) / "generations"
    root.mkdir(parents=True, exist_ok=True)
    return _ensure_under_base(root / generation_id, root)


def pending_document_generation_dir(
    content_sha256: str,
    generation_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> Path:
    _validate_generation_id(generation_id)
    root = document_store_dir(content_sha256, base_dir) / ".pending"
    root.mkdir(parents=True, exist_ok=True)
    return _ensure_under_base(root / generation_id, root)


def _lock_dir(base: Path) -> Path:
    lock_dir = base / ".locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    return lock_dir


def document_lock_path(
    content_sha256: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> Path:
    _validate_content_sha256(content_sha256)
    base = Path(base_dir) if base_dir is not None else DEFAULT_DOCUMENT_STORE_DIR
    return _lock_dir(base) / f"{content_sha256}.lock"


def document_store_lock_path(
    base_dir: str | os.PathLike[str] | None = None,
) -> Path:
    base = Path(base_dir) if base_dir is not None else DEFAULT_DOCUMENT_STORE_DIR
    return _lock_dir(base) / "store.lock"


def task_lock_path(
    task_id: str,
    data_dir: str | os.PathLike[str] | None = None,
) -> Path:
    canonical_task_id = validate_task_id(task_id)
    base = Path(data_dir) if data_dir is not None else DEFAULT_DATA_DIR
    return _lock_dir(base) / f"{canonical_task_id}.lock"


def task_store_lock_path(
    data_dir: str | os.PathLike[str] | None = None,
) -> Path:
    base = Path(data_dir) if data_dir is not None else DEFAULT_DATA_DIR
    return _lock_dir(base) / "store.lock"


def canonical_parsed_document_path(
    content_sha256: str, base_dir: str | os.PathLike[str] | None = None
) -> Path:
    doc_dir = document_store_dir(content_sha256, base_dir)
    doc_dir.mkdir(parents=True, exist_ok=True)
    return doc_dir / PARSED_DOCUMENT_FILENAME


def service_relative_ref(path: Path) -> str:
    return path.resolve().relative_to(SERVICE_ROOT.resolve()).as_posix()


def safe_relative_ref(base: Path, path: Path) -> str:
    """Return a POSIX relative reference of path under base, or raise ValueError."""
    try:
        return path.resolve().relative_to(base.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError("Artifact path escaped the base directory.") from exc
def resolve_service_ref(ref: str) -> Path:
    """Resolve a service-relative artifact reference without symlink escapes."""
    service_root = SERVICE_ROOT.resolve()
    candidate = SERVICE_ROOT / ref
    if candidate.is_symlink():
        raise ValueError("Artifact reference may not be a symlink.")
    path = candidate.resolve()
    if not path.is_relative_to(service_root):
        raise ValueError("Artifact reference escaped the service root.")
    return path
