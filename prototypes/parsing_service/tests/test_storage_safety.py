import hashlib
import json
import os
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from app.storage import paths
from app.storage.blobs import (
    prune_document_store,
    prune_source_store,
    store_source_by_hash,
    validate_document_size,
)
from app.storage.paths import (
    safe_display_filename,
    source_store_path,
    task_dir_for,
    validate_task_id,
)


class TestStorageSafety(unittest.TestCase):
    def test_validate_task_id_accepts_only_uuid(self):
        task_id = str(uuid.uuid4())
        self.assertEqual(validate_task_id(task_id), task_id)
        with self.assertRaises(ValueError):
            validate_task_id("../evil")
        with self.assertRaises(ValueError):
            validate_task_id("not-a-uuid")

    def test_task_dir_stays_under_base(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            task_id = str(uuid.uuid4())
            task_dir = task_dir_for(task_id, tmp_dir)
            self.assertEqual(task_dir, Path(tmp_dir).resolve() / task_id)

    def test_safe_display_filename_strips_path_components(self):
        self.assertEqual(safe_display_filename("../evil.pdf"), "evil.pdf")
        self.assertEqual(safe_display_filename("/tmp/evil.pdf"), "evil.pdf")
        self.assertEqual(safe_display_filename(r"C:\\tmp\\report.pdf"), "report.pdf")

    def test_safe_relative_ref_rejects_escapes(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            base = Path(tmp_dir)
            inside = base / "output" / "document.md"
            self.assertEqual(
                paths.safe_relative_ref(base, inside), "output/document.md"
            )
            with self.assertRaises(ValueError):
                paths.safe_relative_ref(base, base.parent / "escape.md")

    def test_source_store_path_is_content_addressed(self):
        digest = "a" * 64
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = source_store_path(digest, tmp_dir)
            self.assertEqual(path, Path(tmp_dir).resolve() / f"{digest}.pdf")
            with self.assertRaises(ValueError):
                source_store_path("../evil", tmp_dir)

    def test_store_source_by_hash_tolerates_concurrent_same_hash_writers(self):
        content = b"%PDF-1.4\nconcurrent source\n"
        digest = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "source.pdf"
            source.write_bytes(content)

            original_store_dir = paths.DEFAULT_SOURCE_STORE_DIR
            paths.DEFAULT_SOURCE_STORE_DIR = Path(tmp_dir) / "sources"
            try:
                with ThreadPoolExecutor(max_workers=4) as executor:
                    results = list(
                        executor.map(
                            lambda _: store_source_by_hash(source, digest), range(8)
                        )
                    )
            finally:
                paths.DEFAULT_SOURCE_STORE_DIR = original_store_dir

            self.assertEqual(len(set(results)), 1)
            self.assertEqual(results[0].read_bytes(), content)

    def test_store_source_by_hash_rejects_mismatched_input_digest(self):
        content = b"%PDF-1.4\nsource\n"
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = root / "source.pdf"
            source.write_bytes(content)
            with patch.object(paths, "DEFAULT_SOURCE_STORE_DIR", root / "sources"):
                with self.assertRaisesRegex(ValueError, "content_sha256"):
                    store_source_by_hash(source, "a" * 64)
                self.assertEqual(list((root / "sources").glob("*")), [])

    def test_store_source_by_hash_failure_publishes_no_partial_blob(self):
        content = b"%PDF-1.4\nsource\n"
        digest = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = root / "source.pdf"
            source.write_bytes(content)
            source_dir = root / "sources"
            with (
                patch.object(paths, "DEFAULT_SOURCE_STORE_DIR", source_dir),
                patch("app.storage.blobs.os.replace", side_effect=OSError("stop")),
                self.assertRaisesRegex(OSError, "stop"),
            ):
                store_source_by_hash(source, digest)

            self.assertFalse((source_dir / f"{digest}.pdf").exists())
            self.assertEqual(list(source_dir.glob("*.tmp")), [])

    def test_source_pruning_respects_references_and_one_hour_grace(self):
        contents = {
            "referenced": b"%PDF-1.4\nreferenced source\n",
            "young": b"%PDF-1.4\nyoung source\n",
            "old": b"%PDF-1.4\nold source\n",
        }
        digests = {
            name: hashlib.sha256(content).hexdigest()
            for name, content in contents.items()
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            data_dir = root / "tasks"
            source_dir = root / "sources"
            task_dir = task_dir_for(str(uuid.uuid4()), data_dir)
            task_dir.mkdir(parents=True)
            (task_dir / "metadata.json").write_text(
                json.dumps({"content_sha256": digests["referenced"]}),
                encoding="utf-8",
            )
            source_paths = {
                name: source_store_path(digest, source_dir)
                for name, digest in digests.items()
            }
            for name, path in source_paths.items():
                path.write_bytes(contents[name])
            os.utime(source_paths["referenced"], (1, 1))
            os.utime(source_paths["old"], (1, 1))
            os.utime(source_paths["young"], (5_400, 5_400))

            removed = prune_source_store(
                data_dir=data_dir,
                source_store_dir=source_dir,
                max_total_bytes=0,
                now=7_200,
            )

            self.assertEqual(removed, 1)
            self.assertTrue(source_paths["referenced"].exists())
            self.assertTrue(source_paths["young"].exists())
            self.assertFalse(source_paths["old"].exists())

    def test_prune_source_store_removes_only_unreferenced_sources(self):
        referenced_content = b"%PDF-1.4\nreferenced\n"
        unreferenced_content = b"%PDF-1.4\nunreferenced\n"
        referenced_digest = hashlib.sha256(referenced_content).hexdigest()
        unreferenced_digest = hashlib.sha256(unreferenced_content).hexdigest()
        with tempfile.TemporaryDirectory() as tmp_dir:
            data_dir = Path(tmp_dir) / "tasks"
            source_dir = Path(tmp_dir) / "sources"
            task_dir = task_dir_for(str(uuid.uuid4()), data_dir)
            task_dir.mkdir(parents=True)
            (task_dir / "metadata.json").write_text(
                json.dumps({"content_sha256": referenced_digest}), encoding="utf-8"
            )
            referenced_path = source_store_path(referenced_digest, source_dir)
            unreferenced_path = source_store_path(unreferenced_digest, source_dir)
            referenced_path.write_bytes(referenced_content)
            unreferenced_path.write_bytes(unreferenced_content)
            os.utime(unreferenced_path, (1, 1))

            removed = prune_source_store(
                data_dir=data_dir,
                source_store_dir=source_dir,
                max_total_bytes=len(referenced_content),
                now=7_200,
            )

            self.assertEqual(removed, 1)
            self.assertTrue(referenced_path.exists())
            self.assertFalse(unreferenced_path.exists())

    def test_final_manifest_bytes_are_included_in_document_quota(self):
        digest = "a" * 64
        with tempfile.TemporaryDirectory() as tmp_dir:
            original_documents = paths.DEFAULT_DOCUMENT_STORE_DIR
            paths.DEFAULT_DOCUMENT_STORE_DIR = Path(tmp_dir) / "documents"
            try:
                document_dir = paths.document_store_dir(digest)
                artifact = document_dir / "generations" / "fixture" / "artifact.txt"
                artifact.parent.mkdir(parents=True)
                artifact.write_bytes(b"artifact")
                canonical = paths.canonical_parsed_document_path(digest)
                canonical.write_bytes(b"old")

                with self.assertRaisesRegex(ValueError, "per-document"):
                    validate_document_size(
                        digest,
                        additional_bytes=100,
                        replacing_path=canonical,
                        max_document_bytes=50,
                    )
            finally:
                paths.DEFAULT_DOCUMENT_STORE_DIR = original_documents

    def test_prune_document_store_removes_only_unreferenced_documents(self):
        referenced_digest = "a" * 64
        unreferenced_digest = "b" * 64
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            data_dir = root / "tasks"
            document_dir = root / "documents"
            task_dir = task_dir_for(str(uuid.uuid4()), data_dir)
            task_dir.mkdir(parents=True)
            (task_dir / "metadata.json").write_text(
                json.dumps({"content_sha256": referenced_digest}), encoding="utf-8"
            )
            referenced = document_dir / referenced_digest
            unreferenced = document_dir / unreferenced_digest
            referenced.mkdir(parents=True)
            unreferenced.mkdir(parents=True)
            (referenced / "parsed_document.json").write_bytes(b"referenced")
            (unreferenced / "parsed_document.json").write_bytes(b"unreferenced")

            removed = prune_document_store(
                data_dir=data_dir,
                document_store_dir=document_dir,
                max_total_bytes=len(b"referenced"),
                retention_seconds=10_000,
            )

            self.assertEqual(removed, 1)
            self.assertTrue(referenced.exists())
            self.assertFalse(unreferenced.exists())


if __name__ == "__main__":
    unittest.main()
