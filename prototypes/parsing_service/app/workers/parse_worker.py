"""Background worker for source-hash canonical ParsedDocuments."""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from app.models.parsed_document import ParsedDocument
from app.models.parser import canonical_preprocessing_config
from app.parsing.orchestrator import CanonicalIngestionError, build_parsed_document
from app.storage.blobs import (
    prune_document_store,
    prune_orphan_document_generations,
    prune_source_store,
    reserve_document_capacity,
    store_source_by_hash,
    validate_document_size,
    validate_task_capacity,
)
from app.storage.hashing import compute_sha256, document_id_from_hash
from app.storage.manifests import (
    json_payload_size,
    load_task_metadata,
    parsed_document_json_size,
    preprocessing_config_hash,
    read_canonical_parsed_document,
    rebase_parsed_document_artifacts,
    rebind_parsed_document_for_task,
    save_task_metadata,
    validate_canonical_document,
    write_canonical_parsed_document,
    write_parsed_document,
)
from app.storage.paths import (
    DEFAULT_DATA_DIR,
    PARSED_DOCUMENT_FILENAME,
    canonical_parsed_document_path,
    document_generation_dir,
    document_lock_path,
    document_store_lock_path,
    pending_document_generation_dir,
    service_relative_ref,
    source_store_path,
    task_dir_for,
    task_lock_path,
    task_store_lock_path,
    validate_task_id,
)

logger = logging.getLogger(__name__)

# Native parser workloads are memory-heavy. The file lock extends the same
# single-build admission policy across service processes.
_PARSER_ADMISSION = asyncio.Semaphore(1)
_CANONICAL_LOCK_TIMEOUT_SECONDS = 15 * 60
_ACTIVE_TASK_IDS: set[str] = set()


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _cached_document_matches_task(
    parsed_document: ParsedDocument,
    metadata: dict[str, Any],
) -> bool:
    content_sha256 = metadata.get("content_sha256")
    return bool(
        isinstance(content_sha256, str)
        and parsed_document.document.content_sha256 == content_sha256
        and parsed_document.document.document_id
        == document_id_from_hash(content_sha256)
        and parsed_document.preprocessing.config_hash
        == preprocessing_config_hash(metadata)
    )


def _load_valid_canonical(
    content_sha256: str,
    metadata: dict[str, Any],
) -> ParsedDocument | None:
    try:
        parsed_document = read_canonical_parsed_document(content_sha256)
        validate_canonical_document(
            parsed_document,
            expected_sha256=content_sha256,
            expected_config_hash=preprocessing_config_hash(metadata),
        )
    except (FileNotFoundError, OSError, ValueError):
        return None
    return parsed_document


def _authenticated_source_blob(
    task_id: str,
    content_sha256: str,
) -> Path:
    task_source = task_dir_for(task_id) / "source.pdf"
    if not task_source.is_file() or compute_sha256(task_source) != content_sha256:
        raise CanonicalIngestionError(
            "source_digest_mismatch",
            "Task source bytes do not match their recorded digest.",
        )
    source_blob = source_store_path(content_sha256)
    if not source_blob.is_file() or compute_sha256(source_blob) != content_sha256:
        source_blob = store_source_by_hash(task_source, content_sha256)
    return source_blob


def _new_generation_id(config_hash: str) -> str:
    return f"{config_hash[:16]}-{uuid.uuid4().hex}"


def _build_or_load_canonical(
    task_id: str,
    content_sha256: str,
    metadata: dict[str, Any],
) -> ParsedDocument:
    """Authenticate, build, and atomically publish one immutable generation."""
    canonical_path = canonical_parsed_document_path(content_sha256)
    source_blob = _authenticated_source_blob(task_id, content_sha256)
    store_lock = FileLock(str(document_store_lock_path()))
    source_lock = FileLock(str(document_lock_path(content_sha256)))

    try:
        with (
            store_lock.acquire(timeout=_CANONICAL_LOCK_TIMEOUT_SECONDS),
            source_lock.acquire(timeout=_CANONICAL_LOCK_TIMEOUT_SECONDS),
        ):
            cached = _load_valid_canonical(content_sha256, metadata)
            if cached is not None:
                return cached

            reserve_document_capacity(
                content_sha256=content_sha256,
                data_dir=DEFAULT_DATA_DIR,
            )
            config_hash = preprocessing_config_hash(metadata)
            generation_id = _new_generation_id(config_hash)
            pending_dir = pending_document_generation_dir(
                content_sha256,
                generation_id,
            )
            final_dir = document_generation_dir(content_sha256, generation_id)
            published_generation = False
            try:
                pending_artifacts = pending_dir / "artifacts"
                pending_artifacts.mkdir(parents=True, exist_ok=False)
                parsed_document = build_parsed_document(
                    task_id,
                    source_path=source_blob,
                    artifact_root=pending_artifacts,
                )
                parsed_document = rebase_parsed_document_artifacts(
                    parsed_document,
                    pending_dir,
                    final_dir,
                )
                validate_document_size(
                    content_sha256,
                    additional_bytes=parsed_document_json_size(parsed_document),
                    replacing_path=canonical_path,
                )
                final_dir.parent.mkdir(parents=True, exist_ok=True)
                os.replace(pending_dir, final_dir)
                published_generation = True
                validate_canonical_document(
                    parsed_document,
                    expected_sha256=content_sha256,
                    expected_config_hash=config_hash,
                )
                write_canonical_parsed_document(content_sha256, parsed_document)
                return parsed_document
            except Exception:
                shutil.rmtree(pending_dir, ignore_errors=True)
                if published_generation:
                    shutil.rmtree(final_dir, ignore_errors=True)
                raise
    except Timeout as exc:
        cached = _load_valid_canonical(content_sha256, metadata)
        if cached is not None:
            return cached
        raise CanonicalIngestionError(
            "canonical_build_timeout",
            "Timed out waiting for canonical source-document parsing.",
        ) from exc


def _persist_task_metadata(
    task_dir: Path,
    metadata: dict[str, Any],
) -> None:
    metadata_path = task_dir / "metadata.json"
    with FileLock(str(task_store_lock_path())):
        validate_task_capacity(
            task_dir,
            additional_bytes=json_payload_size(metadata),
            replacing_paths=(metadata_path,),
        )
        save_task_metadata(task_dir, metadata)


def _completed_metadata(
    task_dir: Path,
    metadata: dict[str, Any],
    parsed_document: ParsedDocument,
) -> dict[str, Any]:
    rebound = rebind_parsed_document_for_task(task_dir, metadata, parsed_document)
    updated = dict(metadata)
    updated["document_id"] = document_id_from_hash(rebound.document.content_sha256)
    updated["stats"] = {run.parser: run.metrics for run in rebound.parser_runs}
    updated["parser_runs"] = [
        run.model_dump(mode="json") for run in rebound.parser_runs
    ]
    updated["selected_parser"] = rebound.arbitration.primary_document_parser
    updated["canonical_parsed_document_ref"] = service_relative_ref(
        canonical_parsed_document_path(rebound.document.content_sha256)
    )
    updated["status"] = "completed"
    updated["error_code"] = None
    updated["error"] = None
    updated["updated_at"] = _utc_now()

    parsed_path = task_dir / PARSED_DOCUMENT_FILENAME
    metadata_path = task_dir / "metadata.json"
    with FileLock(str(task_store_lock_path())):
        validate_task_capacity(
            task_dir,
            additional_bytes=(
                parsed_document_json_size(rebound) + json_payload_size(updated)
            ),
            replacing_paths=(parsed_path, metadata_path),
        )
        write_parsed_document(task_dir, rebound)
        save_task_metadata(task_dir, updated)
    return updated


def _failure_metadata(
    metadata: dict[str, Any],
    exc: Exception,
) -> dict[str, Any]:
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


def _run_task_sync(task_id: str) -> None:
    task_dir = task_dir_for(task_id)
    lock = FileLock(str(task_lock_path(task_id)))
    with lock.acquire(timeout=_CANONICAL_LOCK_TIMEOUT_SECONDS):
        metadata = load_task_metadata(task_dir)
        metadata["status"] = "running"
        metadata["updated_at"] = _utc_now()
        _persist_task_metadata(task_dir, metadata)
        try:
            content_sha256 = metadata.get("content_sha256")
            if not isinstance(content_sha256, str) or not content_sha256:
                raise CanonicalIngestionError(
                    "source_digest_missing",
                    "Task metadata is missing its source digest.",
                )
            parsed_document = _build_or_load_canonical(
                task_id,
                content_sha256,
                metadata,
            )
            _completed_metadata(
                task_dir,
                load_task_metadata(task_dir),
                parsed_document,
            )
        except Exception as exc:
            logger.exception("Canonical parsing task %s failed", task_id)
            metadata = _failure_metadata(load_task_metadata(task_dir), exc)
            metadata["updated_at"] = _utc_now()
            _persist_task_metadata(task_dir, metadata)


async def run_extraction_task(
    task_id: str,
    source_path: str,
    dpi: int | None = None,
    pipeline: str | None = None,
    device: str | None = None,
):
    """Compatibility entry point for the canonical ingestion worker."""
    _ = (source_path, dpi, pipeline, device)
    _ACTIVE_TASK_IDS.add(task_id)
    try:
        async with _PARSER_ADMISSION:
            await asyncio.to_thread(_run_task_sync, task_id)
    except Timeout:
        logger.warning("Task %s is already owned by another worker", task_id)
    except Exception as exc:
        logger.exception("Could not dispatch canonical parsing task %s", task_id)
        task_dir = task_dir_for(task_id)
        metadata = _failure_metadata(load_task_metadata(task_dir), exc)
        metadata["updated_at"] = _utc_now()
        _persist_task_metadata(task_dir, metadata)
    finally:
        _ACTIVE_TASK_IDS.discard(task_id)


def _normalize_legacy_metadata(
    task_id: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
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
        "source_name": str(params.get("source_name") or "source.pdf"),
    }
    normalized.setdefault("source_path", "source.pdf")
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
    now = _utc_now()
    normalized.setdefault("created_at", now)
    normalized.setdefault("updated_at", now)
    return normalized


def reconcile_interrupted_tasks() -> int:
    """Finish from a valid cache or mark interrupted tasks failed on startup."""
    reconciled = 0
    data_path = Path(DEFAULT_DATA_DIR)
    if not data_path.exists():
        return reconciled
    for entry in data_path.iterdir():
        if not entry.is_dir():
            continue
        try:
            task_id = validate_task_id(entry.name)
        except ValueError:
            continue
        lock = FileLock(str(task_lock_path(task_id)))
        try:
            with lock.acquire(timeout=0):
                try:
                    metadata = load_task_metadata(entry)
                except (OSError, ValueError):
                    logger.warning("Skipping malformed task metadata in %s", entry)
                    continue
                metadata = _normalize_legacy_metadata(task_id, metadata)
                content_sha256 = metadata.get("content_sha256")
                if metadata.get("status") in {"pending", "running"}:
                    cached = (
                        _load_valid_canonical(content_sha256, metadata)
                        if isinstance(content_sha256, str)
                        else None
                    )
                    if cached is not None:
                        _completed_metadata(entry, metadata, cached)
                        reconciled += 1
                        continue
                    metadata["status"] = "failed"
                    metadata["error_code"] = "task_interrupted"
                    metadata["error"] = (
                        "Parsing was interrupted before a canonical result was published."
                    )
                    reconciled += 1
                metadata["updated_at"] = _utc_now()
                _persist_task_metadata(entry, metadata)
        except Timeout:
            continue
    return reconciled


def cleanup_once(*, now: float | None = None) -> int:
    """Remove expired inactive tasks and prune unreferenced source stores."""
    removed = 0
    current = time.time() if now is None else now
    cutoff = current - 24 * 3600
    data_path = Path(DEFAULT_DATA_DIR)
    if data_path.exists():
        for entry in data_path.iterdir():
            if not entry.is_dir():
                continue
            try:
                task_id = validate_task_id(entry.name)
            except ValueError:
                continue
            if task_id in _ACTIVE_TASK_IDS:
                continue
            meta_path = entry / "metadata.json"
            try:
                modified = (
                    meta_path.stat().st_mtime
                    if meta_path.exists()
                    else entry.stat().st_mtime
                )
            except OSError:
                continue
            if modified >= cutoff:
                continue
            lock = FileLock(str(task_lock_path(task_id)))
            try:
                with lock.acquire(timeout=0):
                    shutil.rmtree(entry)
                    removed += 1
            except (Timeout, FileNotFoundError, PermissionError, OSError):
                continue
    prune_source_store(data_dir=DEFAULT_DATA_DIR)
    document_store_lock = FileLock(str(document_store_lock_path()))
    try:
        with document_store_lock.acquire(timeout=0):
            prune_orphan_document_generations(data_dir=DEFAULT_DATA_DIR)
            prune_document_store(data_dir=DEFAULT_DATA_DIR)
    except Timeout:
        pass
    return removed


async def cleanup_loop():
    logger.info("Starting hourly task cleanup loop")
    while True:
        try:
            await asyncio.to_thread(cleanup_once)
        except Exception:
            logger.exception("Task cleanup pass failed")
        await asyncio.sleep(3600)
