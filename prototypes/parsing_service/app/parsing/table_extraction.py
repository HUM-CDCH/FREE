"""Canonical table extraction and reconciliation.

Docling supplies the table inventory because its document model preserves table
boundaries, spans, roles, and provenance. Camelot's stream parser remains the
optional enrichment/fallback path for environments or documents where Docling
does not expose a usable table inventory.

All published geometry uses PDF points with a top-left origin in displayed page
space. Camelot geometry is intentionally withheld on rotated pages until a
complete rotation transform is independently verified.

Row/prose heuristics live in ``_table_matrix``; everything that produces a
``ParsedTable`` lives here so the pipeline reads top to bottom.
"""

from __future__ import annotations

import gc
import importlib
import logging
import math
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.models.parsed_document_v2 import BoundingBox
from app.models.parser_output import ParsedTable, TableCell
from app.parsing._table_matrix import (
    _guess_header_rows,
    _is_header_like_row,
    _is_numbery,
    _is_prose_row,
    _is_table_data_row,
    _norm_cell,
    _normalise_camelot_matrix,
    _normalise_matrix,
    is_matrixlike,
)
from app.parsing.v2_publication import render_table_markdown
from app.timing import duration_ms, utc_now

TABLE_PARSER_NAME = "camelot_stream"
DOCLING_TABLE_PARSER_NAME = "docling_table"
TABLE_PIPELINE_NAME = "docling_inventory_camelot_fallback"
ROTATED_TABLE_GEOMETRY_WARNING = "rotated_table_geometry_suppressed"

BBoxTuple = tuple[float, float, float, float]
CellPosition = tuple[int, int]
CellSpan = tuple[int, int]

_BOTTOM_LEFT_ORIGINS = {"bottomleft", "bottom_left", "bottom-left"}
_ENRICHMENT_OVERLAP = 0.8

logger = logging.getLogger(__name__)

__all__ = (
    "BBoxTuple",
    "DOCLING_TABLE_PARSER_NAME",
    "ROTATED_TABLE_GEOMETRY_WARNING",
    "TableExtractionOutput",
    "extract_tables",
    "is_matrixlike",
    "table_matrix_to_parsed_table",
    "render_parsed_table_markdown",
)


@dataclass(frozen=True)
class TableExtractionOutput:
    parser: str = TABLE_PARSER_NAME
    status: str = "skipped"
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    tables: list[ParsedTable] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    # Rejected candidates stay internal and auditable; they never become a
    # second public canonical table.
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #


def _coerce_bbox(raw: Any) -> BBoxTuple | None:
    try:
        values = tuple(float(value) for value in raw)
    except (TypeError, ValueError):
        return None
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        return None
    return values[0], values[1], values[2], values[3]


def _topleft_bbox_values(
    raw: Any,
    page_height_pt: float | None,
    *,
    origin: str = "bottomleft",
    enabled: bool = True,
) -> BBoxTuple | None:
    """Normalize a raw bbox into displayed top-left page space."""
    values = _coerce_bbox(raw) if enabled else None
    if values is not None and origin.lower() in _BOTTOM_LEFT_ORIGINS:
        values = (
            None
            if page_height_pt is None
            else (
                values[0],
                page_height_pt - values[3],
                values[2],
                page_height_pt - values[1],
            )
        )
    if values is None or values[0] >= values[2] or values[1] >= values[3]:
        return None
    return values


def _bbox_topleft(
    raw: Any,
    page_height_pt: float | None,
    *,
    origin: str = "bottomleft",
    enabled: bool = True,
) -> BoundingBox | None:
    values = _topleft_bbox_values(raw, page_height_pt, origin=origin, enabled=enabled)
    if values is None:
        return None
    try:
        return BoundingBox(x0=values[0], y0=values[1], x1=values[2], y1=values[3])
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Matrix -> canonical table
# --------------------------------------------------------------------------- #

_ROW_HEADER_KEYWORDS = (
    "mg/ml",
    "mg/",
    "content",
    "recovery",
    "yield",
    "protein",
    "hydroxyproline",
)


def _is_row_header(
    matrix: list[list[str]], r: int, c: int, n_cols: int, header_rows: list[int]
) -> bool:
    if r in header_rows or c > 2:
        return False
    cell_text = matrix[r][c]
    if not cell_text or _is_numbery(cell_text):
        return False
    has_data_to_right = any(
        matrix[r][check_c] and _is_numbery(matrix[r][check_c])
        for check_c in range(c + 1, min(c + 4, n_cols))
    )
    return (
        has_data_to_right
        or any(keyword in cell_text.lower() for keyword in _ROW_HEADER_KEYWORDS)
        or "(" in cell_text
        or "/" in cell_text
    )


def _is_column_header(matrix: list[list[str]], r: int, c: int, n_rows: int) -> bool:
    if r >= 4 or c == 0:
        return False
    cell_text = matrix[r][c]
    if not cell_text or _is_numbery(cell_text):
        return False
    has_data_below = any(
        matrix[check_r][c] and _is_numbery(matrix[check_r][c])
        for check_r in range(r + 1, min(r + 5, n_rows))
    )
    if not has_data_below:
        return False
    return sum(1 for cell in matrix[r] if cell and not _is_numbery(cell)) >= 2


def _markdown_view(matrix: list[list[str]], header_rows: list[int]) -> str:
    """Render the same matrix policy used by v2 publication."""
    return render_table_markdown(matrix, header_rows)


def render_parsed_table_markdown(table: ParsedTable) -> str:
    """Render Markdown from the final typed table cells.

    This is the table-extraction seam used by v2 publication and is purposely
    a thin delegation to the shared renderer; no OTSL or Camelot matrix is
    consulted after canonicalization.
    """
    return render_table_markdown(table)


def _safe_spans(
    matrix: list[list[str]], cell_spans: Mapping[CellPosition, CellSpan] | None
) -> dict[CellPosition, CellSpan]:
    """Accept only explicit spans that stay in bounds and cover empty cells."""
    rows = len(matrix)
    cols = len(matrix[0]) if matrix else 0
    occupied: set[CellPosition] = set()
    accepted: dict[CellPosition, CellSpan] = {}
    for position, raw_span in sorted((cell_spans or {}).items()):
        try:
            rowspan, colspan = int(raw_span[0]), int(raw_span[1])
        except (TypeError, ValueError, IndexError):
            continue
        if rowspan < 1 or colspan < 1:
            continue
        covered = {
            (covered_row, covered_col)
            for covered_row in range(position[0], position[0] + rowspan)
            for covered_col in range(position[1], position[1] + colspan)
        }
        fits = all(0 <= row < rows and 0 <= col < cols for row, col in covered)
        only_root_text = fits and all(
            cell == position or not matrix[cell[0]][cell[1]] for cell in covered
        )
        if only_root_text and occupied.isdisjoint(covered):
            accepted[position] = (rowspan, colspan)
            occupied.update(covered)
    return accepted


@dataclass(frozen=True)
class _TableBuildContext:
    """Everything ``table_matrix_to_parsed_table`` accepts beyond the matrix."""

    page_number: int
    table_index: int
    page_height_pt: float | None
    cell_bboxes: Sequence[Sequence[BBoxTuple | None]] | None = None
    table_bbox: BBoxTuple | None = None
    geometry_enabled: bool = True
    bbox_origin: str = "bottomleft"
    source_parser: str = TABLE_PARSER_NAME
    cell_spans: Mapping[CellPosition, CellSpan] | None = None
    cell_roles: Mapping[CellPosition, str | None] | None = None
    header_rows: list[int] | None = None

    def bbox(self, raw: Any) -> BoundingBox | None:
        return _bbox_topleft(
            raw,
            self.page_height_pt,
            origin=self.bbox_origin,
            enabled=self.geometry_enabled,
        )

    def cell_bbox(self, row: int, col: int) -> BoundingBox | None:
        grid = self.cell_bboxes
        try:
            raw = grid[row][col] if grid is not None else None
        except IndexError:
            raw = None
        return self.bbox(raw) if raw is not None else None


def _inferred_role(
    matrix: list[list[str]],
    row: int,
    col: int,
    header_rows: list[int],
) -> str:
    n_rows = len(matrix)
    n_cols = len(matrix[0]) if matrix else 0
    if row in header_rows:
        return "header"
    if _is_column_header(matrix, row, col, n_rows):
        return "column_header"
    if _is_row_header(matrix, row, col, n_cols, header_rows):
        return "row_header"
    if col == 0 and not _is_numbery(matrix[row][col]):
        return "row_header_hint"
    return "data"


def _parsed_table_from_matrix(
    matrix: list[list[str]], context: _TableBuildContext
) -> ParsedTable:
    matrix = _normalise_matrix(matrix)
    n_rows = len(matrix)
    n_cols = len(matrix[0]) if n_rows else 0
    header_rows = (
        _guess_header_rows(matrix)
        if context.header_rows is None
        else context.header_rows
    )
    spans = _safe_spans(matrix, context.cell_spans)
    roles = context.cell_roles or {}

    cells: list[TableCell] = []
    for row in range(n_rows):
        for col in range(n_cols):
            text = matrix[row][col]
            if not text:
                continue
            rowspan, colspan = spans.get((row, col), (1, 1))
            cells.append(
                TableCell(
                    row=row,
                    col=col,
                    text=text,
                    role=roles.get((row, col))
                    or _inferred_role(matrix, row, col, header_rows),
                    rowspan=rowspan,
                    colspan=colspan,
                    bbox=context.cell_bbox(row, col),
                )
            )

    return ParsedTable(
        table_id=f"p{context.page_number:02d}_t{context.table_index:02d}",
        page_number=context.page_number,
        source_parser=context.source_parser,
        content_parser=context.source_parser,
        structure_parser=context.source_parser,
        geometry_parser=(context.source_parser if context.geometry_enabled else None),
        bbox=(
            context.bbox(context.table_bbox) if context.table_bbox is not None else None
        ),
        rows=n_rows,
        cols=n_cols,
        cells=cells,
        markdown_view=_markdown_view(matrix, header_rows),
    )


def table_matrix_to_parsed_table(
    matrix: list[list[str]],
    page_number: int,
    table_index: int,
    **options: Any,
) -> ParsedTable:
    """Convert a matrix into the canonical table shape.

    Spans are accepted only from explicit parser metadata. Empty neighboring
    strings never imply a merge.
    """
    return _parsed_table_from_matrix(
        matrix,
        _TableBuildContext(page_number=page_number, table_index=table_index, **options),
    )


# --------------------------------------------------------------------------- #
# Docling inventory -> canonical table
# --------------------------------------------------------------------------- #


def _inventory_bbox(raw: Any, page_height_pt: float | None) -> BBoxTuple | None:
    if not isinstance(raw, Mapping):
        return None
    origin = str(raw.get("origin") or "TOPLEFT").upper()
    return _topleft_bbox_values(
        (raw.get("x0"), raw.get("y0"), raw.get("x1"), raw.get("y1")),
        page_height_pt,
        origin="bottomleft" if "BOTTOM" in origin else "topleft",
    )


def _inventory_shape(inventory: Mapping[str, Any]) -> tuple[int, int, int] | None:
    try:
        page_number = int(inventory.get("page_number", 0))
        rows = max(0, int(inventory.get("rows", 0)))
        cols = max(0, int(inventory.get("cols", 0)))
    except (TypeError, ValueError):
        return None
    if page_number < 1 or rows < 1 or cols < 1:
        return None
    return page_number, rows, cols


def _docling_table_to_parsed_table(
    inventory: Mapping[str, Any],
    table_index: int,
    page_heights_pt: Mapping[int, float],
) -> ParsedTable | None:
    shape = _inventory_shape(inventory)
    raw_cells = inventory.get("cells")
    if shape is None or not isinstance(raw_cells, Sequence):
        return None
    page_number, rows, cols = shape
    page_height = page_heights_pt.get(page_number)

    matrix = [[""] * cols for _ in range(rows)]
    bboxes: list[list[BBoxTuple | None]] = [[None] * cols for _ in range(rows)]
    spans: dict[CellPosition, CellSpan] = {}
    roles: dict[CellPosition, str | None] = {}
    header_rows: set[int] = set()
    for raw_cell in raw_cells:
        if not isinstance(raw_cell, Mapping):
            continue
        try:
            row = int(raw_cell.get("row", -1))
            col = int(raw_cell.get("col", -1))
            span = (
                max(1, int(raw_cell.get("rowspan", 1))),
                max(1, int(raw_cell.get("colspan", 1))),
            )
        except (TypeError, ValueError):
            continue
        if not (0 <= row < rows and 0 <= col < cols):
            continue
        role = str(raw_cell.get("role") or "data")
        matrix[row][col] = _norm_cell(raw_cell.get("text"))
        bboxes[row][col] = _inventory_bbox(raw_cell.get("bbox"), page_height)
        spans[(row, col)] = span
        roles[(row, col)] = role
        if role in {"header", "column_header"}:
            header_rows.add(row)

    table = _parsed_table_from_matrix(
        matrix,
        _TableBuildContext(
            page_number=page_number,
            table_index=table_index,
            page_height_pt=page_height,
            cell_bboxes=bboxes,
            table_bbox=_inventory_bbox(inventory.get("bbox"), page_height),
            bbox_origin="topleft",
            source_parser=DOCLING_TABLE_PARSER_NAME,
            cell_spans=spans,
            cell_roles=roles,
            header_rows=sorted(header_rows),
        ),
    )
    if not table.cells:
        return None
    producer_ref = inventory.get("producer_ref")
    producer_order = inventory.get("producer_order")
    return table.model_copy(
        update={
            "producer_ref": str(producer_ref) if producer_ref is not None else None,
            "producer_order": (
                int(producer_order)
                if isinstance(producer_order, int) and producer_order >= 0
                else None
            ),
        }
    )


# --------------------------------------------------------------------------- #
# Overlap and deduplication
# --------------------------------------------------------------------------- #


def _intersection_area(first: BoundingBox, second: BoundingBox) -> float:
    return max(0.0, min(first.x1, second.x1) - max(first.x0, second.x0)) * max(
        0.0, min(first.y1, second.y1) - max(first.y0, second.y0)
    )


def _area(box: BoundingBox) -> float:
    return max(0.0, box.x1 - box.x0) * max(0.0, box.y1 - box.y0)


def _overlap_ratio(first: BoundingBox | None, second: BoundingBox | None) -> float:
    if first is None or second is None:
        return 0.0
    return _intersection_area(first, second) / max(
        1e-9, min(_area(first), _area(second))
    )


def _intersection_over_union(
    first: BoundingBox | None, second: BoundingBox | None
) -> float:
    if first is None or second is None:
        return 0.0
    intersection = _intersection_area(first, second)
    return intersection / max(1e-9, _area(first) + _area(second) - intersection)


def _content_overlap(first: ParsedTable, second: ParsedTable) -> float:
    def fingerprint(table: ParsedTable) -> set[tuple[int, int, str]]:
        return {
            (cell.row, cell.col, _norm_cell(cell.text).casefold())
            for cell in table.cells
            if cell.text
        }

    first_cells = fingerprint(first)
    second_cells = fingerprint(second)
    if not first_cells or not second_cells:
        return 0.0
    return len(first_cells & second_cells) / min(len(first_cells), len(second_cells))


def _deduplicate_tables(tables: list[ParsedTable]) -> list[ParsedTable]:
    # Equal content may legitimately recur in distinct physical page regions.
    kept: list[ParsedTable] = []
    for table in tables:
        if any(
            prior.page_number == table.page_number
            and _content_overlap(prior, table) >= _ENRICHMENT_OVERLAP
            and _overlap_ratio(prior.bbox, table.bbox) >= _ENRICHMENT_OVERLAP
            for prior in kept
        ):
            continue
        kept.append(table)
    return kept


def _assign_table_ids(tables: list[ParsedTable]) -> list[ParsedTable]:
    counters: dict[int, int] = {}
    ordered = sorted(
        tables,
        key=lambda table: (
            table.page_number,
            table.bbox.y0 if table.bbox is not None else math.inf,
            table.bbox.x0 if table.bbox is not None else math.inf,
        ),
    )
    result: list[ParsedTable] = []
    for table in ordered:
        index = counters[table.page_number] = counters.get(table.page_number, 0) + 1
        result.append(
            table.model_copy(
                update={"table_id": f"p{table.page_number:02d}_t{index:02d}"}
            )
        )
    return result


# --------------------------------------------------------------------------- #
# Camelot candidates
# --------------------------------------------------------------------------- #


@dataclass
class _Extraction:
    """Inputs, the loaded Camelot module, and warnings for one extraction."""

    source_pdf: Path
    page_heights_pt: Mapping[int, float]
    page_rotations: Mapping[int, int]
    docling_tables: Sequence[Mapping[str, Any]]
    camelot: Any | None
    camelot_error: str
    warnings: list[str] = field(default_factory=list)
    diagnostics: list[dict[str, Any]] = field(default_factory=list)

    def warn_once(self, warning: str) -> None:
        if warning not in self.warnings:
            self.warnings.append(warning)

    def geometry_enabled(self, page_number: int) -> bool:
        return self.page_rotations.get(page_number, 0) % 360 == 0


def _cell_bbox_grid(
    table: Any, n_rows: int, n_cols: int
) -> list[list[BBoxTuple | None]]:
    grid: list[list[BBoxTuple | None]] = [[None] * n_cols for _ in range(n_rows)]
    try:
        for row_index, row in enumerate((getattr(table, "cells", None) or ())[:n_rows]):
            for col_index, cell in enumerate(row[:n_cols]):
                coords = tuple(
                    getattr(cell, name, None) for name in ("x1", "y1", "x2", "y2")
                )
                if None not in coords:
                    grid[row_index][col_index] = _coerce_bbox(coords)
    except Exception:
        logger.exception("Failed to harvest camelot cell bboxes")
    return grid


def _candidate_extent(matrix: list[list[str]], start: int) -> tuple[int, int]:
    """Return (end, data_row_count) for the candidate run beginning at ``start``."""
    cursor = start
    data_rows = 0
    while cursor < len(matrix) and any(matrix[cursor]):
        row = matrix[cursor]
        if cursor > start and (_is_prose_row(row) or _is_header_like_row(row)):
            break
        data_rows += int(_is_table_data_row(row))
        cursor += 1
    return cursor, data_rows


def _candidate_runs(matrix: list[list[str]]) -> list[tuple[int, int]]:
    """Find table-shaped row runs inside Camelot's often broad stream regions."""
    runs: list[tuple[int, int]] = []
    cursor = 0
    while cursor < len(matrix):
        row = matrix[cursor]
        if not (_is_header_like_row(row) or _is_table_data_row(row)):
            cursor += 1
            continue
        start = cursor
        cursor, data_rows = _candidate_extent(matrix, start)
        segment = matrix[start:cursor]
        single_header = len(segment) == 1 and _is_header_like_row(segment[0])
        if (data_rows or single_header) and is_matrixlike(
            segment, min_rows=1, min_cols=1
        ):
            runs.append((start, cursor))
    return runs


def _segment_bbox(
    cell_bboxes: Sequence[Sequence[BBoxTuple | None]],
    fallback: BBoxTuple | None,
) -> BBoxTuple | None:
    values = [bbox for row in cell_bboxes for bbox in row if bbox is not None]
    if not values:
        return fallback
    return (
        min(value[0] for value in values),
        min(value[1] for value in values),
        max(value[2] for value in values),
        max(value[3] for value in values),
    )


def _camelot_matrix(table: Any, extraction: _Extraction) -> list[list[str]] | None:
    try:
        return _normalise_camelot_matrix(
            table.df.values.tolist(),
            table.df.isna().values.tolist(),
        )
    except Exception:
        extraction.warnings.append("camelot_table_matrix_unavailable")
        return None


def _camelot_page_number(table: Any, extraction: _Extraction) -> int | None:
    try:
        page_number = int(getattr(table, "page", 0) or 0)
    except (TypeError, ValueError):
        page_number = 0
    if page_number < 1:
        extraction.warnings.append("table_without_page_number_skipped")
        return None
    return page_number


def _camelot_segments(
    table: Any,
    matrix: list[list[str]],
    runs: Sequence[tuple[int, int]],
    page_number: int,
    extraction: _Extraction,
    region_index: int,
) -> list[ParsedTable]:
    """Convert each table-shaped row run of one Camelot region into a table."""
    grid = _cell_bbox_grid(table, len(matrix), len(matrix[0]) if matrix else 0)
    raw_bbox = _coerce_bbox(
        getattr(table, "_bbox", None) or getattr(table, "bbox", None)
    )
    geometry_enabled = extraction.geometry_enabled(page_number)
    segments: list[ParsedTable] = []
    for start, end in runs:
        segment_bboxes = grid[start:end]
        segment = _parsed_table_from_matrix(
            matrix[start:end],
            _TableBuildContext(
                page_number=page_number,
                table_index=len(segments) + 1,
                page_height_pt=extraction.page_heights_pt.get(page_number),
                cell_bboxes=segment_bboxes,
                table_bbox=_segment_bbox(segment_bboxes, raw_bbox),
                geometry_enabled=geometry_enabled,
            ),
        )
        if segment.cells:
            # Camelot has no Docling ``#/tables/N`` identity.  Preserve the
            # actual capture-local region/segment identity instead, so a
            # validated no-inventory fallback can be published as explicitly
            # Camelot-attributed Evidence without masquerading as producer
            # observations from another parser.
            segments.append(
                segment.model_copy(
                    update={
                        "producer_ref": (
                            f"camelot://page/{page_number}/region/{region_index}"
                            f"/segment/{len(segments) + 1}"
                        ),
                        "producer_order": region_index - 1,
                    }
                )
            )
    return segments


def _camelot_tables(found: Sequence[Any], extraction: _Extraction) -> list[ParsedTable]:
    """Segment Camelot stream regions into canonical tables."""
    tables: list[ParsedTable] = []
    warned_rotations: set[int] = set()
    for region_index, table in enumerate(found, start=1):
        matrix = _camelot_matrix(table, extraction)
        if matrix is None:
            continue
        page_number = _camelot_page_number(table, extraction)
        if page_number is None:
            continue
        runs = _candidate_runs(matrix)
        if runs and not extraction.geometry_enabled(page_number):
            if page_number not in warned_rotations:
                extraction.warnings.append(ROTATED_TABLE_GEOMETRY_WARNING)
            warned_rotations.add(page_number)
        tables.extend(
            _camelot_segments(
                table, matrix, runs, page_number, extraction, region_index
            )
        )
    return _deduplicate_tables(tables)


# --------------------------------------------------------------------------- #
# Camelot enrichment of Docling inventory tables
# --------------------------------------------------------------------------- #


def _parsed_table_matrix(table: ParsedTable) -> list[list[str]]:
    rows = table.rows or 0
    cols = table.cols or 0
    matrix = [[""] * cols for _ in range(rows)]
    for cell in table.cells:
        if 0 <= cell.row < rows and 0 <= cell.col < cols:
            matrix[cell.row][cell.col] = " ".join(cell.text.split())
    return matrix


def _is_safe_enrichment_target(table: ParsedTable) -> bool:
    header_rows = {cell.row for cell in table.cells if cell.role == "header"}
    return header_rows in (set(), {0}) and all(
        cell.rowspan == 1 and cell.colspan == 1 for cell in table.cells
    )


def _cell_structure_signature(
    table: ParsedTable,
) -> dict[CellPosition, tuple[str | None, int, int]]:
    return {
        (cell.row, cell.col): (cell.role, cell.rowspan, cell.colspan)
        for cell in table.cells
    }


def _boxed_cells(table: ParsedTable) -> dict[CellPosition, BoundingBox]:
    return {
        (cell.row, cell.col): cell.bbox for cell in table.cells if cell.bbox is not None
    }


def _is_demonstrable_camelot_improvement(
    inventory: ParsedTable, candidate: ParsedTable
) -> bool:
    """Accept only structure-preserving, monotonic geometry enrichment."""
    same_structure = all(
        (
            inventory.page_number == candidate.page_number,
            _is_safe_enrichment_target(inventory),
            _is_safe_enrichment_target(candidate),
            _parsed_table_matrix(inventory) == _parsed_table_matrix(candidate),
            _cell_structure_signature(inventory)
            == _cell_structure_signature(candidate),
            _intersection_over_union(inventory.bbox, candidate.bbox)
            >= _ENRICHMENT_OVERLAP,
        )
    )
    if not same_structure:
        return False
    inventory_boxes = _boxed_cells(inventory)
    candidate_boxes = _boxed_cells(candidate)
    return set(inventory_boxes) < set(candidate_boxes) and all(
        _intersection_over_union(inventory_bbox, candidate_boxes[coordinate])
        >= _ENRICHMENT_OVERLAP
        for coordinate, inventory_bbox in inventory_boxes.items()
    )


def _merge_enriched_geometry(
    inventory: ParsedTable, candidate: ParsedTable
) -> ParsedTable:
    """Fill missing inventory boxes without replacing verified Docling geometry."""
    candidate_boxes = _boxed_cells(candidate)
    cells = [
        cell.model_copy(update={"bbox": candidate_boxes[(cell.row, cell.col)]})
        if cell.bbox is None and (cell.row, cell.col) in candidate_boxes
        else cell
        for cell in inventory.cells
    ]
    return inventory.model_copy(
        update={
            # Docling remains authoritative for semantic content and
            # structure. Camelot contributes geometry only; preserve the
            # inventory parser identity so a Camelot candidate can never be
            # mistaken for a publishable canonical table.
            "source_parser": inventory.source_parser,
            "geometry_parser": candidate.source_parser or "camelot_stream",
            "cells": cells,
        }
    )


def _enrichment_candidates(
    inventory_tables: Sequence[ParsedTable], extraction: _Extraction
) -> list[ParsedTable]:
    """Re-read each inventory page with Camelot constrained to known table areas."""
    candidates: list[ParsedTable] = []
    for page_number in sorted({table.page_number for table in inventory_tables}):
        page_height = extraction.page_heights_pt.get(page_number)
        if page_height is None or not extraction.geometry_enabled(page_number):
            continue
        areas = [
            f"{table.bbox.x0},{page_height - table.bbox.y0},"
            f"{table.bbox.x1},{page_height - table.bbox.y1}"
            for table in inventory_tables
            if table.page_number == page_number
            and table.bbox is not None
            and _is_safe_enrichment_target(table)
        ]
        if not areas:
            continue
        camelot = extraction.camelot
        if camelot is None:
            continue
        try:
            found = list(
                camelot.read_pdf(
                    str(extraction.source_pdf),
                    pages=str(page_number),
                    flavor="stream",
                    table_areas=areas,
                )
            )
        except Exception:
            logger.exception("Constrained Camelot table enrichment failed")
            extraction.warn_once("camelot_inventory_enrichment_failed")
            continue
        try:
            candidates.extend(_camelot_tables(found, extraction))
        finally:
            del found
            gc.collect()
    return candidates


def _enrich_inventory_tables(
    inventory_tables: Sequence[ParsedTable], extraction: _Extraction
) -> tuple[list[ParsedTable], int]:
    candidates = _enrichment_candidates(inventory_tables, extraction)
    available = list(candidates)
    reconciled: list[ParsedTable] = []
    for inventory in inventory_tables:
        eligible = [
            (len(_boxed_cells(candidate)) - len(_boxed_cells(inventory)), -index)
            for index, candidate in enumerate(available)
            if _is_demonstrable_camelot_improvement(inventory, candidate)
        ]
        best = max(eligible, default=None)
        if best is None:
            reconciled.append(inventory)
            extraction.diagnostics.append(
                {
                    "code": "camelot_candidate_rejected",
                    "page_number": inventory.page_number,
                    "table_id": inventory.table_id,
                }
            )
        else:
            candidate = available.pop(-best[1])
            reconciled.append(_merge_enriched_geometry(inventory, candidate))
    return reconciled, len(candidates)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def _load_camelot() -> tuple[Any | None, str]:
    try:
        return importlib.import_module("camelot"), "table_extraction_failed"
    except ModuleNotFoundError:
        return None, "table_extraction_unavailable"
    except Exception:
        return None, "table_extraction_failed"


def _inventory_tables(extraction: _Extraction) -> list[ParsedTable]:
    return [
        table
        for index, inventory in enumerate(extraction.docling_tables, start=1)
        if (
            table := _docling_table_to_parsed_table(
                inventory, index, extraction.page_heights_pt
            )
        )
        is not None
    ]


def _read_all_camelot(extraction: _Extraction) -> list[Any] | None:
    if extraction.camelot is None:
        return None
    try:
        return list(
            extraction.camelot.read_pdf(
                str(extraction.source_pdf), pages="all", flavor="stream"
            )
        )
    except Exception:
        logger.exception("Camelot table extraction failed")
        return None


def extract_tables(
    source_pdf: Path,
    content_sha256: str,
    page_heights_pt: dict[int, float],
    page_rotations: Mapping[int, int] | None = None,
    docling_tables: Sequence[Mapping[str, Any]] = (),
) -> TableExtractionOutput:
    """Extract all available tables, preferring Docling's bounded inventory."""
    del content_sha256  # provenance is recorded by the caller's ParserRun
    started_at = utc_now()
    start_time = time.time()
    camelot, camelot_error = _load_camelot()
    extraction = _Extraction(
        source_pdf=source_pdf,
        page_heights_pt=page_heights_pt,
        page_rotations=page_rotations or {},
        docling_tables=docling_tables,
        camelot=camelot,
        camelot_error=camelot_error,
    )

    inventory_tables = _inventory_tables(extraction)
    if inventory_tables:
        candidates = 0
        reconciled = inventory_tables
        if camelot is None:
            extraction.warnings.append("camelot_inventory_enrichment_unavailable")
        else:
            reconciled, candidates = _enrich_inventory_tables(
                inventory_tables, extraction
            )
        tables = _assign_table_ids(_deduplicate_tables(reconciled))
        metrics = {
            "tables_found": len(inventory_tables),
            "tables_kept": len(tables),
            "docling_tables": len(inventory_tables),
            "camelot_candidates": candidates,
        }
        parser = TABLE_PIPELINE_NAME
    else:
        found = _read_all_camelot(extraction)
        if found is None:
            logger.error(
                "Camelot table extraction dependency is unavailable"
                if camelot_error == "table_extraction_unavailable"
                else "Camelot table extraction failed"
            )
            return TableExtractionOutput(
                status="failed",
                started_at=started_at,
                finished_at=utc_now(),
                duration_ms=duration_ms(start_time),
                warnings=extraction.warnings,
                diagnostics=extraction.diagnostics,
                error=camelot_error,
            )
        # Camelot has no reviewed semantic authority without a Docling
        # inventory. Keep candidate counts and diagnostics internal, but do
        # not publish Camelot-only canonical tables.
        camelot_candidates = _camelot_tables(found, extraction)
        found_count = len(found)
        # Camelot's parser graph can retain the PDF handle until cyclic GC.
        del found
        gc.collect()
        extraction.diagnostics.append(
            {
                "code": "camelot_only_tables_excluded",
                "count": len(camelot_candidates),
            }
        )
        tables = []
        metrics = {
            "tables_found": found_count,
            "tables_kept": 0,
            "camelot_candidates": len(camelot_candidates),
        }
        parser = TABLE_PARSER_NAME

    return TableExtractionOutput(
        parser=parser,
        status="success",
        started_at=started_at,
        finished_at=utc_now(),
        duration_ms=duration_ms(start_time),
        tables=tables,
        metrics=metrics,
        warnings=extraction.warnings,
        diagnostics=extraction.diagnostics,
    )
