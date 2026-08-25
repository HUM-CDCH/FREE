from __future__ import annotations

import hashlib
import time
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from threading import Event, Lock
from typing import Any
from unittest import TestCase

from fastapi.testclient import TestClient


TASK_STATUS_KEYS = {
    "task_id",
    "document_id",
    "content_sha256",
    "source_kind",
    "status",
    "created_at",
    "updated_at",
    "params",
    "stats",
    "parser_runs",
    "interrupted_attempt",
    "selected_parser",
    "error_code",
    "error",
}

TASK_PARAMETER_KEYS = {
    "pipeline",
    "policy_revision",
    "doctags_converter_revision",
    "v2_renderer_revision",
    "parsed_document_schema_revision",
    "docling_version",
    "ocr_fallback_dpi",
    "ocr_fallback_device_policy",
    "resolved_ocr_device",
    "paddleocr_model",
    "paddleocr_version",
    "source_name",
    "table_parser",
    "camelot_version",
}

TERMINAL_STATUSES = {"cancelled", "completed", "failed"}


def make_pdf() -> bytes:
    """Return a small, structurally valid one-page PDF without test dependencies."""

    objects = (
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    )
    chunks = [b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"]
    offsets = [0]
    cursor = len(chunks[0])
    for number, body in enumerate(objects, start=1):
        offsets.append(cursor)
        chunk = f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
        chunks.append(chunk)
        cursor += len(chunk)
    xref_offset = cursor
    xref = [f"xref\n0 {len(objects) + 1}\n".encode(), b"0000000000 65535 f \n"]
    xref.extend(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    trailer = (
        b"trailer\n"
        + f"<< /Size {len(objects) + 1} /Root 1 0 R >>\n".encode()
        + f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return b"".join((*chunks, *xref, trailer))


PDF_BYTES = make_pdf()
MARKDOWN = "<!-- FREE:PAGE 1 -->\n"


def parser_run() -> dict[str, Any]:
    return {
        "parser": "docling",
        "version": "test-docling",
        "status": "success",
        "warnings": [],
        "error": None,
    }


def parsed_document(context: Mapping[str, Any]) -> dict[str, Any]:
    """A minimal document accepted by Studio's strict parsed_document.v2 decoder."""

    created_at = str(context["created_at"])
    markdown_size = len(MARKDOWN.encode("utf-8"))
    return {
        "schema_version": "parsed_document.v2",
        "document": {
            "document_id": str(context["document_id"]),
            "content_sha256": str(context["content_sha256"]),
            "source": {
                "kind": "upload",
                "original_filename": str(context["source_name"]),
                "media_type": "application/pdf",
                "byte_size": None,
            },
            "created_at": created_at,
            "page_count": 1,
            "language_hints": [],
            "is_encrypted": False,
            "input_profile": {
                "file_kind": "pdf",
                "detected_mime": "application/pdf",
                "pdf_version": "1.4",
                "has_text_layer": False,
                "has_images": False,
            },
        },
        "preprocessing": {
            "preprocess_id": str(context["preprocess_id"]),
            "profile": "docling_default",
            "service_version": "test-service",
            "started_at": created_at,
            "finished_at": created_at,
            "status": "completed",
            "warnings": [],
        },
        "page_count": 1,
        "page_mapping_verified": True,
        "artifacts": {
            "source_ref": "source.pdf",
            "parsed_json_ref": "parsed_document.json",
            "markdown_ref": "artifacts/document.llm.md",
        },
        "parser_runs": [parser_run()],
        # Studio's ingestion provenance reader requires this even though its
        # generic document decoder permits null arbitration metadata.
        "arbitration": {"primary_document_parser": "docling"},
        "diagnostics": [],
        "content_stream": [],
        "pages": [
            {
                "page_number": 1,
                "width_pt": 612.0,
                "height_pt": 792.0,
                "rotation": 0,
                "ordered_content": [],
                "unplaced_content": [],
                "markdown_span": {"start": 0, "end": markdown_size},
            }
        ],
        "tables": [],
        "evidence_index": {"anchors": []},
    }


def parse_result(source_path: Path, context: Mapping[str, Any]) -> dict[str, Any]:
    source = source_path.read_bytes()
    if hashlib.sha256(source).hexdigest() != context["content_sha256"]:
        raise AssertionError("parser context does not describe the retained source")
    return {
        "parsed_document": parsed_document(context),
        "markdown": MARKDOWN,
        "stats": {
            "task": {"cache_status": "miss"},
            "docling": {"status": "success"},
        },
        "parser_runs": [parser_run()],
        "selected_parser": "docling",
        "warnings": [],
        "docling_version": "test-docling",
    }


class ImmediateParser:
    def __init__(self) -> None:
        self.contexts: list[dict[str, Any]] = []
        self._lock = Lock()

    def parse(
        self,
        source_path: Path,
        context: Mapping[str, Any],
    ) -> dict[str, Any]:
        with self._lock:
            self.contexts.append(dict(context))
        return parse_result(source_path, context)


class BlockingParser(ImmediateParser):
    def __init__(self) -> None:
        super().__init__()
        self.started = Event()
        self.release = Event()
        self.finished = Event()

    def parse(
        self,
        source_path: Path,
        context: Mapping[str, Any],
    ) -> dict[str, Any]:
        with self._lock:
            self.contexts.append(dict(context))
        self.started.set()
        try:
            if not self.release.wait(timeout=10):
                raise TimeoutError("test parser was not released")
            return parse_result(source_path, context)
        finally:
            self.finished.set()


class FailingParser:
    def parse(self, _source_path: Path, _context: Mapping[str, Any]) -> None:
        raise RuntimeError("controlled parser failure")


def submit_pdf(
    client: TestClient,
    *,
    filename: str = "sample.pdf",
    pdf: bytes = PDF_BYTES,
):
    return client.post(
        "/tasks",
        files={"file": (filename, pdf, "application/pdf")},
    )


def wait_for_status(
    client: TestClient,
    task_id: str,
    expected: str | set[str],
    *,
    timeout: float = 5.0,
) -> dict[str, Any]:
    expected_statuses = {expected} if isinstance(expected, str) else expected
    deadline = time.monotonic() + timeout
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        response = client.get(f"/tasks/{task_id}")
        if response.status_code != 200:
            raise AssertionError(response.text)
        last = response.json()
        if last["status"] in expected_statuses:
            return last
        time.sleep(0.01)
    raise AssertionError(
        f"task {task_id} did not reach {sorted(expected_statuses)}; last={last}"
    )


def assert_status_contract(test: TestCase, payload: Mapping[str, Any]) -> None:
    test.assertEqual(set(payload), TASK_STATUS_KEYS)
    test.assertEqual(set(payload["params"]), TASK_PARAMETER_KEYS)
    test.assertEqual(payload["source_kind"], "upload")
    test.assertEqual(
        payload["params"]["parsed_document_schema_revision"],
        "parsed_document.v2",
    )
    test.assertEqual(payload["params"]["paddleocr_model"], "unavailable")
    test.assertEqual(payload["params"]["paddleocr_version"], "unavailable")
    test.assertEqual(payload["params"]["camelot_version"], "unavailable")
    test.assertIsInstance(payload["stats"], dict)
    test.assertIsInstance(payload["parser_runs"], list)
    test.assertIsNone(payload["interrupted_attempt"])
    for field in ("created_at", "updated_at"):
        parsed = datetime.fromisoformat(payload[field].replace("Z", "+00:00"))
        test.assertIsNotNone(parsed.tzinfo)
