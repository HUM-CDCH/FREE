"""Dependency-neutral table inventory extraction from Docling objects."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


def _jsonable(value: Any) -> Any:
    """Copy producer values without retaining Docling model instances."""
    for method_name in ("model_dump", "dict"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                return _jsonable(method(mode="json"))
            except TypeError:
                try:
                    return _jsonable(method())
                except Exception:
                    pass
            except Exception:
                pass
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_jsonable(item) for item in value]
    if hasattr(value, "__dict__"):
        return {
            str(key): _jsonable(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }
    return value


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
    if x0 >= x1 or y0 >= y1:
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


def _charspan(value: Any) -> list[int] | None:
    """Copy a producer charspan only when it is a finite integer pair."""
    raw = getattr(value, "charspan", None)
    if raw is None:
        return None
    try:
        values = [int(item) for item in raw]
    except (TypeError, ValueError):
        return None
    return (
        values
        if len(values) == 2 and values[0] >= 0 and values[1] >= values[0]
        else None
    )


def _inventory_table(
    table: Any, producer_order: int | None = None
) -> dict[str, Any] | None:
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
    result: dict[str, Any] = {
        "page_number": page_number,
        "rows": rows,
        "cols": cols,
        "bbox": _bbox_inventory(getattr(provenance, "bbox", None)),
        "cells": cells,
    }
    # These are document-local producer observations.  They are deliberately
    # not used as durable logical-table IDs by the canonicalizer.
    producer_ref = getattr(table, "self_ref", None)
    if producer_ref is not None:
        result["producer_ref"] = str(producer_ref)
    if producer_order is not None:
        result["producer_order"] = producer_order
    observed: dict[str, Any] = {"page_number": page_number}
    charspan = _charspan(provenance)
    if charspan is not None:
        observed["charspan"] = charspan
    if observed:
        result["producer_observation"] = observed
    # Keep the narrow raw record needed by the reviewed continuation gate.  It
    # is an in-memory producer observation and is never exported in packages.
    raw_table = _jsonable(table)
    if isinstance(raw_table, Mapping):
        record = {
            "self_ref": raw_table.get("self_ref", result.get("producer_ref")),
            "prov": raw_table.get("prov", []),
            "data": raw_table.get("data", {}),
        }
        if record["self_ref"] is not None and record["prov"] and record["data"]:
            result["producer_record"] = record
    return result


def table_inventory(document: Any) -> tuple[dict[str, Any], ...]:
    """Copy Docling table structure into dependency-neutral primitives."""
    return tuple(
        inventory_table
        for order, table in enumerate(getattr(document, "tables", ()) or ())
        if (inventory_table := _inventory_table(table, order)) is not None
    )
