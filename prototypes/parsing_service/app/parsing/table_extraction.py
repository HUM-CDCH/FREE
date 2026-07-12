"""Canonical table extraction and reconciliation.

Docling supplies the table inventory because its document model preserves table
boundaries, spans, roles, and provenance. Camelot's stream parser remains the
optional enrichment/fallback path for environments or documents where Docling
does not expose a usable table inventory.

All published geometry uses PDF points with a top-left origin in displayed page
space. Camelot geometry is intentionally withheld on rotated pages until a
complete rotation transform is independently verified.
"""

from __future__ import annotations

import datetime
import importlib
import logging
import math
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.models.parsed_document import BoundingBox, ParsedTable, TableCell

logger = logging.getLogger(__name__)

TABLE_PARSER_NAME = "camelot_stream"
DOCLING_TABLE_PARSER_NAME = "docling_table"
TABLE_PIPELINE_NAME = "docling_inventory_camelot_fallback"
ROTATED_TABLE_GEOMETRY_WARNING = "rotated_table_geometry_suppressed"

BBoxTuple = tuple[float, float, float, float]
CellPosition = tuple[int, int]
CellSpan = tuple[int, int]


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
    error: str | None = None


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _duration_ms(start: float) -> int:
    try:
        return int((time.time() - start) * 1000)
    except (OverflowError, ValueError):
        return 0


def _norm_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    if text.lower() == "nan":
        return ""
    return " ".join(text.replace("\u00a0", " ").split()).strip()


def _normalise_matrix(matrix: Sequence[Sequence[Any]]) -> list[list[str]]:
    rows = [[_norm_cell(value) for value in row] for row in matrix]
    width = max((len(row) for row in rows), default=0)
    return [row + [""] * (width - len(row)) for row in rows]


def _is_numbery(text: str) -> bool:
    if not text:
        return False
    digits = sum(ch.isdigit() for ch in text)
    return digits >= max(2, len(text) // 4) or any(
        token in text for token in ["±", "%", "cm", "mg", "kg", "°", "µ", "μ", "/"]
    )


def _word_count(text: str) -> int:
    return len(text.split())


def _is_sentence_like(text: str) -> bool:
    if not text:
        return False
    words = _word_count(text)
    return words >= 10 or (words >= 8 and any(ch in text for ch in ".;:"))


def _looks_like_identifier(text: str) -> bool:
    if not text:
        return False
    text = _norm_cell(text)
    if not text or len(text) > 24 or _word_count(text) > 3:
        return False
    if text.endswith(".") and not any(ch.isdigit() for ch in text):
        return False
    compact = text.replace(" ", "")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", compact):
        if any(ch.isdigit() for ch in compact):
            return True
        if any(ch in compact for ch in "-_/"):
            return True
        if compact.isalpha() and compact[0].isupper() and len(compact) <= 8:
            return True
    return False


def _is_prose_row(row: Sequence[str]) -> bool:
    nonempty = [cell for cell in row if cell]
    return len(nonempty) == 1 and _is_sentence_like(nonempty[0])


def _is_header_like_row(row: Sequence[str], min_cols: int = 2) -> bool:
    nonempty = [cell for cell in row if cell]
    if len(nonempty) < min_cols or any(_is_sentence_like(cell) for cell in nonempty):
        return False
    first = nonempty[0]
    if _looks_like_identifier(first) and (
        any(ch.isdigit() for ch in first) or any(ch in "-_/" for ch in first)
    ):
        return False
    texty = sum(1 for cell in nonempty if not _is_numbery(cell))
    return texty >= max(2, len(nonempty) - 1)


def _is_table_data_row(row: Sequence[str]) -> bool:
    nonempty = [cell for cell in row if cell]
    if len(nonempty) < 2 or _is_prose_row(row):
        return False
    if _looks_like_identifier(nonempty[0]):
        return True
    return any(_is_numbery(cell) for cell in nonempty)


def _is_dense_row(row: Sequence[str], min_cols: int) -> bool:
    return sum(1 for cell in row if cell) >= max(1, min_cols - 1)


def _is_identifier_list_table(
    matrix: list[list[str]], min_rows: int = 1, min_cols: int = 1
) -> bool:
    """Recognize identifier/data tables without imposing a four-row minimum."""
    rows = len(matrix)
    cols = len(matrix[0]) if matrix else 0
    if rows < min_rows or cols < min_cols:
        return False

    header_index = next(
        (
            index
            for index, row in enumerate(matrix[: min(rows, 8)])
            if _is_header_like_row(row)
        ),
        None,
    )
    data_rows = matrix[header_index + 1 :] if header_index is not None else matrix
    structured = [row for row in data_rows if _is_table_data_row(row)]
    identifiers = [
        row
        for row in structured
        if row and _looks_like_identifier(next((c for c in row if c), ""))
    ]
    if not structured or len(identifiers) * 2 < len(structured):
        return False
    return not any(_is_prose_row(row) for row in structured)


def is_matrixlike(
    matrix: list[list[str]], min_rows: int = 1, min_cols: int = 1
) -> bool:
    """Return whether a matrix contains table-shaped data rather than prose."""
    matrix = _normalise_matrix(matrix)
    rows = len(matrix)
    cols = len(matrix[0]) if matrix else 0
    if rows < min_rows or cols < min_cols:
        return False

    nonempty = [cell for row in matrix for cell in row if cell]
    if not nonempty or all(_is_prose_row(row) for row in matrix):
        return False

    table_rows = sum(
        1 for row in matrix if _is_header_like_row(row) or _is_table_data_row(row)
    )
    if table_rows == 0:
        return False
    if rows == 1:
        return _is_table_data_row(matrix[0]) or _is_header_like_row(matrix[0])
    if _is_identifier_list_table(matrix, min_rows=min_rows, min_cols=min_cols):
        return True

    digit_cells = sum(1 for cell in nonempty if any(ch.isdigit() for ch in cell))
    digit_ratio = digit_cells / len(nonempty)
    dense_rows = sum(1 for row in matrix if _is_dense_row(row, min_cols))
    return digit_ratio >= 0.18 and dense_rows >= min(2, rows)


def _guess_header_rows(matrix: list[list[str]], max_header_rows: int = 1) -> list[int]:
    """Identify one explicit header row, never an identifier data row."""
    if not matrix or max_header_rows < 1:
        return []
    return [0] if _is_header_like_row(matrix[0]) else []


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
        or any(
            keyword in cell_text.lower()
            for keyword in [
                "mg/ml",
                "mg/",
                "content",
                "recovery",
                "yield",
                "protein",
                "hydroxyproline",
            ]
        )
        or "(" in cell_text
        or "/" in cell_text
    )


def _is_column_header(matrix: list[list[str]], r: int, c: int, n_rows: int) -> bool:
    if r >= 4:
        return False
    cell_text = matrix[r][c]
    if not cell_text or _is_numbery(cell_text):
        return False
    has_data_below = any(
        matrix[check_r][c] and _is_numbery(matrix[check_r][c])
        for check_r in range(r + 1, min(r + 5, n_rows))
    )
    if c > 0 and has_data_below:
        return sum(1 for cell in matrix[r] if cell and not _is_numbery(cell)) >= 2
    return False


def _coerce_bbox(raw: Any) -> BBoxTuple | None:
    try:
        values = tuple(float(value) for value in raw)
    except (TypeError, ValueError):
        return None
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        return None
    return values  # type: ignore[return-value]


def _bbox_topleft(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    page_height_pt: float | None,
    *,
    origin: str = "bottomleft",
    geometry_enabled: bool = True,
) -> BoundingBox | None:
    if not geometry_enabled:
        return None
    values = _coerce_bbox((x0, y0, x1, y1))
    if values is None:
        return None
    x0, y0, x1, y1 = values
    if origin.lower() in {"bottomleft", "bottom_left", "bottom-left"}:
        if page_height_pt is None:
            return None
        y0, y1 = page_height_pt - y1, page_height_pt - y0
    if (
        x0 > x1
        or y0 > y1
        or not all(math.isfinite(value) for value in (x0, y0, x1, y1))
    ):
        return None
    try:
        return BoundingBox(x0=x0, y0=y0, x1=x1, y1=y1)
    except ValueError:
        return None


def _markdown_view(matrix: list[list[str]], header_rows: list[int]) -> str:
    if not matrix:
        return ""

    def row_line(row: list[str]) -> str:
        return "| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |"

    n_cols = len(matrix[0]) if matrix else 0
    separator_after = header_rows[-1] if header_rows else 0
    lines: list[str] = []
    for r, row in enumerate(matrix):
        lines.append(row_line(row))
        if r == separator_after:
            lines.append("| " + " | ".join("---" for _ in range(n_cols)) + " |")
    return "\n".join(lines)


def _safe_spans(
    matrix: list[list[str]], cell_spans: Mapping[CellPosition, CellSpan] | None
) -> dict[CellPosition, CellSpan]:
    if not cell_spans:
        return {}
    rows = len(matrix)
    cols = len(matrix[0]) if matrix else 0
    occupied: set[CellPosition] = set()
    accepted: dict[CellPosition, CellSpan] = {}
    for (row, col), raw_span in sorted(cell_spans.items()):
        try:
            rowspan, colspan = int(raw_span[0]), int(raw_span[1])
        except (TypeError, ValueError, IndexError):
            continue
        if row < 0 or col < 0 or rowspan < 1 or colspan < 1:
            continue
        covered = {
            (covered_row, covered_col)
            for covered_row in range(row, row + rowspan)
            for covered_col in range(col, col + colspan)
        }
        if any(
            covered_row >= rows or covered_col >= cols
            for covered_row, covered_col in covered
        ):
            continue
        if any(
            position != (row, col) and matrix[position[0]][position[1]]
            for position in covered
        ):
            continue
        if occupied.intersection(covered):
            continue
        accepted[(row, col)] = (rowspan, colspan)
        occupied.update(covered)
    return accepted


def table_matrix_to_parsed_table(
    matrix: list[list[str]],
    *,
    page_number: int,
    table_index: int,
    page_height_pt: float | None,
    cell_bboxes: list[list[BBoxTuple | None]] | None = None,
    table_bbox: BBoxTuple | None = None,
    geometry_enabled: bool = True,
    bbox_origin: str = "bottomleft",
    source_parser: str = TABLE_PARSER_NAME,
    cell_spans: Mapping[CellPosition, CellSpan] | None = None,
    cell_roles: Mapping[CellPosition, str | None] | None = None,
    header_rows: list[int] | None = None,
) -> ParsedTable:
    """Convert a matrix into the canonical table shape.

    Spans are accepted only from explicit parser metadata. Empty neighboring
    strings never imply a merge.
    """
    matrix = _normalise_matrix(matrix)
    n_rows = len(matrix)
    n_cols = len(matrix[0]) if n_rows else 0
    header_rows = _guess_header_rows(matrix) if header_rows is None else header_rows
    safe_spans = _safe_spans(matrix, cell_spans)
    cells: list[TableCell] = []

    for row in range(n_rows):
        for col in range(n_cols):
            text = matrix[row][col]
            if not text:
                continue
            rowspan, colspan = safe_spans.get((row, col), (1, 1))
            role = cell_roles.get((row, col)) if cell_roles else None
            if role is None:
                if row in header_rows:
                    role = "header"
                elif _is_column_header(matrix, row, col, n_rows):
                    role = "column_header"
                elif _is_row_header(matrix, row, col, n_cols, header_rows):
                    role = "row_header"
                elif col == 0 and not _is_numbery(text):
                    role = "row_header_hint"
                else:
                    role = "data"

            bbox = None
            if (
                cell_bboxes is not None
                and row < len(cell_bboxes)
                and col < len(cell_bboxes[row])
            ):
                raw = cell_bboxes[row][col]
                if raw is not None:
                    bbox = _bbox_topleft(
                        *raw,
                        page_height_pt,
                        origin=bbox_origin,
                        geometry_enabled=geometry_enabled,
                    )
            cells.append(
                TableCell(
                    row=row,
                    col=col,
                    text=text,
                    role=role,
                    rowspan=rowspan,
                    colspan=colspan,
                    bbox=bbox,
                )
            )

    bbox = None
    if table_bbox is not None:
        bbox = _bbox_topleft(
            *table_bbox,
            page_height_pt,
            origin=bbox_origin,
            geometry_enabled=geometry_enabled,
        )
    return ParsedTable(
        table_id=f"p{page_number:02d}_t{table_index:02d}",
        page_number=page_number,
        source_parser=source_parser,
        bbox=bbox,
        rows=n_rows,
        cols=n_cols,
        cells=cells,
        markdown_view=_markdown_view(matrix, header_rows),
    )


def _inventory_bbox(
    raw: Any, page_height_pt: float | None, geometry_enabled: bool
) -> BBoxTuple | None:
    if not isinstance(raw, Mapping):
        return None
    values = _coerce_bbox((raw.get("x0"), raw.get("y0"), raw.get("x1"), raw.get("y1")))
    if values is None:
        return None
    origin = str(raw.get("origin") or "TOPLEFT").upper()
    if "BOTTOM" in origin:
        if page_height_pt is None:
            return None
        values = (
            values[0],
            page_height_pt - values[3],
            values[2],
            page_height_pt - values[1],
        )
    if not geometry_enabled or values[0] > values[2] or values[1] > values[3]:
        return None
    return values


def _docling_table_to_parsed_table(
    inventory: Mapping[str, Any],
    *,
    table_index: int,
    page_heights_pt: Mapping[int, float],
) -> ParsedTable | None:
    try:
        page_number = int(inventory.get("page_number", 0))
        rows = max(0, int(inventory.get("rows", 0)))
        cols = max(0, int(inventory.get("cols", 0)))
    except (TypeError, ValueError):
        return None
    if page_number < 1 or rows < 1 or cols < 1:
        return None
    raw_cells = inventory.get("cells")
    if not isinstance(raw_cells, Sequence):
        return None

    matrix = [[""] * cols for _ in range(rows)]
    spans: dict[CellPosition, CellSpan] = {}
    roles: dict[CellPosition, str | None] = {}
    cell_bboxes: list[list[BBoxTuple | None]] = [[None] * cols for _ in range(rows)]
    header_rows: set[int] = set()
    page_height = page_heights_pt.get(page_number)
    for raw_cell in raw_cells:
        if not isinstance(raw_cell, Mapping):
            continue
        try:
            row = int(raw_cell.get("row", -1))
            col = int(raw_cell.get("col", -1))
        except (TypeError, ValueError):
            continue
        if not (0 <= row < rows and 0 <= col < cols):
            continue
        text = _norm_cell(raw_cell.get("text"))
        matrix[row][col] = text
        try:
            rowspan = max(1, int(raw_cell.get("rowspan", 1)))
            colspan = max(1, int(raw_cell.get("colspan", 1)))
        except (TypeError, ValueError):
            rowspan, colspan = 1, 1
        spans[(row, col)] = (rowspan, colspan)
        role = str(raw_cell.get("role") or "data")
        roles[(row, col)] = role
        if role in {"header", "column_header"}:
            header_rows.add(row)
        cell_bboxes[row][col] = _inventory_bbox(raw_cell.get("bbox"), page_height, True)

    table_bbox = _inventory_bbox(inventory.get("bbox"), page_height, True)
    table = table_matrix_to_parsed_table(
        matrix,
        page_number=page_number,
        table_index=table_index,
        page_height_pt=page_height,
        cell_bboxes=cell_bboxes,
        table_bbox=table_bbox,
        bbox_origin="topleft",
        source_parser=DOCLING_TABLE_PARSER_NAME,
        cell_spans=spans,
        cell_roles=roles,
        header_rows=sorted(header_rows),
    )
    return table if table.cells else None


def _cell_bbox_grid(
    table: Any, n_rows: int, n_cols: int
) -> list[list[BBoxTuple | None]]:
    grid: list[list[BBoxTuple | None]] = [[None] * n_cols for _ in range(n_rows)]
    try:
        camelot_cells = getattr(table, "cells", None)
        if camelot_cells:
            for row_index in range(min(n_rows, len(camelot_cells))):
                row = camelot_cells[row_index]
                for col_index in range(min(n_cols, len(row))):
                    cell = row[col_index]
                    coords = tuple(
                        getattr(cell, name, None) for name in ("x1", "y1", "x2", "y2")
                    )
                    if None in coords:
                        continue
                    values = _coerce_bbox(coords)
                    if values is not None:
                        grid[row_index][col_index] = values
    except Exception:
        logger.exception("Failed to harvest camelot cell bboxes")
    return grid


def _candidate_runs(matrix: list[list[str]]) -> list[tuple[int, int]]:
    """Find table-shaped row runs inside Camelot's often broad stream regions."""
    runs: list[tuple[int, int]] = []
    index = 0
    while index < len(matrix):
        starts = _is_header_like_row(matrix[index]) or _is_table_data_row(matrix[index])
        if not starts:
            index += 1
            continue
        start = index
        data_rows = 0
        while index < len(matrix):
            row = matrix[index]
            if index > start and (_is_prose_row(row) or _is_header_like_row(row)):
                break
            if not any(row):
                break
            if _is_table_data_row(row):
                data_rows += 1
            index += 1
        segment = matrix[start:index]
        single_header = len(segment) == 1 and _is_header_like_row(segment[0])
        if (data_rows or single_header) and is_matrixlike(
            segment, min_rows=1, min_cols=1
        ):
            runs.append((start, index))
        if index == start:
            index += 1
    return runs


def _segment_bbox(
    cell_bboxes: list[list[BBoxTuple | None]],
    start: int,
    end: int,
    fallback: BBoxTuple | None,
) -> BBoxTuple | None:
    values = [
        bbox for row in cell_bboxes[start:end] for bbox in row if bbox is not None
    ]
    if not values:
        return fallback
    return (
        min(value[0] for value in values),
        min(value[1] for value in values),
        max(value[2] for value in values),
        max(value[3] for value in values),
    )


def _table_fingerprint(
    table: ParsedTable,
) -> tuple[int, int | None, int | None, tuple[tuple[int, int, str], ...]]:
    return (
        table.page_number,
        table.rows,
        table.cols,
        tuple(
            (cell.row, cell.col, _norm_cell(cell.text).casefold())
            for cell in table.cells
            if cell.text
        ),
    )


def _content_overlap(first: ParsedTable, second: ParsedTable) -> float:
    first_cells = {
        (cell.row, cell.col, _norm_cell(cell.text).casefold())
        for cell in first.cells
        if cell.text
    }
    second_cells = {
        (cell.row, cell.col, _norm_cell(cell.text).casefold())
        for cell in second.cells
        if cell.text
    }
    if not first_cells or not second_cells:
        return 0.0
    return len(first_cells.intersection(second_cells)) / min(
        len(first_cells), len(second_cells)
    )


def _overlap_ratio(first: BoundingBox | None, second: BoundingBox | None) -> float:
    if first is None or second is None:
        return 0.0
    intersection = max(0.0, min(first.x1, second.x1) - max(first.x0, second.x0)) * max(
        0.0, min(first.y1, second.y1) - max(first.y0, second.y0)
    )
    first_area = max(0.0, first.x1 - first.x0) * max(0.0, first.y1 - first.y0)
    second_area = max(0.0, second.x1 - second.x0) * max(0.0, second.y1 - second.y0)
    return intersection / max(1e-9, min(first_area, second_area))


def _deduplicate_tables(tables: list[ParsedTable]) -> list[ParsedTable]:
    kept: list[ParsedTable] = []
    fingerprints: set[
        tuple[int, int | None, int | None, tuple[tuple[int, int, str], ...]]
    ] = set()
    for table in tables:
        fingerprint = _table_fingerprint(table)
        if fingerprint in fingerprints:
            continue
        if any(
            prior.page_number == table.page_number
            and _content_overlap(prior, table) >= 0.8
            and _overlap_ratio(prior.bbox, table.bbox) >= 0.8
            for prior in kept
        ):
            continue
        fingerprints.add(fingerprint)
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
        counters[table.page_number] = counters.get(table.page_number, 0) + 1
        result.append(
            table.model_copy(
                update={
                    "table_id": f"p{table.page_number:02d}_t{counters[table.page_number]:02d}"
                }
            )
        )
    return result


def _camelot_tables(
    found: Sequence[Any],
    *,
    page_heights_pt: Mapping[int, float],
    page_rotations: Mapping[int, int],
    warnings: list[str],
) -> list[ParsedTable]:
    tables: list[ParsedTable] = []
    warned_rotations: set[int] = set()
    for table in found:
        try:
            matrix = _normalise_matrix(table.df.values.tolist())
        except Exception:
            warnings.append("camelot_table_matrix_unavailable")
            continue
        try:
            page_number = int(getattr(table, "page", 0) or 0)
        except (TypeError, ValueError):
            page_number = 0
        if page_number < 1:
            warnings.append("table_without_page_number_skipped")
            continue
        runs = _candidate_runs(matrix)
        full_bboxes = _cell_bbox_grid(
            table, len(matrix), len(matrix[0]) if matrix else 0
        )
        raw_bbox = _coerce_bbox(
            getattr(table, "_bbox", None) or getattr(table, "bbox", None)
        )
        rotation = page_rotations.get(page_number, 0) % 360
        geometry_enabled = rotation == 0
        if not geometry_enabled and runs and page_number not in warned_rotations:
            warnings.append(ROTATED_TABLE_GEOMETRY_WARNING)
            warned_rotations.add(page_number)
        for start, end in runs:
            segment_bboxes = full_bboxes[start:end]
            segment = table_matrix_to_parsed_table(
                matrix[start:end],
                page_number=page_number,
                table_index=len(tables) + 1,
                page_height_pt=page_heights_pt.get(page_number),
                cell_bboxes=segment_bboxes,
                table_bbox=_segment_bbox(
                    segment_bboxes, 0, len(segment_bboxes), raw_bbox
                ),
                geometry_enabled=geometry_enabled,
            )
            if segment.cells:
                tables.append(segment)
    return _deduplicate_tables(tables)


def _parsed_table_matrix(table: ParsedTable) -> list[list[str]]:
    rows = table.rows or 0
    cols = table.cols or 0
    matrix = [["" for _ in range(cols)] for _ in range(rows)]
    for cell in table.cells:
        if 0 <= cell.row < rows and 0 <= cell.col < cols:
            matrix[cell.row][cell.col] = " ".join(cell.text.split())
    return matrix


def _is_safe_enrichment_target(table: ParsedTable) -> bool:
    header_rows = {cell.row for cell in table.cells if cell.role == "header"}
    return header_rows in (set(), {0}) and all(
        cell.rowspan == 1 and cell.colspan == 1 for cell in table.cells
    )


def _camelot_table_areas(
    tables: Sequence[ParsedTable], page_height_pt: float
) -> list[str]:
    areas: list[str] = []
    for table in tables:
        if table.bbox is None:
            continue
        areas.append(
            f"{table.bbox.x0},{page_height_pt - table.bbox.y0},"
            f"{table.bbox.x1},{page_height_pt - table.bbox.y1}"
        )
    return areas


def _enrich_inventory_tables(
    *,
    camelot: Any,
    source_pdf: Path,
    inventory_tables: Sequence[ParsedTable],
    page_heights_pt: Mapping[int, float],
    page_rotations: Mapping[int, int],
    warnings: list[str],
) -> tuple[list[ParsedTable], int]:
    candidates: list[ParsedTable] = []
    for page_number in sorted({table.page_number for table in inventory_tables}):
        if page_rotations.get(page_number, 0) % 360:
            continue
        page_tables = [
            table
            for table in inventory_tables
            if table.page_number == page_number and _is_safe_enrichment_target(table)
        ]
        page_height = page_heights_pt.get(page_number)
        if page_height is None:
            continue
        areas = _camelot_table_areas(page_tables, page_height)
        if not areas:
            continue
        try:
            found = list(
                camelot.read_pdf(
                    str(source_pdf),
                    pages=str(page_number),
                    flavor="stream",
                    table_areas=areas,
                )
            )
        except Exception:
            logger.exception("Constrained Camelot table enrichment failed")
            if "camelot_inventory_enrichment_failed" not in warnings:
                warnings.append("camelot_inventory_enrichment_failed")
            continue
        candidates.extend(
            _camelot_tables(
                found,
                page_heights_pt=page_heights_pt,
                page_rotations=page_rotations,
                warnings=warnings,
            )
        )

    available = list(candidates)
    reconciled: list[ParsedTable] = []
    for inventory in inventory_tables:
        inventory_matrix = _parsed_table_matrix(inventory)
        match_index = next(
            (
                index
                for index, candidate in enumerate(available)
                if candidate.page_number == inventory.page_number
                and _parsed_table_matrix(candidate) == inventory_matrix
            ),
            None,
        )
        if match_index is None or not _is_safe_enrichment_target(inventory):
            reconciled.append(inventory)
        else:
            reconciled.append(available.pop(match_index))
    return reconciled, len(candidates)


def extract_tables(
    *,
    source_pdf: Path,
    content_sha256: str,
    page_heights_pt: dict[int, float],
    page_rotations: Mapping[int, int] | None = None,
    docling_tables: Sequence[Mapping[str, Any]] = (),
) -> TableExtractionOutput:
    """Extract all available tables, preferring Docling's bounded inventory."""
    del content_sha256
    started_at = _utc_now()
    start = time.time()
    warnings: list[str] = []
    rotations = page_rotations or {}
    try:
        camelot = importlib.import_module("camelot")
    except Exception as exc:
        camelot = None
        error = (
            "table_extraction_unavailable"
            if isinstance(exc, ModuleNotFoundError)
            else "table_extraction_failed"
        )
    else:
        error = "table_extraction_failed"

    inventory_tables: list[ParsedTable] = []
    for index, inventory in enumerate(docling_tables, start=1):
        table = _docling_table_to_parsed_table(
            inventory,
            table_index=index,
            page_heights_pt=page_heights_pt,
        )
        if table is not None:
            inventory_tables.append(table)
    if inventory_tables:
        camelot_candidates = 0
        reconciled = inventory_tables
        if camelot is None:
            warnings.append("camelot_inventory_enrichment_unavailable")
        else:
            reconciled, camelot_candidates = _enrich_inventory_tables(
                camelot=camelot,
                source_pdf=source_pdf,
                inventory_tables=inventory_tables,
                page_heights_pt=page_heights_pt,
                page_rotations=rotations,
                warnings=warnings,
            )
        tables = _assign_table_ids(_deduplicate_tables(reconciled))
        return TableExtractionOutput(
            parser=TABLE_PIPELINE_NAME,
            status="success",
            started_at=started_at,
            finished_at=_utc_now(),
            duration_ms=_duration_ms(start),
            tables=tables,
            metrics={
                "tables_found": len(inventory_tables),
                "tables_kept": len(tables),
                "docling_tables": len(inventory_tables),
                "camelot_candidates": camelot_candidates,
            },
            warnings=warnings,
        )

    found: list[Any] = []
    if camelot is not None:
        try:
            found = list(
                camelot.read_pdf(str(source_pdf), pages="all", flavor="stream")
            )
        except Exception:
            logger.exception("Camelot table extraction failed")

    if found:
        tables = _assign_table_ids(
            _camelot_tables(
                found,
                page_heights_pt=page_heights_pt,
                page_rotations=rotations,
                warnings=warnings,
            )
        )
        return TableExtractionOutput(
            status="success",
            started_at=started_at,
            finished_at=_utc_now(),
            duration_ms=_duration_ms(start),
            tables=tables,
            metrics={
                "tables_found": len(found),
                "tables_kept": len(tables),
                "camelot_candidates": len(found),
            },
            warnings=warnings,
        )

    logger.error(
        "Camelot table extraction dependency is unavailable"
        if error == "table_extraction_unavailable"
        else "Camelot table extraction failed"
    )
    return TableExtractionOutput(
        status="failed",
        started_at=started_at,
        finished_at=_utc_now(),
        duration_ms=_duration_ms(start),
        warnings=warnings,
        error=error,
    )
