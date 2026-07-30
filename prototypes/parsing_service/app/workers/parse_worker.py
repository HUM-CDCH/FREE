"""Background worker for source-hash canonical ParsedDocuments."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from app.models.parsed_document import ParsedDocument
from app.parsing.orchestrator import (
    CanonicalIngestionError,
    build_canonical_generation,
)
from app.storage.canonical_package import has_active_delivery_lease
from app.storage.atomic_json import write_json_atomic
from app.storage.blobs import (
    prune_document_store,
    prune_orphan_document_generations,
    prune_source_store,
    store_source_by_hash,
)
from app.storage.hashing import compute_sha256, document_id_from_hash
from app.storage.manifests import (
    TaskNotFoundError,
    load_task_metadata,
    preprocessing_config_hash,
    read_canonical_generation_ref,
    read_canonical_parsed_document,
    rebase_parsed_document_artifacts,
    rebind_parsed_document_for_task,
    save_task_metadata,
    validate_canonical_document,
    write_canonical_generation_pointer,
    write_canonical_parsed_document,
    write_parsed_document,
)
from app.storage.paths import (
    DEFAULT_DATA_DIR,
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
)
from app.timing import utc_now
from app.workers._task_state import (
    cached_document_matches_task,
    failure_metadata as _failure_metadata,
    iter_task_entries as _iter_task_entries,
    validate_current_task_metadata as _validate_current_task_metadata,
    task_modified_at as _task_modified_at,
)

_cached_document_matches_task = cached_document_matches_task

logger = logging.getLogger(__name__)

# Native parser workloads are memory-heavy. The file lock extends the same
# single-build admission policy across service processes.
_PARSER_ADMISSION = asyncio.Semaphore(1)
_CANONICAL_LOCK_TIMEOUT_SECONDS = 15 * 60
_ACTIVE_TASK_IDS: set[str] = set()
_SOURCE_PDF_FILENAME = "source.pdf"


class _TaskStateError(Exception):
    pass


def _load_valid_canonical(
    content_sha256: str,
    metadata: dict[str, Any],
) -> ParsedDocument | None:
    try:
        parsed_document = read_canonical_parsed_document(content_sha256)
        if parsed_document.schema_version != "parsed_document.v2":
            return None
        validate_canonical_document(
            parsed_document,
            expected_sha256=content_sha256,
            expected_config_hash=preprocessing_config_hash(metadata),
        )
    except FileNotFoundError:
        return None
    except ValueError as exc:
        if isinstance(exc.__cause__, FileNotFoundError):
            return None
        if isinstance(exc.__cause__, OSError):
            raise OSError from exc
        return None
    return parsed_document


def _authenticated_source_blob(
    task_id: str,
    content_sha256: str,
) -> Path:
    task_source = task_dir_for(task_id) / _SOURCE_PDF_FILENAME
    if not task_source.is_file() or compute_sha256(task_source) != content_sha256:
        raise CanonicalIngestionError(
            "source_digest_mismatch",
            "Task source bytes do not match their recorded digest.",
        )
    source_blob = source_store_path(content_sha256)
    if not source_blob.is_file() or compute_sha256(source_blob) != content_sha256:
        source_blob = store_source_by_hash(task_source, content_sha256)
    return source_blob


def _reusable_canonical(
    content_sha256: str,
    metadata: dict[str, Any],
) -> ParsedDocument | None:
    """Return a cache entry only when it can be bound to a live generation.

    Task completion requires an immutable generation binding, so a canonical
    document whose generation was pruned is treated as a miss and rebuilt.
    """
    cached = _load_valid_canonical(content_sha256, metadata)
    if cached is None:
        return None
    generation_ref = read_canonical_generation_ref(
        content_sha256,
        expected_config_hash=preprocessing_config_hash(metadata),
    )
    if generation_ref is None:
        return None
    metadata["canonical_generation_ref"] = generation_ref
    return cached


def _new_generation_id(config_hash: str) -> str:
    return f"{config_hash[:16]}-{uuid.uuid4().hex}"


def _build_or_load_canonical(
    task_id: str,
    content_sha256: str,
    metadata: dict[str, Any],
) -> ParsedDocument:
    """Authenticate, build, and atomically publish one immutable generation."""
    source_blob = _authenticated_source_blob(task_id, content_sha256)
    store_lock = FileLock(str(document_store_lock_path()))
    source_lock = FileLock(str(document_lock_path(content_sha256)))

    try:
        with (
            store_lock.acquire(timeout=_CANONICAL_LOCK_TIMEOUT_SECONDS),
            source_lock.acquire(timeout=_CANONICAL_LOCK_TIMEOUT_SECONDS),
        ):
            cached = _reusable_canonical(content_sha256, metadata)
            if cached is not None:
                return cached

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
                built = build_canonical_generation(
                    task_id,
                    source_path=source_blob,
                    artifact_root=pending_artifacts,
                )
                parsed_document = built.document
                metadata["canonical_generation_ref"] = service_relative_ref(final_dir)
                write_json_atomic(
                    pending_artifacts / "generation-manifest.json",
                    built.generation_manifest,
                )
                parsed_document = rebase_parsed_document_artifacts(
                    parsed_document,
                    pending_dir,
                    final_dir,
                )
                final_dir.parent.mkdir(parents=True, exist_ok=True)
                os.replace(pending_dir, final_dir)
                published_generation = True
                write_canonical_generation_pointer(
                    content_sha256,
                    generation_ref=metadata["canonical_generation_ref"],
                    config_hash=config_hash,
                )
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
        cached = _reusable_canonical(content_sha256, metadata)
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
    store_lock = FileLock(str(task_store_lock_path()))
    with store_lock:
        try:
            save_task_metadata(task_dir, metadata)
        except (OSError, TypeError, ValueError) as exc:
            raise _TaskStateError from exc


def _completed_metadata(
    task_dir: Path,
    metadata: dict[str, Any],
    parsed_document: ParsedDocument,
) -> dict[str, Any]:
    canonical_ref = service_relative_ref(
        canonical_parsed_document_path(parsed_document.document.content_sha256)
    )
    try:
        rebound = rebind_parsed_document_for_task(task_dir, metadata, parsed_document)
        updated = dict(metadata)
        updated["document_id"] = document_id_from_hash(rebound.document.content_sha256)
        updated["stats"] = {run.parser: {} for run in rebound.parser_runs}
        updated["parser_runs"] = [
            run.model_dump(mode="json") for run in rebound.parser_runs
        ]
        updated["selected_parser"] = (
            rebound.arbitration.primary_document_parser
            if rebound.arbitration is not None
            else None
        )
        updated["canonical_parsed_document_ref"] = canonical_ref
        generation_ref = metadata.get("canonical_generation_ref")
        if generation_ref is None:
            raise ValueError(
                "Canonical parser output has no immutable generation binding."
            )
        updated["canonical_generation_ref"] = generation_ref
        updated["status"] = "completed"
        updated["error_code"] = None
        updated["error"] = None
        updated["updated_at"] = utc_now()
    except (OSError, TypeError, ValueError) as exc:
        raise _TaskStateError from exc

    store_lock = FileLock(str(task_store_lock_path()))
    with store_lock:
        try:
            write_parsed_document(task_dir, rebound)
            save_task_metadata(task_dir, updated)
        except (OSError, TypeError, ValueError) as exc:
            raise _TaskStateError from exc
    return updated


def _run_task_sync(task_id: str) -> None:
    task_dir = task_dir_for(task_id)
    lock = FileLock(str(task_lock_path(task_id)))
    with lock.acquire(timeout=_CANONICAL_LOCK_TIMEOUT_SECONDS):
        metadata = load_task_metadata(task_dir)
        metadata["status"] = "running"
        metadata["updated_at"] = utc_now()
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
                metadata,
                parsed_document,
            )
        except Exception as exc:
            logger.exception("Canonical parsing task %s failed", task_id)
            metadata = _failure_metadata(load_task_metadata(task_dir), exc)
            metadata["updated_at"] = utc_now()
            _persist_task_metadata(task_dir, metadata)


async def run_extraction_task(task_id: str):
    """Dispatch one task using only the persisted, authenticated task state."""
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
        metadata["updated_at"] = utc_now()
        _persist_task_metadata(task_dir, metadata)
    finally:
        _ACTIVE_TASK_IDS.discard(task_id)


def _probe_shared_store_locks() -> None:
    """Verify shared lock paths are accessible without requiring ownership."""
    for store_lock_path in (task_store_lock_path(), document_store_lock_path()):
        try:
            lock = FileLock(str(store_lock_path))
            lock.acquire(timeout=0)
            lock.release()
        except Timeout:
            pass


def _reconcile_task(entry: Path, task_id: str) -> bool:
    """Reconcile one locked task, isolating malformed task-local state."""
    try:
        stored_metadata = load_task_metadata(entry)
        metadata = _validate_current_task_metadata(task_id, stored_metadata)
        status = metadata.get("status")
        if status not in {"pending", "running", "completed", "failed"}:
            raise ValueError("Task metadata has an invalid status.")
        if status in {"completed", "failed"}:
            if metadata != stored_metadata:
                _persist_task_metadata(entry, metadata)
            return False

        content_sha256 = metadata.get("content_sha256")
        cached = (
            _load_valid_canonical(content_sha256, metadata)
            if isinstance(content_sha256, str)
            else None
        )
        if cached is not None:
            _completed_metadata(entry, metadata, cached)
            return True

        metadata["status"] = "failed"
        metadata["error_code"] = "task_interrupted"
        metadata["error"] = (
            "Parsing was interrupted before a canonical result was published."
        )
        metadata["updated_at"] = utc_now()
        _persist_task_metadata(entry, metadata)
        return True
    except (
        _TaskStateError,
        TaskNotFoundError,
        TypeError,
        ValueError,
    ) as exc:
        logger.warning(
            "Task recovery skipped for task %s (%s)",
            task_id,
            type(exc).__name__,
        )
        return False


def reconcile_interrupted_tasks() -> int:
    """Finish from a valid cache or mark interrupted tasks failed on startup."""
    _probe_shared_store_locks()
    reconciled = 0
    for entry, task_id in _iter_task_entries(Path(DEFAULT_DATA_DIR)):
        try:
            with FileLock(str(task_lock_path(task_id))).acquire(timeout=0):
                reconciled += _reconcile_task(entry, task_id)
        except Timeout:
            continue
    return reconciled


def _completed(entry: Path) -> bool:
    """A published task is retained; unreadable metadata is not a publication."""
    try:
        return load_task_metadata(entry).get("status") == "completed"
    except (TaskNotFoundError, ValueError):
        return False


def _remove_expired_task(entry: Path, task_id: str, cutoff: float) -> bool:
    if (
        task_id in _ACTIVE_TASK_IDS
        or _completed(entry)
        or has_active_delivery_lease(entry)
    ):
        return False
    modified = _task_modified_at(entry)
    if modified is None or modified >= cutoff:
        return False

    lock = FileLock(str(task_lock_path(task_id)))
    try:
        with lock.acquire(timeout=0):
            # The lease can be created after the first check while the lock is
            # being acquired. Re-check while owning the task lock so an active
            # FileResponse cannot lose its immutable delivery artifact.
            if has_active_delivery_lease(entry):
                return False
            shutil.rmtree(entry)
    except OSError:
        return False
    return True


def _prune_document_stores() -> None:
    document_store_lock = FileLock(str(document_store_lock_path()))
    try:
        with document_store_lock.acquire(timeout=0):
            prune_orphan_document_generations(data_dir=DEFAULT_DATA_DIR)
            prune_document_store(data_dir=DEFAULT_DATA_DIR)
    except Timeout:
        return


def cleanup_once(*, now: float | None = None) -> int:
    """Remove expired unpublished tasks and prune unreferenced source stores.

    A completed task never expires: its `task_id` is the `artifactReference` a
    consumer's own store pins for the life of the Source Representation, and the
    retained artifacts are the only copy — nothing upstream can re-supply them.
    The window therefore only reclaims tasks that never published (abandoned
    uploads, failures, interrupted parses).
    """
    current = time.time() if now is None else now
    cutoff = current - 24 * 3600
    data_path = Path(DEFAULT_DATA_DIR)
    entries = _iter_task_entries(data_path) if data_path.exists() else ()
    removed = sum(
        _remove_expired_task(entry, task_id, cutoff) for entry, task_id in entries
    )

    prune_source_store(data_dir=DEFAULT_DATA_DIR)
    _prune_document_stores()
    return removed


async def cleanup_loop():
    logger.info("Starting hourly task cleanup loop")
    while True:
        try:
            await asyncio.to_thread(cleanup_once)
        except Exception:
            logger.exception("Task cleanup pass failed")
        await asyncio.sleep(3600)
