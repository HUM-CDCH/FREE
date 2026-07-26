"""Matrix normalization and table-shape recognition."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any


def _norm_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return " ".join(text.replace("\u00a0", " ").split()).strip()


def _normalise_matrix(matrix: Sequence[Sequence[Any]]) -> list[list[str]]:
    rows = [[_norm_cell(value) for value in row] for row in matrix]
    width = max((len(row) for row in rows), default=0)
    return [row + [""] * (width - len(row)) for row in rows]


def _normalise_camelot_matrix(
    matrix: Sequence[Sequence[Any]],
    missing: Sequence[Sequence[bool]],
) -> list[list[str]]:
    masked = [
        [
            None if is_missing and not isinstance(value, str) else value
            for value, is_missing in zip(row, missing_row, strict=True)
        ]
        for row, missing_row in zip(matrix, missing, strict=True)
    ]
    return _normalise_matrix(masked)


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
    text = _norm_cell(text)
    compact = text.replace(" ", "")
    has_marker = (
        any(ch.isdigit() for ch in compact)
        or any(ch in compact for ch in "-_/")
        or (compact.isalpha() and compact[:1].isupper() and len(compact) <= 8)
    )
    return all(
        (
            bool(text),
            len(text) <= 24,
            _word_count(text) <= 3,
            not (text.endswith(".") and not any(ch.isdigit() for ch in text)),
            re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", compact) is not None,
            has_marker,
        )
    )


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
        if row and _looks_like_identifier(next((cell for cell in row if cell), ""))
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
    nonempty = [cell for row in matrix for cell in row if cell]
    table_rows = sum(
        1 for row in matrix if _is_header_like_row(row) or _is_table_data_row(row)
    )
    one_row_shape = rows == 1 and (
        _is_table_data_row(matrix[0]) or _is_header_like_row(matrix[0])
    )
    digit_cells = sum(1 for cell in nonempty if any(ch.isdigit() for ch in cell))
    digit_ratio = digit_cells / len(nonempty) if nonempty else 0.0
    dense_rows = sum(1 for row in matrix if _is_dense_row(row, min_cols))
    multirow_shape = rows > 1 and (
        _is_identifier_list_table(matrix, min_rows=min_rows, min_cols=min_cols)
        or (digit_ratio >= 0.18 and dense_rows >= min(2, rows))
    )
    return all(
        (
            rows >= min_rows,
            cols >= min_cols,
            bool(nonempty),
            not all(_is_prose_row(row) for row in matrix),
            table_rows > 0,
            one_row_shape or multirow_shape,
        )
    )


def _guess_header_rows(matrix: list[list[str]], max_header_rows: int = 1) -> list[int]:
    """Identify one explicit header row, never an identifier data row."""
    if not matrix or max_header_rows < 1:
        return []
    return [0] if _is_header_like_row(matrix[0]) else []
