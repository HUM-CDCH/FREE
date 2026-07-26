"""Pure task-state derivation for parsing workers."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from app.models.parsed_document import ParsedDocument
from app.models.parser import canonical_preprocessing_config
from app.parsing.orchestrator import CanonicalIngestionError
from app.storage.hashing import document_id_from_hash
from app.storage.manifests import preprocessing_config_hash
from app.storage.paths import validate_task_id
from app.timing import utc_now

_SOURCE_PDF_FILENAME = "source.pdf"


def cached_document_matches_task(
    parsed_document: ParsedDocument,
    metadata: dict[str, Any],
) -> bool:
    """Return whether a canonical document satisfies a task's identity/config."""
    content_sha256 = metadata.get("content_sha256")
    return bool(
        isinstance(content_sha256, str)
        and parsed_document.document.content_sha256 == content_sha256
        and parsed_document.document.document_id
        == document_id_from_hash(content_sha256)
        and parsed_document.preprocessing.config_hash
        == preprocessing_config_hash(metadata)
    )


def failure_metadata(
    metadata: dict[str, Any],
    exc: Exception,
) -> dict[str, Any]:
    """Derive terminal failure state without mutating stored metadata."""
    updated = dict(metadata)
    if isinstance(exc, CanonicalIngestionError):
        updated["error_code"] = exc.code
        updated["error"] = exc.public_message
        updated["parser_runs"] = [
            run.model_dump(mode="json") for run in exc.parser_runs
        ]
        updated["stats"] = {run.parser: run.metrics for run in exc.parser_runs}
    else:
        updated["error_code"] = "parsing_failed"
        updated["error"] = "Parsing failed. See server logs for details."
    updated["selected_parser"] = None
    updated["status"] = "failed"
    return updated


def normalize_legacy_metadata(
    task_id: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Fill current task-state fields while preserving recorded values."""
    normalized = dict(metadata)
    normalized["task_id"] = task_id
    content_sha256 = normalized.get("content_sha256")
    if isinstance(content_sha256, str):
        normalized["document_id"] = document_id_from_hash(content_sha256)
        normalized.setdefault(
            "source_store_path",
            f"data/sources/{content_sha256}.pdf",
        )
    params = dict(normalized.get("params", {}))
    resolved_device = str(
        params.get("resolved_ocr_device") or params.get("device") or "cpu"
    )
    normalized["params"] = {
        **canonical_preprocessing_config(resolved_ocr_device=resolved_device),
        **params,
        "resolved_ocr_device": resolved_device,
        "source_name": str(params.get("source_name") or _SOURCE_PDF_FILENAME),
    }
    normalized.setdefault("source_path", _SOURCE_PDF_FILENAME)
    normalized.setdefault(
        "source_kind",
        "url" if normalized.get("submitted_url") else "upload",
    )
    normalized.setdefault("stats", {})
    normalized.setdefault("parser_runs", [])
    normalized.setdefault("selected_parser", None)
    normalized.setdefault("canonical_parsed_document_ref", None)
    normalized.setdefault("error_code", None)
    normalized.setdefault("error", None)
    now = utc_now()
    normalized.setdefault("created_at", now)
    normalized.setdefault("updated_at", now)
    return normalized


def iter_task_entries(data_path: Path) -> Iterator[tuple[Path, str]]:
    """Yield UUID-named task directories and ignore unrelated entries."""
    for entry in data_path.iterdir():
        if not entry.is_dir():
            continue
        try:
            task_id = validate_task_id(entry.name)
        except ValueError:
            continue
        yield entry, task_id


def task_modified_at(entry: Path) -> float | None:
    """Read task metadata mtime, falling back to its directory mtime."""
    metadata_path = entry / "metadata.json"
    try:
        tracked_path = metadata_path if metadata_path.exists() else entry
        return tracked_path.stat().st_mtime
    except OSError:
        return None
