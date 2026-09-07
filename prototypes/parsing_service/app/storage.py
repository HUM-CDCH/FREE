"""Small, task-local filesystem store with atomic publication."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import uuid
import zipfile
from collections.abc import Mapping
from pathlib import Path, PureWindowsPath
from typing import Any, BinaryIO


SOURCE_FILENAME = "source.pdf"
METADATA_FILENAME = "metadata.json"
PARSED_DOCUMENT_FILENAME = "parsed_document.json"
MARKDOWN_FILENAME = "artifacts/document.llm.md"
MANIFEST_FILENAME = "manifest.json"
PACKAGE_VERSION = "canonical-ingestion-package.v1"
PARSED_DOCUMENT_VERSION = "parsed_document.v2"
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

_PACKAGE_ENTRIES = (
    (SOURCE_FILENAME, "application/pdf"),
    (PARSED_DOCUMENT_FILENAME, "application/json"),
    (MARKDOWN_FILENAME, "text/markdown; charset=utf-8"),
)


class TaskNotFoundError(FileNotFoundError):
    pass


class UploadTooLargeError(ValueError):
    pass


def canonical_task_id(task_id: str) -> str:
    try:
        return str(uuid.UUID(str(task_id)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("Task id must be a UUID.") from exc


def utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            separators=(",", ": "),
        )
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .encode("utf-8")
        + b"\n"
    )


def _markdown_bytes(value: str | bytes) -> bytes:
    if isinstance(value, bytes):
        text = value.decode("utf-8")
    elif isinstance(value, str):
        text = value
    else:
        raise ValueError("Canonical Markdown must be text or UTF-8 bytes.")
    return text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


def _portable_mapping(value: Any, label: str) -> dict[str, Any]:
    if isinstance(value, Mapping):
        data = dict(value)
    elif hasattr(value, "model_dump"):
        data = value.model_dump(mode="json")
    else:
        raise ValueError(f"{label} must be a mapping or Pydantic model.")
    try:
        copied = json.loads(json.dumps(data, ensure_ascii=False))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} is not JSON serializable.") from exc
    if not isinstance(copied, dict):
        raise ValueError(f"{label} must be a JSON object.")
    return copied


def _atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def _safe_display_filename(raw_name: str | None) -> str:
    value = str(raw_name or "upload.pdf").replace("\x00", "")
    name = Path(PureWindowsPath(value).name).name.strip()
    return name or "upload.pdf"


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.create_version = 20
    info.extract_version = 20
    info.flag_bits = 0x800
    info.external_attr = 0o100644 << 16
    info.internal_attr = 0
    info.extra = b""
    info.comment = b""
    return info


class TaskStorage:
    """Owns all durable state below one tasks directory."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def task_dir(self, task_id: str) -> Path:
        path = (self.root / canonical_task_id(task_id)).resolve()
        try:
            path.relative_to(self.root)
        except ValueError as exc:  # defensive; canonical UUIDs cannot traverse
            raise ValueError("Resolved path escapes the storage directory.") from exc
        return path

    def create_task_dir(self, task_id: str) -> Path:
        path = self.task_dir(task_id)
        path.mkdir(parents=True, exist_ok=False)
        return path

    def remove_task_dir(self, task_id: str) -> None:
        path = self.task_dir(task_id)
        if path.parent == self.root and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)

    def metadata_path(self, task_id: str) -> Path:
        return self.task_dir(task_id) / METADATA_FILENAME

    def save_metadata(self, metadata: Mapping[str, Any]) -> None:
        task_id = canonical_task_id(str(metadata.get("task_id", "")))
        _atomic_write(self.metadata_path(task_id), _json_bytes(dict(metadata)))

    def load_metadata(self, task_id: str) -> dict[str, Any]:
        canonical = canonical_task_id(task_id)
        path = self.metadata_path(canonical)
        if not _regular_file(path):
            raise TaskNotFoundError(canonical)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Task metadata is unreadable.") from exc
        if not isinstance(value, dict) or value.get("task_id") != canonical:
            raise ValueError("Task metadata identity is invalid.")
        return value

    def store_upload(
        self,
        task_id: str,
        stream: BinaryIO,
        *,
        filename: str | None,
        content_type: str | None,
        max_bytes: int = MAX_UPLOAD_BYTES,
    ) -> tuple[Path, str, str, int]:
        display_name = _safe_display_filename(filename)
        if not display_name.lower().endswith(".pdf"):
            raise ValueError("Uploaded file must be a PDF.")
        media_type = (content_type or "").partition(";")[0].strip().lower()
        allowed = {
            "application/pdf",
            "application/x-pdf",
            "application/octet-stream",
            "binary/octet-stream",
            "",
        }
        if media_type not in allowed:
            raise TypeError(
                f"Uploaded source document must be a PDF, not {media_type}."
            )

        destination = self.task_dir(task_id) / SOURCE_FILENAME
        fd, temporary = tempfile.mkstemp(
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
        )
        digest = hashlib.sha256()
        total = 0
        header = b""
        try:
            with os.fdopen(fd, "wb") as handle:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    if not isinstance(chunk, bytes):
                        raise ValueError("Uploaded file stream did not return bytes.")
                    total += len(chunk)
                    if total > max_bytes:
                        raise UploadTooLargeError(
                            "Uploaded PDF exceeds the maximum allowed size."
                        )
                    if len(header) < 5:
                        header = (header + chunk)[:5]
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            if header != b"%PDF-":
                raise ValueError("Input does not appear to be a PDF document.")
            os.replace(temporary, destination)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        return destination, display_name, digest.hexdigest(), total

    def source_path(self, task_id: str) -> Path:
        return self.task_dir(task_id) / SOURCE_FILENAME

    def parsed_document_path(self, task_id: str) -> Path:
        return self.task_dir(task_id) / PARSED_DOCUMENT_FILENAME

    def markdown_path(self, task_id: str) -> Path:
        return self.task_dir(task_id) / MARKDOWN_FILENAME

    def package_path(self, task_id: str) -> Path:
        canonical = canonical_task_id(task_id)
        return self.task_dir(canonical) / f"{canonical}.zip"

    def discard_result(self, task_id: str) -> None:
        """Remove only publishable output, retaining source and task metadata."""

        for path in (
            self.parsed_document_path(task_id),
            self.markdown_path(task_id),
            self.task_dir(task_id) / MANIFEST_FILENAME,
            self.package_path(task_id),
        ):
            path.unlink(missing_ok=True)

    def read_parsed_document(self, task_id: str) -> dict[str, Any]:
        path = self.parsed_document_path(task_id)
        if not _regular_file(path):
            raise FileNotFoundError("Parsed document JSON not found")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Parsed document JSON is unreadable.") from exc
        if not isinstance(value, dict):
            raise ValueError("Parsed document JSON is not an object.")
        return value

    def read_markdown(self, task_id: str) -> bytes:
        path = self.markdown_path(task_id)
        if not _regular_file(path):
            raise FileNotFoundError("Canonical Markdown not found")
        return path.read_bytes()

    def publish_result(
        self,
        task_id: str,
        parsed_document: Any,
        markdown: str | bytes,
        *,
        content_sha256: str,
        preprocess_id: str,
    ) -> Path:
        document = _portable_mapping(parsed_document, "Canonical document")
        identity = document.get("document")
        preprocessing = document.get("preprocessing")
        artifacts = document.get("artifacts")
        if document.get("schema_version") != PARSED_DOCUMENT_VERSION:
            raise ValueError("Canonical package requires parsed_document.v2.")
        if (
            not isinstance(identity, Mapping)
            or identity.get("content_sha256") != content_sha256
        ):
            raise ValueError("Canonical document source identity is inconsistent.")
        if (
            not isinstance(preprocessing, Mapping)
            or preprocessing.get("preprocess_id") != preprocess_id
        ):
            raise ValueError("Canonical document preprocessing identity is inconsistent.")
        if artifacts != {
            "source_ref": SOURCE_FILENAME,
            "parsed_json_ref": PARSED_DOCUMENT_FILENAME,
            "markdown_ref": MARKDOWN_FILENAME,
        }:
            raise ValueError("Canonical document artifact references are invalid.")

        source_path = self.source_path(task_id)
        if not _regular_file(source_path):
            raise ValueError("Task source PDF is unavailable.")
        source = source_path.read_bytes()
        if _sha256(source) != content_sha256:
            raise ValueError("Task source PDF failed its integrity check.")
        parsed = _json_bytes(document)
        rendered = _markdown_bytes(markdown)
        entry_bytes = {
            SOURCE_FILENAME: source,
            PARSED_DOCUMENT_FILENAME: parsed,
            MARKDOWN_FILENAME: rendered,
        }
        entries = [
            {
                "path": path,
                "media_type": media_type,
                "size": len(entry_bytes[path]),
                "sha256": _sha256(entry_bytes[path]),
            }
            for path, media_type in _PACKAGE_ENTRIES
        ]
        manifest = _json_bytes(
            {
                "package_version": PACKAGE_VERSION,
                "parsed_document_schema_version": PARSED_DOCUMENT_VERSION,
                "source_sha256": content_sha256,
                "preprocess_id": preprocess_id,
                "entries": entries,
            }
        )

        task_dir = self.task_dir(task_id)
        _atomic_write(task_dir / PARSED_DOCUMENT_FILENAME, parsed)
        _atomic_write(task_dir / MARKDOWN_FILENAME, rendered)
        _atomic_write(task_dir / MANIFEST_FILENAME, manifest)

        package_path = self.package_path(task_id)
        fd, temporary = tempfile.mkstemp(
            dir=task_dir,
            prefix=f".{package_path.name}.",
            suffix=".tmp",
        )
        os.close(fd)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr(_zip_info(MANIFEST_FILENAME), manifest)
                for path, _media_type in _PACKAGE_ENTRIES:
                    archive.writestr(_zip_info(path), entry_bytes[path])
            os.replace(temporary, package_path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        return package_path

    def recover_interrupted(self) -> int:
        recovered = 0
        for task_dir in self.root.iterdir():
            if task_dir.is_symlink() or not task_dir.is_dir():
                continue
            try:
                task_id = canonical_task_id(task_dir.name)
                metadata = self.load_metadata(task_id)
            except (TaskNotFoundError, OSError, TypeError, ValueError):
                continue
            if metadata.get("status") not in {"pending", "running", "cancelling"}:
                continue
            metadata["status"] = "failed"
            metadata["updated_at"] = utc_now()
            metadata["error_code"] = "service_restarted"
            metadata["error"] = "Parsing was interrupted by a service restart."
            self.save_metadata(metadata)
            recovered += 1
        return recovered


__all__ = [
    "MANIFEST_FILENAME",
    "MARKDOWN_FILENAME",
    "MAX_UPLOAD_BYTES",
    "METADATA_FILENAME",
    "PARSED_DOCUMENT_FILENAME",
    "SOURCE_FILENAME",
    "TaskNotFoundError",
    "TaskStorage",
    "UploadTooLargeError",
    "canonical_task_id",
    "utc_now",
]
