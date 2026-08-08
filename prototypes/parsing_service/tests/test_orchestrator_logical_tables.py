from __future__ import annotations

import unittest

from app.models.parsed_document import BoundingBox, ParsedTable, TableCell
from app.models.parsed_document_v2 import V2_GEOMETRY_ERROR_CODE
from app.parsing.orchestrator import CanonicalIngestionError, _v2_logical_tables


def _fragment(
    table_id: str,
    ref: str,
    page: int,
    order: int,
    *,
    rows: int,
    row: int = 0,
    rowspan: int = 1,
) -> ParsedTable:
    return ParsedTable(
        table_id=table_id,
        page_number=page,
        producer_ref=ref,
        producer_order=order,
        source_parser="docling_table",
        rows=rows,
        cols=1,
        cells=[
            TableCell(
                row=row,
                col=0,
                text="Fundnummer",
                rowspan=rowspan,
                bbox=BoundingBox(x0=10, y0=10, x1=20, y1=20),
            )
        ],
    )


class TestOrchestratorLogicalTables(unittest.TestCase):
    def build(self, first: ParsedTable, second: ParsedTable):
        return _v2_logical_tables(
            [first, second],
            content_sha256="a" * 64,
            preprocess_id="preprocess",
            continuation_pairs=[("#/tables/0", "#/tables/1")],
        )

    def test_underreported_fragment_rows_do_not_merge_distinct_cells(self):
        tables, _observed, observations = self.build(
            _fragment("first", "#/tables/0", 1, 0, rows=1, row=1),
            _fragment("second", "#/tables/1", 2, 1, rows=1),
        )

        self.assertEqual([cell.row for cell in tables[0].cells], [1, 2])
        anchor_ids = [cell.evidence_anchor_id for cell in tables[0].cells]
        self.assertEqual(len(set(anchor_ids)), 2)
        self.assertEqual(
            [observation.page_number for observation in observations[anchor_ids[1]]],
            [2],
        )

    def test_cross_fragment_rowspan_keeps_one_anchor_with_both_observations(self):
        tables, _observed, observations = self.build(
            _fragment("first", "#/tables/0", 1, 0, rows=1, rowspan=2),
            _fragment("second", "#/tables/1", 2, 1, rows=1),
        )

        self.assertEqual(len(tables[0].cells), 1)
        anchor_id = tables[0].cells[0].evidence_anchor_id
        self.assertEqual(
            [observation.page_number for observation in observations[anchor_id]],
            [1, 2],
        )

    def test_missing_cell_geometry_fails_the_v2_publication(self):
        first = _fragment("first", "#/tables/0", 1, 0, rows=1)
        first = first.model_copy(
            update={"cells": [first.cells[0].model_copy(update={"bbox": None})]}
        )
        with self.assertRaises(CanonicalIngestionError) as raised:
            self.build(first, _fragment("second", "#/tables/1", 2, 1, rows=1))
        self.assertEqual(raised.exception.code, V2_GEOMETRY_ERROR_CODE)


if __name__ == "__main__":
    unittest.main()
