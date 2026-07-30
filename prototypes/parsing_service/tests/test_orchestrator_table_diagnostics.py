"""Table-extraction diagnostics must survive the trip into publication.

Regression cover for an image-based source document (no Docling table
inventory, Camelot-only candidates): the extraction diagnostics were dropped
when `_TableResolution` was built, so `build_parsed_document_v2` raised
`AttributeError: '_TableResolution' object has no attribute 'diagnostics'`
and the whole canonical parsing task failed.
"""

from __future__ import annotations

import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.models.parsed_document import ParserRun
from app.models.parsed_document_v2 import ParserDiagnostic
from app.parsing.adapters.pymupdf_inspect import PdfInspection, PdfPageInspection
from app.parsing.orchestrator import _BuildContext, _extract_document_tables
from app.parsing.table_extraction import TableExtractionOutput


CONTENT_SHA256 = "a" * 64


def _inspection() -> PdfInspection:
    return PdfInspection(
        status="completed",
        started_at="2026-01-01T00:00:00Z",
        finished_at="2026-01-01T00:00:01Z",
        duration_ms=1,
        page_count=1,
        pages=[
            # An image-based page: no text layer, one scanned image.
            PdfPageInspection(
                page=1,
                width_pt=595.0,
                height_pt=842.0,
                rotation=0,
                char_count=0,
                word_count=0,
                image_count=1,
            )
        ],
    )


def _context(source_path: Path) -> _BuildContext:
    return _BuildContext(
        task_id="00000000-0000-4000-8000-000000000000",
        task_dir=source_path.parent,
        metadata={},
        content_sha256=CONTENT_SHA256,
        params={},
        source_name="source.pdf",
        source_path=source_path,
        artifact_root=None,
        started_at="2026-01-01T00:00:00Z",
    )


def _resolve_tables(*, table_inventory: tuple[object, ...] = ()):
    """Run the real table extraction through the orchestrator's resolver.

    `_extract_document_tables` reads only `inspected.inspection` and
    `parsing.docling_output`, so the surrounding results are stood in for.
    """
    camelot = SimpleNamespace(read_pdf=Mock(return_value=[]))
    inspected = SimpleNamespace(inspection=_inspection())
    parsing = SimpleNamespace(
        docling_output=SimpleNamespace(table_inventory=table_inventory)
    )
    with patch(
        "app.parsing.table_extraction._load_camelot",
        return_value=(camelot, "table_extraction_failed"),
    ):
        return _extract_document_tables(
            _context(Path("source.pdf")), inspected, parsing
        )


class TestTableDiagnosticsPropagation(unittest.TestCase):
    def test_camelot_only_diagnostics_survive_table_resolution(self):
        resolution = _resolve_tables()

        self.assertEqual(resolution.tables, [])
        self.assertEqual(
            [diagnostic["code"] for diagnostic in resolution.diagnostics],
            ["camelot_only_tables_excluded"],
        )

    def test_resolved_diagnostics_are_publishable_parser_diagnostics(self):
        # build_parsed_document_v2 spreads these into `diagnostics` and then
        # validates each entry as a ParserDiagnostic before publication.
        resolution = _resolve_tables()

        published = [
            ParserDiagnostic.model_validate(diagnostic)
            for diagnostic in resolution.diagnostics
        ]

        self.assertEqual(
            [diagnostic.code for diagnostic in published],
            ["camelot_only_tables_excluded"],
        )

    def test_diagnostics_are_empty_when_extraction_reports_none(self):
        output = TableExtractionOutput(status="success")
        parser_run = ParserRun(parser="camelot_stream", status="success")

        with (
            patch(
                "app.parsing.orchestrator._run_table_extraction", return_value=output
            ),
            patch(
                "app.parsing.orchestrator.parser_run_from_table_output",
                return_value=parser_run,
            ),
        ):
            resolution = _extract_document_tables(
                _context(Path("source.pdf")),
                SimpleNamespace(inspection=_inspection()),
                SimpleNamespace(docling_output=SimpleNamespace(table_inventory=())),
            )

        self.assertEqual(resolution.diagnostics, ())

    def test_resolution_diagnostics_are_an_immutable_copy(self):
        output = TableExtractionOutput(
            status="success",
            diagnostics=[{"code": "camelot_candidate_rejected", "page_number": 1}],
        )
        parser_run = ParserRun(parser="camelot_stream", status="success")

        with (
            patch(
                "app.parsing.orchestrator._run_table_extraction", return_value=output
            ),
            patch(
                "app.parsing.orchestrator.parser_run_from_table_output",
                return_value=parser_run,
            ),
        ):
            resolution = _extract_document_tables(
                _context(Path("source.pdf")),
                SimpleNamespace(inspection=_inspection()),
                SimpleNamespace(docling_output=SimpleNamespace(table_inventory=())),
            )

        output.diagnostics.append({"code": "late_mutation"})
        resolution.diagnostics[0]["page_number"] = 99

        self.assertIsInstance(resolution.diagnostics, tuple)
        self.assertEqual(
            [diagnostic["code"] for diagnostic in resolution.diagnostics],
            ["camelot_candidate_rejected"],
        )
        self.assertEqual(output.diagnostics[0]["page_number"], 1)


if __name__ == "__main__":
    unittest.main()
