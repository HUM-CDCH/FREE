from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.parsing.docling_runner import run_docling_ingestion
from app.storage.paths import SERVICE_ROOT

CONTENT_HASH = "a" * 64


class PhysicalPageDoclingDocument:
    def __init__(self) -> None:
        self.calls: list[tuple[set[int] | None, bool]] = []

    def export_to_dict(self):
        return {"name": "physical-pages"}

    def export_to_doctags(self, *, pages=None, add_page_index=True):
        self.calls.append((pages, add_page_index))
        if pages is None:
            return "<text>One</text><page_break><text>Three</text>"
        page = next(iter(pages))
        return {1: "<text>One</text>", 2: "", 3: "<text>Three</text>"}[page]

    def export_to_markdown(self):
        return "diagnostic"


class LegacyDoclingDocument:
    def export_to_doctags(self):
        return "<text>One</text><page_break><text>Three</text>"


class TestDoclingRunner(unittest.TestCase):
    def test_conversion_failure_exposes_only_stable_diagnostic_code(self):
        with tempfile.TemporaryDirectory(dir=SERVICE_ROOT) as tmp_dir:
            source = Path(tmp_dir) / "source.pdf"
            source.write_bytes(b"%PDF-1.4\n")
            with (
                patch(
                    "app.parsing.docling_runner._convert_document",
                    side_effect=RuntimeError("/private/source.pdf?token=do-not-expose"),
                ),
                patch("app.parsing.docling_runner.logger.exception"),
            ):
                output = run_docling_ingestion(
                    source,
                    CONTENT_HASH,
                    artifact_root=Path(tmp_dir) / "artifacts",
                )

        self.assertEqual(output.error, "docling_conversion_failed")
        diagnostics = " ".join([output.error or "", *output.warnings])
        self.assertNotIn("private", diagnostics)
        self.assertNotIn("token", diagnostics)

    def test_physical_page_exports_preserve_internal_blank_page(self):
        document = PhysicalPageDoclingDocument()
        with tempfile.TemporaryDirectory(dir=SERVICE_ROOT) as tmp_dir:
            source = Path(tmp_dir) / "source.pdf"
            source.write_bytes(b"%PDF-1.4\n")
            artifact_root = Path(tmp_dir) / "artifacts"
            with patch(
                "app.parsing.docling_runner._convert_document", return_value=document
            ):
                output = run_docling_ingestion(
                    source,
                    CONTENT_HASH,
                    physical_pages=[1, 2, 3],
                    artifact_root=artifact_root,
                )

            self.assertTrue(output.page_mapping_verified)
            self.assertEqual([span.page for span in output.page_spans], [1, 2, 3])
            self.assertEqual(
                [span.text for span in output.page_spans], ["One", "", "Three"]
            )
            self.assertEqual(
                document.calls,
                [
                    (None, True),
                    ({1}, False),
                    ({2}, False),
                    ({3}, False),
                ],
            )
            raw_ref = output.raw_doctags_ref or ""
            raw_path = SERVICE_ROOT / raw_ref
            self.assertEqual(
                raw_path.read_text(encoding="utf-8").count("<page_break>"),
                2,
            )
            aggregate_path = SERVICE_ROOT / (output.aggregate_doctags_ref or "")
            self.assertEqual(
                aggregate_path.read_text(encoding="utf-8").count("<page_break>"),
                1,
            )
            for span in output.page_spans:
                self.assertEqual(
                    output.llm_markdown[
                        span.llm_markdown_start : span.llm_markdown_end
                    ],
                    span.text,
                )

    def test_legacy_export_does_not_claim_physical_page_mapping(self):
        with tempfile.TemporaryDirectory(dir=SERVICE_ROOT) as tmp_dir:
            source = Path(tmp_dir) / "source.pdf"
            source.write_bytes(b"%PDF-1.4\n")
            with patch(
                "app.parsing.docling_runner._convert_document",
                return_value=LegacyDoclingDocument(),
            ):
                output = run_docling_ingestion(
                    source,
                    CONTENT_HASH,
                    physical_pages=[1, 2, 3],
                    artifact_root=Path(tmp_dir) / "artifacts",
                )

        self.assertFalse(output.page_mapping_verified)
        self.assertEqual(output.page_spans, ())
        self.assertIn("doctags_physical_page_export_unsupported", output.warnings)


if __name__ == "__main__":
    unittest.main()
