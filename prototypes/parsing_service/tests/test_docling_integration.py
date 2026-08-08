"""Opt-in smoke test for the installed Docling exporter contract."""

from __future__ import annotations

import importlib
import inspect
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import fitz  # type: ignore[import-not-found]

from app.parsing.docling_runner import _convert_document, run_docling_ingestion
from app.parsing.orchestrator import _reviewed_continuations
from app.storage.paths import SERVICE_ROOT
from app.parsing.doctags_to_markdown import convert_doctags_to_markdown


class TestInstalledDoclingContract(unittest.TestCase):
    def test_physical_page_export_api_is_available_without_model_loading(self):
        converter_module = importlib.import_module("docling.document_converter")
        document_module = importlib.import_module("docling_core.types.doc.document")
        converter = converter_module.DocumentConverter
        document_type = document_module.DoclingDocument

        self.assertTrue(callable(converter))
        parameters = inspect.signature(document_type.export_to_doctags).parameters
        self.assertIn("pages", parameters)
        self.assertIn("add_page_index", parameters)


@unittest.skipUnless(
    os.getenv("RUN_DOCLING_INTEGRATION") == "1",
    "set RUN_DOCLING_INTEGRATION=1 to run the real Docling smoke test",
)
class TestDoclingIntegration(unittest.TestCase):
    def test_locked_example_capture_admits_only_reviewed_6_to_7(self):
        source = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "Beretning_Ellekilde_8_13.pdf"
        )
        artifact_root = SERVICE_ROOT / "data" / ".producer-review-test"
        shutil.rmtree(artifact_root, ignore_errors=True)
        try:
            output = run_docling_ingestion(
                source,
                "fbd6884163b68656687d4c6ab7395be6ea306a5faf7b94253f18eb50c60b9679",
                physical_pages=list(range(1, 7)),
                artifact_root=artifact_root,
            )
            pairs, _diagnostics = _reviewed_continuations(output)
            self.assertEqual(pairs, (("#/tables/6", "#/tables/7"),))
            self.assertNotIn(("#/tables/10", "#/tables/11"), pairs)
        finally:
            shutil.rmtree(artifact_root, ignore_errors=True)

    def test_real_pdf_export_produces_clean_canonical_markdown(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "fixture.pdf"
            pdf = fitz.open()
            page = pdf.new_page(width=300, height=300)
            page.insert_text((36, 72), "FREE Docling integration fixture")
            pdf.save(source)
            pdf.close()

            document = _convert_document(source)
            raw_doctags = document.export_to_doctags()
            result = convert_doctags_to_markdown(raw_doctags)

        self.assertIn("FREE Docling integration fixture", result.markdown)
        self.assertNotIn("<doctag>", result.markdown)
        self.assertNotIn("<text>", result.markdown)
        self.assertTrue(result.page_spans)


if __name__ == "__main__":
    unittest.main()
