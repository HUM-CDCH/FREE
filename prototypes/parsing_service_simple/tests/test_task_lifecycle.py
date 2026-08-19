from __future__ import annotations

import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from support import (
    BlockingParser,
    FailingParser,
    ImmediateParser,
    assert_status_contract,
    submit_pdf,
    wait_for_status,
)


class TaskLifecycleContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_root = Path(self.temporary.name)

    def test_capacity_two_counts_one_running_and_one_pending_task(self) -> None:
        parser = BlockingParser()
        self.addCleanup(parser.release.set)
        app = create_app(
            parser=parser,
            data_root=self.data_root,
            queue_capacity=2,
        )
        with TestClient(app) as client:
            first = submit_pdf(client, filename="first.pdf")
            self.assertEqual(first.status_code, 202, first.text)
            self.assertTrue(parser.started.wait(timeout=2))
            wait_for_status(client, first.json()["task_id"], "running")

            second = submit_pdf(client, filename="second.pdf")
            third = submit_pdf(client, filename="third.pdf")

            self.assertEqual(second.status_code, 202, second.text)
            self.assertEqual(
                wait_for_status(client, second.json()["task_id"], "pending")["status"],
                "pending",
            )
            self.assertEqual(third.status_code, 503, third.text)
            self.assertEqual(third.headers["Retry-After"], "5")
            self.assertEqual(set(third.json()), {"detail"})

            parser.release.set()
            wait_for_status(client, first.json()["task_id"], "completed")
            wait_for_status(client, second.json()["task_id"], "completed")

    def test_pending_cancellation_is_terminal_and_idempotent(self) -> None:
        parser = BlockingParser()
        self.addCleanup(parser.release.set)
        app = create_app(parser=parser, data_root=self.data_root)
        with TestClient(app) as client:
            running = submit_pdf(client, filename="running.pdf").json()
            self.assertTrue(parser.started.wait(timeout=2))
            pending = submit_pdf(client, filename="pending.pdf").json()
            wait_for_status(client, pending["task_id"], "pending")

            first = client.post(f"/tasks/{pending['task_id']}/cancel")
            second = client.post(f"/tasks/{pending['task_id']}/cancel")

            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(second.status_code, 200, second.text)
            self.assertEqual(first.json()["status"], "cancelled")
            self.assertEqual(second.json()["status"], "cancelled")
            assert_status_contract(self, first.json())

            parser.release.set()
            wait_for_status(client, running["task_id"], "completed")

    def test_running_cancellation_discards_late_parser_output(self) -> None:
        parser = BlockingParser()
        self.addCleanup(parser.release.set)
        app = create_app(parser=parser, data_root=self.data_root)
        with TestClient(app) as client:
            created = submit_pdf(client).json()
            self.assertTrue(parser.started.wait(timeout=2))
            wait_for_status(client, created["task_id"], "running")

            cancelling = client.post(f"/tasks/{created['task_id']}/cancel")
            self.assertEqual(cancelling.status_code, 200, cancelling.text)
            self.assertEqual(cancelling.json()["status"], "cancelling")

            parser.release.set()
            cancelled = wait_for_status(client, created["task_id"], "cancelled")
            self.assertEqual(cancelled["status"], "cancelled")
            for suffix in ("markdown", "source", "document", "download"):
                gated = client.get(f"/tasks/{created['task_id']}/{suffix}")
                self.assertEqual(gated.status_code, 400, gated.text)

    def test_cancellation_during_publication_discards_output_artifacts(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        storage = app.state.storage
        original_publish = storage.publish_result
        publication_started = threading.Event()
        release_publication = threading.Event()
        self.addCleanup(release_publication.set)
        self.addCleanup(setattr, storage, "publish_result", original_publish)

        def blocking_publish(*args, **kwargs):
            publication_started.set()
            if not release_publication.wait(timeout=5):
                raise TimeoutError("test publication was not released")
            return original_publish(*args, **kwargs)

        storage.publish_result = blocking_publish
        with TestClient(app) as client:
            created = submit_pdf(client).json()
            task_id = created["task_id"]
            self.assertTrue(publication_started.wait(timeout=2))

            cancelling = client.post(f"/tasks/{task_id}/cancel")
            self.assertEqual(cancelling.status_code, 200, cancelling.text)
            self.assertEqual(cancelling.json()["status"], "cancelling")

            release_publication.set()
            wait_for_status(client, task_id, "cancelled")

            task_dir = storage.task_dir(task_id)
            for path in (
                storage.parsed_document_path(task_id),
                storage.markdown_path(task_id),
                task_dir / "manifest.json",
                storage.package_path(task_id),
            ):
                self.assertFalse(path.exists(), path)

    def test_worker_storage_failure_marks_service_unhealthy(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        storage = app.state.storage
        original_load = storage.load_metadata
        self.addCleanup(setattr, storage, "load_metadata", original_load)

        def fail_worker_load(task_id: str):
            try:
                task = asyncio.current_task()
            except RuntimeError:
                task = None
            if task is not None and task.get_name() == "simple-parsing-worker":
                raise OSError("controlled metadata read failure")
            return original_load(task_id)

        storage.load_metadata = fail_worker_load
        with TestClient(app) as client:
            created = submit_pdf(client)
            self.assertEqual(created.status_code, 202, created.text)

            deadline = time.monotonic() + 2
            status = client.get("/status").json()
            while status["parser_worker_health"] != "unhealthy":
                if time.monotonic() >= deadline:
                    self.fail(f"worker did not fail closed: {status}")
                time.sleep(0.01)
                status = client.get("/status").json()

            self.assertEqual(status["parser_worker_state"], "failed")
            rejected = submit_pdf(client, filename="rejected.pdf")
            self.assertEqual(rejected.status_code, 503, rejected.text)

    def test_noncompleted_artifacts_are_gated_while_source_pdf_remains_readable(self) -> None:
        parser = BlockingParser()
        self.addCleanup(parser.release.set)
        app = create_app(parser=parser, data_root=self.data_root)
        with TestClient(app) as client:
            created = submit_pdf(client).json()
            self.assertTrue(parser.started.wait(timeout=2))
            wait_for_status(client, created["task_id"], "running")

            for suffix in ("markdown", "source", "document", "download"):
                response = client.get(f"/tasks/{created['task_id']}/{suffix}")
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(set(response.json()), {"detail"})
            self.assertEqual(
                client.get(f"/tasks/{created['task_id']}/pdf").status_code,
                200,
            )

            parser.release.set()
            wait_for_status(client, created["task_id"], "completed")

    def test_parser_exception_becomes_a_failed_public_task(self) -> None:
        app = create_app(parser=FailingParser(), data_root=self.data_root)
        with TestClient(app, raise_server_exceptions=False) as client:
            created = submit_pdf(client).json()
            failed = wait_for_status(client, created["task_id"], "failed")

        assert_status_contract(self, failed)
        self.assertEqual(failed["error_code"], "parsing_failed")
        self.assertIsInstance(failed["error"], str)
        self.assertTrue(failed["error"])

    def test_startup_fails_interrupted_running_and_pending_tasks(self) -> None:
        parser = BlockingParser()
        self.addCleanup(parser.release.set)
        first_id: str
        second_id: str

        first_app = create_app(parser=parser, data_root=self.data_root)
        with TestClient(first_app) as client:
            first_id = submit_pdf(client, filename="running.pdf").json()["task_id"]
            self.assertTrue(parser.started.wait(timeout=2))
            wait_for_status(client, first_id, "running")
            second_id = submit_pdf(client, filename="pending.pdf").json()["task_id"]
            wait_for_status(client, second_id, "pending")

            # Let TestClient initiate lifespan shutdown while parse() is still
            # blocked, then release its executor thread so teardown can finish.
            release_after_shutdown = threading.Timer(0.3, parser.release.set)
            release_after_shutdown.start()
            self.addCleanup(release_after_shutdown.cancel)

        restarted_app = create_app(
            parser=ImmediateParser(),
            data_root=self.data_root,
        )
        with TestClient(restarted_app) as client:
            recovered = [client.get(f"/tasks/{task_id}") for task_id in (first_id, second_id)]

        for response in recovered:
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            assert_status_contract(self, payload)
            self.assertEqual(payload["status"], "failed")
            self.assertEqual(payload["error_code"], "service_restarted")
            self.assertIsInstance(payload["error"], str)
            self.assertTrue(payload["error"])


if __name__ == "__main__":
    unittest.main()
