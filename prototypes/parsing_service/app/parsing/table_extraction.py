"""Structured table extraction via Camelot stream flavor.

Camelot reports bboxes in PDF points with a bottom-left origin; everything
emitted here is converted to the canonical BoundingBox convention (top-left
origin PDF points, displayed page space). The filtering and role heuristics
are ported from FREE-technical core/table_extraction.py, reworked to operate
on a plain string matrix so they stay pure and testable without camelot.
"""

from __future__ import annotations

import datetime
import importlib
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.models.parsed_document import BoundingBox, ParsedTable, TableCell

logger = logging.getLogger(__name__)

TABLE_PARSER_NAME = "camelot_stream"


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
    # Camelot sometimes returns 'nan' strings after astype(str).
    if text.lower() == "nan":
        return ""
    return " ".join(text.replace("\u00a0", " ").split()).strip()


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


def _is_dense_row(row: list[str], min_cols: int) -> bool:
    return sum(1 for cell in row if cell) >= min_cols - 1


def _is_header_like_row(row: list[str], min_cols: int) -> bool:
    nonempty = [cell for cell in row if cell]
    if len(nonempty) < min_cols - 1:
        return False
    if any(_is_sentence_like(cell) for cell in nonempty):
        return False
    texty = sum(1 for cell in nonempty if not _is_numbery(cell))
    return texty >= max(2, len(nonempty) - 1)


def _is_identifier_list_table(
    matrix: list[list[str]], min_rows: int = 4, min_cols: int = 3
) -> bool:
    """Accept row-oriented tables organized around an identifier/code column."""
    rows = len(matrix)
    cols = len(matrix[0]) if matrix else 0
    if rows < min_rows or cols < min_cols:
        return False

    header_row_idx = None
    for idx, row in enumerate(matrix[: min(rows, 8)]):
        if _is_header_like_row(row, min_cols=min_cols):
            header_row_idx = idx
            break
    if header_row_idx is None:
        return False

    data_rows = matrix[header_row_idx + 1 :]
    if len(data_rows) < min_rows - 1:
        return False

    structured_rows = 0
    identifier_rows = 0
    prose_like_rows = 0
    dense_rows = 0
    first_col_lengths: list[int] = []
    trailing_lengths: list[int] = []

    for row in data_rows:
        if not _is_dense_row(row, min_cols=min_cols):
            continue
        dense_rows += 1
        first = row[0] if row else ""
        trailing = [cell for cell in row[1:] if cell]
        if not first or not trailing:
            continue
        if _is_sentence_like(first) or _word_count(first) > 4:
            prose_like_rows += 1
            continue
        sentence_like_trailing = sum(1 for cell in trailing if _is_sentence_like(cell))
        if sentence_like_trailing >= 2 and not _looks_like_identifier(first):
            prose_like_rows += 1
            continue
        structured_rows += 1
        first_col_lengths.append(len(first))
        trailing_lengths.append(max(len(cell) for cell in trailing))
        if _looks_like_identifier(first):
            identifier_rows += 1

    if dense_rows < min_rows - 1 or structured_rows < min_rows - 1:
        return False
    if identifier_rows * 2 < structured_rows:
        return False
    if prose_like_rows > structured_rows:
        return False

    avg_first = sum(first_col_lengths) / len(first_col_lengths) if first_col_lengths else 0
    avg_trailing = sum(trailing_lengths) / len(trailing_lengths) if trailing_lengths else 0
    return avg_trailing > avg_first


def is_matrixlike(
    matrix: list[list[str]], min_rows: int = 4, min_cols: int = 3
) -> bool:
    """Keep numeric/text matrices and identifier lists; reject prose-as-table."""
    rows = len(matrix)
    cols = len(matrix[0]) if matrix else 0
    if rows < min_rows or cols < min_cols:
        return False

    nonempty = [cell for row in matrix for cell in row if cell]
    if len(nonempty) < min_rows * min_cols * 0.4:
        return False

    digit_cells = sum(1 for cell in nonempty if any(ch.isdigit() for ch in cell))
    digit_ratio = digit_cells / max(1, len(nonempty))
    long_cells = sum(1 for cell in nonempty if len(cell.split()) >= 12)
    dense_rows = sum(1 for row in matrix if _is_dense_row(row, min_cols))
    pm_count = sum(1 for cell in nonempty if "±" in cell)

    if digit_ratio >= 0.18 and long_cells < 3 and (pm_count > 0 or dense_rows >= min_rows):
        return True
    return _is_identifier_list_table(matrix, min_rows=min_rows, min_cols=min_cols)


def _detect_merged_cells(
    matrix: list[list[str]], r: int, c: int, n_rows: int, n_cols: int
) -> tuple[int, int]:
    """Return (rowspan, colspan) inferred from trailing empty neighbours."""
    if not matrix[r][c]:
        return 1, 1
    rowspan = 1
    for dr in range(1, n_rows - r):
        if not matrix[r + dr][c]:
            rowspan += 1
        else:
            break
    colspan = 1
    for dc in range(1, n_cols - c):
        if not matrix[r][c + dc]:
            colspan += 1
        else:
            break
    return rowspan, colspan


def _guess_header_rows(matrix: list[list[str]], max_header_rows: int = 2) -> list[int]:
    header_rows: list[int] = []
    for r, row in enumerate(matrix[:max_header_rows]):
        nonempty = [cell for cell in row if cell]
        if not nonempty:
            continue
        numbery = sum(_is_numbery(cell) for cell in nonempty)
        texty = len(nonempty) - numbery
        if texty >= numbery:
            header_rows.append(r)
        else:
            break
    return header_rows


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
    # ponytail: keyword list inherited from the reference implementation;
    # tune per corpus if role labels matter downstream.
    has_descriptive_text = (
        any(
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
    return has_data_to_right or has_descriptive_text


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
        text_cells_in_row = sum(
            1 for cell in matrix[r] if cell and not _is_numbery(cell)
        )
        return text_cells_in_row >= 2
    return False


def _bbox_topleft(
    x0: float, y_bottom: float, x1: float, y_top: float, page_height_pt: float
) -> BoundingBox:
    """Camelot bottom-left-origin (x1, y1, x2, y2) -> top-left-origin BoundingBox."""
    return BoundingBox(
        x0=x0, y0=page_height_pt - y_top, x1=x1, y1=page_height_pt - y_bottom
    )


def _markdown_view(matrix: list[list[str]], header_rows: list[int]) -> str:
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


def table_matrix_to_parsed_table(
    matrix: list[list[str]],
    *,
    page_number: int,
    table_index: int,
    page_height_pt: float | None,
    cell_bboxes: list[list[tuple[float, float, float, float] | None]] | None = None,
    table_bbox: tuple[float, float, float, float] | None = None,
) -> ParsedTable:
    """Convert a normalized string matrix (+ optional camelot geometry) to ParsedTable.

    Bboxes are emitted only when page_height_pt is known — never in raw
    bottom-left-origin coordinates.
    """
    n_rows = len(matrix)
    n_cols = len(matrix[0]) if n_rows else 0
    header_rows = _guess_header_rows(matrix)

    cells: list[TableCell] = []
    for r in range(n_rows):
        for c in range(n_cols):
            text = matrix[r][c]
            if not text:
                continue
            rowspan, colspan = _detect_merged_cells(matrix, r, c, n_rows, n_cols)
            if r in header_rows:
                role = "header"
            elif _is_column_header(matrix, r, c, n_rows):
                role = "column_header"
            elif _is_row_header(matrix, r, c, n_cols, header_rows):
                role = "row_header"
            elif c == 0 and not _is_numbery(text):
                role = "row_header_hint"
            else:
                role = "data"

            bbox = None
            if page_height_pt is not None and cell_bboxes is not None:
                raw = cell_bboxes[r][c] if r < len(cell_bboxes) and c < len(cell_bboxes[r]) else None
                if raw is not None:
                    bbox = _bbox_topleft(raw[0], raw[1], raw[2], raw[3], page_height_pt)

            cells.append(
                TableCell(
                    row=r,
                    col=c,
                    text=text,
                    role=role,
                    rowspan=rowspan,
                    colspan=colspan,
                    bbox=bbox,
                )
            )

    bbox = None
    if page_height_pt is not None and table_bbox is not None:
        bbox = _bbox_topleft(
            table_bbox[0], table_bbox[1], table_bbox[2], table_bbox[3], page_height_pt
        )

    return ParsedTable(
        table_id=f"p{page_number:02d}_t{table_index:02d}",
        page_number=page_number,
        source_parser=TABLE_PARSER_NAME,
        bbox=bbox,
        rows=n_rows,
        cols=n_cols,
        cells=cells,
        markdown_view=_markdown_view(matrix, header_rows),
    )


def _cell_bbox_grid(
    table: Any, n_rows: int, n_cols: int
) -> list[list[tuple[float, float, float, float] | None]]:
    grid: list[list[tuple[float, float, float, float] | None]] = [
        [None] * n_cols for _ in range(n_rows)
    ]
    try:
        camelot_cells = getattr(table, "cells", None)
        if camelot_cells:
            for r in range(min(n_rows, len(camelot_cells))):
                row = camelot_cells[r]
                for c in range(min(n_cols, len(row))):
                    cell = row[c]
                    coords = tuple(
                        getattr(cell, name, None) for name in ("x1", "y1", "x2", "y2")
                    )
                    if None in coords:
                        continue
                    grid[r][c] = tuple(float(v) for v in coords)
    except Exception:  # semi-private camelot API: degrade to no cell geometry
        logger.exception("Failed to harvest camelot cell bboxes")
    return grid


def extract_tables(
    *,
    source_pdf: Path,
    content_sha256: str,
    page_heights_pt: dict[int, float],
    min_rows: int = 4,
    min_cols: int = 3,
) -> TableExtractionOutput:
    """Run camelot stream extraction over all pages. Never raises."""
    started_at = _utc_now()
    start = time.time()
    warnings: list[str] = []
    try:
        camelot = importlib.import_module("camelot")
        found = camelot.read_pdf(str(source_pdf), pages="all", flavor="stream")

        kept: list[ParsedTable] = []
        accuracy: list[float] = []
        whitespace: list[float] = []
        for table in found:
            matrix = [
                [_norm_cell(value) for value in row]
                for row in table.df.values.tolist()
            ]
            if not is_matrixlike(matrix, min_rows=min_rows, min_cols=min_cols):
                continue
            page_number = int(getattr(table, "page", 0) or 0)
            if page_number < 1:
                warnings.append("table_without_page_number_skipped")
                continue
            parsed = table_matrix_to_parsed_table(
                matrix,
                page_number=page_number,
                table_index=len(kept) + 1,
                page_height_pt=page_heights_pt.get(page_number),
                cell_bboxes=_cell_bbox_grid(table, len(matrix), len(matrix[0])),
                table_bbox=getattr(table, "_bbox", None) or getattr(table, "bbox", None),
            )
            if not parsed.cells:
                continue
            kept.append(parsed)
            report = getattr(table, "parsing_report", None) or {}
            if isinstance(report, dict):
                if isinstance(report.get("accuracy"), (int, float)):
                    accuracy.append(round(float(report["accuracy"]), 2))
                if isinstance(report.get("whitespace"), (int, float)):
                    whitespace.append(round(float(report["whitespace"]), 2))

        return TableExtractionOutput(
            status="success",
            started_at=started_at,
            finished_at=_utc_now(),
            duration_ms=_duration_ms(start),
            tables=kept,
            metrics={
                "tables_found": len(found),
                "tables_kept": len(kept),
                "accuracy": accuracy,
                "whitespace": whitespace,
            },
            warnings=warnings,
        )
    except Exception as exc:
        unavailable = isinstance(exc, ModuleNotFoundError)
        logger.exception(
            "Camelot table extraction dependency is unavailable"
            if unavailable
            else "Camelot table extraction failed"
        )
        return TableExtractionOutput(
            status="failed",
            started_at=started_at,
            finished_at=_utc_now(),
            duration_ms=_duration_ms(start),
            warnings=warnings,
            error=(
                "table_extraction_unavailable"
                if unavailable
                else "table_extraction_failed"
            ),
        )
