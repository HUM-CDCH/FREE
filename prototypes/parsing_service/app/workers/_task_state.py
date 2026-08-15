"""Pure task-state derivation for parsing workers."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from app.models.parsed_document_v2 import ParsedDocument, PublicParserProvenance
from app.models.parser import canonical_preprocessing_config
from app.parsing.orchestrator import CanonicalIngestionError
from app.storage.hashing import document_id_from_hash, preprocess_id_from_hashes
from app.storage.manifests import preprocessing_config_hash
from app.storage.paths import validate_task_id

_SOURCE_PDF_FILENAME = "source.pdf"
GENERIC_PARSING_ERROR = "Parsing failed. See server logs for details."


def new_attempt_diagnostics(queued_at: str) -> tuple[str, dict[str, Any]]:
    """Return the private processor-cache state for one queued attempt."""
    diagnostic_id = str(uuid.uuid4())
    return diagnostic_id, {
        "queued_at": queued_at,
        "started_at": None,
        "finished_at": None,
        "current_phase": None,
        "phases": {},
        "worker": {
            "pid": None,
            "peak_private_memory_bytes": 0,
            "thread_count": 0,
            "peak_thread_count": 0,
        },
        "failure": None,
    }


def new_task_metadata(
    *,
    task_id: str,
    content_sha256: str,
    source_name: str,
    resolved_ocr_device: str,
    queued_at: str,
) -> dict[str, Any]:
    diagnostic_id, attempt = new_attempt_diagnostics(queued_at)
    return {
        "task_id": task_id,
        "document_id": document_id_from_hash(content_sha256),
        "content_sha256": content_sha256,
        "source_path": _SOURCE_PDF_FILENAME,
        "source_store_path": f"data/sources/{content_sha256}.pdf",
        "source_kind": "upload",
        "status": "pending",
        "created_at": queued_at,
        "updated_at": queued_at,
        "params": {
            **canonical_preprocessing_config(
                resolved_ocr_device=resolved_ocr_device
            ),
            "source_name": source_name,
        },
        "stats": {},
        "parser_runs": [],
        "selected_parser": None,
        "canonical_parsed_document_ref": None,
        "error_code": None,
        "error": None,
        "diagnostic_id": diagnostic_id,
        "attempt": attempt,
        "attempt_history": [],
    }


def retry_task_metadata(
    metadata: dict[str, Any],
    *,
    queued_at: str,
) -> dict[str, Any]:
    """Queue the same authenticated task/source identity for another attempt."""
    updated = dict(metadata)
    history = list(metadata["attempt_history"])
    history.append(
        {
            "diagnostic_id": metadata["diagnostic_id"],
            **metadata["attempt"],
        }
    )
    diagnostic_id, attempt = new_attempt_diagnostics(queued_at)
    updated.update(
        {
            "status": "pending",
            "updated_at": queued_at,
            "stats": {},
            "parser_runs": [],
            "selected_parser": None,
            "canonical_parsed_document_ref": None,
            "canonical_generation_ref": None,
            "error_code": None,
            "error": None,
            "diagnostic_id": diagnostic_id,
            "attempt": attempt,
            "attempt_history": history,
        }
    )
    return updated


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
        updated["error"] = GENERIC_PARSING_ERROR
    updated["selected_parser"] = None
    updated["status"] = "failed"
    return updated


def validate_current_task_metadata(
    task_id: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Accept only a current upload task; never migrate legacy task shapes."""
    required = {
        "task_id",
        "document_id",
        "content_sha256",
        "source_path",
        "source_store_path",
        "source_kind",
        "status",
        "created_at",
        "updated_at",
        "params",
        "stats",
        "parser_runs",
        "selected_parser",
        "canonical_parsed_document_ref",
        "error_code",
        "error",
        "diagnostic_id",
        "attempt",
        "attempt_history",
    }
    missing = sorted(required.difference(metadata))
    if missing or metadata.get("task_id") != task_id:
        raise ValueError("task_metadata_not_current")
    if metadata.get("source_kind") != "upload":
        raise ValueError("task_metadata_not_current")
    digest = metadata.get("content_sha256")
    if not isinstance(digest, str) or metadata.get(
        "document_id"
    ) != document_id_from_hash(digest):
        raise ValueError("task_metadata_not_current")
    if not isinstance(metadata.get("params"), dict) or not isinstance(
        metadata.get("parser_runs"), list
    ):
        raise ValueError("task_metadata_not_current")
    diagnostic_id = metadata.get("diagnostic_id")
    try:
        if str(uuid.UUID(str(diagnostic_id))) != diagnostic_id:
            raise ValueError
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("task_metadata_not_current") from exc
    attempt = metadata.get("attempt")
    if (
        not isinstance(attempt, dict)
        or not isinstance(attempt.get("queued_at"), str)
        or not isinstance(attempt.get("phases"), dict)
        or not isinstance(attempt.get("worker"), dict)
    ):
        raise ValueError("task_metadata_not_current")
    if not isinstance(metadata.get("attempt_history"), list):
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
