"""Opt-in golden-sample e2e test: real pipeline over a real source document.

Runs examples/Beretning_Ellekilde_8_13.pdf through the unmocked pipeline
(Docling ingestion + camelot table extraction; all pages have native text so
the OCR fallback never triggers) and compares a normalized, deterministic
subset of the ParsedDocument against a checked-in golden file.

    RUN_GOLDEN_E2E=1 uv run --no-sync python -m unittest tests.test_golden_e2e
    RUN_GOLDEN_E2E=1 UPDATE_GOLDEN=1 uv run --no-sync python -m unittest tests.test_golden_e2e  # regenerate

ponytail: Docling/camelot upgrades may legitimately change output; the
regen command above is the upgrade path.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.storage import paths
from app.workers import parse_worker
from main import app

SOURCE_PDF = Path(__file__).resolve().parents[3] / "examples" / "Beretning_Ellekilde_8_13.pdf"
GOLDEN_PATH = Path(__file__).resolve().parent / "golden" / "Beretning_Ellekilde_8_13.golden.json"


def normalize(parsed: dict) -> dict:
    """Deterministic subset of a ParsedDocument dump.

    Excludes timestamps, durations, version-derived hashes, and artifact refs
    containing task/generation UUIDs.
    """
    document = parsed["document"]
    return {
        "schema_version": parsed["schema_version"],
        "document": {
            "document_id": document["document_id"],
            "content_sha256": document["content_sha256"],
            "page_count": document["page_count"],
            "is_encrypted": document["is_encrypted"],
            "input_profile": document["input_profile"],
            "source_byte_size": document["source"]["byte_size"],
        },
        "arbitration": parsed["arbitration"],
        "text_views": parsed["text_views"],
        "pages": [
            {
                "page": page["page"],
                "width_pt": page["width_pt"],
                "height_pt": page["height_pt"],
                "rotation": page["rotation"],
                "selected_parser": page["selected_parser"],
                "text": page["text"],
                "markdown": page["markdown"],
                "char_span": page["char_span"],
            }
            for page in parsed["pages"]
        ],
        "tables": [
            {key: value for key, value in table.items() if not key.endswith("_ref")}
            for table in parsed["tables"]
        ],
    }


@unittest.skipUnless(
    os.getenv("RUN_GOLDEN_E2E") == "1",
    "set RUN_GOLDEN_E2E=1 to run the real-pipeline golden e2e test",
)
class TestGoldenE2E(unittest.TestCase):
    def setUp(self):
        self._storage_tmp = tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT)
        root = Path(self._storage_tmp.name)
        self._original_storage_paths = (
            paths.DEFAULT_DATA_DIR,
            paths.DEFAULT_SOURCE_STORE_DIR,
            paths.DEFAULT_DOCUMENT_STORE_DIR,
            parse_worker.DEFAULT_DATA_DIR,
        )
        paths.DEFAULT_DATA_DIR = root / "tasks"
        paths.DEFAULT_SOURCE_STORE_DIR = root / "sources"
        paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
        parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        (
            paths.DEFAULT_DATA_DIR,
            paths.DEFAULT_SOURCE_STORE_DIR,
            paths.DEFAULT_DOCUMENT_STORE_DIR,
            parse_worker.DEFAULT_DATA_DIR,
        ) = self._original_storage_paths
        self._storage_tmp.cleanup()

    def test_parsed_document_matches_golden(self):
        response = self.client.post(
            "/tasks",
            files={
                "file": (
                    SOURCE_PDF.name,
                    SOURCE_PDF.read_bytes(),
                    "application/pdf",
                )
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        task_id = response.json()["task_id"]

        status = self.client.get(f"/tasks/{task_id}").json()
        self.assertEqual(status["status"], "completed", status)

        parsed = self.client.get(f"/tasks/{task_id}/parsed-document").json()
        actual = normalize(parsed)

        if os.getenv("UPDATE_GOLDEN") == "1":
            GOLDEN_PATH.parent.mkdir(exist_ok=True)
            GOLDEN_PATH.write_text(
                json.dumps(actual, indent=2, ensure_ascii=False, sort_keys=True)
                + "\n",
                encoding="utf-8",
            )
            return

        self.assertTrue(
            GOLDEN_PATH.exists(),
            f"missing {GOLDEN_PATH}; regenerate with UPDATE_GOLDEN=1",
        )
        golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
        self.assertEqual(actual, golden)

        markdown = self.client.get(f"/tasks/{task_id}/markdown")
        self.assertEqual(markdown.status_code, 200)
        self.assertEqual(markdown.text, golden["text_views"]["llm_markdown"])


if __name__ == "__main__":
    unittest.main()
