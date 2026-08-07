"""Deterministic, portable packages for canonical parsed documents.

This module deliberately has no knowledge of task metadata or parser-specific
artifacts.  It is the boundary at which a committed canonical document leaves
the parsing-service cache.  The package format is intentionally small and
boring: callers can validate it without importing the service.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import stat
import tempfile
import time
import zipfile
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from filelock import FileLock

from app.storage.paths import task_lock_path

PACKAGE_SCHEMA_VERSION = "canonical-ingestion-package.v1"
PARSED_DOCUMENT_SCHEMA_VERSION = "parsed_document.v2"
PACKAGE_ENTRY_NAMES = (
    "manifest.json",
    "source.pdf",
    "parsed_document.json",
    "artifacts/document.llm.md",
)
DELIVERY_LEASE_TTL_SECONDS = 2 * 3600
_NON_MANIFEST_ENTRY_NAMES = PACKAGE_ENTRY_NAMES[1:]

_MEDIA_TYPES = {
    "source.pdf": "application/pdf",
    "parsed_document.json": "application/json",
    "artifacts/document.llm.md": "text/markdown; charset=utf-8",
}


class PackageError(ValueError):
    """Raised when a package cannot be safely assembled or validated."""


class PackageValidationError(PackageError):
    """Raised when a ZIP is not a valid canonical package."""


@dataclass(frozen=True)
class PackageLease:
    """A delivery lease which keeps a task directory live during streaming."""

    path: Path

    def release(self) -> None:
        with suppress(FileNotFoundError):
            self.path.unlink()

    def __enter__(self) -> PackageLease:
        return self

    def __exit__(self, *_: object) -> None:
        self.release()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _regular_file(path: Path, label: str) -> Path:
    if path.is_symlink() or not path.is_file():
        raise PackageError(f"Required {label} is unavailable.")
    return path


def normalize_package_path(value: str) -> str:
    """Return a safe canonical ZIP path, rejecting aliases and traversal."""
    if not isinstance(value, str) or not value or "\\" in value:
        raise PackageValidationError("Package path is not a safe UTF-8 POSIX path.")
    if "\x00" in value or value.startswith("/"):
        raise PackageValidationError("Package path is absolute or malformed.")
    path = PurePosixPath(value)
    if str(path) != value or any(part in {"", ".", ".."} for part in path.parts):
        raise PackageValidationError("Package path is not normalized.")
    return value


def _portable_document_data(document: Any) -> dict[str, Any]:
    if isinstance(document, Mapping):
        data: Any = json.loads(json.dumps(document, ensure_ascii=False))
    elif hasattr(document, "model_dump"):
        data = document.model_dump(mode="json")
    else:
        raise PackageError("Canonical document must be a mapping or Pydantic model.")
    if not isinstance(data, dict):
        raise PackageError("Canonical document must be a JSON object.")
    return data


def portable_document_payload(document: Any) -> dict[str, Any]:
    """Return the route/package JSON payload with portable artifact refs."""
    return _portable_document_data(document)


def portable_document_json(document: Any) -> bytes:
    """Serialize a canonical document with package-relative references."""
    data = portable_document_payload(document)
    schema = data.get("schema_version")
    if schema != PARSED_DOCUMENT_SCHEMA_VERSION:
        raise PackageError("Canonical package requires parsed_document.v2.")
    try:
        from app.models.parsed_document_v2 import ParsedDocument

        ParsedDocument.model_validate(data)
    except (ImportError, TypeError, ValueError) as exc:
        raise PackageError(
            "Canonical document does not satisfy parsed_document.v2."
        ) from exc
    return _json_bytes(data)


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


def _markdown_bytes(markdown: str | bytes) -> bytes:
    if isinstance(markdown, str):
        value = markdown
    elif isinstance(markdown, bytes):
        try:
            value = markdown.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PackageError("Canonical Markdown is not UTF-8.") from exc
    else:
        raise PackageError("Canonical Markdown must be text or UTF-8 bytes.")
    return value.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


def _identity(data: Mapping[str, Any]) -> tuple[str, str, str]:
    schema = data.get("schema_version")
    document = data.get("document")
    preprocessing = data.get("preprocessing")
    source_hash = (
        document.get("content_sha256") if isinstance(document, Mapping) else None
    )
    preprocess_id = (
        preprocessing.get("preprocess_id")
        if isinstance(preprocessing, Mapping)
        else None
    )
    if schema != PARSED_DOCUMENT_SCHEMA_VERSION:
        raise PackageError("Canonical package requires parsed_document.v2.")
    if not isinstance(source_hash, str) or len(source_hash) != 64:
        raise PackageError("Canonical document has no valid source hash.")
    if not isinstance(preprocess_id, str) or not preprocess_id:
        raise PackageError("Canonical document has no preprocessing identity.")
    return schema, source_hash, preprocess_id


def _entry_record(path: str, data: bytes) -> dict[str, Any]:
    return {
        "path": path,
        "media_type": _MEDIA_TYPES[path],
        "size": len(data),
        "sha256": _sha256_bytes(data),
    }


def _manifest_bytes(
    *,
    schema: str,
    source_sha256: str,
    preprocess_id: str,
    entries: list[dict[str, Any]],
) -> bytes:
    return _json_bytes(
        {
            "package_version": PACKAGE_SCHEMA_VERSION,
            "parsed_document_schema_version": schema,
            "source_sha256": source_sha256,
            "preprocess_id": preprocess_id,
            "entries": entries,
        }
    )


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename=name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3  # Unix, independent of the host that assembles it.
    info.create_version = 20
    info.extract_version = 20
    info.flag_bits = 0x800  # UTF-8 names, even when all fixed names are ASCII.
    info.external_attr = 0o100644 << 16
    info.internal_attr = 0
    info.extra = b""
    info.comment = b""
    return info


def _write_zip(path: Path, payloads: Mapping[str, bytes]) -> None:
    with zipfile.ZipFile(
        path, "w", compression=zipfile.ZIP_STORED, allowZip64=True
    ) as archive:
        for name in PACKAGE_ENTRY_NAMES:
            archive.writestr(_zip_info(name), payloads[name])


def assemble_package(
    source_path: str | os.PathLike[str],
    document: Any,
    markdown: str | bytes,
    output_path: str | os.PathLike[str],
) -> Path:
    """Atomically assemble one deterministic canonical package.

    The output is replaced only after all bytes have been written and closed.
    Any failure, including cancellation, removes the temporary sibling and
    leaves an existing output untouched.
    """
    source = _regular_file(Path(source_path), "Source Document")
    with source.open("rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise PackageError("Canonical package Source Document must be a PDF.")
    canonical_json = portable_document_json(document)
    document_data = json.loads(canonical_json)
    schema, expected_hash, preprocess_id = _identity(document_data)
    actual_hash = _sha256_file(source)
    if actual_hash != expected_hash:
        raise PackageError("Source Document hash does not match canonical document.")
    markdown_bytes = _markdown_bytes(markdown)
    payloads = {
        "source.pdf": source.read_bytes(),
        "parsed_document.json": canonical_json,
        "artifacts/document.llm.md": markdown_bytes,
    }
    entries = [
        _entry_record(name, payloads[name]) for name in _NON_MANIFEST_ENTRY_NAMES
    ]
    payloads["manifest.json"] = _manifest_bytes(
        schema=schema,
        source_sha256=actual_hash,
        preprocess_id=preprocess_id,
        entries=entries,
    )

    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent)
    )
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        _write_zip(temporary, payloads)
        validate_package(temporary)
        os.replace(temporary, destination)
    except BaseException:
        with suppress(FileNotFoundError):
            temporary.unlink()
        raise
    return destination


def _manifest_from_zip(archive: zipfile.ZipFile) -> dict[str, Any]:
    try:
        manifest = json.loads(archive.read("manifest.json"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackageValidationError("Package manifest is missing or invalid.") from exc
    if not isinstance(manifest, dict):
        raise PackageValidationError("Package manifest is not an object.")
    return manifest


def validate_package(package_path: str | os.PathLike[str]) -> dict[str, Any]:
    """Validate ZIP names, manifest declarations, bytes, and v2 identities."""
    path = _regular_file(Path(package_path), "package")
    try:
        archive = zipfile.ZipFile(path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise PackageValidationError("Package is not a readable ZIP.") from exc
    with archive:
        infos = archive.infolist()
        names = [normalize_package_path(info.filename) for info in infos]
        if len(names) != len(set(names)):
            raise PackageValidationError("Package contains duplicate entries.")
        if any(
            stat.S_ISDIR(info.external_attr >> 16)
            or stat.S_ISLNK(info.external_attr >> 16)
            or info.compress_type != zipfile.ZIP_STORED
            or info.date_time != (1980, 1, 1, 0, 0, 0)
            or info.create_system != 3
            or info.create_version != 20
            or info.extract_version != 20
            # zipfile clears the UTF-8 bit for ASCII-only names; all fixed
            # package names are ASCII, so both encodings are canonical.
            or info.flag_bits not in {0, 0x800}
            or info.external_attr != (0o100644 << 16)
            or info.internal_attr != 0
            or info.extra
            or info.comment
            for info in infos
        ):
            raise PackageValidationError(
                "Package entries may not be directories or symlinks."
            )
        if names != list(PACKAGE_ENTRY_NAMES):
            raise PackageValidationError(
                "Package entries do not match the fixed layout."
            )
        manifest = _manifest_from_zip(archive)
        if manifest.get("package_version") != PACKAGE_SCHEMA_VERSION:
            raise PackageValidationError("Unsupported package schema version.")
        if (
            manifest.get("parsed_document_schema_version")
            != PARSED_DOCUMENT_SCHEMA_VERSION
        ):
            raise PackageValidationError("Package does not contain parsed_document.v2.")
        records = manifest.get("entries")
        if not isinstance(records, list) or [
            record.get("path") for record in records if isinstance(record, dict)
        ] != list(_NON_MANIFEST_ENTRY_NAMES):
            raise PackageValidationError(
                "Manifest entries do not match the fixed layout."
            )
        if len(records) != len(_NON_MANIFEST_ENTRY_NAMES):
            raise PackageValidationError("Manifest contains missing or extra entries.")
        for record, name in zip(records, _NON_MANIFEST_ENTRY_NAMES, strict=True):
            if (
                not isinstance(record, dict)
                or normalize_package_path(record.get("path")) != name
            ):
                raise PackageValidationError("Manifest contains an unsafe entry path.")
            data = archive.read(name)
            if record.get("media_type") != _MEDIA_TYPES[name]:
                raise PackageValidationError("Package media type mismatch.")
            if record.get("size") != len(data) or record.get("sha256") != _sha256_bytes(
                data
            ):
                raise PackageValidationError("Package entry digest or size mismatch.")
        source = archive.read("source.pdf")
        if not source.startswith(b"%PDF-"):
            raise PackageValidationError("Package source is not a PDF.")
        if manifest.get("source_sha256") != _sha256_bytes(source):
            raise PackageValidationError("Package source digest mismatch.")
        try:
            document = json.loads(archive.read("parsed_document.json"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PackageValidationError(
                "Packaged canonical document is invalid JSON."
            ) from exc
        try:
            schema, source_hash, preprocess_id = _identity(document)
        except PackageError as exc:
            raise PackageValidationError(str(exc)) from exc
        if (
            schema != manifest["parsed_document_schema_version"]
            or source_hash != manifest["source_sha256"]
            or preprocess_id != manifest.get("preprocess_id")
        ):
            raise PackageValidationError(
                "Package identity does not match parsed document."
            )
        # Rewriting is also a strict check that no service-owned ref leaked in.
        try:
            if portable_document_json(document) != archive.read("parsed_document.json"):
                raise PackageValidationError(
                    "Packaged canonical JSON is not canonical."
                )
        except PackageError as exc:
            raise PackageValidationError(str(exc)) from exc
    return manifest


def create_delivery_lease(task_dir: str | os.PathLike[str]) -> PackageLease:
    """Create an exclusive lease marker before a package response is returned."""
    root = Path(task_dir) / ".delivery-leases"
    root.mkdir(parents=True, exist_ok=True)
    for _ in range(10):
        path = root / f"{os.getpid()}-{secrets.token_hex(12)}.lease"
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            continue
        os.close(fd)
        return PackageLease(path)
    raise PackageError("Could not create package delivery lease.")


def has_active_delivery_lease(task_dir: str | os.PathLike[str]) -> bool:
    root = Path(task_dir) / ".delivery-leases"
    if not root.is_dir():
        return False
    now = time.time()
    active = False
    for lease in root.glob("*.lease"):
        try:
            if now - lease.stat().st_mtime > DELIVERY_LEASE_TTL_SECONDS:
                lease.unlink()
            else:
                active = True
        except FileNotFoundError:
            continue
    return active


def assemble_task_package(
    task_dir: str | os.PathLike[str],
    document: Any,
    markdown: str | bytes,
    *,
    task_id: str | None = None,
    output_path: str | os.PathLike[str] | None = None,
) -> tuple[Path, PackageLease]:
    """Build a task package under its task lock and return a delivery lease."""
    root = Path(task_dir)
    task_name = task_id or root.name
    destination = (
        Path(output_path) if output_path is not None else root / f"{task_name}.zip"
    )
    with FileLock(str(task_lock_path(task_name, data_dir=root.parent))):
        if has_active_delivery_lease(root) and destination.exists():
            # Never replace an artifact which a FileResponse may open while a
            # prior lease is active. It is immutable for the response lifetime.
            validate_package(destination)
            lease = create_delivery_lease(root)
            package = destination
        else:
            source = root / "source.pdf"
            package = assemble_package(source, document, markdown, destination)
            try:
                # The lease is deliberately created while task ownership is
                # held; cleanup can only observe this package after publication
                # is safe.
                lease = create_delivery_lease(root)
            except BaseException:
                # A published package without a delivery lease is not a safe
                # response artifact. Fail closed rather than leaving a package
                # which cleanup may race.
                with suppress(FileNotFoundError):
                    package.unlink()
                raise
    return package, lease
