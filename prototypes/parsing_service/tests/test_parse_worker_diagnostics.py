from __future__ import annotations

import hashlib
import os
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.storage.manifests import load_task_metadata, save_task_metadata
from app.storage.paths import task_dir_for
from app.timing import utc_now
from app.workers import parse_worker
from app.workers._attempt_diagnostics import AttemptTracker
from app.workers._parser_supervisor import (
    ParserDeadlineExceeded,
    ParserProcessFailed,
)
from app.workers._task_state import new_task_metadata
from tests.storage_test_support import isolated_storage


class TestParseWorkerDiagnostics(unittest.TestCase):
    def setUp(self):
        self._storage = isolated_storage()
        self._storage.__enter__()
        self.addCleanup(self._storage.__exit__, None, None, None)

    def _new_task(self) -> tuple[str, Path, str]:
        task_id = str(uuid.uuid4())
        task_dir = task_dir_for(task_id)
        task_dir.mkdir(parents=True)
        source = b"%PDF-1.7\nreplay"
        content_sha256 = hashlib.sha256(source).hexdigest()
        (task_dir / "source.pdf").write_bytes(source)
        now = utc_now()
        metadata = new_task_metadata(
            task_id=task_id,
            content_sha256=content_sha256,
            source_name="replay.pdf",
            resolved_ocr_device="cpu",
            queued_at=now,
        )
        save_task_metadata(task_dir, metadata)
        return task_id, task_dir, str(metadata["diagnostic_id"])

    def test_publication_failure_keeps_generic_error_and_local_diagnostics(self):
        task_id, task_dir, diagnostic_id = self._new_task()

        def child(*_args, result_path, **_kwargs):
            child_metadata = load_task_metadata(task_dir)
            started_at = utc_now()
            child_metadata["attempt"]["current_phase"] = "publication"
            child_metadata["attempt"]["phases"]["publication"] = {
                "started_at": started_at,
                "finished_at": None,
                "duration_ms": None,
                "outcome": "running",
            }
            save_task_metadata(task_dir, child_metadata)
            result_path.write_text("{}", encoding="utf-8")
            return SimpleNamespace(payload={"status": "completed"})

        with (
            patch.object(parse_worker, "_load_valid_canonical", return_value=None),
            patch.object(parse_worker, "run_parser_child", side_effect=child),
            patch.object(
                parse_worker,
                "_validated_child_generation",
                return_value=(object(), {}),
            ),
            patch.object(
                parse_worker,
                "write_canonical_generation_pointer",
                side_effect=OSError("simulated publication failure"),
            ),
        ):
            parse_worker._run_task_sync(task_id)

        metadata = load_task_metadata(task_dir)
        self.assertEqual(metadata["status"], "failed")
        self.assertEqual(metadata["error_code"], "generation_publish_failed")
        self.assertEqual(
            metadata["error"], "Parsing failed. See server logs for details."
        )
        self.assertEqual(metadata["diagnostic_id"], diagnostic_id)
        uuid.UUID(diagnostic_id)

        attempt = metadata["attempt"]
        self.assertEqual(attempt["current_phase"], None)
        self.assertIsNotNone(attempt["started_at"])
        self.assertIsNotNone(attempt["finished_at"])
        publication = attempt["phases"]["publication"]
        self.assertEqual(publication["outcome"], "failed")
        self.assertIsNotNone(publication["finished_at"])
        self.assertGreaterEqual(publication["duration_ms"], 0)
        self.assertEqual(attempt["worker"]["pid"], os.getpid())
        self.assertGreater(attempt["worker"]["peak_private_memory_bytes"], 0)
        self.assertGreater(attempt["worker"]["thread_count"], 0)
        self.assertGreater(attempt["worker"]["peak_thread_count"], 0)
        self.assertEqual(
            attempt["failure"]["exception_type"], "builtins.OSError"
        )
        self.assertEqual(attempt["failure"]["failing_phase"], "publication")
        self.assertIn("simulated publication failure", attempt["failure"]["traceback"])

    def test_invalid_child_payload_is_attributed_to_publication(self):
        task_id, task_dir, _ = self._new_task()

        def child(*_args, result_path, **_kwargs):
            metadata = load_task_metadata(task_dir)
            metadata["attempt"]["current_phase"] = "tables"
            metadata["attempt"]["phases"]["tables"] = {
                "started_at": utc_now(),
                "finished_at": None,
                "duration_ms": None,
                "outcome": "running",
            }
            save_task_metadata(task_dir, metadata)
            result_path.write_text("{}", encoding="utf-8")
            return SimpleNamespace(payload={"status": "completed"})

        with (
            patch.object(parse_worker, "_load_valid_canonical", return_value=None),
            patch.object(parse_worker, "run_parser_child", side_effect=child),
        ):
            parse_worker._run_task_sync(task_id)

        attempt = load_task_metadata(task_dir)["attempt"]
        self.assertEqual(attempt["failure"]["failing_phase"], "publication")
        self.assertEqual(attempt["phases"]["tables"]["outcome"], "completed")

    def test_supervisor_failures_keep_the_failing_parser_phase(self):
        cases = (
            (
                "deadline",
                ParserDeadlineExceeded("deadline"),
                "parser_deadline_exceeded",
            ),
            ("nonzero", ParserProcessFailed(7), "parser_process_failed"),
        )
        for name, failure, error_code in cases:
            with self.subTest(name=name):
                task_id, task_dir, _ = self._new_task()

                def child(**_kwargs):
                    metadata = load_task_metadata(task_dir)
                    started_at = utc_now()
                    metadata["attempt"]["current_phase"] = "docling"
                    metadata["attempt"]["phases"]["docling"] = {
                        "started_at": started_at,
                        "finished_at": None,
                        "duration_ms": None,
                        "outcome": "running",
                    }
                    save_task_metadata(task_dir, metadata)
                    raise failure

                with (
                    patch.object(
                        parse_worker, "_load_valid_canonical", return_value=None
                    ),
                    patch.object(parse_worker, "run_parser_child", side_effect=child),
                ):
                    parse_worker._run_task_sync(task_id)

                metadata = load_task_metadata(task_dir)
                self.assertEqual(metadata["status"], "failed")
                self.assertEqual(metadata["error_code"], error_code)
                self.assertEqual(
                    metadata["attempt"]["failure"]["failing_phase"], "docling"
                )

    def test_child_tracker_preserves_parent_attempt_start_and_inspection(self):
        _, task_dir, _ = self._new_task()
        parent = AttemptTracker(task_dir, load_task_metadata(task_dir))
        parent.start()
        parent.observe("inspection", "started")
        parent.stop_sampling()
        parent_metadata = load_task_metadata(task_dir)

        child = AttemptTracker(task_dir, parent_metadata)
        child.start()
        self.addCleanup(child.stop_sampling)

        resumed = load_task_metadata(task_dir)["attempt"]
        self.assertEqual(
            resumed["started_at"], parent_metadata["attempt"]["started_at"]
        )
        self.assertEqual(resumed["current_phase"], "inspection")
        self.assertEqual(resumed["phases"]["inspection"]["outcome"], "running")


if __name__ == "__main__":
    unittest.main()
