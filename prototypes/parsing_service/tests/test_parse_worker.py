from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
import uuid
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
