from __future__ import annotations

import importlib.util
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.models.parsed_document import BoundingBox, ParsedTable
from app.parsing.table_extraction import (
    BBoxTuple,
    DOCLING_TABLE_PARSER_NAME,
    ROTATED_TABLE_GEOMETRY_WARNING,
    extract_tables,
    is_matrixlike,
    table_matrix_to_parsed_table,
)

NUMERIC_MATRIX = [
    ["Sample", "Weight", "Depth"],
    ["K1", "12.4", "0.5"],
    ["K2", "8.1", "0.7"],
    ["K3", "15.9", "1.2"],
    ["K4", "3.3", "1.4"],
]

PROSE_MATRIX = [
    [
        "This is a long narrative sentence that camelot mistook for a table cell "
        "because the layout looked columnar to the stream parser.",
        "",
        "",
    ]
    for _ in range(5)
]


class _Values:
    def __init__(self, rows: list[list[str]]):
        self._rows = rows

    def tolist(self) -> list[list[str]]:
        return self._rows


class _FakeTable:
    def __init__(self, rows: list[list[str]], page: int = 1):
        self.df = SimpleNamespace(values=_Values(rows))
        self.page = page
        self.cells: list[list[object]] = []
        self._bbox: BBoxTuple | None = None
        self.parsing_report = {"accuracy": 99.0, "whitespace": 1.0}


class TestIsMatrixlike(unittest.TestCase):
    def test_accepts_numeric_matrix(self):
        self.assertTrue(is_matrixlike(NUMERIC_MATRIX))

    def test_rejects_prose(self):
        self.assertFalse(is_matrixlike(PROSE_MATRIX))

    def test_small_table_is_eligible_when_it_has_table_shape(self):
        self.assertTrue(
            is_matrixlike(
                [
                    ["Fundnummer", "Beskrivelse", "Bemærkninger"],
                    ["28-2", "Skår", "Bundniveau"],
                ],
                min_rows=1,
                min_cols=3,
            )
        )

    def test_one_row_text_table_is_eligible(self):
        self.assertTrue(is_matrixlike([["Object type", "Description"]]))

    def test_explicit_minimum_can_reject_undersized_input(self):
        self.assertFalse(is_matrixlike(NUMERIC_MATRIX[:2], min_rows=4, min_cols=3))


class TestMatrixToParsedTable(unittest.TestCase):
    def test_roles_do_not_infer_spans_from_empty_values(self):
        matrix = [
            ["Code", "Weight", "Depth"],
            ["K1", "12.4", "0.5"],
            ["K2", "", "0.7"],
            ["K3", "15.9", "1.2"],
        ]
        table = table_matrix_to_parsed_table(
            matrix, page_number=3, table_index=2, page_height_pt=None
        )
        self.assertIsInstance(table, ParsedTable)
        self.assertEqual(table.table_id, "p03_t02")
        self.assertEqual(table.page_number, 3)
        self.assertEqual((table.rows, table.cols), (4, 3))

        by_pos = {(cell.row, cell.col): cell for cell in table.cells}
        self.assertEqual(by_pos[(0, 0)].role, "header")
        self.assertEqual(by_pos[(1, 0)].role, "row_header")
        self.assertEqual(by_pos[(2, 0)].rowspan, 1)
        self.assertEqual(by_pos[(2, 0)].colspan, 1)
        self.assertTrue(
            all(cell.rowspan == 1 and cell.colspan == 1 for cell in table.cells)
        )
        self.assertTrue(all(cell.bbox is None for cell in table.cells))
        self.assertIn("| --- | --- | --- |", table.markdown_view or "")

    def test_all_text_first_data_row_is_not_a_second_header(self):
        matrix = [
            ["Code", "Place", "Type"],
            ["K1", "Rome", "Temple"],
            ["K2", "Athens", "Shrine"],
            ["K3", "Paris", "Church"],
        ]
        table = table_matrix_to_parsed_table(
            matrix, page_number=1, table_index=1, page_height_pt=None
        )
        by_pos = {(cell.row, cell.col): cell for cell in table.cells}
        self.assertTrue(all(by_pos[(0, col)].role == "header" for col in range(3)))
        self.assertTrue(all(by_pos[(1, col)].role != "header" for col in range(3)))
        self.assertEqual(
            (table.markdown_view or "").splitlines()[2], "| K1 | Rome | Temple |"
        )

    def test_cell_bbox_converted_to_top_left_origin(self):
        matrix = [
            ["Sample", "Weight", "Depth"],
            ["K1", "12.4", "0.5"],
            ["K2", "8.1", "0.7"],
            ["K3", "15.9", "1.2"],
        ]
        bboxes: list[list[BBoxTuple | None]] = [[None] * 3 for _ in range(4)]
        bboxes[1][1] = (10.0, 700.0, 50.0, 720.0)
        table = table_matrix_to_parsed_table(
            matrix,
            page_number=1,
            table_index=1,
            page_height_pt=792.0,
            cell_bboxes=bboxes,
            table_bbox=(10.0, 600.0, 200.0, 780.0),
        )
        by_pos = {(cell.row, cell.col): cell for cell in table.cells}
        self.assertEqual(
            by_pos[(1, 1)].bbox, BoundingBox(x0=10.0, y0=72.0, x1=50.0, y1=92.0)
        )
        self.assertIsNone(by_pos[(0, 0)].bbox)
        self.assertEqual(table.bbox, BoundingBox(x0=10.0, y0=12.0, x1=200.0, y1=192.0))

    def test_rotated_geometry_is_suppressed(self):
        table = table_matrix_to_parsed_table(
            NUMERIC_MATRIX,
            page_number=1,
            table_index=1,
            page_height_pt=500.0,
            cell_bboxes=[[(10.0, 10.0, 20.0, 20.0)] * 3 for _ in NUMERIC_MATRIX],
            table_bbox=(10.0, 10.0, 100.0, 100.0),
            geometry_enabled=False,
        )
        self.assertIsNone(table.bbox)
        self.assertTrue(all(cell.bbox is None for cell in table.cells))

    def test_proven_spans_are_kept_only_when_non_overlapping(self):
        table = table_matrix_to_parsed_table(
            [["A", "", "B"], ["", "C", "D"]],
            page_number=1,
            table_index=1,
            page_height_pt=None,
            cell_spans={(0, 0): (2, 2)},
        )
        by_pos = {(cell.row, cell.col): cell for cell in table.cells}
        self.assertEqual((by_pos[(0, 0)].rowspan, by_pos[(0, 0)].colspan), (1, 1))


class TestExtractTables(unittest.TestCase):
    def test_missing_dependency_returns_safe_diagnostic_without_inventory(self):
        with (
            patch("app.parsing.table_extraction.logger.exception"),
            patch(
                "app.parsing.table_extraction.importlib.import_module",
                side_effect=ModuleNotFoundError("/private/camelot?token=do-not-expose"),
            ),
        ):
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={1: 792.0},
            )
        self.assertEqual(output.status, "failed")
        self.assertEqual(output.error, "table_extraction_unavailable")
        self.assertNotIn("private", output.error or "")
        self.assertNotIn("token", output.error or "")

    def test_docling_inventory_is_complete_when_camelot_is_unavailable(self):
        inventory = [
            {
                "page_number": 2,
                "rows": 2,
                "cols": 3,
                "bbox": {
                    "x0": 10,
                    "y0": 100,
                    "x1": 200,
                    "y1": 150,
                    "origin": "TOPLEFT",
                },
                "cells": [
                    {"row": 0, "col": 0, "text": "Fundnummer", "role": "header"},
                    {"row": 0, "col": 1, "text": "Beskrivelse", "role": "header"},
                    {"row": 0, "col": 2, "text": "Bemærkninger", "role": "header"},
                    {"row": 1, "col": 0, "text": "28-2", "role": "data"},
                    {"row": 1, "col": 1, "text": "Skår", "role": "data"},
                    {"row": 1, "col": 2, "text": "Bundniveau", "role": "data"},
                ],
            }
        ]
        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            side_effect=ModuleNotFoundError("camelot"),
        ) as mock_import:
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={2: 200.0},
                docling_tables=inventory,
            )
        mock_import.assert_called_once_with("camelot")
        self.assertEqual(output.status, "success")
        self.assertEqual(output.error, None)
        self.assertEqual(len(output.tables), 1)
        self.assertEqual(output.tables[0].source_parser, DOCLING_TABLE_PARSER_NAME)
        self.assertEqual(
            output.tables[0].bbox,
            BoundingBox(x0=10, y0=100, x1=200, y1=150),
        )
        self.assertEqual(output.warnings, ["camelot_inventory_enrichment_unavailable"])

    def test_overlapping_inventory_tables_with_distinct_content_are_retained(self):
        def inventory(text: str) -> dict[str, object]:
            return {
                "page_number": 1,
                "rows": 1,
                "cols": 2,
                "bbox": {
                    "x0": 10,
                    "y0": 20,
                    "x1": 200,
                    "y1": 60,
                    "origin": "TOPLEFT",
                },
                "cells": [
                    {"row": 0, "col": 0, "text": text, "role": "header"},
                    {"row": 0, "col": 1, "text": "Description", "role": "header"},
                ],
            }

        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            side_effect=ModuleNotFoundError("camelot"),
        ):
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={1: 200.0},
                docling_tables=[inventory("First"), inventory("Second")],
            )
        self.assertEqual(len(output.tables), 2)

    def test_exact_constrained_camelot_candidate_enriches_inventory_table(self):
        rows = [
            ["Fundnummer", "Beskrivelse", "Bemærkninger"],
            ["28-2", "Skår", "Bundniveau"],
        ]
        inventory = [
            {
                "page_number": 2,
                "rows": 2,
                "cols": 3,
                "bbox": {
                    "x0": 10,
                    "y0": 100,
                    "x1": 200,
                    "y1": 150,
                    "origin": "TOPLEFT",
                },
                "cells": [
                    {
                        "row": row,
                        "col": col,
                        "text": text,
                        "role": "header" if row == 0 else "data",
                    }
                    for row, values in enumerate(rows)
                    for col, text in enumerate(values)
                ],
            }
        ]
        read_pdf = Mock(return_value=[_FakeTable(rows, page=2)])
        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            return_value=SimpleNamespace(read_pdf=read_pdf),
        ):
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={2: 200.0},
                docling_tables=inventory,
            )

        self.assertEqual(output.tables[0].source_parser, "camelot_stream")
        self.assertEqual(output.metrics["camelot_candidates"], 1)
        self.assertEqual(
            read_pdf.call_args.kwargs["table_areas"], ["10.0,100.0,200.0,50.0"]
        )

    def test_camelot_extracts_one_row_text_table(self):
        fake_camelot = SimpleNamespace(
            read_pdf=lambda *args, **kwargs: [
                _FakeTable([["Object type", "Description"]])
            ]
        )
        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            return_value=fake_camelot,
        ):
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={1: 200.0},
            )
        self.assertEqual(len(output.tables), 1)

    def test_camelot_extracts_small_table_when_available(self):
        fake_table = _FakeTable(
            [
                ["Fundnummer", "Beskrivelse", "Bemærkninger"],
                ["28-2", "Skår", "Bundniveau"],
            ]
        )
        fake_camelot = SimpleNamespace(read_pdf=lambda *args, **kwargs: [fake_table])
        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            return_value=fake_camelot,
        ):
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={1: 200.0},
            )
        self.assertEqual(output.status, "success")
        self.assertEqual(len(output.tables), 1)
        self.assertEqual((output.tables[0].rows, output.tables[0].cols), (2, 3))

    def test_rotated_camelot_page_keeps_content_but_suppresses_geometry(self):
        fake_table = _FakeTable(
            [
                ["Fundnummer", "Beskrivelse", "Bemærkninger"],
                ["28-2", "Skår", "Bundniveau"],
            ]
        )
        fake_table._bbox = (10.0, 10.0, 100.0, 100.0)
        fake_camelot = SimpleNamespace(read_pdf=lambda *args, **kwargs: [fake_table])
        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            return_value=fake_camelot,
        ):
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={1: 200.0},
                page_rotations={1: 90},
            )
        self.assertEqual(len(output.tables), 1)
        self.assertIsNone(output.tables[0].bbox)
        self.assertTrue(all(cell.bbox is None for cell in output.tables[0].cells))
        self.assertIn(ROTATED_TABLE_GEOMETRY_WARNING, output.warnings)

    def test_broken_source_fails_without_leaking(self):
        with patch("app.parsing.table_extraction.logger.exception"):
            output = extract_tables(
                source_pdf=Path("/nonexistent/secret-name.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={1: 792.0},
            )
        self.assertEqual(output.status, "failed")
        self.assertEqual(output.error, "table_extraction_failed")
        self.assertNotIn("secret", output.error or "")

    @unittest.skipIf(
        importlib.util.find_spec("camelot") is None, "camelot not installed"
    )
    def test_real_rotated_pdfs_suppress_camelot_geometry(self):
        import fitz  # type: ignore[import-not-found]

        rows = [
            ["Sample", "Weight", "Depth"],
            ["K1", "12.4", "0.5"],
            ["K2", "8.1", "0.7"],
            ["K3", "15.9", "1.2"],
            ["K4", "3.3", "1.4"],
        ]
        with tempfile.TemporaryDirectory() as tmp_dir:
            for rotation in (90, 180, 270):
                source = Path(tmp_dir) / f"rotated-{rotation}.pdf"
                document = fitz.open()
                page = document.new_page(width=300, height=500)
                for row_index, row in enumerate(rows):
                    for col_index, text in enumerate(row):
                        page.insert_text(
                            (40 + col_index * 80, 80 + row_index * 30),
                            text,
                            fontsize=11,
                        )
                page.set_rotation(rotation)
                document.save(source)
                document.close()

                output = extract_tables(
                    source_pdf=source,
                    content_sha256="a" * 64,
                    page_heights_pt={1: 300.0 if rotation in (90, 270) else 500.0},
                    page_rotations={1: rotation},
                )
                self.assertTrue(output.tables, rotation)
                self.assertIn(ROTATED_TABLE_GEOMETRY_WARNING, output.warnings)
                self.assertTrue(all(table.bbox is None for table in output.tables))
                self.assertTrue(
                    all(
                        cell.bbox is None
                        for table in output.tables
                        for cell in table.cells
                    )
                )

    @unittest.skipIf(
        importlib.util.find_spec("camelot") is None, "camelot not installed"
    )
    def test_integration_sample_pdf_uses_semantic_inventory(self):
        sample = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "Beretning_Ellekilde_8_13.pdf"
        )
        if not sample.exists():
            self.skipTest("sample PDF unavailable")
        import fitz  # type: ignore[import-not-found]

        with fitz.open(sample) as pdf:
            heights = {
                index + 1: pdf.load_page(index).rect.height
                for index in range(pdf.page_count)
            }
        output = extract_tables(
            source_pdf=sample,
            content_sha256="a" * 64,
            page_heights_pt=heights,
            docling_tables=[],
        )
        self.assertEqual(output.status, "success")
        for table in output.tables:
            self.assertGreaterEqual(table.page_number, 1)
            self.assertTrue(table.cells)
            self.assertTrue(
                all(math.isfinite(c.bbox.x0) for c in table.cells if c.bbox)
            )


if __name__ == "__main__":
    unittest.main()
