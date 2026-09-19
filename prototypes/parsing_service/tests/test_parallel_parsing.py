from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.parallel_parsing import (
    compute_partition_ranges,
    flag_boundary_text,
    merge_fragments,
    pymupdf_boundary_risk,
    stitch_boundary_tables,
)

try:
    import pymupdf

    HAVE_PYMUPDF = True
except ImportError:
    HAVE_PYMUPDF = False


@unittest.skipUnless(HAVE_PYMUPDF, "pymupdf is not installed in this environment")
class PymupdfBoundaryRiskTests(unittest.TestCase):
    def _grid_table_pdf(self, *, table_top: float, table_bottom: float, page_height: float = 800) -> Path:
        document = pymupdf.open()
        page = document.new_page(width=600, height=page_height)
        columns = (40, 200, 360, 520)
        rows = [table_top + i * (table_bottom - table_top) / 3 for i in range(4)]
        for x in columns:
            page.draw_line((x, table_top), (x, table_bottom))
        for y in rows:
            page.draw_line((columns[0], y), (columns[-1], y))
        for row_index in range(3):
            for col_index in range(3):
                page.insert_text(
                    (columns[col_index] + 5, rows[row_index] + 15),
                    f"r{row_index}c{col_index}",
                )
        directory = Path(tempfile.mkdtemp())
        path = directory / "table.pdf"
        document.save(path)
        document.close()
        return path

    def test_table_flush_to_bottom_marks_boundary_risky(self):
        path = self._grid_table_pdf(table_top=600, table_bottom=790)
        is_risky = pymupdf_boundary_risk(path)
        self.assertTrue(is_risky(1))

    def test_table_away_from_edges_does_not_mark_boundary_risky(self):
        path = self._grid_table_pdf(table_top=300, table_bottom=500)
        is_risky = pymupdf_boundary_risk(path)
        self.assertFalse(is_risky(1))


class PartitionRangeTests(unittest.TestCase):
    def test_document_at_or_under_threshold_is_not_partitioned(self):
        self.assertEqual(compute_partition_ranges(8, min_pages=10, max_workers=4), [(1, 8)])
        self.assertEqual(compute_partition_ranges(10, min_pages=10, max_workers=4), [(1, 10)])

    def test_document_over_threshold_splits_into_contiguous_even_ranges(self):
        ranges = compute_partition_ranges(
            40, min_pages=10, target_partition_pages=10, max_workers=4,
        )
        self.assertEqual(ranges, [(1, 10), (11, 20), (21, 30), (31, 40)])

    def test_partition_count_is_bounded_by_max_workers(self):
        ranges = compute_partition_ranges(
            100, min_pages=10, target_partition_pages=5, max_workers=3,
        )
        self.assertEqual(len(ranges), 3)
        self.assertEqual(ranges[0][0], 1)
        self.assertEqual(ranges[-1][1], 100)

    def test_risky_boundary_shifts_to_nearest_safe_gap(self):
        # A naive split at page 20 is inside a table that starts at page 19
        # and ends at page 21; pages 18 and 22 are safe.
        risky = {19, 20, 21}

        def is_risky(page: int) -> bool:
            return page in risky

        ranges = compute_partition_ranges(
            40, min_pages=10, target_partition_pages=10, max_workers=4,
            is_risky_boundary=is_risky, search_radius=2,
        )
        boundaries = [end for _, end in ranges[:-1]]
        self.assertNotIn(20, boundaries)
        self.assertTrue(any(b in {18, 22} for b in boundaries))

    def test_risky_boundary_falls_back_when_no_safe_gap_in_radius(self):
        def always_risky(_page: int) -> bool:
            return True

        ranges = compute_partition_ranges(
            40, min_pages=10, target_partition_pages=10, max_workers=4,
            is_risky_boundary=always_risky, search_radius=1,
        )
        # Falls back to the naive even split when nothing within radius is safe.
        self.assertEqual(ranges, [(1, 10), (11, 20), (21, 30), (31, 40)])

    def test_boundaries_stay_ordered_and_cover_every_page_exactly_once(self):
        ranges = compute_partition_ranges(
            37, min_pages=10, target_partition_pages=9, max_workers=4,
            is_risky_boundary=lambda page: page % 5 == 0, search_radius=2,
        )
        covered: list[int] = []
        for start, end in ranges:
            self.assertLessEqual(start, end)
            covered.extend(range(start, end + 1))
        self.assertEqual(covered, list(range(1, 38)))


def _fragment(*, pages, content_stream, tables, anchors, markdown, warnings=()):
    return {
        "markdown": markdown,
        "parsed_document": {
            "schema_version": "parsed_document.v2",
            "document": {"document_id": "sha256:doc", "page_count": len(pages)},
            "preprocessing": {"warnings": list(warnings)},
            "page_count": len(pages),
            "page_mapping_verified": True,
            "artifacts": {"source_ref": "source.pdf"},
            "parser_runs": [{"parser": "docling", "version": "test", "status": "success", "warnings": [], "error": None}],
            "arbitration": {"primary_document_parser": "docling", "page_decisions": []},
            "diagnostics": [],
            "content_stream": content_stream,
            "pages": pages,
            "tables": tables,
            "evidence_index": {"anchors": anchors},
        },
    }


class MergeFragmentsTests(unittest.TestCase):
    def test_two_fragments_merge_with_shifted_markdown_spans(self):
        first = _fragment(
            pages=[{"page_number": 1, "width_pt": 600, "height_pt": 800, "rotation": 0,
                     "ordered_content": ["b1"], "unplaced_content": [], "markdown_span": {"start": 0, "end": 10}}],
            content_stream=[{"block_id": "b1", "page_number": 1, "parser": "docling", "bbox": {"x0": 0, "y0": 0, "x1": 1, "y1": 1},
                              "markdown_span": {"start": 0, "end": 10}, "kind": "paragraph", "text": "hello"}],
            tables=[],
            anchors=[{"kind": "text", "anchor_id": "a1", "block_id": "b1", "markdown_span": {"start": 0, "end": 10},
                      "producer_observations": []}],
            markdown="0123456789",
        )
        second = _fragment(
            pages=[{"page_number": 2, "width_pt": 600, "height_pt": 800, "rotation": 0,
                     "ordered_content": ["b2"], "unplaced_content": [], "markdown_span": {"start": 0, "end": 5}}],
            content_stream=[{"block_id": "b2", "page_number": 2, "parser": "docling", "bbox": {"x0": 0, "y0": 0, "x1": 1, "y1": 1},
                              "markdown_span": {"start": 0, "end": 5}, "kind": "paragraph", "text": "world"}],
            tables=[],
            anchors=[{"kind": "text", "anchor_id": "a2", "block_id": "b2", "markdown_span": {"start": 0, "end": 5},
                      "producer_observations": []}],
            markdown="world",
        )
        merged, markdown = merge_fragments([first, second])

        self.assertEqual(markdown, "0123456789world")
        self.assertEqual(merged["page_count"], 2)
        self.assertEqual([p["page_number"] for p in merged["pages"]], [1, 2])
        self.assertEqual(merged["pages"][1]["markdown_span"], {"start": 10, "end": 15})
        second_block = next(b for b in merged["content_stream"] if b["block_id"] == "b2")
        self.assertEqual(second_block["markdown_span"], {"start": 10, "end": 15})
        second_anchor = next(a for a in merged["evidence_index"]["anchors"] if a["anchor_id"] == "a2")
        self.assertEqual(second_anchor["markdown_span"], {"start": 10, "end": 15})
        # Identical parser_runs across partitions are de-duplicated.
        self.assertEqual(len(merged["parser_runs"]), 1)

    def test_single_fragment_is_returned_unchanged(self):
        only = _fragment(
            pages=[{"page_number": 1, "width_pt": 600, "height_pt": 800, "rotation": 0,
                     "ordered_content": [], "unplaced_content": [], "markdown_span": {"start": 0, "end": 4}}],
            content_stream=[], tables=[], anchors=[], markdown="text",
        )
        merged, markdown = merge_fragments([only])
        self.assertEqual(markdown, "text")
        self.assertEqual(merged, only["parsed_document"])


def _table(table_id, page_number, *, rows, cols, cells):
    return {
        "table_id": table_id, "rows": rows, "cols": cols, "cells": cells,
        "spans": [{"page_number": page_number, "producer_table_ref": table_id,
                    "page_local_row_start": 0, "page_local_row_end": rows - 1, "page_local_col_count": cols}],
        "parser_attribution": {}, "continuation": "page_local",
    }


def _cell(table_id, cell_id, row, column, text, bbox, *, role=None):
    return {
        "cell_id": cell_id, "row": row, "column": column, "text": text, "role": role,
        "rowspan": 1, "colspan": 1, "bbox": bbox, "evidence_anchor_id": f"anchor-{cell_id}",
    }


def _table_anchor(table_id, cell_id, row, column):
    return {
        "kind": "table_cell", "anchor_id": f"anchor-{cell_id}", "logical_table_id": table_id,
        "cell_id": cell_id, "canonical_row": row, "canonical_column": column,
        "producer_observations": [],
    }


class StitchBoundaryTablesTests(unittest.TestCase):
    def _document(self, *, earlier_bottom, later_top):
        page1 = {"page_number": 1, "width_pt": 600, "height_pt": 800, "rotation": 0,
                  "ordered_content": ["block-a"], "unplaced_content": [], "markdown_span": None}
        page2 = {"page_number": 2, "width_pt": 600, "height_pt": 800, "rotation": 0,
                  "ordered_content": ["block-b"], "unplaced_content": [], "markdown_span": None}
        earlier_cells = [
            _cell("table-a", "a-h0", 0, 0, "Name", {"x0": 10, "y0": 20, "x1": 100, "y1": 40}, role="column_header"),
            _cell("table-a", "a-h1", 0, 1, "Value", {"x0": 100, "y0": 20, "x1": 200, "y1": 40}, role="column_header"),
            _cell("table-a", "a-r0c0", 1, 0, "Alpha", {"x0": 10, "y0": 40, "x1": 100, "y1": earlier_bottom}),
            _cell("table-a", "a-r0c1", 1, 1, "1", {"x0": 100, "y0": 40, "x1": 200, "y1": earlier_bottom}),
        ]
        later_cells = [
            _cell("table-b", "b-h0", 0, 0, "Name", {"x0": 10, "y0": later_top, "x1": 100, "y1": later_top + 20}, role="column_header"),
            _cell("table-b", "b-h1", 0, 1, "Value", {"x0": 100, "y0": later_top, "x1": 200, "y1": later_top + 20}, role="column_header"),
            _cell("table-b", "b-r0c0", 1, 0, "Beta", {"x0": 10, "y0": later_top + 20, "x1": 100, "y1": later_top + 40}),
            _cell("table-b", "b-r0c1", 1, 1, "2", {"x0": 100, "y0": later_top + 20, "x1": 200, "y1": later_top + 40}),
        ]
        anchors = [_table_anchor("table-a", cell["cell_id"], cell["row"], cell["column"]) for cell in earlier_cells]
        anchors += [_table_anchor("table-b", cell["cell_id"], cell["row"], cell["column"]) for cell in later_cells]
        return {
            "diagnostics": [],
            "pages": [page1, page2],
            "content_stream": [
                {"block_id": "block-a", "page_number": 1, "kind": "table", "table_id": "table-a",
                 "bbox": {"x0": 10, "y0": 20, "x1": 200, "y1": earlier_bottom}, "markdown_span": None},
                {"block_id": "block-b", "page_number": 2, "kind": "table", "table_id": "table-b",
                 "bbox": {"x0": 10, "y0": later_top, "x1": 200, "y1": later_top + 40}, "markdown_span": None},
            ],
            "tables": [
                _table("table-a", 1, rows=2, cols=2, cells=earlier_cells),
                _table("table-b", 2, rows=2, cols=2, cells=later_cells),
            ],
            "evidence_index": {"anchors": anchors},
        }

    def test_flush_aligned_tables_are_stitched_with_header_dropped(self):
        document = self._document(earlier_bottom=780, later_top=5)  # both flush (800 * 0.06 = 48 margin)

        result = stitch_boundary_tables(document, boundary_pages=[1])

        self.assertEqual(len(result["tables"]), 1)
        stitched = result["tables"][0]
        self.assertEqual(stitched["table_id"], "table-a")
        self.assertEqual(stitched["continuation"], "derived_continuation")
        # Header row from table-b dropped; one data row appended after table-a's row 1.
        self.assertEqual(stitched["rows"], 3)
        rows = sorted({cell["row"] for cell in stitched["cells"]})
        self.assertEqual(rows, [0, 1, 2])
        appended = next(cell for cell in stitched["cells"] if cell["cell_id"] == "b-r0c0")
        self.assertEqual(appended["row"], 2)
        # table-b's own block and page-2 ordered_content reference are gone.
        self.assertNotIn("block-b", [b["block_id"] for b in result["content_stream"]])
        self.assertNotIn("block-b", result["pages"][1]["ordered_content"])
        # table-b's dropped header cell anchors are gone; surviving cell anchors point at table-a.
        anchor_ids = {a["cell_id"] for a in result["evidence_index"]["anchors"]}
        self.assertNotIn("b-h0", anchor_ids)
        self.assertNotIn("b-h1", anchor_ids)
        moved_anchor = next(a for a in result["evidence_index"]["anchors"] if a["cell_id"] == "b-r0c0")
        self.assertEqual(moved_anchor["logical_table_id"], "table-a")
        self.assertEqual(moved_anchor["canonical_row"], 2)
        self.assertEqual(result["diagnostics"], [])

    def test_non_flush_tables_are_left_separate_with_diagnostic(self):
        # earlier table ends well above the bottom margin -> not flush.
        document = self._document(earlier_bottom=400, later_top=5)

        result = stitch_boundary_tables(document, boundary_pages=[1])

        self.assertEqual({t["table_id"] for t in result["tables"]}, {"table-a", "table-b"})
        self.assertEqual(result["diagnostics"], [])  # no flush pair found at all -> nothing to flag either

    def test_misaligned_columns_are_left_separate_with_diagnostic(self):
        document = self._document(earlier_bottom=780, later_top=5)
        # Shift table-b's columns so they no longer line up with table-a's.
        for table in document["tables"]:
            if table["table_id"] != "table-b":
                continue
            for cell in table["cells"]:
                cell["bbox"] = {**cell["bbox"], "x0": cell["bbox"]["x0"] + 300, "x1": cell["bbox"]["x1"] + 300}

        result = stitch_boundary_tables(document, boundary_pages=[1])

        self.assertEqual({t["table_id"] for t in result["tables"]}, {"table-a", "table-b"})
        codes = {d["code"] for d in result["diagnostics"]}
        self.assertIn("partition_boundary_table_not_stitched", codes)


class FlagBoundaryTextTests(unittest.TestCase):
    def test_paragraph_adjacent_to_boundary_is_flagged_not_moved(self):
        document = {
            "diagnostics": [],
            "content_stream": [
                {"block_id": "p1", "page_number": 5, "kind": "paragraph", "text": "tail of partition A"},
                {"block_id": "p2", "page_number": 6, "kind": "paragraph", "text": "head of partition B"},
                {"block_id": "p3", "page_number": 20, "kind": "paragraph", "text": "unrelated"},
            ],
        }
        result = flag_boundary_text(document, boundary_pages=[5])

        flagged = {d["detail"] for d in result["diagnostics"]}
        self.assertEqual(flagged, {"p1", "p2"})
        # Content itself is untouched.
        self.assertEqual(
            [b["text"] for b in result["content_stream"]],
            ["tail of partition A", "head of partition B", "unrelated"],
        )


if __name__ == "__main__":
    unittest.main()
