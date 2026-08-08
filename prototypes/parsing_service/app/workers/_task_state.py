"""Pure task-state derivation for parsing workers."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from app.models.parsed_document_v2 import ParsedDocument, PublicParserProvenance
from app.parsing.orchestrator import CanonicalIngestionError
from app.storage.hashing import document_id_from_hash, preprocess_id_from_hashes
from app.storage.manifests import preprocessing_config_hash
from app.storage.paths import validate_task_id

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
        and parsed_document.preprocessing.preprocess_id
        == preprocess_id_from_hashes(content_sha256, preprocessing_config_hash(metadata))
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
            PublicParserProvenance(
                parser=run.parser,
                version=run.version,
                status=run.status,
                warnings=list(run.warnings),
                error=run.error,
            ).model_dump(mode="json")
            for run in exc.parser_runs
        ]
        updated["stats"] = {run.parser: run.metrics for run in exc.parser_runs}
    else:
        updated["error_code"] = "parsing_failed"
        updated["error"] = "Parsing failed. See server logs for details."
    updated["selected_parser"] = None
    updated["status"] = "failed"
    return updated


def validate_current_task_metadata(
    task_id: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Accept only a current upload task; never migrate legacy task shapes."""
    required = {
        "task_id", "document_id", "content_sha256", "source_path",
        "source_store_path", "source_kind", "status", "created_at",
        "updated_at", "params", "stats", "parser_runs", "selected_parser",
        "canonical_parsed_document_ref", "error_code", "error",
    }
    missing = sorted(required.difference(metadata))
    if missing or metadata.get("task_id") != task_id:
        raise ValueError("task_metadata_not_current")
    if metadata.get("source_kind") != "upload":
        raise ValueError("task_metadata_not_current")
    digest = metadata.get("content_sha256")
    if not isinstance(digest, str) or metadata.get("document_id") != document_id_from_hash(digest):
        raise ValueError("task_metadata_not_current")
    if not isinstance(metadata.get("params"), dict) or not isinstance(metadata.get("parser_runs"), list):
        raise ValueError("task_metadata_not_current")
    return dict(metadata)


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
