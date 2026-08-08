"""Typed publication helpers for the canonical ``parsed_document.v2`` model."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.models.parsed_document_v2 import (
    ContentBlock,
    ContentBlockBase,
    EvidenceIndex,
    LogicalTable,
    MarkdownByteSpan,
    ParsedPageV2,
    ProducerTableCellObservation,
    TableCellEvidenceAnchor,
    TextEvidenceAnchor,
    V2_GEOMETRY_ERROR_CODE,
)
from app.models.parser_output import ParsedTable

PAGE_MARKER_RE = re.compile(r"^<!-- FREE:PAGE ([1-9][0-9]*) -->$")
PAGE_MARKER_PREFIX = "<!-- FREE:PAGE "
CanonicalTable = LogicalTable | ParsedTable


@dataclass(frozen=True)
class RenderedSpan:
    """Half-open UTF-8 byte offsets into the exact rendered Markdown."""

    start: int
    end: int


@dataclass(frozen=True)
class RenderedMarkdown:
    """Canonical Markdown and the byte spans produced while rendering it."""

    markdown: str
    page_spans: dict[int, RenderedSpan] = field(default_factory=dict)
    block_spans: dict[str, RenderedSpan] = field(default_factory=dict)
    table_spans: dict[str, RenderedSpan] = field(default_factory=dict)
    page_marker_spans: dict[int, RenderedSpan] = field(default_factory=dict)

    @property
    def utf8(self) -> bytes:
        return self.markdown.encode("utf-8")

    def slice(self, span: RenderedSpan) -> str:
        return self.utf8[span.start : span.end].decode("utf-8")


def _normalise_lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _check_marker_collision(text: str) -> None:
    for line in _normalise_lf(text).split("\n"):
        if PAGE_MARKER_RE.fullmatch(line.strip()):
            raise ValueError("reserved_page_marker_collision")


def _escape_table_cell(text: str) -> str:
    return text.replace("\\", "\\\\").replace("|", "\\|")


def _cell_matrix(
    table: CanonicalTable,
) -> tuple[list[list[str]], dict[tuple[int, int], tuple[str | None, int, int]]]:
    """Lay out either cell shape. The only difference is the column attribute:
    an internal ``ParsedTable`` names it ``col``, a ``LogicalTable`` ``column``.
    """

    def column_of(cell: Any) -> int:
        return cell.col if isinstance(table, ParsedTable) else cell.column

    rows = int(table.rows or 0)
    cols = int(table.cols or 0)
    if table.cells:
        rows = max(rows, max(cell.row + cell.rowspan for cell in table.cells))
        cols = max(cols, max(column_of(cell) + cell.colspan for cell in table.cells))
    matrix = [[""] * cols for _ in range(rows)]
    metadata: dict[tuple[int, int], tuple[str | None, int, int]] = {}
    occupied: set[tuple[int, int]] = set()
    for cell in table.cells:
        column = column_of(cell)
        covered = {
            (row, col)
            for row in range(cell.row, cell.row + cell.rowspan)
            for col in range(column, column + cell.colspan)
        }
        if any(row >= rows or col >= cols for row, col in covered):
            raise ValueError("table_cell_span_out_of_bounds")
        if occupied.intersection(covered):
            raise ValueError("table_cell_span_overlap")
        occupied.update(covered)
        _check_marker_collision(cell.text)
        matrix[cell.row][column] = cell.text
        metadata[(cell.row, column)] = (cell.role, cell.rowspan, cell.colspan)
    return matrix, metadata


def _table_matrix(
    table_or_matrix: CanonicalTable | Sequence[Sequence[str]],
) -> tuple[list[list[str]], dict[tuple[int, int], tuple[str | None, int, int]]]:
    if isinstance(table_or_matrix, (LogicalTable, ParsedTable)):
        return _cell_matrix(table_or_matrix)
    matrix = [[str(cell) for cell in row] for row in table_or_matrix]
    width = max((len(row) for row in matrix), default=0)
    return [row + [""] * (width - len(row)) for row in matrix], {}


def render_table_markdown(
    table_or_matrix: CanonicalTable | Sequence[Sequence[str]],
    header_rows: Iterable[int] | None = None,
) -> str:
    """Render one typed table or a rectangular extraction-stage matrix."""
    matrix, metadata = _table_matrix(table_or_matrix)
    if not matrix or not matrix[0]:
        return ""
    if header_rows is None:
        header_rows = sorted(
            row
            for (row, _), (role, _, _) in metadata.items()
            if role in {"header", "column_header"}
        )
    header_rows = sorted({row for row in header_rows if 0 <= row < len(matrix)})
    separator_after = header_rows[-1] if header_rows else 0
    separator = "| " + " | ".join("---" for _ in matrix[0]) + " |"
    lines: list[str] = []
    for row_index, row in enumerate(matrix):
        lines.append("| " + " | ".join(_escape_table_cell(cell) for cell in row) + " |")
        if row_index == separator_after:
            lines.append(separator)
    return "\n".join(lines)


def _render_block(
    block: ContentBlock,
    tables: Mapping[str, LogicalTable],
) -> tuple[str, str | None]:
    if block.kind == "page_break":
        return "", None
    if block.kind == "table":
        table = tables.get(block.table_id)
        if table is None:
            raise ValueError("table_reference_unresolved")
        return render_table_markdown(table), table.table_id
    if block.kind == "list":
        prefix = (lambda index: f"{index}. ") if block.ordered else (lambda _: "- ")
        text = "\n".join(prefix(index) + item for index, item in enumerate(block.items, 1))
    elif block.kind == "heading":
        text = "#" * max(1, min(6, block.level)) + " " + block.text.lstrip("# ")
    elif block.kind == "code":
        text = block.text if block.text.startswith("```") else f"```\n{block.text}\n```"
    elif block.kind == "formula":
        text = block.text if block.text.startswith("$$") else f"$$\n{block.text}\n$$"
    else:
        text = block.text
    text = _normalise_lf(text)
    _check_marker_collision(text)
    return text, None


def render_canonical_markdown(
    pages: Sequence[ParsedPageV2],
    blocks: Sequence[ContentBlock] = (),
    tables: Sequence[LogicalTable] = (),
    *,
    page_count: int | None = None,
) -> RenderedMarkdown:
    """Render deterministic Markdown while recording UTF-8 byte spans."""
    table_by_id = {table.table_id: table for table in tables}
    blocks_by_id = {block.block_id: block for block in blocks}
    grouped: dict[int, list[ContentBlock]] = {}
    for block in blocks:
        grouped.setdefault(block.page_number, []).append(block)
    max_page = page_count or max((page.page_number for page in pages), default=0)
    if max_page < 1:
        raise ValueError("physical_page_mapping_unavailable")

    chunks: list[str] = []
    page_spans: dict[int, RenderedSpan] = {}
    block_spans: dict[str, RenderedSpan] = {}
    table_spans: dict[str, RenderedSpan] = {}
    marker_spans: dict[int, RenderedSpan] = {}
    cursor = 0

    def append(text: str) -> tuple[int, int]:
        nonlocal cursor
        start = cursor
        chunks.append(text)
        cursor += len(text.encode("utf-8"))
        return start, cursor

    pages_by_number = {page.page_number: page for page in pages}
    for page_number in range(1, max_page + 1):
        if chunks:
            append("\n\n")
        marker_start, marker_end = append(f"{PAGE_MARKER_PREFIX}{page_number} -->\n")
        marker_spans[page_number] = RenderedSpan(marker_start, marker_end - 1)
        page = pages_by_number.get(page_number)
        if page is None:
            raise ValueError("physical_page_mapping_unavailable")
        page_blocks = [blocks_by_id[block_id] for block_id in page.ordered_content]
        rendered: list[tuple[str, ContentBlock | None, str | None]] = []
        for block in page_blocks:
            text, table_id = _render_block(block, table_by_id)
            if text:
                rendered.append((text, block, table_id))
        for table_id in page.unplaced_content:
            table = table_by_id.get(table_id)
            if table is None:
                raise ValueError("unplaced_table_reference_unresolved")
            rendered.append(
                (f"[Unplaced table: {table_id}]\n\n{render_table_markdown(table)}", None, table_id)
            )
        page_start = cursor
        for index, (text, block, table_id) in enumerate(rendered):
            if index:
                append("\n\n")
            start, end = append(text)
            if block is not None:
                block_spans[block.block_id] = RenderedSpan(start, end)
            if table_id is not None:
                table_spans[table_id] = RenderedSpan(start, end)
        page_spans[page_number] = RenderedSpan(page_start, cursor)
    return RenderedMarkdown(
        _normalise_lf("".join(chunks)), page_spans, block_spans, table_spans, marker_spans
    )


def _identity(content_sha256: str, preprocess_id: str, *parts: str) -> str:
    from app.models.parsed_document_v2 import deterministic_anchor_id

    return deterministic_anchor_id(content_sha256, preprocess_id, "\x00".join(parts))


def build_evidence_index(
    rendered: RenderedMarkdown,
    blocks: Sequence[ContentBlock],
    tables: Sequence[LogicalTable],
    *,
    content_sha256: str,
    preprocess_id: str,
    producer_observations: Mapping[
        str, Sequence[ProducerTableCellObservation]
    ]
    | None = None,
) -> EvidenceIndex:
    """Build exactly one typed text or table-cell anchor per published value."""
    anchors: list[TextEvidenceAnchor | TableCellEvidenceAnchor] = []
    for block in blocks:
        span = rendered.block_spans.get(block.block_id)
        if span is None or block.kind in {"table", "page_break"}:
            continue
        if block.bbox is None:
            raise ValueError(
                f"{V2_GEOMETRY_ERROR_CODE}: text block {block.block_id} has no producer geometry"
            )
        anchors.append(
            TextEvidenceAnchor(
                anchor_id=_identity(content_sha256, preprocess_id, "text", block.block_id),
                occurrence_id=_identity(
                    content_sha256, preprocess_id, "text-occurrence", block.block_id
                ),
                content_sha256=content_sha256,
                preprocess_id=preprocess_id,
                block_id=block.block_id,
                page_number=block.page_number,
                markdown_span=MarkdownByteSpan(start=span.start, end=span.end),
                bbox=block.bbox,
            )
        )

    observations = producer_observations or {}
    for table in tables:
        for cell in table.cells:
            cell_observations = observations.get(cell.evidence_anchor_id)
            if not cell_observations:
                raise ValueError("table_cell_evidence_incomplete")
            anchors.append(
                TableCellEvidenceAnchor(
                    anchor_id=cell.evidence_anchor_id,
                    content_sha256=content_sha256,
                    preprocess_id=preprocess_id,
                    logical_table_id=table.table_id,
                    cell_id=cell.cell_id,
                    canonical_row=cell.row,
                    canonical_column=cell.column,
                    producer_observations=list(cell_observations),
                )
            )
    return EvidenceIndex(anchors=anchors)


def apply_rendered_spans(
    rendered: RenderedMarkdown,
    blocks: Sequence[ContentBlock],
    pages: Sequence[ParsedPageV2],
) -> tuple[list[ContentBlock], list[ParsedPageV2]]:
    """Attach exact final-Markdown byte spans to v2 blocks and pages."""
    updated_blocks = [
        block.model_copy(
            update={
                "markdown_span": (
                    MarkdownByteSpan(start=span.start, end=span.end)
                    if (span := rendered.block_spans.get(block.block_id)) is not None
                    else block.markdown_span
                )
            }
        )
        for block in blocks
    ]
    updated_pages = [
        page.model_copy(
            update={
                "markdown_span": (
                    MarkdownByteSpan(start=span.start, end=span.end)
                    if (span := rendered.page_spans.get(page.page_number)) is not None
                    else page.markdown_span
                )
            }
        )
        for page in pages
    ]
    return updated_blocks, updated_pages


def validate_publication(
    rendered: RenderedMarkdown,
    pages: Sequence[ParsedPageV2],
    blocks: Sequence[ContentBlock],
    tables: Sequence[LogicalTable],
    evidence_index: EvidenceIndex | None = None,
    *,
    page_count: int | None = None,
) -> None:
    """Fail closed if Markdown, placements, spans, tables, or anchors disagree."""
    markdown_bytes = rendered.utf8
    expected_pages = page_count or len(pages)
    if set(rendered.page_spans) != set(range(1, expected_pages + 1)):
        raise ValueError("page_span_coverage_invalid")
    pages_by_number = {page.page_number: page for page in pages}
    for page_number, span in rendered.page_spans.items():
        if not (0 <= span.start <= span.end <= len(markdown_bytes)):
            raise ValueError("page_span_invalid")
        if span.start < rendered.page_marker_spans[page_number].end:
            raise ValueError("page_span_includes_marker")
        if pages_by_number[page_number].markdown_span != MarkdownByteSpan(
            start=span.start, end=span.end
        ):
            raise ValueError("page_span_disagreement")

    table_by_id = {table.table_id: table for table in tables}
    placed_table_ids: set[str] = set()
    for page in pages:
        for block_id in page.ordered_content:
            block = next((candidate for candidate in blocks if candidate.block_id == block_id), None)
            if block is None or block.page_number != page.page_number:
                raise ValueError("ordered_content_reference_unresolved")
            if block.kind == "table":
                if block.table_id not in table_by_id:
                    raise ValueError("table_reference_unresolved")
                placed_table_ids.add(block.table_id)
        for table_id in page.unplaced_content:
            if table_id not in table_by_id:
                raise ValueError("unplaced_table_reference_unresolved")
            placed_table_ids.add(table_id)
    if placed_table_ids != set(table_by_id):
        raise ValueError("table_publication_placement_incomplete")

    for block in blocks:
        if block.kind in {"table", "page_break"}:
            continue
        span = rendered.block_spans.get(block.block_id)
        if span is None or block.markdown_span != MarkdownByteSpan(start=span.start, end=span.end):
            raise ValueError("block_span_disagreement")
        expected, _ = _render_block(block, table_by_id)
        if rendered.slice(span) != expected:
            raise ValueError("block_span_disagreement")

    if evidence_index is None:
        return
    anchors = evidence_index.anchors
    for anchor in anchors:
        occurrences = (
            [(anchor.page_number, anchor.bbox)]
            if isinstance(anchor, TextEvidenceAnchor)
            else [
                (observation.page_number, observation.bbox)
                for observation in anchor.producer_observations
            ]
        )
        for page_number, bbox in occurrences:
            page = pages_by_number.get(page_number)
            if (
                page is None
                or bbox.x0 < 0
                or bbox.y0 < 0
                or bbox.x1 > page.width_pt
                or bbox.y1 > page.height_pt
            ):
                raise ValueError(
                    f"{V2_GEOMETRY_ERROR_CODE}: Evidence geometry is outside physical page {page_number}"
                )
    table_anchors = {
        (anchor.logical_table_id, anchor.cell_id): anchor
        for anchor in anchors
        if isinstance(anchor, TableCellEvidenceAnchor)
    }
    cell_count = sum(len(table.cells) for table in tables)
    if len(table_anchors) != cell_count:
        raise ValueError("table_cell_evidence_incomplete")
    text_anchor_ids = {
        anchor.block_id for anchor in anchors if isinstance(anchor, TextEvidenceAnchor)
    }
    for block in blocks:
        if block.kind not in {"table", "page_break"} and block.block_id not in text_anchor_ids:
            raise ValueError("text_evidence_incomplete")
    for table in tables:
        for cell in table.cells:
            anchor = table_anchors.get((table.table_id, cell.cell_id))
            if anchor is None or cell.evidence_anchor_id != anchor.anchor_id:
                raise ValueError("table_cell_evidence_incomplete")


__all__ = [
    "PAGE_MARKER_RE",
    "PAGE_MARKER_PREFIX",
    "RenderedMarkdown",
    "RenderedSpan",
    "apply_rendered_spans",
    "build_evidence_index",
    "render_canonical_markdown",
    "render_table_markdown",
    "validate_publication",
]
