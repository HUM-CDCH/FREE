from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
import uuid
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from pathlib import Path
from unittest.mock import AsyncMock, patch

from filelock import FileLock

from app.models.parsed_document import ParsedDocument
from app.storage import paths
from app.storage.manifests import (
    load_task_metadata,
    preprocessing_config_hash,
    read_canonical_parsed_document,
    save_task_metadata,
    write_canonical_parsed_document,
)
from app.workers import parse_worker

NOW = "2026-07-10T00:00:00+00:00"


@contextmanager
def _reconciliation_storage() -> Iterator[tuple[Path, Path]]:
    with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
        root = Path(tmp_dir)
        tasks_dir = root / "tasks"
        with (
            patch.object(paths, "DEFAULT_DATA_DIR", tasks_dir),
            patch.object(paths, "DEFAULT_DOCUMENT_STORE_DIR", root / "documents"),
            patch.object(parse_worker, "DEFAULT_DATA_DIR", tasks_dir),
        ):
            yield root, tasks_dir


def _running_task(task_id: str) -> Path:
    task_dir = paths.task_dir_for(task_id)
    task_dir.mkdir(parents=True)
    save_task_metadata(
        task_dir,
        {
            "task_id": task_id,
            "content_sha256": "a" * 64,
            "status": "running",
            "params": {"source_name": "source.pdf"},
        },
    )
    return task_dir


def _parsed_document(
    content_hash: str,
    config_hash: str,
    llm_ref: str,
) -> ParsedDocument:
    return ParsedDocument.model_validate(
        {
            "document": {
                "document_id": f"sha256:{content_hash}",
                "content_sha256": content_hash,
                "source": {"kind": "upload", "original_filename": "source.pdf"},
                "created_at": NOW,
                "page_count": 1,
            },
            "preprocessing": {
                "preprocess_id": f"sha256:{'b' * 64}",
                "config_hash": config_hash,
                "status": "completed",
            },
            "artifacts": {
                "llm_markdown_ref": llm_ref,
                "debug_refs": [llm_ref],
            },
            "parser_runs": [],
            "arbitration": {
                "primary_document_parser": "docling_doctags",
                "strategy": "docling_primary_ocr_page_fallback",
            },
            "text_views": {
                "plain_text": "Body",
                "page_marked_text": "[PAGE 1]\nBody",
                "markdown": "Body",
                "llm_markdown": "Body",
                "doc_tags_simplified": "Body",
            },
        }
    )


class TestParseWorker(unittest.IsolatedAsyncioTestCase):
    async def test_parser_build_is_offloaded_from_event_loop(self):
        with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
            root = Path(tmp_dir)
            original_tasks = paths.DEFAULT_DATA_DIR
            original_documents = paths.DEFAULT_DOCUMENT_STORE_DIR
            original_worker_tasks = parse_worker.DEFAULT_DATA_DIR
            paths.DEFAULT_DATA_DIR = root / "tasks"
            paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
            parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
            try:
                task_id = str(uuid.uuid4())
                task_dir = paths.task_dir_for(task_id)
                task_dir.mkdir(parents=True)
                (task_dir / "source.pdf").write_bytes(b"%PDF-1.4\n")
                save_task_metadata(
                    task_dir,
                    {
                        "task_id": task_id,
                        "content_sha256": "a" * 64,
                        "status": "pending",
                        "params": {"source_name": "source.pdf"},
                    },
                )

                with (
                    patch(
                        "app.workers.parse_worker.asyncio.to_thread",
                        new_callable=AsyncMock,
                        side_effect=RuntimeError("stop after offload"),
                    ) as mock_to_thread,
                    patch("app.workers.parse_worker.logger.exception"),
                ):
                    await parse_worker.run_extraction_task(
                        task_id, str(task_dir / "source.pdf")
                    )

                mock_to_thread.assert_awaited_once()
                self.assertEqual(load_task_metadata(task_dir)["status"], "failed")
            finally:
                paths.DEFAULT_DATA_DIR = original_tasks
                paths.DEFAULT_DOCUMENT_STORE_DIR = original_documents
                parse_worker.DEFAULT_DATA_DIR = original_worker_tasks

    def test_completed_task_quota_accounts_for_document_and_metadata(self):
        with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
            original_document_store = paths.DEFAULT_DOCUMENT_STORE_DIR
            paths.DEFAULT_DOCUMENT_STORE_DIR = Path(tmp_dir) / "documents"
            try:
                task_id = str(uuid.uuid4())
                task_dir = Path(tmp_dir) / task_id
                task_dir.mkdir()
                metadata = {
                    "task_id": task_id,
                    "content_sha256": "a" * 64,
                    "status": "running",
                    "created_at": NOW,
                    "params": {"source_name": "source.pdf"},
                }
                parsed = _parsed_document(
                    "a" * 64,
                    preprocessing_config_hash(metadata),
                    "data/documents/example/document.llm.md",
                )
                with (
                    patch(
                        "app.workers.parse_worker.validate_task_capacity"
                    ) as mock_capacity,
                    patch("app.workers.parse_worker.write_parsed_document"),
                    patch("app.workers.parse_worker.save_task_metadata"),
                ):
                    parse_worker._completed_metadata(task_dir, metadata, parsed)

                kwargs = mock_capacity.call_args.kwargs
                self.assertGreater(kwargs["additional_bytes"], 0)
                self.assertEqual(
                    {path.name for path in kwargs["replacing_paths"]},
                    {"parsed_document.json", "metadata.json"},
                )
            finally:
                paths.DEFAULT_DOCUMENT_STORE_DIR = original_document_store

    def test_corrupt_cache_rebuilds_into_immutable_generation(self):
        with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
            root = Path(tmp_dir)
            original_paths = (
                paths.DEFAULT_DATA_DIR,
                paths.DEFAULT_SOURCE_STORE_DIR,
                paths.DEFAULT_DOCUMENT_STORE_DIR,
                parse_worker.DEFAULT_DATA_DIR,
            )
            paths.DEFAULT_DATA_DIR = root / "tasks"
            paths.DEFAULT_SOURCE_STORE_DIR = root / "sources"
            paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
            parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
            try:
                task_id = str(uuid.uuid4())
                task_dir = paths.task_dir_for(task_id)
                task_dir.mkdir(parents=True)
                source = b"%PDF-1.4\nsource\n"
                content_hash = hashlib.sha256(source).hexdigest()
                (task_dir / "source.pdf").write_bytes(source)
                metadata = {
                    "task_id": task_id,
                    "content_sha256": content_hash,
                    "status": "running",
                    "created_at": NOW,
                    "params": {
                        "source_name": "source.pdf",
                        "resolved_ocr_device": "cpu",
                    },
                }
                save_task_metadata(task_dir, metadata)
                corrupt = paths.canonical_parsed_document_path(content_hash)
                corrupt.write_text("{not-json", encoding="utf-8")

                def build(task_id, *, source_path, artifact_root):
                    self.assertEqual(source_path, paths.source_store_path(content_hash))
                    llm_path = artifact_root / "document.llm.md"
                    llm_path.write_text("Body\n", encoding="utf-8")
                    return _parsed_document(
                        content_hash,
                        preprocessing_config_hash(metadata),
                        paths.service_relative_ref(llm_path),
                    )

                with patch(
                    "app.workers.parse_worker.build_parsed_document",
                    side_effect=build,
                ) as mock_build:
                    parsed = parse_worker._build_or_load_canonical(
                        task_id,
                        content_hash,
                        metadata,
                    )

                mock_build.assert_called_once()
                self.assertEqual(parsed.document.content_sha256, content_hash)
                self.assertIn(
                    "/generations/",
                    parsed.artifacts.llm_markdown_ref or "",
                )
                self.assertNotIn(
                    "/.pending/",
                    parsed.artifacts.llm_markdown_ref or "",
                )
                persisted = read_canonical_parsed_document(content_hash)
                self.assertEqual(
                    persisted.artifacts.llm_markdown_ref,
                    parsed.artifacts.llm_markdown_ref,
                )
            finally:
                (
                    paths.DEFAULT_DATA_DIR,
                    paths.DEFAULT_SOURCE_STORE_DIR,
                    paths.DEFAULT_DOCUMENT_STORE_DIR,
                    parse_worker.DEFAULT_DATA_DIR,
                ) = original_paths

    def test_failed_rebuild_preserves_previous_generation(self):
        with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
            root = Path(tmp_dir)
            original_paths = (
                paths.DEFAULT_DATA_DIR,
                paths.DEFAULT_SOURCE_STORE_DIR,
                paths.DEFAULT_DOCUMENT_STORE_DIR,
                parse_worker.DEFAULT_DATA_DIR,
            )
            paths.DEFAULT_DATA_DIR = root / "tasks"
            paths.DEFAULT_SOURCE_STORE_DIR = root / "sources"
            paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
            parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
            try:
                task_id = str(uuid.uuid4())
                task_dir = paths.task_dir_for(task_id)
                task_dir.mkdir(parents=True)
                source = b"%PDF-1.4\nsource\n"
                content_hash = hashlib.sha256(source).hexdigest()
                (task_dir / "source.pdf").write_bytes(source)
                metadata = {
                    "task_id": task_id,
                    "content_sha256": content_hash,
                    "status": "running",
                    "created_at": NOW,
                    "params": {
                        "source_name": "source.pdf",
                        "resolved_ocr_device": "cpu",
                    },
                }
                save_task_metadata(task_dir, metadata)

                def successful_build(task_id, *, source_path, artifact_root):
                    llm_path = artifact_root / "document.llm.md"
                    llm_path.write_text("Body\n", encoding="utf-8")
                    return _parsed_document(
                        content_hash,
                        preprocessing_config_hash(metadata),
                        paths.service_relative_ref(llm_path),
                    )

                with patch(
                    "app.workers.parse_worker.build_parsed_document",
                    side_effect=successful_build,
                ):
                    previous = parse_worker._build_or_load_canonical(
                        task_id,
                        content_hash,
                        metadata,
                    )
                previous_ref = previous.artifacts.llm_markdown_ref or ""
                previous_path = paths.SERVICE_ROOT / previous_ref
                canonical_path = paths.canonical_parsed_document_path(content_hash)
                canonical_bytes = canonical_path.read_bytes()

                stale_metadata = {
                    **metadata,
                    "params": {
                        **metadata["params"],
                        "resolved_ocr_device": "gpu:0",
                    },
                }

                def failed_build(task_id, *, source_path, artifact_root):
                    (artifact_root / "partial.txt").write_text(
                        "partial",
                        encoding="utf-8",
                    )
                    raise RuntimeError("injected build failure")

                with (
                    patch(
                        "app.workers.parse_worker.build_parsed_document",
                        side_effect=failed_build,
                    ),
                    self.assertRaisesRegex(RuntimeError, "injected"),
                ):
                    parse_worker._build_or_load_canonical(
                        task_id,
                        content_hash,
                        stale_metadata,
                    )

                self.assertEqual(canonical_path.read_bytes(), canonical_bytes)
                self.assertTrue(previous_path.is_file())
                self.assertFalse(
                    any(
                        path.is_file()
                        for path in paths.document_store_dir(content_hash).glob(
                            ".pending/**/partial.txt"
                        )
                    )
                )
            finally:
                (
                    paths.DEFAULT_DATA_DIR,
                    paths.DEFAULT_SOURCE_STORE_DIR,
                    paths.DEFAULT_DOCUMENT_STORE_DIR,
                    parse_worker.DEFAULT_DATA_DIR,
                ) = original_paths

    def test_startup_reconciliation_marks_interrupted_task_failed(self):
        with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
            root = Path(tmp_dir)
            original_tasks = paths.DEFAULT_DATA_DIR
            original_documents = paths.DEFAULT_DOCUMENT_STORE_DIR
            original_worker_tasks = parse_worker.DEFAULT_DATA_DIR
            paths.DEFAULT_DATA_DIR = root / "tasks"
            paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
            parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
            try:
                task_id = str(uuid.uuid4())
                task_dir = paths.task_dir_for(task_id)
                task_dir.mkdir(parents=True)
                save_task_metadata(
                    task_dir,
                    {
                        "task_id": task_id,
                        "document_id": "a" * 64,
                        "content_sha256": "a" * 64,
                        "status": "running",
                        "params": {"source_name": "source.pdf"},
                    },
                )

                self.assertEqual(parse_worker.reconcile_interrupted_tasks(), 1)

                metadata = load_task_metadata(task_dir)
                self.assertEqual(metadata["status"], "failed")
                self.assertEqual(metadata["error_code"], "task_interrupted")
                self.assertEqual(metadata["document_id"], f"sha256:{'a' * 64}")
            finally:
                paths.DEFAULT_DATA_DIR = original_tasks
                paths.DEFAULT_DOCUMENT_STORE_DIR = original_documents
                parse_worker.DEFAULT_DATA_DIR = original_worker_tasks

    def test_startup_reconciliation_isolates_task_local_failures(self):
        failure_cases = (
            ("invalid JSON", b"{invalid", None, ValueError),
            ("invalid status", b'{"status":"bogus"}', None, ValueError),
            ("over quota", None, "validate_task_capacity", ValueError),
            ("unwritable", None, "save_task_metadata", PermissionError),
        )
        for label, malformed_metadata, dependency, error_type in failure_cases:
            with self.subTest(failure=label), _reconciliation_storage() as (root, _):
                blocked_id = "00000000-0000-0000-0000-000000000001"
                healthy_id = "00000000-0000-0000-0000-000000000002"
                blocked_dir = _running_task(blocked_id)
                healthy_dir = _running_task(healthy_id)

                if malformed_metadata is not None:
                    (blocked_dir / "metadata.json").write_bytes(malformed_metadata)
                    failure = nullcontext()
                else:
                    assert dependency is not None
                    original = getattr(parse_worker, dependency)

                    def fail_blocked(task_dir, *args, **kwargs):
                        if task_dir == blocked_dir:
                            raise error_type(f"{label}: {blocked_dir}")
                        return original(task_dir, *args, **kwargs)

                    failure = patch(
                        f"app.workers.parse_worker.{dependency}",
                        side_effect=fail_blocked,
                    )
                blocked_metadata = (blocked_dir / "metadata.json").read_bytes()

                with (
                    failure,
                    self.assertLogs(parse_worker.logger, level="WARNING") as logs,
                ):
                    self.assertEqual(parse_worker.reconcile_interrupted_tasks(), 1)

                self.assertEqual(
                    (blocked_dir / "metadata.json").read_bytes(),
                    blocked_metadata,
                )
                self.assertEqual(load_task_metadata(healthy_dir)["status"], "failed")
                warning = "\n".join(logs.output)
                self.assertIn(blocked_id, warning)
                self.assertNotIn(str(root), warning)

    def test_startup_reconciliation_does_not_rewrite_terminal_metadata(self):
        with _reconciliation_storage():
            snapshots = []
            for index, status in enumerate(("completed", "failed"), start=1):
                task_id = f"00000000-0000-0000-0000-{index:012d}"
                task_dir = paths.task_dir_for(task_id)
                task_dir.mkdir(parents=True)
                metadata = parse_worker._normalize_legacy_metadata(
                    task_id,
                    {
                        "content_sha256": "a" * 64,
                        "status": status,
                        "created_at": NOW,
                        "updated_at": NOW,
                        "params": {"source_name": "source.pdf"},
                    },
                )
                save_task_metadata(task_dir, metadata)
                metadata_path = task_dir / "metadata.json"
                timestamp_ns = 1_700_000_000_000_000_000 + index
                os.utime(metadata_path, ns=(timestamp_ns, timestamp_ns))
                snapshots.append(
                    (
                        metadata_path,
                        metadata_path.read_bytes(),
                        metadata_path.stat().st_mtime_ns,
                    )
                )

            self.assertEqual(parse_worker.reconcile_interrupted_tasks(), 0)

            for metadata_path, metadata_bytes, modified_ns in snapshots:
                self.assertEqual(metadata_path.read_bytes(), metadata_bytes)
                self.assertEqual(metadata_path.stat().st_mtime_ns, modified_ns)

    def test_startup_reconciliation_keeps_shared_store_failure_fatal(self):
        with _reconciliation_storage():
            _running_task("00000000-0000-0000-0000-000000000001")
            task_store_lock_path = parse_worker.task_store_lock_path
            calls = 0

            def fail_after_probe():
                nonlocal calls
                calls += 1
                if calls == 1:
                    return task_store_lock_path()
                raise PermissionError("shared store unavailable")

            with (
                patch(
                    "app.workers.parse_worker.task_store_lock_path",
                    side_effect=fail_after_probe,
                ),
                self.assertRaisesRegex(PermissionError, "shared store unavailable"),
            ):
                parse_worker.reconcile_interrupted_tasks()

        with _reconciliation_storage():
            _running_task("00000000-0000-0000-0000-000000000001")

            def fail_canonical_read(*_args, **_kwargs):
                try:
                    raise PermissionError("shared store unavailable")
                except PermissionError as exc:
                    raise ValueError("canonical read failed") from exc

            with (
                patch(
                    "app.workers.parse_worker.read_canonical_parsed_document",
                    side_effect=fail_canonical_read,
                ),
                self.assertRaises(OSError),
            ):
                parse_worker.reconcile_interrupted_tasks()

    def test_cleanup_removes_crash_abandoned_generations(self):
        with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
            root = Path(tmp_dir)
            original_paths = (
                paths.DEFAULT_DATA_DIR,
                paths.DEFAULT_SOURCE_STORE_DIR,
                paths.DEFAULT_DOCUMENT_STORE_DIR,
                parse_worker.DEFAULT_DATA_DIR,
            )
            paths.DEFAULT_DATA_DIR = root / "tasks"
            paths.DEFAULT_SOURCE_STORE_DIR = root / "sources"
            paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
            parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
            try:
                digest = "a" * 64
                pending = paths.pending_document_generation_dir(
                    digest,
                    f"{'1' * 16}-{'2' * 32}",
                )
                orphan = paths.document_generation_dir(
                    digest,
                    f"{'3' * 16}-{'4' * 32}",
                )
                referenced = paths.document_generation_dir(
                    digest,
                    f"{'5' * 16}-{'6' * 32}",
                )
                pending.mkdir(parents=True)
                orphan.mkdir(parents=True)
                referenced.mkdir(parents=True)
                (pending / "partial.bin").write_bytes(b"partial")
                (orphan / "complete.bin").write_bytes(b"unreferenced")
                llm_path = referenced / "document.llm.md"
                llm_path.write_text("Body", encoding="utf-8")
                write_canonical_parsed_document(
                    digest,
                    _parsed_document(
                        digest,
                        "c" * 64,
                        paths.service_relative_ref(llm_path),
                    ),
                )

                parse_worker.cleanup_once()

                self.assertFalse(pending.exists())
                self.assertFalse(orphan.exists())
                self.assertTrue(referenced.exists())
            finally:
                (
                    paths.DEFAULT_DATA_DIR,
                    paths.DEFAULT_SOURCE_STORE_DIR,
                    paths.DEFAULT_DOCUMENT_STORE_DIR,
                    parse_worker.DEFAULT_DATA_DIR,
                ) = original_paths

    def test_cleanup_skips_locked_active_task(self):
        with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
            root = Path(tmp_dir)
            original_tasks = paths.DEFAULT_DATA_DIR
            original_documents = paths.DEFAULT_DOCUMENT_STORE_DIR
            original_sources = paths.DEFAULT_SOURCE_STORE_DIR
            original_worker_tasks = parse_worker.DEFAULT_DATA_DIR
            paths.DEFAULT_DATA_DIR = root / "tasks"
            paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
            paths.DEFAULT_SOURCE_STORE_DIR = root / "sources"
            parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
            try:
                task_id = str(uuid.uuid4())
                task_dir = paths.task_dir_for(task_id)
                task_dir.mkdir(parents=True)
                save_task_metadata(
                    task_dir,
                    {
                        "task_id": task_id,
                        "content_sha256": "a" * 64,
                        "status": "completed",
                        "params": {"source_name": "source.pdf"},
                    },
                )
                old_time = 1.0
                os.utime(task_dir / "metadata.json", (old_time, old_time))

                lock = FileLock(str(paths.task_lock_path(task_id)))
                with lock:
                    self.assertEqual(
                        parse_worker.cleanup_once(now=2 * 24 * 3600),
                        0,
                    )
                    self.assertTrue(task_dir.exists())

                self.assertEqual(
                    parse_worker.cleanup_once(now=2 * 24 * 3600),
                    1,
                )
                self.assertFalse(task_dir.exists())
            finally:
                paths.DEFAULT_DATA_DIR = original_tasks
                paths.DEFAULT_DOCUMENT_STORE_DIR = original_documents
                paths.DEFAULT_SOURCE_STORE_DIR = original_sources
                parse_worker.DEFAULT_DATA_DIR = original_worker_tasks


if __name__ == "__main__":
    unittest.main()
