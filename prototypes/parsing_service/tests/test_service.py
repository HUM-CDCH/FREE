import hashlib
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import fitz  # type: ignore[import-not-found]
from fastapi import HTTPException, UploadFile
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.datastructures import Headers

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.api.deps import load_metadata, save_metadata
from app.api.request_admission import (  # type: ignore[import-not-found]
    TASK_REQUEST_LIMIT_BYTES,
    TaskRequestLimitMiddleware,
)
from app.api.routes_tasks import router as tasks_router
from app.ingestion.upload import (
    MAX_UPLOAD_BYTES,
    copy_upload_to_path,
    validate_upload_mime,
)
from app.parsing.orchestrator import build_parsed_document
from app.parsing.table_extraction import TableExtractionOutput
from app.storage import paths
from app.storage.paths import DEFAULT_DATA_DIR, DEFAULT_DOCUMENT_STORE_DIR
from app.workers import parse_worker
from main import app
from tests.storage_test_support import isolated_storage

DATA_DIR = str(DEFAULT_DATA_DIR)
DOCUMENT_STORE_DIR = str(DEFAULT_DOCUMENT_STORE_DIR)


def make_pdf_bytes(page_count=1, width=200, height=300):
    document = fitz.open()
    for index in range(page_count):
        page = document.new_page(width=width, height=height)
        page.insert_text((36, 72), f"Fixture page {index + 1}")
    return document.tobytes()


PDF_BYTES = make_pdf_bytes(1)
TWO_PAGE_PDF_BYTES = make_pdf_bytes(2)


class BodyReadingAsgiApp:
    def __init__(self):
        self.handler_calls = 0

    async def __call__(self, _scope, receive, send):
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if not message.get("more_body", False):
                break
        self.handler_calls += 1
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})


async def run_asgi_request(application, *, headers=(), path="/tasks"):
    pending = [{"type": "http.request", "body": b"", "more_body": False}]
    sent = []

    async def receive():
        if pending:
            return pending.pop(0)
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "root_path": "",
        "headers": list(headers),
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }
    await application(scope, receive, send)
    return sent, pending


class TestTaskRequestLimitMiddleware(unittest.IsolatedAsyncioTestCase):
    async def test_exact_declared_request_boundary_is_admitted(self):
        downstream = BodyReadingAsgiApp()
        middleware = TaskRequestLimitMiddleware(downstream)

        sent, _pending = await run_asgi_request(
            middleware,
            headers=[
                (b"content-length", str(TASK_REQUEST_LIMIT_BYTES).encode("ascii"))
            ],
        )

        self.assertEqual(TASK_REQUEST_LIMIT_BYTES, 51 * 1024 * 1024)
        self.assertEqual(downstream.handler_calls, 1)
        self.assertEqual(sent[0]["status"], 204)

    async def test_declared_request_over_boundary_is_rejected_before_handler(self):
        downstream = BodyReadingAsgiApp()
        middleware = TaskRequestLimitMiddleware(downstream)

        sent, pending = await run_asgi_request(
            middleware,
            headers=[
                (
                    b"content-length",
                    str(TASK_REQUEST_LIMIT_BYTES + 1).encode("ascii"),
                )
            ],
        )

        self.assertEqual(downstream.handler_calls, 0)
        self.assertEqual(len(pending), 1)
        self.assertEqual(
            [
                message["status"]
                for message in sent
                if message["type"] == "http.response.start"
            ],
            [413],
        )

    async def test_oversized_request_to_another_route_is_not_limited(self):
        downstream = BodyReadingAsgiApp()
        middleware = TaskRequestLimitMiddleware(downstream, max_bytes=8)

        sent, _pending = await run_asgi_request(
            middleware,
            headers=[(b"content-length", b"9")],
            path="/status",
        )

        self.assertEqual(downstream.handler_calls, 1)
        self.assertEqual(sent[0]["status"], 204)

    async def test_missing_or_malformed_content_length_is_not_preempted(self):
        for headers in ([], [(b"content-length", b"not-a-number")]):
            with self.subTest(headers=headers):
                downstream = BodyReadingAsgiApp()
                middleware = TaskRequestLimitMiddleware(downstream, max_bytes=4)
                sent, _pending = await run_asgi_request(
                    middleware,
                    headers=headers,
                )
                self.assertEqual(downstream.handler_calls, 1)
                self.assertEqual(sent[0]["status"], 204)


class FakeDoclingDocument:
    def __init__(self, page_count=1):
        self.page_count = page_count

    def export_to_doctags(self, *, pages=None, add_page_index=True):
        page_streams = [
            "<section_header_level_1>Fixture</section_header_level_1>"
            "<text>Fixture page 1</text>"
        ]
        page_streams.extend(
            f"<text>Fixture page {page}</text>"
            for page in range(2, self.page_count + 1)
        )
        selected = (
            [page_streams[page - 1] for page in sorted(pages)]
            if pages is not None
            else page_streams
        )
        separator = "<page_break>" if add_page_index else ""
        return "<doctag>" + separator.join(selected) + "</doctag>"

    def export_to_markdown(self):
        return "# Diagnostic Docling Markdown"

    def export_to_dict(self):
        return {"name": "fixture"}


class TestService(unittest.TestCase):
    def setUp(self):
        self._storage = isolated_storage()
        self._storage.__enter__()
        self.addCleanup(self._storage.__exit__, None, None, None)
        global DATA_DIR, DOCUMENT_STORE_DIR
        DATA_DIR = str(paths.DEFAULT_DATA_DIR)
        DOCUMENT_STORE_DIR = str(paths.DEFAULT_DOCUMENT_STORE_DIR)

        self.client = TestClient(app)
        self._mkdir(DATA_DIR)
        self._mkdir(DOCUMENT_STORE_DIR)
        self._docling_patcher = patch(
            "app.parsing.docling_runner._convert_document",
            side_effect=self._fake_docling_document,
        )
        self._docling_patcher.start()
        self._table_patcher = patch(
            "app.parsing.orchestrator._run_table_extraction",
            return_value=TableExtractionOutput(),
        )
        self._table_patcher.start()

    def _mkdir(self, path):
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as exc:
            self.fail(f"Could not create test directory {path}: {exc}")

    def _write_bytes(self, path, content):
        try:
            with open(path, "wb") as output_file:
                output_file.write(content)
        except OSError as exc:
            self.fail(f"Could not write test bytes {path}: {exc}")

    def _write_text(self, path, content):
        try:
            with open(path, "w", encoding="utf-8") as output_file:
                output_file.write(content)
        except OSError as exc:
            self.fail(f"Could not write test text {path}: {exc}")

    def _write_json(self, path, content):
        try:
            with open(path, "w", encoding="utf-8") as output_file:
                json.dump(content, output_file)
        except OSError as exc:
            self.fail(f"Could not write test JSON {path}: {exc}")

    def _read_json(self, path):
        try:
            with open(path, encoding="utf-8") as input_file:
                return json.load(input_file)
        except (OSError, json.JSONDecodeError) as exc:
            self.fail(f"Could not read test JSON {path}: {exc}")
            return {}

    def _create_completed_task(
        self,
        source: bytes,
        *,
        params: dict[str, str],
        source_path: str | None = None,
    ) -> tuple[str, str, str]:
        task_id = str(uuid.uuid4())
        task_dir = os.path.join(DATA_DIR, task_id)
        self._mkdir(task_dir)
        content_hash = hashlib.sha256(source).hexdigest()
        metadata = {
            "task_id": task_id,
            "document_id": content_hash,
            "content_sha256": content_hash,
            "status": "completed",
            "created_at": "2026-06-23T00:00:00Z",
            "updated_at": "2026-06-23T00:00:00Z",
            "params": params,
            "stats": {},
            "error": None,
        }
        if source_path is not None:
            metadata["source_path"] = source_path
            self._write_bytes(os.path.join(task_dir, source_path), source)
        save_metadata(task_id, metadata)
        return task_id, task_dir, content_hash

    def _fake_docling_document(self, source_path):
        with fitz.open(source_path) as document:
            return FakeDoclingDocument(document.page_count)

    def tearDown(self):
        self._table_patcher.stop()
        self._docling_patcher.stop()
        self.client.close()

    def test_status_endpoint(self):
        response = self.client.get("/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("status", data)
        self.assertIn("gpu_available", data)
        self.assertEqual(data["status"], "online")

    def test_lifespan_starts_after_task_local_recovery_failure(self):
        task_id = str(uuid.uuid4())
        task_dir = paths.task_dir_for(task_id)
        task_dir.mkdir(parents=True)
        metadata = {
            "task_id": task_id,
            "content_sha256": "a" * 64,
            "status": "running",
            "params": {"source_name": "source.pdf"},
        }
        parse_worker.save_task_metadata(task_dir, metadata)
        stored_metadata = (task_dir / "metadata.json").read_bytes()

        with (
            patch("app.main.check_gpu_available", return_value=False),
            patch(
                "app.workers.parse_worker.save_task_metadata",
                side_effect=PermissionError(f"cannot write {task_dir}"),
            ),
            self.assertLogs(parse_worker.logger, level="WARNING"),
            self.client as client,
        ):
            response = client.get("/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "online")
        self.assertEqual((task_dir / "metadata.json").read_bytes(), stored_metadata)

    def test_lifespan_fails_when_shared_store_is_unavailable(self):
        with (
            patch("app.main.check_gpu_available", return_value=False),
            patch(
                "app.workers.parse_worker.task_store_lock_path",
                side_effect=PermissionError("shared store unavailable"),
            ),
            self.assertRaisesRegex(PermissionError, "shared store unavailable"),
            self.client as client,
        ):
            client.get("/status")

    def test_root_ui_describes_canonical_docling_doctags(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Docling DocTags", response.text)
        self.assertNotIn('id="pipeline-select"', response.text)
        self.assertNotIn('id="device-select"', response.text)
        self.assertNotIn('id="dpi-slider"', response.text)
        self.assertNotIn('id="url-input"', response.text)

    def test_tasks_require_an_upload(self):
        for data in ({}, {"url": "https://example.com/report.pdf"}):
            with self.subTest(data=data):
                response = self.client.post("/tasks", data=data)
                self.assertEqual(response.status_code, 422)
        self.assertEqual(list(Path(DATA_DIR).iterdir()), [])

    def test_declared_oversized_request_preempts_task_reservation(self):
        task_route = next(
            route
            for route in tasks_router.routes
            if isinstance(route, APIRoute) and route.path == "/tasks"
        )
        route_handler = AsyncMock()
        with (
            patch.object(task_route.dependant, "call", route_handler),
            patch("app.api.routes_tasks.http_task_dir") as task_dir,
            patch("starlette.background.BackgroundTasks.add_task") as add_task,
        ):
            response = self.client.post(
                "/tasks",
                content=b"",
                headers={
                    "content-length": str(TASK_REQUEST_LIMIT_BYTES + 1),
                    "content-type": "multipart/form-data; boundary=request-limit",
                    "origin": "http://localhost:5173",
                },
            )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(
            response.headers["access-control-allow-origin"],
            "http://localhost:5173",
        )
        self.assertEqual(
            response.json(),
            {"detail": "Request body exceeds the 51 MiB limit."},
        )
        route_handler.assert_not_awaited()
        task_dir.assert_not_called()
        add_task.assert_not_called()
        self.assertEqual(list(Path(DATA_DIR).iterdir()), [])

    def test_legacy_image_conversion_endpoint_is_removed(self):
        response = self.client.post(
            "/convert/images",
            files={"file": ("report.pdf", PDF_BYTES, "application/pdf")},
        )
        self.assertEqual(response.status_code, 404)

    def test_convert_pdf_to_images_rejects_page_count_over_budget(self):
        from app.parsing.render import convert_pdf_to_images

        with tempfile.TemporaryDirectory() as tmp_dir:
            source_path = os.path.join(tmp_dir, "source.pdf")
            output_dir = os.path.join(tmp_dir, "images")
            self._write_bytes(source_path, TWO_PAGE_PDF_BYTES)

            with self.assertRaisesRegex(ValueError, "too many pages"):
                convert_pdf_to_images(source_path, output_dir, dpi=72, max_pages=1)

    def test_convert_pdf_to_images_validates_selected_physical_pages(self):
        from app.parsing.render import convert_pdf_to_images

        with tempfile.TemporaryDirectory() as tmp_dir:
            source_path = os.path.join(tmp_dir, "source.pdf")
            output_dir = os.path.join(tmp_dir, "images")
            self._write_bytes(source_path, TWO_PAGE_PDF_BYTES)

            selected = convert_pdf_to_images(
                source_path,
                output_dir,
                dpi=72,
                page_numbers=[2],
            )
            self.assertEqual([Path(path).name for path in selected], ["page_02.png"])
            for invalid in ([0], [3], [1, 1]):
                with self.subTest(page_numbers=invalid), self.assertRaises(ValueError):
                    convert_pdf_to_images(
                        source_path,
                        output_dir,
                        dpi=72,
                        page_numbers=list(invalid),
                    )

    def test_convert_pdf_to_images_rejects_page_pixel_budget(self):
        from app.parsing.render import convert_pdf_to_images

        with tempfile.TemporaryDirectory() as tmp_dir:
            source_path = os.path.join(tmp_dir, "source.pdf")
            output_dir = os.path.join(tmp_dir, "images")
            self._write_bytes(source_path, make_pdf_bytes(width=1000, height=1000))

            with self.assertRaisesRegex(ValueError, "too large to render"):
                convert_pdf_to_images(
                    source_path, output_dir, dpi=72, max_page_pixels=10
                )

    def test_source_pdf_route_serves_the_retained_upload_with_ranges(self):
        task_id, _, _ = self._create_completed_task(
            PDF_BYTES,
            params={"source_name": "report.pdf"},
            source_path="source.pdf",
        )

        response = self.client.get(f"/tasks/{task_id}/source")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("content-type"), "application/pdf")
        self.assertEqual(response.content, PDF_BYTES)
        self.assertEqual(response.headers.get("accept-ranges"), "bytes")

        head = self.client.head(f"/tasks/{task_id}/source")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(
            head.headers.get("content-length"), str(len(PDF_BYTES))
        )

        partial = self.client.get(
            f"/tasks/{task_id}/source", headers={"Range": "bytes=0-3"}
        )
        self.assertEqual(partial.status_code, 206)
        self.assertEqual(partial.content, PDF_BYTES[:4])
        self.assertEqual(
            partial.headers.get("content-range"), f"bytes 0-3/{len(PDF_BYTES)}"
        )

        unsatisfiable = self.client.get(
            f"/tasks/{task_id}/source",
            headers={"Range": f"bytes={len(PDF_BYTES) + 10}-"},
        )
        self.assertEqual(unsatisfiable.status_code, 416)

    def test_source_pdf_route_reports_a_missing_retained_upload(self):
        task_id, _, _ = self._create_completed_task(
            PDF_BYTES, params={"source_name": "report.pdf"}
        )

        response = self.client.get(f"/tasks/{task_id}/source")
        self.assertEqual(response.status_code, 404)

        missing = self.client.get(f"/tasks/{uuid.uuid4()}/source")
        self.assertEqual(missing.status_code, 404)

        invalid = self.client.get("/tasks/not-a-uuid/source")
        self.assertEqual(invalid.status_code, 400)

    def test_get_nonexistent_and_invalid_tasks(self):
        response = self.client.get(f"/tasks/{uuid.uuid4()}")
        self.assertEqual(response.status_code, 404)

        response = self.client.get("/tasks/not-a-uuid")
        self.assertEqual(response.status_code, 400)

    @patch("app.api.routes_tasks.run_in_threadpool")
    def test_create_task_with_upload_sanitizes_filename_and_stores_source_pdf(
        self, mock_threadpool
    ):
        mock_threadpool.side_effect = lambda func, *args, **kwargs: func(
            *args, **kwargs
        )

        response = self.client.post(
            "/tasks",
            files={
                "file": ("../evil.pdf", PDF_BYTES, "application/pdf; charset=binary")
            },
        )
        self.assertEqual(response.status_code, 202)
        mock_threadpool.assert_awaited_once()
        self.assertEqual(
            mock_threadpool.call_args.args[0].__name__,
            "save_uploaded_source",
        )
        task_id = response.json()["task_id"]
        metadata = load_metadata(task_id)
        content_hash = hashlib.sha256(PDF_BYTES).hexdigest()
        self.assertEqual(response.json()["document_id"], f"sha256:{content_hash}")
        self.assertEqual(response.json()["content_sha256"], content_hash)
        self.assertEqual(metadata["params"]["source_name"], "evil.pdf")
        self.assertEqual(metadata["document_id"], f"sha256:{content_hash}")
        self.assertEqual(metadata["content_sha256"], content_hash)
        self.assertEqual(metadata["source_path"], "source.pdf")
        self.assertEqual(metadata["source_kind"], "upload")
        self.assertEqual(
            metadata["source_store_path"], f"data/sources/{content_hash}.pdf"
        )
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(metadata["selected_parser"], "docling_doctags")
        polled = self.client.get(f"/tasks/{task_id}")
        self.assertEqual(polled.status_code, 200)
        self.assertEqual(polled.json()["document_id"], f"sha256:{content_hash}")
        self.assertEqual(polled.json()["content_sha256"], content_hash)
        self.assertEqual(
            polled.json()["params"]["table_parser"],
            metadata["params"]["table_parser"],
        )
        self.assertEqual(
            polled.json()["params"]["camelot_version"],
            metadata["params"]["camelot_version"],
        )
        self.assertTrue(os.path.exists(os.path.join(DATA_DIR, task_id, "source.pdf")))
        self.assertTrue(
            os.path.exists(
                os.path.join(
                    os.path.dirname(DATA_DIR), "sources", f"{content_hash}.pdf"
                )
            )
        )
        parsed_document_path = os.path.join(DATA_DIR, task_id, "parsed_document.json")
        self.assertTrue(os.path.exists(parsed_document_path))
        parsed_document = self._read_json(parsed_document_path)
        self.assertEqual(parsed_document["schema_version"], "parsed_document.v1")
        self.assertEqual(
            parsed_document["document"]["document_id"], f"sha256:{content_hash}"
        )
        self.assertEqual(parsed_document["document"]["content_sha256"], content_hash)
        self.assertTrue(parsed_document["preprocessing"]["preprocess_id"])
        self.assertTrue(parsed_document["preprocessing"]["config_hash"])
        self.assertIn(
            "docling_doctags", {run["parser"] for run in parsed_document["parser_runs"]}
        )
        self.assertEqual(
            parsed_document["arbitration"]["primary_document_parser"], "docling_doctags"
        )
        self.assertTrue(parsed_document["arbitration"]["page_decisions"])
        self.assertIn("page_marked_text", parsed_document["text_views"])
        self.assertEqual(
            parsed_document["text_views"]["llm_markdown"],
            "# Fixture\n\nFixture page 1",
        )
        self.assertTrue(parsed_document["artifacts"]["raw_docling_json_ref"])
        self.assertTrue(parsed_document["artifacts"]["raw_doctags_ref"])
        self.assertTrue(parsed_document["artifacts"]["llm_markdown_ref"])
        for ref_name in (
            "raw_docling_json_ref",
            "raw_doctags_ref",
            "llm_markdown_ref",
        ):
            ref = parsed_document["artifacts"][ref_name]
            self.assertIn("/generations/", ref)
            self.assertNotIn("/.pending/", ref)
        task_source = Path(DATA_DIR) / task_id / "source.pdf"
        source_blob = Path(DATA_DIR).parent / "sources" / f"{content_hash}.pdf"
        self.assertEqual(task_source.stat().st_ino, source_blob.stat().st_ino)
        self.assertTrue(metadata["canonical_parsed_document_ref"])
        self.assertTrue(parsed_document["pages"])
        self.assertFalse(os.path.exists(os.path.join(DATA_DIR, "evil.pdf")))

    def test_deprecated_parser_fields_do_not_change_canonical_config(self):
        response = self.client.post(
            "/tasks",
            data={"pipeline": "paddleocr", "device": "cpu"},
            files={"file": ("test.pdf", PDF_BYTES, "application/pdf")},
        )
        self.assertEqual(response.status_code, 202)
        task_id = response.json()["task_id"]
        metadata = load_metadata(task_id)
        self.assertEqual(metadata["params"]["pipeline"], "docling_doctags_canonical")
        self.assertEqual(metadata["params"]["ocr_fallback_dpi"], 150)
        self.assertEqual(metadata["params"]["ocr_fallback_device_policy"], "auto")
        self.assertNotIn("device", metadata["params"])

    def test_upload_mime_accepts_current_pdf_hints(self):
        for content_type in (
            None,
            "application/pdf",
            "application/x-pdf",
            "application/octet-stream",
            "binary/octet-stream",
        ):
            with (
                self.subTest(content_type=content_type),
                tempfile.TemporaryFile() as source,
            ):
                headers = (
                    Headers({"content-type": content_type})
                    if content_type is not None
                    else Headers()
                )
                upload = UploadFile(
                    source,
                    filename="report.pdf",
                    headers=headers,
                )
                validate_upload_mime(upload)

    def test_create_task_rejects_invalid_extension_mime_and_magic(self):
        cases = (
            ("report.txt", PDF_BYTES, "application/pdf"),
            ("report.pdf", PDF_BYTES, "text/plain"),
            ("report.pdf", b"not a PDF", "application/pdf"),
        )
        for filename, content, content_type in cases:
            with self.subTest(filename=filename, content_type=content_type):
                response = self.client.post(
                    "/tasks",
                    files={"file": (filename, content, content_type)},
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(list(Path(DATA_DIR).iterdir()), [])

    def test_create_task_storage_failure_is_path_free(self):
        internal_path = str(paths.DEFAULT_DATA_DIR / "private" / "metadata.json")
        with patch(
            "app.api.routes_tasks.save_metadata",
            side_effect=OSError(internal_path),
        ):
            response = self.client.post(
                "/tasks",
                files={"file": ("report.pdf", PDF_BYTES, "application/pdf")},
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"detail": "Could not create parsing task."})
        self.assertNotIn(internal_path, response.text)
        self.assertEqual(list(Path(DATA_DIR).iterdir()), [])

    def test_same_source_document_twice_uses_one_hash_addressed_blob(self):
        responses = [
            self.client.post(
                "/tasks",
                files={"file": (name, PDF_BYTES, "application/pdf")},
            )
            for name in ("first.pdf", "second.pdf")
        ]
        self.assertEqual([response.status_code for response in responses], [202, 202])
        task_ids = [response.json()["task_id"] for response in responses]
        metadata = [load_metadata(task_id) for task_id in task_ids]
        self.assertEqual(
            len({item["source_store_path"] for item in metadata}),
            1,
        )
        source_blobs = list(paths.DEFAULT_SOURCE_STORE_DIR.glob("*.pdf"))
        self.assertEqual(len(source_blobs), 1)
        self.assertEqual(source_blobs[0].read_bytes(), PDF_BYTES)

    def test_upload_mime_rejects_disallowed_hint(self):
        with tempfile.TemporaryFile() as source:
            upload = UploadFile(
                source,
                filename="report.pdf",
                headers=Headers({"content-type": "text/plain"}),
            )
            with self.assertRaises(HTTPException) as raised:
                validate_upload_mime(upload)
        self.assertEqual(raised.exception.status_code, 400)

    @patch("app.ingestion.upload.MAX_UPLOAD_BYTES", 8)
    def test_create_task_rejects_oversized_upload(self):
        response = self.client.post(
            "/tasks",
            files={"file": ("report.pdf", PDF_BYTES, "application/pdf")},
        )
        self.assertEqual(response.status_code, 413)
        self.assertIn("maximum allowed size", response.json()["detail"])

    def test_exact_50_mib_source_passes_post_parse_byte_check(self):
        self.assertEqual(MAX_UPLOAD_BYTES, 50 * 1024 * 1024)
        destination = Path(DATA_DIR) / "exact-limit.pdf"
        with tempfile.TemporaryFile() as source:
            source.write(b"%PDF-")
            source.seek(MAX_UPLOAD_BYTES - 1)
            source.write(b"\0")
            source.seek(0)
            upload = UploadFile(source, filename="exact-limit.pdf")

            copied = copy_upload_to_path(upload, destination)

        self.assertEqual(copied, MAX_UPLOAD_BYTES)
        self.assertEqual(destination.stat().st_size, MAX_UPLOAD_BYTES)

    def test_upload_staging_failure_publishes_no_partial_source(self):
        destination = Path(DATA_DIR) / "staged.pdf"
        with tempfile.TemporaryFile() as source:
            source.write(PDF_BYTES)
            source.seek(0)
            upload = UploadFile(source, filename="staged.pdf")
            with (
                patch(
                    "app.ingestion.upload.os.replace",
                    side_effect=OSError("stop"),
                ),
                self.assertRaisesRegex(OSError, "stop"),
            ):
                copy_upload_to_path(upload, destination)

        self.assertFalse(destination.exists())
        self.assertEqual(list(destination.parent.glob(".staged.pdf.*.tmp")), [])

    def test_get_task_markdown_and_document_endpoints(self):
        task_id, task_dir, content_hash = self._create_completed_task(
            PDF_BYTES,
            params={
                "pipeline": "all",
                "device": "cpu",
                "source_name": "test.pdf",
            },
        )

        output_dir = os.path.join(task_dir, "output", "test_doc")
        docling_pdf_dir = os.path.join(output_dir, "docling_pdf")
        docling_img_dir = os.path.join(output_dir, "docling_images")
        paddle_img_dir = os.path.join(output_dir, "paddleocr_images")
        self._mkdir(docling_pdf_dir)
        self._mkdir(docling_img_dir)
        self._mkdir(paddle_img_dir)

        docling_pdf_content = "# Docling PDF Content\n" + ("body " * 50)
        self._write_text(
            os.path.join(docling_pdf_dir, "document.md"), docling_pdf_content
        )
        self._write_text(
            os.path.join(docling_img_dir, "page_01.md"), "# Docling Img Page 1"
        )
        self._write_text(
            os.path.join(docling_img_dir, "page_02.md"), "# Docling Img Page 2"
        )
        self._mkdir(os.path.join(paddle_img_dir, "page_01"))
        self._mkdir(os.path.join(paddle_img_dir, "page_02"))
        self._write_text(
            os.path.join(paddle_img_dir, "page_01", "page_01.md"), "# Paddle Page 1"
        )
        self._write_text(
            os.path.join(paddle_img_dir, "page_02", "page_02.md"), "# Paddle Page 2"
        )

        stored_document = {
            "schema_version": "parsed_document.v1",
            "document": {
                "document_id": f"sha256:{content_hash}",
                "content_sha256": content_hash,
                "source": {
                    "kind": "upload",
                    "original_filename": "test.pdf",
                    "byte_size": len(PDF_BYTES),
                },
                "created_at": "2026-06-23T00:00:00Z",
                "page_count": 1,
            },
            "preprocessing": {
                "preprocess_id": "sha256:" + "b" * 64,
                "config_hash": "c" * 64,
                "status": "completed",
            },
            "artifacts": {"source_ref": f"data/sources/{content_hash}.pdf"},
            "parser_runs": [{"parser": "docling_pdf", "status": "success"}],
            "arbitration": {
                "primary_document_parser": "docling_pdf",
                "strategy": "document_primary_page_fallback",
                "page_decisions": [
                    {
                        "page": 1,
                        "selected_text_parser": "docling_pdf",
                        "reason": "stored-json-sentinel",
                    }
                ],
            },
            "text_views": {
                "plain_text": docling_pdf_content,
                "page_marked_text": f"[DOCUMENT]\n{docling_pdf_content}",
            },
            "pages": [],
            "tables": [],
        }
        self._write_json(
            os.path.join(task_dir, "parsed_document.json"), stored_document
        )

        response = self.client.get(f"/tasks/{task_id}/markdown")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("content-type"), "text/markdown; charset=utf-8"
        )
        self.assertEqual(response.text, f"[DOCUMENT]\n{docling_pdf_content}")

        response = self.client.get(f"/tasks/{task_id}/markdown?pipeline=ignored")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, f"[DOCUMENT]\n{docling_pdf_content}")

        # /document must serve the stored JSON, not rebuild from artifacts.
        self._write_text(os.path.join(docling_pdf_dir, "document.md"), "mutated")
        response = self.client.get(f"/tasks/{task_id}/document")
        self.assertEqual(response.status_code, 200)
        document = response.json()
        self.assertEqual(
            document["arbitration"]["page_decisions"][0]["reason"],
            "stored-json-sentinel",
        )
        self.assertEqual(
            document["text_views"]["page_marked_text"],
            f"[DOCUMENT]\n{docling_pdf_content}",
        )

        alias_response = self.client.get(f"/tasks/{task_id}/parsed-document")
        self.assertEqual(alias_response.status_code, 200)
        self.assertEqual(alias_response.json(), document)

    def test_fallback_document_preserves_page_markers_and_spans(self):
        task_id, task_dir, _ = self._create_completed_task(
            TWO_PAGE_PDF_BYTES,
            params={
                "pipeline": "all",
                "device": "cpu",
                "source_name": "test.pdf",
            },
            source_path="source.pdf",
        )

        output_dir = os.path.join(task_dir, "output", "test_doc")
        docling_pdf_dir = os.path.join(output_dir, "docling_pdf")
        docling_img_dir = os.path.join(output_dir, "docling_images")
        self._mkdir(docling_pdf_dir)
        self._mkdir(docling_img_dir)
        self._write_text(os.path.join(docling_pdf_dir, "document.md"), "too short")
        page_1 = "# OCR Page 1"
        page_2 = "# OCR Page 2"
        self._write_text(os.path.join(docling_img_dir, "page_01.md"), page_1)
        self._write_text(os.path.join(docling_img_dir, "page_02.md"), page_2)
        self._write_json(
            os.path.join(output_dir, "stats_docling.json"),
            {
                "docling_pdf": {
                    "time": 0.1,
                    "char_count": 9,
                    "status": "Success",
                },
                "docling_images": {
                    "time": 0.2,
                    "char_count": len(page_1) + len(page_2),
                    "status": "Success",
                },
            },
        )

        document = build_parsed_document(task_id).model_dump(mode="json")
        page_1_text = "# Fixture\n\nFixture page 1"
        page_2_text = "Fixture page 2"
        expected = f"[PAGE 1]\n{page_1_text}\n\n[PAGE 2]\n{page_2_text}"
        page_2_start = len(f"[PAGE 1]\n{page_1_text}\n\n[PAGE 2]\n")
        self.assertEqual(
            document["arbitration"]["primary_document_parser"], "docling_doctags"
        )
        self.assertEqual(document["text_views"]["page_marked_text"], expected)
        self.assertEqual(
            document["text_views"]["llm_markdown"],
            "# Fixture\n\nFixture page 1\n\n---\n\nFixture page 2",
        )
        span_1 = document["pages"][0]["char_span"]
        span_2 = document["pages"][1]["char_span"]
        self.assertEqual(span_1["page_marked_text_start"], 9)
        self.assertEqual(span_1["page_marked_text_end"], 9 + len(page_1_text))
        self.assertEqual(span_2["page_marked_text_start"], page_2_start)
        self.assertEqual(
            span_2["page_marked_text_end"], page_2_start + len(page_2_text)
        )
        self.assertEqual(span_1["llm_markdown_start"], 0)
        self.assertEqual(
            span_2["doc_tags_simplified_start"],
            len("# Fixture\n\nFixture page 1\n\n---\n\n"),
        )

    def test_two_page_pdf_produces_two_page_parsed_document(self):
        task_id, task_dir, _ = self._create_completed_task(
            TWO_PAGE_PDF_BYTES,
            params={
                "pipeline": "docling_pdf",
                "device": "cpu",
                "source_name": "two-page.pdf",
            },
            source_path="source.pdf",
        )
        output_dir = os.path.join(task_dir, "output", "source")
        docling_pdf_dir = os.path.join(output_dir, "docling_pdf")
        self._mkdir(docling_pdf_dir)
        selected_markdown = "# Docling document\n" + ("body " * 60)
        self._write_text(
            os.path.join(docling_pdf_dir, "document.md"), selected_markdown
        )
        self._write_json(
            os.path.join(output_dir, "stats_docling.json"),
            {
                "docling_pdf": {
                    "time": 0.1,
                    "char_count": len(selected_markdown),
                    "status": "Success",
                }
            },
        )

        document = build_parsed_document(task_id).model_dump(mode="json")

        self.assertEqual(document["document"]["page_count"], 2)
        self.assertEqual(len(document["pages"]), 2)
        self.assertEqual(document["pages"][0]["page"], 1)
        self.assertEqual(document["pages"][1]["page"], 2)
        self.assertEqual(
            document["text_views"]["page_marked_text"],
            "[PAGE 1]\n# Fixture\n\nFixture page 1\n\n[PAGE 2]\nFixture page 2",
        )
        self.assertEqual(document["pages"][0]["char_span"]["page_marked_text_start"], 9)
        self.assertEqual(document["tables"], [])
        self.assertEqual(len(document["arbitration"]["page_decisions"]), 2)
        self.assertEqual(
            document["arbitration"]["primary_document_parser"], "docling_doctags"
        )

    def test_completed_task_missing_parsed_document_returns_404(self):
        task_id = str(uuid.uuid4())
        task_dir = os.path.join(DATA_DIR, task_id)
        self._mkdir(task_dir)
        save_metadata(
            task_id,
            {
                "task_id": task_id,
                "document_id": "a" * 64,
                "content_sha256": "a" * 64,
                "status": "completed",
                "created_at": "2026-06-23T00:00:00Z",
                "updated_at": "2026-06-23T00:00:00Z",
                "params": {"pipeline": "docling_pdf", "device": "cpu"},
                "stats": {},
                "error": None,
            },
        )

        response = self.client.get(f"/tasks/{task_id}/document")
        self.assertEqual(response.status_code, 404)
        self.assertIn("Parsed document JSON not found", response.json()["detail"])

    def test_openapi_schema_uses_canonical_ingestion_form_fields(self):
        response = self.client.get("/openapi.json")
        self.assertEqual(response.status_code, 200)
        openapi = response.json()
        self.assertNotIn("/tasks/{task_id}/parsed-document", openapi["paths"])
        self.assertNotIn("/convert/images", openapi["paths"])

        schemas = openapi["components"]["schemas"]
        self.assertNotIn("Pipeline", schemas)
        self.assertNotIn("PipelineConfig", schemas)
        self.assertNotIn("DeviceConfig", schemas)
        self.assertNotIn("Device", schemas)

        request_body = openapi["paths"]["/tasks"]["post"]["requestBody"]
        multipart_schema = request_body["content"]["multipart/form-data"]["schema"]
        ref_name = multipart_schema["$ref"].rsplit("/", 1)[-1]
        form_schema = schemas[ref_name]
        fields = form_schema["properties"]
        self.assertEqual(set(fields), {"file"})
        self.assertEqual(form_schema["required"], ["file"])

        create_schema = openapi["paths"]["/tasks"]["post"]["responses"]["202"][
            "content"
        ]["application/json"]["schema"]
        status_schema = openapi["paths"]["/tasks/{task_id}"]["get"]["responses"]["200"][
            "content"
        ]["application/json"]["schema"]
        self.assertEqual(
            create_schema["$ref"],
            "#/components/schemas/TaskCreatedResponse",
        )
        self.assertEqual(
            status_schema["$ref"],
            "#/components/schemas/TaskStatusResponse",
        )
        markdown_content = openapi["paths"]["/tasks/{task_id}/markdown"]["get"][
            "responses"
        ]["200"]["content"]
        download_content = openapi["paths"]["/tasks/{task_id}/download"]["get"][
            "responses"
        ]["200"]["content"]
        self.assertIn("text/markdown", markdown_content)
        self.assertIn("application/zip", download_content)


if __name__ == "__main__":
    unittest.main()
