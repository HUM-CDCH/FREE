from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import psutil

from app.storage.atomic_json import write_json_atomic
from app.storage.manifests import load_task_metadata, save_task_metadata
from app.storage.paths import SERVICE_ROOT, task_dir_for
from app.timing import utc_now
from app.workers import parse_worker
from app.workers._parser_supervisor import (
    ParserDeadlineExceeded,
    ParserProcessFailed,
    supervise_process,
)
from app.workers._task_state import new_task_metadata, retry_task_metadata
from app.workers.replay_parse_worker import _summary
from tests.storage_test_support import isolated_storage


def _surviving(pids, timeout=5):
    """Return the pids still running once the kernel has torn the tree down."""
    deadline = time.monotonic() + timeout
    while True:
        alive = []
        for pid in pids:
            try:
                if psutil.Process(pid).status() != psutil.STATUS_ZOMBIE:
                    alive.append(pid)
            except psutil.Error:
                continue
        if not alive or time.monotonic() >= deadline:
            return alive
        time.sleep(0.05)


class TestParserSupervisor(unittest.TestCase):
    def test_success_nonzero_and_timeout(self):
        writer = (
            "from pathlib import Path; import sys; "
            "Path(sys.argv[1]).write_text(sys.argv[2], encoding='utf-8'); "
            "raise SystemExit(int(sys.argv[3]))"
        )
        cases = (
            ("success", {"status": "completed"}, 0),
            ("nonzero", {"status": "failed"}, 7),
        )
        with tempfile.TemporaryDirectory(dir=SERVICE_ROOT) as directory:
            root = Path(directory)
            for name, payload, exit_code in cases:
                with self.subTest(name=name):
                    result = root / f"{name}.json"
                    outcome = supervise_process(
                        [
                            sys.executable,
                            "-c",
                            writer,
                            str(result),
                            json.dumps(payload),
                            str(exit_code),
                        ],
                        result_path=result,
                        deadline_seconds=5,
                        cwd=root,
                    )
                    self.assertEqual(outcome.exit_code, exit_code)
                    self.assertEqual(outcome.payload, payload)

            started = time.monotonic()
            with self.assertRaises(ParserDeadlineExceeded):
                supervise_process(
                    [sys.executable, "-c", "import time; time.sleep(30)"],
                    result_path=root / "timeout.json",
                    deadline_seconds=0.05,
                    cwd=root,
                )
            self.assertLess(time.monotonic() - started, 5)

            with self.assertRaises(ParserProcessFailed):
                supervise_process(
                    [sys.executable, "-c", "raise SystemExit(7)"],
                    result_path=root / "missing.json",
                    deadline_seconds=5,
                    cwd=root,
                )

    def test_success_terminates_a_lingering_descendant(self):
        script = (
            "import json, subprocess, sys, time; from pathlib import Path; "
            "child = subprocess.Popen([sys.executable, '-c', "
            "'import time; time.sleep(30)']); "
            "Path(sys.argv[1]).write_text(json.dumps({"
            "'status': 'completed', 'descendant_pid': child.pid}), encoding='utf-8'); "
            "time.sleep(0.25)"
        )
        with tempfile.TemporaryDirectory(dir=SERVICE_ROOT) as directory:
            root = Path(directory)
            result = root / "result.json"
            outcome = supervise_process(
                [sys.executable, "-c", script, str(result)],
                result_path=result,
                deadline_seconds=5,
                cwd=root,
            )
        self.assertEqual(_surviving([outcome.payload["descendant_pid"]]), [])

    def test_descendants_spawned_at_exit_do_not_escape(self):
        # The child never waits: the helpers are still starting when it exits,
        # so nothing can have observed them in the process table beforehand.
        script = (
            "import json, subprocess, sys; from pathlib import Path; "
            "kids = [subprocess.Popen([sys.executable, '-c', "
            "'import time; time.sleep(30)']) for _ in range(8)]; "
            "Path(sys.argv[1]).write_text(json.dumps({"
            "'status': 'completed', 'pids': [kid.pid for kid in kids]}), "
            "encoding='utf-8')"
        )
        with tempfile.TemporaryDirectory(dir=SERVICE_ROOT) as directory:
            root = Path(directory)
            result = root / "result.json"
            outcome = supervise_process(
                [sys.executable, "-c", script, str(result)],
                result_path=result,
                deadline_seconds=30,
                cwd=root,
            )
        self.assertEqual(_surviving(outcome.payload["pids"]), [])

    def test_retry_reuses_task_and_source_identity(self):
        task_id = str(uuid.uuid4())
        metadata = new_task_metadata(
            task_id=task_id,
            content_sha256="b" * 64,
            source_name="replay.pdf",
            resolved_ocr_device="cpu",
            queued_at=utc_now(),
        )
        metadata["status"] = "failed"
        prior_diagnostic_id = metadata["diagnostic_id"]

        retried = retry_task_metadata(metadata, queued_at=utc_now())

        self.assertEqual(retried["task_id"], task_id)
        self.assertEqual(retried["content_sha256"], "b" * 64)
        self.assertEqual(retried["source_path"], "source.pdf")
        self.assertEqual(retried["status"], "pending")
        self.assertNotEqual(retried["diagnostic_id"], prior_diagnostic_id)
        self.assertEqual(
            retried["attempt_history"][0]["diagnostic_id"],
            prior_diagnostic_id,
        )

    def test_startup_reconciles_an_orphaned_running_attempt(self):
        with isolated_storage():
            task_id = str(uuid.uuid4())
            task_dir = task_dir_for(task_id)
            task_dir.mkdir(parents=True)
            metadata = new_task_metadata(
                task_id=task_id,
                content_sha256="a" * 64,
                source_name="replay.pdf",
                resolved_ocr_device="cpu",
                queued_at=utc_now(),
            )
            metadata["status"] = "running"
            metadata["attempt"]["started_at"] = utc_now()
            metadata["attempt"]["current_phase"] = "docling"
            metadata["attempt"]["phases"]["docling"] = {
                "started_at": utc_now(),
                "finished_at": None,
                "duration_ms": None,
                "outcome": "running",
            }
            save_task_metadata(task_dir, metadata)
            write_json_atomic(
                task_dir / parse_worker._ATTEMPT_METRICS_FILENAME,
                {
                    "diagnostic_id": metadata["diagnostic_id"],
                    "worker": {
                        "pid": 123,
                        "peak_private_memory_bytes": 456,
                        "thread_count": 7,
                        "peak_thread_count": 8,
                    },
                },
            )

            with patch.object(
                parse_worker, "_reusable_canonical", return_value=None
            ):
                self.assertTrue(parse_worker._reconcile_task(task_dir, task_id))

            recovered = load_task_metadata(task_dir)
            self.assertEqual(recovered["status"], "failed")
            self.assertEqual(recovered["error_code"], "task_interrupted")
            self.assertEqual(
                recovered["attempt"]["failure"]["failing_phase"], "docling"
            )
            self.assertIsNotNone(recovered["attempt"]["finished_at"])
            self.assertEqual(
                recovered["attempt"]["worker"]["peak_private_memory_bytes"],
                456,
            )
            self.assertFalse(
                (task_dir / parse_worker._ATTEMPT_METRICS_FILENAME).exists()
            )

    def test_hash_match_requires_all_four_target_results(self):
        reports = [
            {
                "case": "fresh",
                "jobs": [{"label": "target", "package_sha256": "a"}],
            },
            {
                "case": "after-preceding",
                "jobs": [{"label": "target", "package_sha256": "a"}],
            },
            {
                "case": "repeated",
                "jobs": [
                    {"label": "target-1", "package_sha256": "a"},
                    {"label": "target-2", "package_sha256": "a"},
                ],
            },
        ]

        self.assertFalse(_summary(reports[:1])["target_package_hashes_match"])
        self.assertTrue(_summary(reports)["target_package_hashes_match"])


if __name__ == "__main__":
    unittest.main()
