from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

from app.models.parsed_document import BoundingBox, ParsedTable
from app.parsing.table_extraction import (
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


class TestIsMatrixlike(unittest.TestCase):
    def test_accepts_numeric_matrix(self):
        self.assertTrue(is_matrixlike(NUMERIC_MATRIX))

    def test_rejects_prose(self):
        self.assertFalse(is_matrixlike(PROSE_MATRIX))

    def test_rejects_undersized(self):
        self.assertFalse(is_matrixlike(NUMERIC_MATRIX[:2]))


class TestMatrixToParsedTable(unittest.TestCase):
    def test_roles_spans_and_grid_shape(self):
        matrix = [
            ["", "Weight", "Depth"],
            ["K1", "12.4", "0.5"],
            ["Merged", "", "0.7"],
            ["K3", "15.9", "1.2"],
        ]
        table = table_matrix_to_parsed_table(
            matrix, page_number=3, table_index=2, page_height_pt=None
        )
        self.assertIsInstance(table, ParsedTable)
        self.assertEqual(table.table_id, "p03_t02")
        self.assertEqual(table.page_number, 3)
        self.assertEqual(table.source_parser, "camelot_stream")
        self.assertEqual((table.rows, table.cols), (4, 3))

        by_pos = {(cell.row, cell.col): cell for cell in table.cells}
        self.assertNotIn((0, 0), by_pos)  # empty cells skipped
        self.assertEqual(by_pos[(0, 1)].role, "header")
        self.assertEqual(by_pos[(2, 0)].colspan, 2)  # merged into empty neighbour
        self.assertEqual(by_pos[(1, 1)].role, "data")
        self.assertIn("row_header", by_pos[(1, 0)].role or "")
        self.assertTrue(all(cell.bbox is None for cell in table.cells))
        self.assertIn("| --- | --- | --- |", table.markdown_view or "")

    def test_cell_bbox_converted_to_top_left_origin(self):
        matrix = [
            ["Sample", "Weight", "Depth"],
            ["K1", "12.4", "0.5"],
            ["K2", "8.1", "0.7"],
            ["K3", "15.9", "1.2"],
        ]
        bboxes = [[None] * 3 for _ in range(4)]
        bboxes[1][1] = (10.0, 700.0, 50.0, 720.0)  # camelot bottom-left origin
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

    def test_no_page_height_means_no_bboxes(self):
        matrix = [["A", "B"], ["1", "2"]]
        bboxes = [[(0.0, 0.0, 1.0, 1.0)] * 2 for _ in range(2)]
        table = table_matrix_to_parsed_table(
            matrix,
            page_number=1,
            table_index=1,
            page_height_pt=None,
            cell_bboxes=bboxes,
            table_bbox=(0.0, 0.0, 1.0, 1.0),
        )
        self.assertIsNone(table.bbox)
        self.assertTrue(all(cell.bbox is None for cell in table.cells))


class TestExtractTables(unittest.TestCase):
    def test_missing_dependency_returns_safe_diagnostic(self):
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
    def test_integration_sample_pdf(self):
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
                index + 1: page.rect.height for index, page in enumerate(pdf)
            }
        output = extract_tables(
            source_pdf=sample,
            content_sha256="a" * 64,
            page_heights_pt=heights,
        )
        self.assertEqual(output.status, "success")
        for table in output.tables:
            self.assertGreaterEqual(table.page_number, 1)
            self.assertTrue(table.cells)


if __name__ == "__main__":
    unittest.main()
