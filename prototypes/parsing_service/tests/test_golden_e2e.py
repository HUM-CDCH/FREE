"""Opt-in semantic E2E for the real canonical ingestion pipeline.

The checked-in fixture is a manually reviewed oracle of stable source-document
facts. It is intentionally not regenerable from current output: implementation
changes must preserve the invariants and be reviewed against the source.

    RUN_GOLDEN_E2E=1 uv run --no-sync python -m unittest tests.test_golden_e2e
"""

from __future__ import annotations

import json
import math
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from main import app
from tests.storage_test_support import isolated_storage

SOURCE_PDF = (
    Path(__file__).resolve().parents[3] / "examples" / "Beretning_Ellekilde_8_13.pdf"
)
GOLDEN_PATH = (
    Path(__file__).resolve().parent / "golden" / "Beretning_Ellekilde_8_13.golden.json"
)


def _integer(value: str | int | float) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise AssertionError(
            f"expected integer-compatible value, got {value!r}"
        ) from exc


def _number(value: str | int | float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise AssertionError(f"expected numeric value, got {value!r}") from exc


def _load_golden() -> dict:
    try:
        return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AssertionError(f"invalid semantic oracle: {GOLDEN_PATH}") from exc


def _table_matrix(table: dict) -> list[list[str]]:
    rows = _integer(table["rows"])
    cols = _integer(table["cols"])
    matrix = [[""] * cols for _ in range(rows)]
    for cell in table["cells"]:
        matrix[_integer(cell["row"])][_integer(cell["column"])] = str(cell["text"])
    return matrix


def normalize(parsed: dict) -> dict:
    """Return the compact facts reviewed against the source document."""
    summaries: list[dict] = []
    for table in parsed["tables"]:
        matrix = _table_matrix(table)
        spans = table.get("spans", [])
        page_numbers = [span["page_number"] for span in spans]
        attribution = table.get("parser_attribution", {})
        content_parser = attribution.get("content_parser", {}).get("parser")
        summaries.append(
            {
                "page_numbers": page_numbers,
                "content_parser": content_parser,
                "rows": table["rows"],
                "cols": table["cols"],
                "header_rows": sorted(
                    {
                        _integer(cell["row"])
                        for cell in table["cells"]
                        if cell.get("role") == "header"
                    }
                ),
                "first_column": [row[0] for row in matrix],
            }
        )
    return {
        "schema_version": parsed["schema_version"],
        "content_sha256": parsed["document"]["content_sha256"],
        "page_count": parsed["document"]["page_count"],
        "tables": summaries,
    }


def _assert_bbox_inside_page(test: unittest.TestCase, bbox: dict, page: dict) -> None:
    values = [_number(bbox[name]) for name in ("x0", "y0", "x1", "y1")]
    test.assertTrue(all(math.isfinite(value) for value in values), bbox)
    x0, y0, x1, y1 = values
    test.assertLessEqual(x0, x1, bbox)
    test.assertLessEqual(y0, y1, bbox)
    test.assertGreaterEqual(x0, 0, bbox)
    test.assertGreaterEqual(y0, 0, bbox)
    test.assertLessEqual(x1, _number(page["width_pt"]), bbox)
    test.assertLessEqual(y1, _number(page["height_pt"]), bbox)


def _bbox_overlap_ratio(first: dict | None, second: dict | None) -> float:
    if first is None or second is None:
        return 0.0
    first_values = [_number(first[name]) for name in ("x0", "y0", "x1", "y1")]
    second_values = [_number(second[name]) for name in ("x0", "y0", "x1", "y1")]
    first_x0, first_y0, first_x1, first_y1 = first_values
    second_x0, second_y0, second_x1, second_y1 = second_values
    intersection = max(0.0, min(first_x1, second_x1) - max(first_x0, second_x0)) * max(
        0.0, min(first_y1, second_y1) - max(first_y0, second_y0)
    )
    first_area = max(0.0, first_x1 - first_x0) * max(0.0, first_y1 - first_y0)
    second_area = max(0.0, second_x1 - second_x0) * max(0.0, second_y1 - second_y0)
    return intersection / max(1e-9, min(first_area, second_area))


_FORBIDDEN_TABLE_PROSE = (
    "Antropologisk kunne",
    "Tolkning: Jordfæstegrav",
    "Skeletdelene er nummereret",
)


def _assert_cell_coverage(
    test: unittest.TestCase,
    table_id: str,
    cell: dict,
    occupied: dict[tuple[int, int], tuple[int, int]],
) -> None:
    row, col = _integer(cell["row"]), _integer(cell["column"])
    for covered_row in range(row, row + _integer(cell.get("rowspan", 1))):
        for covered_col in range(col, col + _integer(cell.get("colspan", 1))):
            position = (covered_row, covered_col)
            test.assertNotIn(
                position,
                occupied,
                f"overlapping spans in {table_id}: {position}",
            )
            occupied[position] = (row, col)


def _assert_table_cells(
    test: unittest.TestCase,
    table: dict,
    page: dict,
) -> list[str]:
    occupied: dict[tuple[int, int], tuple[int, int]] = {}
    texts: list[str] = []
    table_label = table.get("table_id", table.get("logical_table_id", "table"))
    for cell in table["cells"]:
        texts.append(str(cell["text"]).strip())
        cell_bbox = cell.get("bbox")
        if cell_bbox is not None:
            _assert_bbox_inside_page(test, cell_bbox, page)
        _assert_cell_coverage(test, table_label, cell, occupied)
    return texts


def _assert_unique_table(
    test: unittest.TestCase,
    table: dict,
    texts: list[str],
    fingerprints: dict[tuple[int, tuple[str, ...]], list[dict | None]],
) -> None:
    page_number = table.get("page_number")
    if page_number is None:
        page_number = table.get("spans", [{}])[0].get("page_number")
    fingerprint = (_integer(page_number), tuple(texts))
    table_bbox = table.get("bbox")
    for prior_bbox in fingerprints.get(fingerprint, []):
        test.assertLess(
            _bbox_overlap_ratio(prior_bbox, table_bbox),
            0.8,
            f"overlapping duplicate table content: {table.get('table_id', table.get('logical_table_id', 'table'))}",
        )
    fingerprints.setdefault(fingerprint, []).append(table_bbox)


def _assert_table_markdown(test: unittest.TestCase, table: dict) -> None:
    markdown = table.get("markdown_view")
    if markdown is None:
        return
    markdown_lines = markdown.splitlines()
    table_label = table.get("table_id", table.get("logical_table_id", "table"))
    test.assertGreaterEqual(len(markdown_lines), 2, table_label)
    test.assertTrue(
        all(part.strip() == "---" for part in markdown_lines[1].strip("| ").split("|")),
        table.get("table_id", table.get("logical_table_id", "table")),
    )


def _assert_table_invariants(
    test: unittest.TestCase,
    table: dict,
    page: dict,
    fingerprints: dict[tuple[int, tuple[str, ...]], list[dict | None]],
) -> None:
    table_bbox = table.get("bbox")
    if table_bbox is not None:
        _assert_bbox_inside_page(test, table_bbox, page)

    texts = _assert_table_cells(test, table, page)
    joined = "\n".join(texts)
    table_label = table.get("table_id", table.get("logical_table_id", "table"))
    for phrase in _FORBIDDEN_TABLE_PROSE:
        test.assertNotIn(phrase, joined, table_label)
    _assert_unique_table(test, table, texts, fingerprints)
    _assert_table_markdown(test, table)


def assert_semantic_invariants(test: unittest.TestCase, parsed: dict) -> None:
    pages = {_integer(page["page_number"]): page for page in parsed["pages"]}
    fingerprints: dict[tuple[int, tuple[str, ...]], list[dict | None]] = {}
    anchors = {
        anchor["anchor_id"]: anchor
        for anchor in parsed.get("evidence_index", {}).get("anchors", [])
    }
    test.assertTrue(parsed["tables"], "canonical tables must not silently disappear")
    multi_page_tables = []
    for table in parsed["tables"]:
        spans = table.get("spans", [])
        page_numbers = [span["page_number"] for span in spans]
        test.assertTrue(
            page_numbers, table["table_id"]
        )
        _assert_table_invariants(
            test, table, pages[_integer(page_numbers[0])], fingerprints
        )
        if not anchors:
            continue
        if len(set(page_numbers)) > 1:
            multi_page_tables.append(table)
        span_by_page = {span["page_number"]: span for span in spans}
        for cell in table["cells"]:
            anchor_id = cell.get("evidence_anchor_id")
            anchor = anchors.get(anchor_id)
            if not isinstance(anchor, dict):
                raise AssertionError(
                    f"missing Evidence anchor for {table.get('table_id')}/{cell.get('cell_id')}"
                )
            test.assertEqual(anchor["kind"], "table_cell")
            test.assertEqual(anchor["logical_table_id"], table["table_id"])
            test.assertEqual(anchor["cell_id"], cell["cell_id"])
            test.assertEqual(anchor["canonical_row"], cell["row"])
            test.assertEqual(anchor["canonical_column"], cell["column"])
            observation = anchor["producer_observation"]
            if not isinstance(observation, dict):
                raise AssertionError(
                    "table Evidence must retain one producer observation per cell"
                )
            anchor_page = observation["page_number"]
            test.assertIn(anchor_page, span_by_page)
    if not anchors:
        return
    reviewed = [
        table
        for table in multi_page_tables
        if {span["page_number"] for span in table.get("spans", [])} == {4, 5}
    ]
    test.assertEqual(
        len(reviewed), 1, "reviewed 6→7 continuation must be one logical table"
    )
    test.assertEqual(reviewed[0]["continuation"], "derived_continuation")
    reviewed_anchor_pages = {
        anchors[cell["evidence_anchor_id"]]["producer_observation"]["page_number"]
        for cell in reviewed[0]["cells"]
    }
    test.assertEqual(reviewed_anchor_pages, {4, 5})
    test.assertEqual(
        len(reviewed[0]["cells"]),
        sum(
            1
            for anchor in anchors.values()
            if anchor.get("logical_table_id") == reviewed[0]["table_id"]
        ),
    )


class TestSemanticInvariants(unittest.TestCase):
    @staticmethod
    def _document_with_repeated_tables(bboxes: list[dict]) -> dict:
        return {
            "pages": [{"page_number": 1, "width_pt": 200, "height_pt": 200}],
            "tables": [
                {
                    "table_id": f"p01_t{index:02d}",
                    "bbox": bbox,
                    "spans": [{"page_number": 1}],
                    "cells": [
                        {"row": 0, "column": 0, "text": "Name"},
                        {"row": 0, "column": 1, "text": "Value"},
                    ],
                    "markdown_view": "| Name | Value |\n| --- | --- |",
                }
                for index, bbox in enumerate(bboxes, start=1)
            ],
        }

    def test_repeated_content_in_distinct_regions_is_valid(self):
        parsed = self._document_with_repeated_tables(
            [
                {"x0": 10, "y0": 10, "x1": 190, "y1": 60},
                {"x0": 10, "y0": 100, "x1": 190, "y1": 150},
            ]
        )

        assert_semantic_invariants(self, parsed)

    def test_repeated_content_in_overlapping_regions_is_rejected(self):
        bbox = {"x0": 10, "y0": 10, "x1": 190, "y1": 60}
        parsed = self._document_with_repeated_tables([bbox, bbox.copy()])

        with self.assertRaisesRegex(AssertionError, "overlapping duplicate"):
            assert_semantic_invariants(self, parsed)


@unittest.skipUnless(
    os.getenv("RUN_GOLDEN_E2E") == "1",
    "set RUN_GOLDEN_E2E=1 to run the real-pipeline semantic e2e test",
)
class TestGoldenE2E(unittest.TestCase):
    def setUp(self):
        self._storage = isolated_storage()
        self._storage.__enter__()
        self.addCleanup(self._storage.__exit__, None, None, None)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()

    def test_parsed_document_matches_semantic_oracle(self):
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

        parsed_response = self.client.get(f"/tasks/{task_id}/parsed-document")
        self.assertEqual(parsed_response.status_code, 200, parsed_response.text)
        parsed = parsed_response.json()
        assert_semantic_invariants(self, parsed)

        golden = _load_golden()
        self.assertEqual(normalize(parsed), golden)

        markdown = self.client.get(f"/tasks/{task_id}/markdown")
        self.assertEqual(markdown.status_code, 200)
        self.assertTrue(markdown.text.strip(), "canonical Markdown must not be empty")


if __name__ == "__main__":
    unittest.main()
