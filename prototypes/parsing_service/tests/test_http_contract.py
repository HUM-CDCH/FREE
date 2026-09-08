from __future__ import annotations

import hashlib
import tempfile
import unittest
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from support import (
    PDF_BYTES,
    ImmediateParser,
    assert_status_contract,
    submit_pdf,
    wait_for_status,
)


class PublicHttpContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_root = Path(self.temporary.name)

    def test_root_and_status_keep_the_public_shape(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        with TestClient(app) as client:
            root = client.get("/")
            status = client.get("/status")

        self.assertEqual(root.status_code, 200, root.text)
        self.assertTrue(root.headers["content-type"].startswith("text/html"))
        self.assertEqual(status.status_code, 200, status.text)
        payload = status.json()
        self.assertEqual(
            set(payload),
            {
                "status",
                "parser_worker_health",
                "parser_worker_state",
                "gpu_available",
                "active_device_default",
                "timestamp",
            },
        )
        self.assertEqual(payload["status"], "online")
        self.assertEqual(payload["parser_worker_health"], "healthy")
        self.assertIn(payload["parser_worker_state"], {"ready", "busy"})
        self.assertIs(payload["gpu_available"], False)

    def test_create_and_status_responses_keep_every_public_field(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        with TestClient(app) as client:
            response = submit_pdf(client)
            self.assertEqual(response.status_code, 202, response.text)
            created = response.json()
            self.assertEqual(
                set(created),
                {
                    "task_id",
                    "document_id",
                    "content_sha256",
                    "status",
                    "created_at",
                },
            )
            uuid.UUID(created["task_id"])
            self.assertEqual(created["status"], "pending")
            self.assertEqual(
                created["content_sha256"], hashlib.sha256(PDF_BYTES).hexdigest()
            )

            completed = wait_for_status(client, created["task_id"], "completed")

        assert_status_contract(self, completed)
        self.assertEqual(completed["task_id"], created["task_id"])
        self.assertEqual(completed["document_id"], created["document_id"])
        self.assertEqual(completed["content_sha256"], created["content_sha256"])
        self.assertEqual(completed["params"]["source_name"], "sample.pdf")
        self.assertEqual(completed["selected_parser"], "docling")
        self.assertEqual(completed["error_code"], None)
        self.assertEqual(completed["error"], None)
        self.assertEqual(completed["parser_runs"][0]["parser"], "docling")

    def test_pdf_is_available_before_completion_and_supports_get_and_head(self) -> None:
        from support import BlockingParser

        parser = BlockingParser()
        self.addCleanup(parser.release.set)
        app = create_app(parser=parser, data_root=self.data_root)
        with TestClient(app) as client:
            created = submit_pdf(client).json()
            self.assertTrue(parser.started.wait(timeout=2))

            get_response = client.get(f"/tasks/{created['task_id']}/pdf")
            head_response = client.head(f"/tasks/{created['task_id']}/pdf")

            self.assertEqual(get_response.status_code, 200, get_response.text)
            self.assertEqual(get_response.content, PDF_BYTES)
            self.assertEqual(get_response.headers["content-type"], "application/pdf")
            self.assertEqual(head_response.status_code, 200, head_response.text)
            self.assertEqual(head_response.content, b"")
            self.assertEqual(int(head_response.headers["content-length"]), len(PDF_BYTES))

            parser.release.set()
            wait_for_status(client, created["task_id"], "completed")

    def test_completed_artifact_routes_keep_their_aliases_and_media_types(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        with TestClient(app) as client:
            created = submit_pdf(client).json()
            wait_for_status(client, created["task_id"], "completed")

            source = client.get(f"/tasks/{created['task_id']}/source")
            document = client.get(f"/tasks/{created['task_id']}/document")
            markdown = client.get(f"/tasks/{created['task_id']}/markdown")
            download = client.get(f"/tasks/{created['task_id']}/download")

        self.assertEqual(source.status_code, 200, source.text)
        self.assertEqual(document.status_code, 200, document.text)
        self.assertEqual(source.json(), document.json())
        self.assertEqual(source.json()["schema_version"], "parsed_document.v2")
        self.assertEqual(markdown.status_code, 200, markdown.text)
        self.assertTrue(markdown.headers["content-type"].startswith("text/markdown"))
        self.assertEqual(download.status_code, 200, download.text)
        self.assertTrue(download.headers["content-type"].startswith("application/zip"))
        self.assertIn("attachment", download.headers["content-disposition"])

    def test_invalid_upload_and_task_identifiers_use_bounded_http_errors(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        unknown = str(uuid.uuid4())
        with TestClient(app) as client:
            non_pdf = client.post(
                "/tasks",
                files={"file": ("notes.txt", b"not a pdf", "text/plain")},
            )
            malformed = client.get("/tasks/not-a-uuid")
            missing = client.get(f"/tasks/{unknown}")

        self.assertEqual(non_pdf.status_code, 400, non_pdf.text)
        self.assertEqual(set(non_pdf.json()), {"detail"})
        self.assertEqual(malformed.status_code, 400, malformed.text)
        self.assertEqual(set(malformed.json()), {"detail"})
        self.assertEqual(missing.status_code, 404, missing.text)
        self.assertEqual(set(missing.json()), {"detail"})

    def test_scanned_catalogue_upload_and_bounded_multipart_envelope(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        pdf = PDF_BYTES + b" " * (65 * 1024 * 1024)
        with TestClient(app) as client:
            accepted = client.post(
                "/tasks", files={"file": ("catalogue.pdf", pdf, "application/pdf")}
            )
            self.assertEqual(accepted.status_code, 202, accepted.text)
            task_id = accepted.json()["task_id"]
            self.assertEqual(app.state.storage.source_path(task_id).stat().st_size, len(pdf))
            wait_for_status(client, task_id, "completed")
            rejected = client.post(
                "/tasks", content=b"", headers={"Content-Length": str(101 * 1024 * 1024 + 1)}
            )
            self.assertEqual(rejected.status_code, 413, rejected.text)


if __name__ == "__main__":
    unittest.main()
