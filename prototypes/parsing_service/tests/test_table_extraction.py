from __future__ import annotations

import importlib.util
import json
import math
import tempfile
import unittest
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from docling_core.types.doc.base import (
    BoundingBox as DoclingBoundingBox,
    CoordOrigin,
)
import pandas

from app.models.parsed_document import BoundingBox, ParsedTable
from app.parsing.docling_runner import _table_inventory
from app.parsing.table_extraction import (
    BBoxTuple,
    DOCLING_TABLE_PARSER_NAME,
    ROTATED_TABLE_GEOMETRY_WARNING,
    _Extraction,
    _camelot_tables,
    extract_tables,
    is_matrixlike,
    table_matrix_to_parsed_table,
    TableExtractionOutput,
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
SMALL_TABLE_ROWS = [
    ["Fundnummer", "Beskrivelse", "Bemærkninger"],
    ["28-2", "Skår", "Bundniveau"],
]

ALIGNED_CAMELOT_CELL_BBOXES = [
    [
        (10.0, 125.0, 70.0, 150.0),
        (70.0, 125.0, 130.0, 150.0),
        (130.0, 125.0, 190.0, 150.0),
    ],
    [
        (10.0, 100.0, 70.0, 125.0),
        (70.0, 100.0, 130.0, 125.0),
        (130.0, 100.0, 190.0, 125.0),
    ],
]


@dataclass(frozen=True, slots=True)
class _InventoryContext:
    page: int = 2
    bbox: BBoxTuple = (10.0, 50.0, 190.0, 100.0)
    cell_bboxes: Mapping[tuple[int, int], BBoxTuple] | None = None
    role_overrides: Mapping[tuple[int, int], str] | None = None


class _FakeTable:
    def __init__(
        self,
        rows: Sequence[Sequence[object]],
        page: int = 1,
        *,
        bbox: BBoxTuple | None = None,
        cell_bboxes: Sequence[Sequence[BBoxTuple | None]] | None = None,
    ):
        self.df = pandas.DataFrame(rows)
        self.page = page
        self.cells: list[list[object]] = []
        for row in cell_bboxes or ():
            fake_row: list[object] = []
            for cell_bbox in row:
                if cell_bbox is None:
                    fake_row.append(object())
                    continue
                x0, y0, x1, y1 = cell_bbox
                fake_row.append(SimpleNamespace(x1=x0, y1=y0, x2=x1, y2=y1))
            self.cells.append(fake_row)
        self._bbox = bbox
        self.parsing_report = {"accuracy": 99.0, "whitespace": 1.0}


def _extract_with_fake_camelot(
    tables: Sequence[_FakeTable],
    *,
    page_heights_pt: dict[int, float],
    docling_tables: Sequence[Mapping[str, object]] = (),
    page_rotations: Mapping[int, int] | None = None,
) -> tuple[TableExtractionOutput, Mock]:
    read_pdf = Mock(return_value=list(tables))
    with patch(
        "app.parsing.table_extraction.importlib.import_module",
        return_value=SimpleNamespace(read_pdf=read_pdf),
    ):
        output = extract_tables(
            source_pdf=Path("source.pdf"),
            content_sha256="a" * 64,
            page_heights_pt=page_heights_pt,
            docling_tables=docling_tables,
            page_rotations=page_rotations,
        )
    return output, read_pdf


def _inventory_for_rows(
    rows: list[list[str]],
    context: _InventoryContext | None = None,
) -> dict[str, object]:
    context = context or _InventoryContext()
    inferred = table_matrix_to_parsed_table(
        rows,
        page_number=context.page,
        table_index=1,
        page_height_pt=None,
    )
    roles = {(cell.row, cell.col): cell.role or "data" for cell in inferred.cells}
    roles.update(context.role_overrides or {})
    raw_cells: list[dict[str, object]] = []
    for row, values in enumerate(rows):
        for col, text in enumerate(values):
            cell: dict[str, object] = {
                "row": row,
                "col": col,
                "text": text,
                "role": roles[(row, col)],
            }
            cell_bbox = (context.cell_bboxes or {}).get((row, col))
            if cell_bbox is not None:
                cell["bbox"] = {
                    "x0": cell_bbox[0],
                    "y0": cell_bbox[1],
                    "x1": cell_bbox[2],
                    "y1": cell_bbox[3],
                    "origin": "TOPLEFT",
                }
            raw_cells.append(cell)
    return {
        "page_number": context.page,
        "rows": len(rows),
        "cols": len(rows[0]),
        "bbox": {
            "x0": context.bbox[0],
            "y0": context.bbox[1],
            "x1": context.bbox[2],
            "y1": context.bbox[3],
            "origin": "TOPLEFT",
        },
        "cells": raw_cells,
    }


class TestIsMatrixlike(unittest.TestCase):
    def test_accepts_numeric_matrix(self):
        self.assertTrue(is_matrixlike(NUMERIC_MATRIX))

    def test_rejects_prose(self):
        self.assertFalse(is_matrixlike(PROSE_MATRIX))

    def test_small_table_is_eligible_when_it_has_table_shape(self):
        self.assertTrue(
            is_matrixlike(
                SMALL_TABLE_ROWS,
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


class TestCamelotFallbackIdentity(unittest.TestCase):
    def test_camelot_segments_keep_capture_local_refs(self):
        table = SimpleNamespace(
            df=pandas.DataFrame(NUMERIC_MATRIX),
            page=1,
            bbox=(0, 0, 100, 100),
            cells=[],
        )
        extraction = _Extraction(
            source_pdf=Path("source.pdf"),
            page_heights_pt={1: 100.0},
            page_rotations={1: 0},
            docling_tables=(),
            camelot=object(),
            camelot_error="",
        )
        tables = _camelot_tables([table], extraction)
        self.assertTrue(tables)
        producer_ref = tables[0].producer_ref
        assert producer_ref is not None
        self.assertTrue(producer_ref.startswith("camelot://page/1/region/1/segment/"))
        self.assertEqual(tables[0].source_parser, "camelot_stream")


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

    def test_successful_camelot_call_with_no_candidates_is_empty_success(self):
        output, _ = _extract_with_fake_camelot(
            [],
            page_heights_pt={1: 792.0},
        )

        self.assertEqual(output.status, "success")
        self.assertIsNone(output.error)
        self.assertEqual(output.tables, [])
        self.assertEqual(output.metrics["tables_found"], 0)
        self.assertEqual(output.metrics["tables_kept"], 0)
        self.assertEqual(output.warnings, [])

    def test_camelot_only_candidates_are_not_published(self):
        output, _ = _extract_with_fake_camelot(
            [
                _FakeTable(
                    [
                        ["Label", "Count", "NaN", "Missing", "Literal"],
                        ["K1", 12, math.nan, pandas.NA, "NaN"],
                    ]
                )
            ],
            page_heights_pt={1: 792.0},
        )

        self.assertEqual(output.tables, [])
        self.assertEqual(output.metrics["tables_kept"], 0)
        self.assertEqual(output.diagnostics[0]["code"], "camelot_only_tables_excluded")

    def test_docling_literal_nan_is_preserved_in_cells_and_markdown(self):
        inventory = [_inventory_for_rows([["Label", "Value"], ["Missing", "NaN"]])]
        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            side_effect=ModuleNotFoundError("camelot"),
        ):
            output = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256="a" * 64,
                page_heights_pt={2: 200.0},
                docling_tables=inventory,
            )

        table = output.tables[0]
        self.assertEqual(table.cells[-1].text, "NaN")
        self.assertEqual(
            table.markdown_view,
            "| Label | Value |\n| --- | --- |\n| Missing | NaN |",
        )

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
        self.assertIsNone(output.error)
        self.assertEqual(len(output.tables), 1)
        self.assertEqual(output.tables[0].source_parser, DOCLING_TABLE_PARSER_NAME)
        self.assertEqual(
            output.tables[0].bbox,
            BoundingBox(x0=10, y0=100, x1=200, y1=150),
        )
        self.assertEqual(output.warnings, ["camelot_inventory_enrichment_unavailable"])

    def test_docling_bottom_left_geometry_reaches_camelot_area_and_dedup(self):
        table_bbox = DoclingBoundingBox(
            l=10,
            t=150,
            r=200,
            b=100,
            coord_origin=CoordOrigin.BOTTOMLEFT,
        )
        cell_bbox = DoclingBoundingBox(
            l=20,
            t=40,
            r=80,
            b=20,
            coord_origin=CoordOrigin.BOTTOMLEFT,
        )
        cell = SimpleNamespace(
            start_row_offset_idx=0,
            start_col_offset_idx=0,
            row_span=1,
            col_span=1,
            text="Value",
            column_header=True,
            row_header=False,
            row_section=False,
            bbox=cell_bbox,
        )
        table = SimpleNamespace(
            prov=[SimpleNamespace(page_no=1, bbox=table_bbox)],
            data=SimpleNamespace(num_rows=1, num_cols=1, table_cells=[cell]),
        )
        inventory = _table_inventory(SimpleNamespace(tables=[table, table]))
        output, read_pdf = _extract_with_fake_camelot(
            [],
            page_heights_pt={1: 200.0},
            docling_tables=inventory,
        )

        self.assertEqual(
            inventory[0]["bbox"],
            {
                "x0": 10.0,
                "y0": 100.0,
                "x1": 200.0,
                "y1": 150.0,
                "origin": "BOTTOMLEFT",
            },
        )
        self.assertEqual(output.metrics["tables_found"], 2)
        self.assertEqual(output.metrics["tables_kept"], 1)
        self.assertEqual(len(output.tables), 1)
        self.assertEqual(
            output.tables[0].bbox,
            BoundingBox(x0=10, y0=50, x1=200, y1=100),
        )
        self.assertEqual(
            output.tables[0].cells[0].bbox,
            BoundingBox(x0=20, y0=160, x1=80, y1=180),
        )
        self.assertEqual(
            read_pdf.call_args.kwargs["table_areas"],
            ["10.0,150.0,200.0,100.0", "10.0,150.0,200.0,100.0"],
        )

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

    def test_equivalent_camelot_candidate_without_geometry_keeps_docling(self):
        inventory = [_inventory_for_rows(SMALL_TABLE_ROWS)]
        output, read_pdf = _extract_with_fake_camelot(
            [_FakeTable(SMALL_TABLE_ROWS, page=2)],
            page_heights_pt={2: 200.0},
            docling_tables=inventory,
        )

        self.assertEqual(output.tables[0].source_parser, DOCLING_TABLE_PARSER_NAME)
        self.assertEqual(
            output.tables[0].bbox,
            BoundingBox(x0=10.0, y0=50.0, x1=190.0, y1=100.0),
        )
        self.assertEqual(output.metrics["camelot_candidates"], 1)
        self.assertEqual(
            read_pdf.call_args.kwargs["table_areas"], ["10.0,150.0,190.0,100.0"]
        )

    def test_camelot_replaces_docling_only_with_strict_geometry_improvement(self):
        rows = SMALL_TABLE_ROWS
        camelot_cell_bboxes = [row.copy() for row in ALIGNED_CAMELOT_CELL_BBOXES]
        camelot_cell_bboxes[0][0] = (11.0, 126.0, 69.0, 149.0)
        inventory = [
            _inventory_for_rows(
                rows,
                _InventoryContext(cell_bboxes={(0, 0): (10.0, 50.0, 70.0, 75.0)}),
            )
        ]
        candidate = _FakeTable(
            rows,
            page=2,
            bbox=(10.0, 100.0, 190.0, 150.0),
            cell_bboxes=camelot_cell_bboxes,
        )
        output, _ = _extract_with_fake_camelot(
            [candidate],
            page_heights_pt={2: 200.0},
            docling_tables=inventory,
        )

        table = output.tables[0]
        self.assertEqual(table.source_parser, DOCLING_TABLE_PARSER_NAME)
        self.assertEqual(table.bbox, BoundingBox(x0=10.0, y0=50.0, x1=190.0, y1=100.0))
        by_position = {(cell.row, cell.col): cell for cell in table.cells}
        self.assertEqual(
            by_position[(0, 0)].bbox,
            BoundingBox(x0=10.0, y0=50.0, x1=70.0, y1=75.0),
        )
        self.assertEqual(
            by_position[(1, 2)].bbox,
            BoundingBox(x0=130.0, y0=75.0, x1=190.0, y1=100.0),
        )

    def test_equal_geometry_coverage_keeps_docling(self):
        rows = SMALL_TABLE_ROWS
        camelot_cell_bboxes = ALIGNED_CAMELOT_CELL_BBOXES
        docling_cell_bboxes = {
            (row, col): (bbox[0], 200.0 - bbox[3], bbox[2], 200.0 - bbox[1])
            for row, values in enumerate(camelot_cell_bboxes)
            for col, bbox in enumerate(values)
        }
        candidate = _FakeTable(
            rows,
            page=2,
            bbox=(10.0, 100.0, 190.0, 150.0),
            cell_bboxes=camelot_cell_bboxes,
        )
        output, _ = _extract_with_fake_camelot(
            [candidate],
            page_heights_pt={2: 200.0},
            docling_tables=[
                _inventory_for_rows(
                    rows,
                    _InventoryContext(cell_bboxes=docling_cell_bboxes),
                )
            ],
        )

        self.assertEqual(output.tables[0].source_parser, DOCLING_TABLE_PARSER_NAME)

    def test_displaced_existing_geometry_or_role_mismatch_keeps_docling(self):
        rows = SMALL_TABLE_ROWS
        displaced_cell_bboxes = [row.copy() for row in ALIGNED_CAMELOT_CELL_BBOXES]
        displaced_cell_bboxes[0][0] = (80.0, 125.0, 140.0, 150.0)
        aligned_cell_bboxes = ALIGNED_CAMELOT_CELL_BBOXES
        cases = (
            (
                "displaced geometry",
                _inventory_for_rows(
                    rows,
                    _InventoryContext(cell_bboxes={(0, 0): (10.0, 50.0, 70.0, 75.0)}),
                ),
                displaced_cell_bboxes,
            ),
            (
                "role mismatch",
                _inventory_for_rows(
                    rows,
                    _InventoryContext(role_overrides={(0, 1): "data"}),
                ),
                aligned_cell_bboxes,
            ),
        )
        for reason, inventory, candidate_cell_bboxes in cases:
            candidate = _FakeTable(
                rows,
                page=2,
                bbox=(10.0, 100.0, 190.0, 150.0),
                cell_bboxes=candidate_cell_bboxes,
            )
            with self.subTest(reason=reason):
                output, _ = _extract_with_fake_camelot(
                    [candidate],
                    page_heights_pt={2: 200.0},
                    docling_tables=[inventory],
                )
            self.assertEqual(output.tables[0].source_parser, DOCLING_TABLE_PARSER_NAME)

    def test_smaller_candidate_geometry_cannot_replace_docling(self):
        rows = SMALL_TABLE_ROWS
        inventory_cell_bbox = BoundingBox(x0=10.0, y0=50.0, x1=70.0, y1=75.0)
        inventory = _inventory_for_rows(
            rows,
            _InventoryContext(cell_bboxes={(0, 0): (10.0, 50.0, 70.0, 75.0)}),
        )
        full_candidate_boxes = ALIGNED_CAMELOT_CELL_BBOXES
        nested_table_boxes = [[(10.0, 125.0, 70.0, 150.0)] * len(row) for row in rows]
        nested_cell_boxes = [row.copy() for row in full_candidate_boxes]
        nested_cell_boxes[0][0] = (20.0, 140.0, 30.0, 145.0)
        cases = (
            ("nested table", nested_table_boxes),
            ("nested existing cell", nested_cell_boxes),
        )
        for reason, candidate_cell_boxes in cases:
            candidate = _FakeTable(
                rows,
                page=2,
                bbox=(10.0, 100.0, 190.0, 150.0),
                cell_bboxes=candidate_cell_boxes,
            )
            with self.subTest(reason=reason):
                output, _ = _extract_with_fake_camelot(
                    [candidate],
                    page_heights_pt={2: 200.0},
                    docling_tables=[inventory],
                )

                table = output.tables[0]
                by_position = {(cell.row, cell.col): cell for cell in table.cells}
                self.assertEqual(table.source_parser, DOCLING_TABLE_PARSER_NAME)
                self.assertEqual(by_position[(0, 0)].bbox, inventory_cell_bbox)
                self.assertIsNone(by_position[(0, 1)].bbox)

    def test_repeated_matrices_match_camelot_by_geometry(self):
        rows = SMALL_TABLE_ROWS
        first = _inventory_for_rows(
            rows,
            _InventoryContext(
                bbox=(10.0, 20.0, 190.0, 70.0),
                cell_bboxes={(0, 0): (10.0, 20.0, 70.0, 45.0)},
            ),
        )
        second = _inventory_for_rows(
            rows,
            _InventoryContext(
                bbox=(10.0, 100.0, 190.0, 150.0),
                cell_bboxes={(0, 0): (10.0, 100.0, 70.0, 125.0)},
            ),
        )
        candidate = _FakeTable(
            rows,
            page=2,
            bbox=(10.0, 50.0, 190.0, 100.0),
            cell_bboxes=[
                [
                    (10.0, 75.0, 70.0, 100.0),
                    (70.0, 75.0, 130.0, 100.0),
                    (130.0, 75.0, 190.0, 100.0),
                ],
                [
                    (10.0, 50.0, 70.0, 75.0),
                    (70.0, 50.0, 130.0, 75.0),
                    (130.0, 50.0, 190.0, 75.0),
                ],
            ],
        )
        output, _ = _extract_with_fake_camelot(
            [candidate],
            page_heights_pt={2: 200.0},
            docling_tables=[first, second],
        )

        self.assertEqual(
            [table.source_parser for table in output.tables],
            [DOCLING_TABLE_PARSER_NAME, DOCLING_TABLE_PARSER_NAME],
        )
        self.assertEqual(
            output.tables[0].bbox,
            BoundingBox(x0=10.0, y0=20.0, x1=190.0, y1=70.0),
        )
        self.assertEqual(
            output.tables[1].bbox,
            BoundingBox(x0=10.0, y0=100.0, x1=190.0, y1=150.0),
        )

    def test_camelot_only_one_row_text_table_is_excluded(self):
        output, _ = _extract_with_fake_camelot(
            [_FakeTable([["Object type", "Description"]])],
            page_heights_pt={1: 200.0},
        )
        self.assertEqual(output.tables, [])

    def test_camelot_only_small_table_is_excluded(self):
        output, _ = _extract_with_fake_camelot(
            [_FakeTable(SMALL_TABLE_ROWS)],
            page_heights_pt={1: 200.0},
        )
        self.assertEqual(output.status, "success")
        self.assertEqual(output.tables, [])
        self.assertEqual(output.metrics["tables_kept"], 0)

    def test_rotated_camelot_only_page_is_excluded(self):
        output, _ = _extract_with_fake_camelot(
            [
                _FakeTable(
                    SMALL_TABLE_ROWS,
                    bbox=(10.0, 10.0, 100.0, 100.0),
                )
            ],
            page_heights_pt={1: 200.0},
            page_rotations={1: 90},
        )
        self.assertEqual(output.tables, [])
        self.assertEqual(output.diagnostics[0]["code"], "camelot_only_tables_excluded")
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
                self.assertEqual(output.tables, [])
                self.assertEqual(output.diagnostics[0]["code"], "camelot_only_tables_excluded")
                self.assertIn(ROTATED_TABLE_GEOMETRY_WARNING, output.warnings)

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
