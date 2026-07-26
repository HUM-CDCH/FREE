"""Dependency-neutral table inventory extraction from Docling objects."""

from __future__ import annotations

from typing import Any


def _coord_origin(value: Any) -> str:
    origin = getattr(value, "coord_origin", None)
    return str(getattr(origin, "value", origin) or "TOPLEFT").upper()


def _bbox_inventory(value: Any) -> dict[str, float | str] | None:
    if value is None:
        return None
    try:
        origin = _coord_origin(value)
        x0 = float(value.l)
        x1 = float(value.r)
        if "BOTTOM" in origin:
            y0 = float(value.b)
            y1 = float(value.t)
        else:
            y0 = float(value.t)
            y1 = float(value.b)
    except (AttributeError, TypeError, ValueError):
        return None
    if x0 > x1 or y0 > y1:
        return None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "origin": origin}


def _table_dimensions(provenance: Any, data: Any) -> tuple[int, int, int] | None:
    try:
        page_number = int(getattr(provenance, "page_no", 0) or 0)
        rows = int(getattr(data, "num_rows", 0) or 0)
        cols = int(getattr(data, "num_cols", 0) or 0)
    except (TypeError, ValueError):
        return None
    if page_number < 1 or rows < 1 or cols < 1:
        return None
    return page_number, rows, cols


def _cell_role(cell: Any) -> str:
    if getattr(cell, "column_header", False):
        return "header"
    if getattr(cell, "row_header", False):
        return "row_header"
    if getattr(cell, "row_section", False):
        return "row_section"
    return "data"


def _inventory_cell(cell: Any, rows: int, cols: int) -> dict[str, Any] | None:
    try:
        row = int(getattr(cell, "start_row_offset_idx", -1))
        col = int(getattr(cell, "start_col_offset_idx", -1))
        rowspan = max(1, int(getattr(cell, "row_span", 1) or 1))
        colspan = max(1, int(getattr(cell, "col_span", 1) or 1))
    except (TypeError, ValueError):
        return None
    if not (0 <= row < rows and 0 <= col < cols):
        return None
    return {
        "row": row,
        "col": col,
        "text": str(getattr(cell, "text", "") or ""),
        "role": _cell_role(cell),
        "rowspan": rowspan,
        "colspan": colspan,
        "bbox": _bbox_inventory(getattr(cell, "bbox", None)),
    }


def _inventory_table(table: Any) -> dict[str, Any] | None:
    provenance = next(
        (
            item
            for item in (getattr(table, "prov", ()) or ())
            if getattr(item, "page_no", None) is not None
        ),
        None,
    )
    data = getattr(table, "data", None)
    dimensions = _table_dimensions(provenance, data)
    if dimensions is None:
        return None
    page_number, rows, cols = dimensions

    cells = [
        inventory_cell
        for cell in (getattr(data, "table_cells", ()) or ())
        if (inventory_cell := _inventory_cell(cell, rows, cols)) is not None
    ]
    if not cells:
        return None
    return {
        "page_number": page_number,
        "rows": rows,
        "cols": cols,
        "bbox": _bbox_inventory(getattr(provenance, "bbox", None)),
        "cells": cells,
    }


def table_inventory(document: Any) -> tuple[dict[str, Any], ...]:
    """Copy Docling table structure into dependency-neutral primitives."""
    return tuple(
        inventory_table
        for table in (getattr(document, "tables", ()) or ())
        if (inventory_table := _inventory_table(table)) is not None
    )
