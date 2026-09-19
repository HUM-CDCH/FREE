"""Partitioning, merging, and boundary-table stitching for large-document
parallel parsing.

Every function here operates on plain ``parsed_document.v2``-shaped dicts (or
on primitive page numbers), never on a live Docling or PyMuPDF object, so the
merge/stitch logic is testable without either dependency. The one place that
does touch PyMuPDF (`pymupdf_boundary_risk`) is a thin, separately-swappable
adapter: its output is a boundary-page predicate, nothing else, and it never
contributes published content. See ``design.md`` in the
``parallelize-large-document-parsing`` OpenSpec change for the full rationale.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any


DEFAULT_MIN_PAGES = 100000
"""Effectively disables partitioning until a deployment lowers it."""

DEFAULT_TARGET_PARTITION_PAGES = 4
DEFAULT_MAX_WORKERS = 2
DEFAULT_SPLIT_SEARCH_RADIUS = 2

_FLUSH_MARGIN_RATIO = 0.06
"""Fraction of page height/width treated as "touching" the page edge."""

_COLUMN_TOLERANCE_RATIO = 0.02
"""Fraction of page width allowed as column x-boundary misalignment."""


# --------------------------------------------------------------------------
# 1. Partition planning
# --------------------------------------------------------------------------


def compute_partition_ranges(
    page_count: int,
    *,
    min_pages: int = DEFAULT_MIN_PAGES,
    target_partition_pages: int = DEFAULT_TARGET_PARTITION_PAGES,
    max_workers: int = DEFAULT_MAX_WORKERS,
    is_risky_boundary: Callable[[int], bool] | None = None,
    search_radius: int = DEFAULT_SPLIT_SEARCH_RADIUS,
) -> list[tuple[int, int]]:
    """Return contiguous, 1-indexed, inclusive ``(start, end)`` page ranges.

    A single-element result means "do not partition" — the caller should keep
    the existing single-call path in that case. Internal boundaries avoid a
    page pair flagged risky by ``is_risky_boundary`` (a table's bounding box
    touching the boundary) when a safe page gap exists within
    ``search_radius``.
    """

    if page_count <= 0:
        raise ValueError("page_count must be positive")
    if page_count <= min_pages or max_workers <= 1 or target_partition_pages <= 0:
        return [(1, page_count)]

    partition_count = max(1, min(max_workers, -(-page_count // target_partition_pages)))
    if partition_count <= 1:
        return [(1, page_count)]

    raw_boundaries = [round(page_count * index / partition_count) for index in range(1, partition_count)]

    boundaries: list[int] = []
    lower = 0
    for index, boundary in enumerate(raw_boundaries):
        upper = (raw_boundaries[index + 1] - 1) if index + 1 < len(raw_boundaries) else page_count - 1
        chosen = boundary
        if is_risky_boundary is not None and is_risky_boundary(boundary):
            chosen = _nearest_safe_boundary(boundary, lower + 1, upper, is_risky_boundary, search_radius)
        chosen = max(lower + 1, min(chosen, upper))
        boundaries.append(chosen)
        lower = chosen

    starts = [1, *(boundary + 1 for boundary in boundaries)]
    ends = [*boundaries, page_count]
    return list(zip(starts, ends))


def _nearest_safe_boundary(
    boundary: int,
    low: int,
    high: int,
    is_risky: Callable[[int], bool],
    radius: int,
) -> int:
    if low > high:
        return boundary
    for delta in range(radius + 1):
        for candidate in (boundary - delta, boundary + delta):
            if low <= candidate <= high and not is_risky(candidate):
                return candidate
    return boundary


def pymupdf_boundary_risk(pdf_path: Path, *, margin_ratio: float = _FLUSH_MARGIN_RATIO) -> Callable[[int], bool]:
    """Build an ``is_risky_boundary`` predicate from PyMuPDF's ``find_tables()``.

    Geometry only: this never produces published table or text content, only
    a yes/no signal for where NOT to place a partition split. See the
    ``parsed-document-v2`` "Parser and table authority" requirement's
    PyMuPDF carve-out.
    """

    import pymupdf

    document = pymupdf.open(str(pdf_path))
    cache: dict[tuple[int, str], bool] = {}

    def touches(page_number: int, edge: str) -> bool:
        key = (page_number, edge)
        if key not in cache:
            cache[key] = _page_touches_edge(document, page_number, margin_ratio, edge)
        return cache[key]

    def is_risky(boundary_page: int) -> bool:
        return touches(boundary_page, "bottom") or touches(boundary_page + 1, "top")

    return is_risky


def _page_touches_edge(document: Any, page_number: int, margin_ratio: float, edge: str) -> bool:
    if not (1 <= page_number <= document.page_count):
        return False
    page = document[page_number - 1]
    height = page.rect.height
    margin = height * margin_ratio
    for table in page.find_tables():
        y0, y1 = table.bbox[1], table.bbox[3]
        if edge == "bottom" and y1 >= height - margin:
            return True
        if edge == "top" and y0 <= margin:
            return True
    return False


# --------------------------------------------------------------------------
# 2. Merge: concatenate independently-published fragments
# --------------------------------------------------------------------------


def merge_fragments(fragments: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], str]:
    """Concatenate partition fragments (each shaped like ``ParseResult``,
    as a mapping with ``parsed_document`` and ``markdown`` keys) in page
    order into one ``parsed_document.v2`` document and its canonical
    Markdown. Every partition already ran the full publish/validate
    pipeline independently, so this only concatenates already-public,
    already-namespaced structures and shifts Markdown byte spans.
    """

    if not fragments:
        raise ValueError("at least one fragment is required")
    if len(fragments) == 1:
        only = fragments[0]
        return dict(only["parsed_document"]), str(only["markdown"])

    ordered = sorted(fragments, key=lambda fragment: fragment["parsed_document"]["pages"][0]["page_number"])
    first_document = ordered[0]["parsed_document"]

    pages: list[dict[str, Any]] = []
    content_stream: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    anchors: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    parser_runs: list[dict[str, Any]] = []
    warnings: list[str] = []
    markdown_parts: list[str] = []
    byte_offset = 0

    for fragment in ordered:
        document = fragment["parsed_document"]
        markdown_text = str(fragment["markdown"])
        shift = byte_offset

        for page in document["pages"]:
            pages.append({**page, "markdown_span": _shift_span(page["markdown_span"], shift)})
        for block in document["content_stream"]:
            span = block.get("markdown_span")
            content_stream.append({**block, "markdown_span": _shift_span(span, shift) if span is not None else None})
        tables.extend(document["tables"])
        for anchor in document["evidence_index"]["anchors"]:
            anchors.append(_shift_anchor_span(anchor, shift))
        diagnostics.extend(document["diagnostics"])
        parser_runs.extend(document["parser_runs"])
        warnings.extend(document["preprocessing"].get("warnings", ()))

        markdown_parts.append(markdown_text)
        byte_offset += len(markdown_text.encode("utf-8"))

    merged_markdown = "".join(markdown_parts)
    merged: dict[str, Any] = {
        "schema_version": first_document["schema_version"],
        "document": {**first_document["document"], "page_count": len(pages)},
        "preprocessing": {**first_document["preprocessing"], "warnings": _unique(warnings)},
        "page_count": len(pages),
        "page_mapping_verified": all(fragment["parsed_document"]["page_mapping_verified"] for fragment in ordered),
        "artifacts": first_document["artifacts"],
        "parser_runs": _unique_dicts(parser_runs),
        "arbitration": _merge_arbitration(fragment["parsed_document"] for fragment in ordered),
        "diagnostics": diagnostics,
        "content_stream": content_stream,
        "pages": pages,
        "tables": tables,
        "evidence_index": {"anchors": anchors},
    }
    return merged, merged_markdown


def _shift_span(span: Mapping[str, int] | None, shift: int) -> dict[str, int] | None:
    if span is None:
        return None
    return {"start": span["start"] + shift, "end": span["end"] + shift}


def _shift_anchor_span(anchor: Mapping[str, Any], shift: int) -> dict[str, Any]:
    if anchor.get("kind") != "text" or anchor.get("markdown_span") is None:
        return dict(anchor)
    return {**anchor, "markdown_span": _shift_span(anchor["markdown_span"], shift)}


def _merge_arbitration(documents: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    documents = list(documents)
    first = documents[0]["arbitration"]
    page_decisions: list[Any] = []
    for document in documents:
        page_decisions.extend(document["arbitration"].get("page_decisions", ()))
    return {**first, "page_decisions": page_decisions}


def _unique(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _unique_dicts(values: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []
    for value in values:
        candidate = dict(value)
        if candidate not in seen:
            seen.append(candidate)
    return seen


# --------------------------------------------------------------------------
# 3. Boundary-table stitching (safety-net layer)
# --------------------------------------------------------------------------

PARTITION_BOUNDARY_TABLE_NOT_STITCHED = "partition_boundary_table_not_stitched"
PARTITION_BOUNDARY_MAY_BE_SPLIT = "partition_boundary_may_be_split"


def stitch_boundary_tables(document: Mapping[str, Any], boundary_pages: Sequence[int]) -> dict[str, Any]:
    """For each partition boundary, try to stitch the table flush against the
    boundary's earlier page with the table flush against its later page.

    Falls back to leaving both tables published separately, with a
    diagnostic, when the geometry doesn't confirm continuation. Never touches
    Docling's own cell content — only re-owns already-published cells onto a
    surviving ``table_id`` and renumbers their row offset.
    """

    result = _deep_copy_document(document)
    tables_by_id = {table["table_id"]: table for table in result["tables"]}
    page_height = {page["page_number"]: page["height_pt"] for page in result["pages"]}
    page_width = {page["page_number"]: page["width_pt"] for page in result["pages"]}

    for boundary in boundary_pages:
        earlier = _table_flush_to_edge(result["tables"], boundary, page_height, edge="bottom")
        later = _table_flush_to_edge(result["tables"], boundary + 1, page_height, edge="top")
        if earlier is None or later is None:
            continue
        earlier_table = tables_by_id[earlier]
        later_table = tables_by_id[later]
        if _tables_align(earlier_table, later_table, page_width.get(boundary, 0.0)):
            _stitch(result, earlier_table, later_table)
            tables_by_id = {table["table_id"]: table for table in result["tables"]}
        else:
            result["diagnostics"].append(
                _diagnostic(
                    PARTITION_BOUNDARY_TABLE_NOT_STITCHED,
                    reason="geometry_alignment_failed",
                    detail=f"{earlier}:{later}",
                    page_number=boundary,
                )
            )
    return result


def flag_boundary_text(document: Mapping[str, Any], boundary_pages: Sequence[int], *, margin_pages: int = 0) -> dict[str, Any]:
    """Attach a diagnostic to non-table blocks adjacent to a partition
    boundary. Never merges or moves the block."""

    result = _deep_copy_document(document)
    boundary_set = set(boundary_pages) | {page + 1 for page in boundary_pages}
    if margin_pages:
        expanded: set[int] = set()
        for page in boundary_set:
            expanded.update(range(page - margin_pages, page + margin_pages + 1))
        boundary_set = expanded

    for block in result["content_stream"]:
        if block["kind"] == "table" or block["page_number"] not in boundary_set:
            continue
        result["diagnostics"].append(
            _diagnostic(
                PARTITION_BOUNDARY_MAY_BE_SPLIT,
                reason="partition_boundary_adjacent",
                detail=block["block_id"],
                page_number=block["page_number"],
            )
        )
    return result


def _table_flush_to_edge(
    tables: Sequence[Mapping[str, Any]],
    page_number: int,
    page_height: Mapping[int, float],
    *,
    edge: str,
) -> str | None:
    height = page_height.get(page_number)
    if height is None:
        return None
    margin = height * _FLUSH_MARGIN_RATIO
    best_id: str | None = None
    best_extent = None
    for table in tables:
        cells_on_page = [cell for cell in table["cells"] if _cell_page(table, cell) == page_number]
        if not cells_on_page:
            continue
        if edge == "bottom":
            extent = max(cell["bbox"]["y1"] for cell in cells_on_page)
            flush = extent >= height - margin
            better = best_extent is None or extent > best_extent
        else:
            extent = min(cell["bbox"]["y0"] for cell in cells_on_page)
            flush = extent <= margin
            better = best_extent is None or extent < best_extent
        if flush and better:
            best_id = table["table_id"]
            best_extent = extent
    return best_id


def _cell_page(table: Mapping[str, Any], cell: Mapping[str, Any]) -> int | None:
    spans = table.get("spans") or ()
    if len(spans) == 1:
        return spans[0]["page_number"]
    # Multiple page spans: fall back to bbox-adjacency is not decidable here,
    # so such tables (already multi-page within their own partition) are
    # never treated as stitch candidates.
    return None


def _tables_align(earlier: Mapping[str, Any], later: Mapping[str, Any], page_width: float) -> bool:
    if earlier["cols"] != later["cols"] or earlier["cols"] == 0:
        return False
    earlier_bounds = _column_bounds(earlier)
    later_bounds = _column_bounds(later)
    if len(earlier_bounds) != len(later_bounds):
        return False
    tolerance = max(page_width * _COLUMN_TOLERANCE_RATIO, 1.0)
    for (x0_a, x1_a), (x0_b, x1_b) in zip(earlier_bounds, later_bounds):
        if abs(x0_a - x0_b) > tolerance or abs(x1_a - x1_b) > tolerance:
            return False
    return True


def _column_bounds(table: Mapping[str, Any]) -> list[tuple[float, float]]:
    bounds: list[tuple[float, float] | None] = [None] * table["cols"]
    for cell in table["cells"]:
        column = cell["column"]
        if column >= len(bounds):
            continue
        x0, x1 = cell["bbox"]["x0"], cell["bbox"]["x1"]
        current = bounds[column]
        bounds[column] = (x0, x1) if current is None else (min(current[0], x0), max(current[1], x1))
    return [bound for bound in bounds if bound is not None]


def _header_row_matches(earlier: Mapping[str, Any], later: Mapping[str, Any]) -> bool:
    earlier_header = sorted((cell for cell in earlier["cells"] if cell["row"] == 0), key=lambda cell: cell["column"])
    later_header = sorted((cell for cell in later["cells"] if cell["row"] == 0), key=lambda cell: cell["column"])
    if len(earlier_header) != len(later_header) or not earlier_header:
        return False
    return all(a["text"] == b["text"] for a, b in zip(earlier_header, later_header))


def _stitch(document: dict[str, Any], earlier: dict[str, Any], later: dict[str, Any]) -> None:
    drop_header = _header_row_matches(earlier, later)
    row_offset = earlier["rows"] - (1 if drop_header else 0)
    later_block_id = _table_block_id(document, later["table_id"])

    kept_cells: list[dict[str, Any]] = []
    dropped_cell_ids: set[str] = set()
    for cell in later["cells"]:
        if drop_header and cell["row"] == 0:
            dropped_cell_ids.add(cell["cell_id"])
            continue
        new_cell = {**cell, "row": cell["row"] + row_offset}
        kept_cells.append(new_cell)

    earlier["cells"] = [*earlier["cells"], *kept_cells]
    earlier["rows"] = row_offset + later["rows"]
    earlier["continuation"] = "derived_continuation"
    earlier["spans"] = [*earlier["spans"], *later["spans"]]

    for anchor in document["evidence_index"]["anchors"]:
        if anchor.get("kind") != "table_cell" or anchor.get("logical_table_id") != later["table_id"]:
            continue
        if anchor["cell_id"] in dropped_cell_ids:
            continue
        anchor["logical_table_id"] = earlier["table_id"]
        anchor["canonical_row"] = anchor["canonical_row"] + row_offset

    document["evidence_index"]["anchors"] = [
        anchor
        for anchor in document["evidence_index"]["anchors"]
        if anchor.get("cell_id") not in dropped_cell_ids
    ]
    document["tables"] = [table for table in document["tables"] if table["table_id"] != later["table_id"]]
    if later_block_id is not None:
        document["content_stream"] = [
            block for block in document["content_stream"] if block["block_id"] != later_block_id
        ]
        for page in document["pages"]:
            if later_block_id in page["ordered_content"]:
                page["ordered_content"] = [
                    block_id for block_id in page["ordered_content"] if block_id != later_block_id
                ]


def _table_block_id(document: Mapping[str, Any], table_id: str) -> str | None:
    for block in document["content_stream"]:
        if block["kind"] == "table" and block["table_id"] == table_id:
            return block["block_id"]
    return None


def _diagnostic(code: str, *, reason: str | None, detail: str | None, page_number: int | None) -> dict[str, Any]:
    return {"code": code, "reason": reason, "detail": detail, "page_number": page_number}


def _deep_copy_document(document: Mapping[str, Any]) -> dict[str, Any]:
    import copy

    return copy.deepcopy(dict(document))


__all__ = [
    "DEFAULT_MAX_WORKERS",
    "DEFAULT_MIN_PAGES",
    "DEFAULT_SPLIT_SEARCH_RADIUS",
    "DEFAULT_TARGET_PARTITION_PAGES",
    "PARTITION_BOUNDARY_MAY_BE_SPLIT",
    "PARTITION_BOUNDARY_TABLE_NOT_STITCHED",
    "compute_partition_ranges",
    "flag_boundary_text",
    "merge_fragments",
    "pymupdf_boundary_risk",
    "stitch_boundary_tables",
]
