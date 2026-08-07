"""Producer-backed semantic stream helpers for parsed-document v2.

This module deliberately has no dependency on the public Pydantic contract.  It
is the small seam between DocTags/OCR producers and the v2 models: producer
facts are retained here, while logical table identity and placement are only
created by the reconciliation functions below when their inputs prove it.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

from app.models.parsed_document import ParsedTable
from app.parsing._table_matrix import _norm_cell

_TAG_BLOCK = re.compile(
    r"<(?P<tag>section_header_level_(?P<level>\d+)|text|title|caption|code|formula|"
    r"ordered_list|unordered_list|otsl)>(?P<body>.*?)</(?P=tag)>",
    re.DOTALL,
)
_PAGE_BREAK = re.compile(r"<page_break>\s*")
_LOC = re.compile(r"<loc_[^>]+>")
_DOCTAG_WRAPPER = re.compile(r"</?doctag>")
_PAGE_FURNITURE = re.compile(
    r"<(?:page_header|page_footer)>.*?</(?:page_header|page_footer)>", re.DOTALL
)
_CAPTION = re.compile(r"<caption>(.*?)</caption>", re.DOTALL)
_LIST_ITEM = re.compile(r"<list_item>(.*?)</list_item>", re.DOTALL)
_CODE_TOKEN = re.compile(r"^<_[^<>=\n]+_>")
_CELL = re.compile(r"<(?:ched|rhed|srow|fcel|ecel|lcel|ucel|xcel)>")
_NL = "<nl>"


@dataclass(frozen=True, slots=True)
class SemanticBlock:
    """An intermediate parser-observed block.

    ``source_text`` is the producer text after location annotations are
    removed; it is never model-inferred.  ``raw`` is retained only in memory
    and is not a portable artifact.
    """

    kind: str
    page_number: int
    source_text: str = ""
    level: int | None = None
    ordered: bool | None = None
    items: tuple[str, ...] = ()
    table_slot: str | None = None
    producer_ref: str | None = None
    raw: str = field(default="", repr=False)
    geometry: Any | None = None

    @property
    def text(self) -> str:
        return self.source_text


@dataclass(frozen=True, slots=True)
class TableSlot:
    """A DocTags table reference, kept separate from canonical table identity.

    ``ordinal`` is one-based within a physical page for stable slot IDs;
    ``producer_order`` is the optional zero-based order in the complete
    producer document and is only comparable with a canonical table carrying
    that same producer-document scope.
    """

    page_number: int
    ordinal: int
    matrix: tuple[tuple[str, ...], ...]
    # OTSL token roles are producer observations, not inferred domain labels.
    roles: tuple[tuple[str | None, ...], ...] = ()
    producer_ref: str | None = None
    raw: str = field(default="", repr=False)
    producer_order: int | None = None

    @property
    def slot_id(self) -> str:
        return f"p{self.page_number:04d}:slot:{self.ordinal:04d}"


@dataclass(frozen=True, slots=True)
class PlacementDiagnostic:
    code: str
    page_number: int
    slot_id: str | None = None
    table_id: str | None = None
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class PlacementResult:
    blocks: tuple[SemanticBlock, ...]
    unplaced_content: Mapping[int, tuple[str, ...]]
    diagnostics: tuple[PlacementDiagnostic, ...]


@dataclass(frozen=True, slots=True)
class LogicalTableGroup:
    """Explicitly derived grouping of page-local canonical table records."""

    logical_table_id: str
    fragments: tuple[Any, ...]
    continuation: bool


def _clean(value: str) -> str:
    value = _LOC.sub("", value)
    value = _DOCTAG_WRAPPER.sub("", value)
    return _PAGE_FURNITURE.sub("", value)


def _table_rows(
    body: str,
) -> tuple[tuple[tuple[str, ...], tuple[str | None, ...]], ...]:
    rows: list[tuple[tuple[str, ...], tuple[str | None, ...]]] = []
    for raw_row in _clean(body).split(_NL):
        matches = list(_CELL.finditer(raw_row))
        if not matches:
            continue
        values: list[str] = []
        roles: list[str | None] = []
        for index, match in enumerate(matches):
            end = (
                matches[index + 1].start() if index + 1 < len(matches) else len(raw_row)
            )
            values.append(_clean(raw_row[match.end() : end]))
            token = match.group(0)[1:-1]
            roles.append(
                "header"
                if token == "ched"
                else "row_header"
                if token == "rhed"
                else "data"
            )
        rows.append((tuple(values), tuple(roles)))
    return tuple(rows)


def _list_items(body: str) -> tuple[str, ...]:
    # Nested lists are represented in source order as item text.  The nested
    # tags remain source structure, and are not promoted to domain semantics.
    return tuple(_clean(match.group(1)) for match in _LIST_ITEM.finditer(body))


def _block_from_match(
    match: re.Match[str], page: int, ordinal: int
) -> tuple[SemanticBlock, TableSlot | None]:
    tag = match.group("tag")
    body = _clean(match.group("body"))
    if tag == "otsl":
        parsed_rows = _table_rows(body)
        slot = TableSlot(
            page,
            ordinal,
            tuple(row for row, _ in parsed_rows),
            tuple(role_row for _, role_row in parsed_rows),
            raw=match.group(0),
        )
        return SemanticBlock(
            "table_slot", page, table_slot=slot.slot_id, raw=match.group(0)
        ), slot
    if tag.startswith("section_header_level_"):
        return SemanticBlock(
            "heading", page, body, int(match.group("level")), raw=match.group(0)
        ), None
    if tag == "title":
        return SemanticBlock("heading", page, body, 1, raw=match.group(0)), None
    if tag == "text":
        return SemanticBlock("paragraph", page, body, raw=match.group(0)), None
    if tag == "caption":
        return SemanticBlock("caption", page, body, raw=match.group(0)), None
    if tag == "code":
        return SemanticBlock(
            "code", page, _CODE_TOKEN.sub("", body), raw=match.group(0)
        ), None
    if tag == "formula":
        return SemanticBlock("formula", page, body, raw=match.group(0)), None
    if tag in {"ordered_list", "unordered_list"}:
        return SemanticBlock(
            "list",
            page,
            ordered=tag == "ordered_list",
            items=_list_items(body),
            raw=match.group(0),
        ), None
    raise AssertionError(f"unsupported DocTags block: {tag}")


def doctags_to_intermediate_blocks(
    doctags: str, *, first_page: int = 1
) -> tuple[tuple[SemanticBlock, ...], tuple[TableSlot, ...]]:
    """Convert page-local DocTags into ordered semantic blocks.

    The page sentinel is a producer boundary, not a guessed Markdown rule.
    Text between known tags is retained as generic ``text`` so conversion never
    silently drops source material.
    """
    value = doctags or ""
    blocks: list[SemanticBlock] = []
    slots: list[TableSlot] = []
    page = first_page
    ordinal = 0
    cursor = 0
    for boundary in _PAGE_BREAK.finditer(value):
        _append_fragment(value[cursor : boundary.start()], page, blocks, slots, ordinal)
        blocks.append(
            SemanticBlock("page_boundary", page, level=None, raw=boundary.group(0))
        )
        page += 1
        cursor = boundary.end()
    _append_fragment(value[cursor:], page, blocks, slots, ordinal)
    # Assign producer-local table ordinal deterministically after parsing.  The
    # slot id is intentionally local to this conversion and is not a logical
    # table id.
    counters: dict[int, int] = {}
    normalized: list[SemanticBlock] = []
    slot_by_id: dict[str, TableSlot] = {}
    producer_order = 0
    for block in blocks:
        if block.kind != "table_slot":
            normalized.append(block)
            continue
        index = counters[block.page_number] = counters.get(block.page_number, 0) + 1
        old = next((slot for slot in slots if slot.slot_id == block.table_slot), None)
        if old is None:
            normalized.append(block)
            continue
        slot = TableSlot(
            block.page_number,
            index,
            old.matrix,
            old.roles,
            old.producer_ref,
            old.raw,
            producer_order,
        )
        producer_order += 1
        slot_by_id[slot.slot_id] = slot
        normalized.append(replace(block, table_slot=slot.slot_id))
    return tuple(normalized), tuple(slot_by_id.values())


def _append_fragment(
    fragment: str,
    page: int,
    blocks: list[SemanticBlock],
    slots: list[TableSlot],
    ordinal: int,
) -> None:
    # Parse recognized semantic tags.  Unsupported tags are retained as generic
    # text, while parser wrappers/location tags are transparent.
    cursor = 0
    for match in _TAG_BLOCK.finditer(fragment):
        prefix = _clean(fragment[cursor : match.start()])
        if prefix.strip():
            blocks.append(
                SemanticBlock(
                    "text", page, prefix, raw=fragment[cursor : match.start()]
                )
            )
        if match.group("tag") == "otsl":
            caption = _CAPTION.search(match.group("body"))
            if caption is not None and _clean(caption.group(1)):
                blocks.append(
                    SemanticBlock(
                        "caption", page, _clean(caption.group(1)), raw=caption.group(0)
                    )
                )
        block, slot = _block_from_match(match, page, ordinal + len(slots) + 1)
        blocks.append(block)
        if slot is not None:
            slots.append(slot)
        cursor = match.end()
    suffix = _clean(fragment[cursor:])
    if suffix.strip():
        blocks.append(SemanticBlock("text", page, suffix, raw=fragment[cursor:]))


# Stable, source-scoped IDs.  These functions do not claim that a producer ref
# is durable; it is merely part of the deterministic input namespace.
def stable_stream_id(
    content_sha256: str, preprocess_id: str, kind: str, ordinal: int, *, extra: str = ""
) -> str:
    payload = f"{content_sha256}\0{preprocess_id}\0{kind}\0{ordinal}\0{extra}".encode()
    return hashlib.sha256(payload).hexdigest()[:24]


def semantic_blocks_to_v2(
    blocks: Sequence[SemanticBlock],
    content_sha256: str,
    preprocess_id: str,
    *,
    table_ids: Mapping[str, str] | None = None,
    parser: str = "docling_doctags",
) -> tuple[Any, ...]:
    """Promote producer-observed blocks into the typed v2 block union.

    Table slots are not silently promoted: a slot must be supplied in
    ``table_ids`` after canonical table arbitration.  Unmatched slots are
    omitted and are handled by page-local unplaced content.
    """
    from app.models.parsed_document_v2 import (
        CaptionBlock,
        CodeBlock,
        FormulaBlock,
        HeadingBlock,
        ListBlock,
        PageBreakBlock,
        ParagraphBlock,
        TableReferenceBlock,
        TextBlock,
        deterministic_block_id,
    )

    def to_bbox(value: Any) -> dict[str, float] | None:
        if isinstance(value, Mapping):
            raw = value.get("bbox", value)
            if isinstance(raw, Mapping) and all(
                key in raw for key in ("x0", "y0", "x1", "y1")
            ):
                return {key: float(raw[key]) for key in ("x0", "y0", "x1", "y1")}
            if isinstance(raw, Sequence) and len(raw) == 4:
                return {
                    key: float(item)
                    for key, item in zip(("x0", "y0", "x1", "y1"), raw, strict=True)
                }
        return None

    result: list[Any] = []
    for ordinal, block in enumerate(blocks):
        identity = f"{block.page_number}:{ordinal}:{block.kind}:{block.source_text}:{block.table_slot or ''}"
        block_id = deterministic_block_id(content_sha256, preprocess_id, identity)
        common = {
            "block_id": block_id,
            "page_number": block.page_number,
            "parser": parser,
        }
        if (geometry := to_bbox(block.geometry)) is not None:
            common["bbox"] = geometry
        if block.kind == "page_boundary":
            result.append(PageBreakBlock(**common, next_page=block.page_number + 1))
        elif block.kind == "table_slot":
            table_id = (table_ids or {}).get(block.table_slot or "")
            if table_id is not None:
                result.append(TableReferenceBlock(**common, table_id=table_id))
        elif block.kind == "heading":
            result.append(
                HeadingBlock(**common, text=block.source_text, level=block.level or 1)
            )
        elif block.kind == "paragraph":
            result.append(ParagraphBlock(**common, text=block.source_text))
        elif block.kind == "text":
            result.append(TextBlock(**common, text=block.source_text))
        elif block.kind == "list":
            if block.items:
                result.append(
                    ListBlock(
                        **common, ordered=bool(block.ordered), items=list(block.items)
                    )
                )
        elif block.kind == "code":
            result.append(CodeBlock(**common, text=block.source_text))
        elif block.kind == "formula":
            result.append(FormulaBlock(**common, text=block.source_text))
        elif block.kind == "caption":
            result.append(CaptionBlock(**common, text=block.source_text))
    return tuple(result)


def ocr_pages_to_blocks(
    pages: Mapping[int, str],
    page_lines: Mapping[int, Sequence[Mapping[str, Any]]] | None = None,
) -> tuple[SemanticBlock, ...]:
    """Emit generic ordered OCR text blocks; no semantic kind is inferred."""
    result: list[SemanticBlock] = []
    lines = page_lines or {}
    for page in sorted(pages):
        text = str(pages[page] or "")
        geometry = tuple(lines.get(page, ())) or None
        if text.strip():
            result.append(SemanticBlock("text", page, text, geometry=geometry))
    return tuple(result)


def _matrix_signature(matrix: Sequence[Sequence[str]]) -> tuple[tuple[str, ...], ...]:
    return tuple(tuple(_norm_cell(value).casefold() for value in row) for row in matrix)


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _table_pages(table: Any) -> tuple[int, ...]:
    pages = _field(table, "page_numbers", None)
    if pages is not None:
        return tuple(int(page) for page in pages)
    page = _field(table, "page_number", _field(table, "page", None))
    return (int(page),) if page is not None else ()


def _table_identity(table: Any) -> str:
    # ParsedTable producer refs are capture-local identities used by the
    # reviewed gate. Logical IDs are preferred only after v2 derivation.
    logical = _field(table, "logical_table_id", None)
    if logical:
        return str(logical)
    producer = _field(table, "producer_ref", None)
    if producer:
        return str(producer)
    return str(_field(table, "table_id", ""))


def _table_producer_refs(table: Any) -> set[str]:
    refs: set[str] = set()
    direct = _field(table, "producer_ref", None)
    if direct is not None:
        refs.add(str(direct))
    for span in _field(table, "spans", ()) or ():
        ref = _field(span, "producer_table_ref", None)
        if ref is not None:
            refs.add(str(ref))
    return refs


def match_table_slot(
    slot: TableSlot,
    tables: Sequence[ParsedTable],
    *,
    producer_refs: Mapping[str, str] | None = None,
) -> tuple[ParsedTable | None, tuple[PlacementDiagnostic, ...]]:
    """Match a slot only on exact content/structure and physical page.

    A slot's document-local producer ref may be used by callers when it is
    available, but is never invented.  Ambiguous matches are deliberately
    unplaced rather than resolved by order, adjacency, or similarity.
    """
    candidates = [
        table
        for table in tables
        if slot.page_number in _table_pages(table)
        and _matrix_signature(slot.matrix) == _matrix_signature(_table_matrix(table))
        and _slot_structure_matches(slot, table)
    ]
    if slot.producer_ref is not None:
        identified = [
            table
            for table in tables
            if slot.page_number in _table_pages(table)
            and slot.producer_ref in _table_producer_refs(table)
        ]
        if identified:
            candidates = identified
    if slot.producer_ref is None and slot.producer_order is not None:
        # Both values are zero-based order in the complete producer document.
        # Page-local slot ordinals are intentionally never compared here.
        ordered = [
            table
            for table in candidates
            if _field(table, "producer_order", None) == slot.producer_order
        ]
        if ordered:
            candidates = ordered
    if len(candidates) == 1:
        return candidates[0], ()
    code = "table_slot_unmatched" if not candidates else "table_slot_ambiguous"
    return None, (PlacementDiagnostic(code, slot.page_number, slot.slot_id),)


def _slot_structure_matches(slot: TableSlot, table: ParsedTable) -> bool:
    if not slot.roles:
        return True
    observed = {
        (row, col): role
        for row, values in enumerate(slot.roles)
        for col, role in enumerate(values)
    }
    actual = {(cell.row, cell.col): (cell.role or "data") for cell in table.cells}
    for position, role in observed.items():
        if (
            position in actual
            and role != actual[position]
            and not (role == "header" and actual[position] == "column_header")
        ):
            return False
    return True


def _table_matrix(table: ParsedTable) -> list[list[str]]:
    matrix = [[""] * (table.cols or 0) for _ in range(table.rows or 0)]
    for cell in table.cells:
        if 0 <= cell.row < len(matrix) and 0 <= cell.col < len(matrix[cell.row]):
            matrix[cell.row][cell.col] = cell.text
    return matrix


def place_table_slots(
    blocks: Sequence[SemanticBlock],
    slots: Sequence[TableSlot],
    tables: Sequence[ParsedTable],
) -> PlacementResult:
    slot_map = {slot.slot_id: slot for slot in slots}
    placed_ids: set[str] = set()
    diagnostics: list[PlacementDiagnostic] = []
    output: list[SemanticBlock] = []
    unplaced: dict[int, list[str]] = {}
    for block in blocks:
        if block.kind != "table_slot" or block.table_slot not in slot_map:
            output.append(block)
            continue
        slot = slot_map[block.table_slot]
        table, issues = match_table_slot(slot, tables)
        diagnostics.extend(issues)
        if table is None:
            # A slot remains a producer observation but is not allowed to place
            # an unrelated canonical table inline.  The slot is therefore not
            # emitted into the canonical stream; its canonical table (if any)
            # is listed as page-local unplaced content below.
            continue
        table_id = _table_identity(table)
        if table_id in placed_ids:
            diagnostics.append(
                PlacementDiagnostic(
                    "table_slot_ambiguous", slot.page_number, slot.slot_id, table_id
                )
            )
            continue
        placed_ids.add(table_id)
        output.append(replace(block, table_slot=table_id))
    for table in tables:
        table_id = _table_identity(table)
        if table_id not in placed_ids:
            for page in _table_pages(table):
                unplaced.setdefault(page, []).append(table_id)
                diagnostics.append(
                    PlacementDiagnostic(
                        "table_placement_unverified", page, table_id=table_id
                    )
                )
    return PlacementResult(
        tuple(output),
        {page: tuple(ids) for page, ids in unplaced.items()},
        tuple(diagnostics),
    )


def derive_logical_table_groups(
    tables: Sequence[ParsedTable],
    *,
    continuation_pairs: Iterable[tuple[str, str]] = (),
) -> tuple[LogicalTableGroup, ...]:
    """Group records only through explicit reviewed continuation links.

    Page adjacency, repeated headers, geometry, and textual similarity are
    intentionally absent from this predicate.  Each group retains its
    page-local fragments so the v2 model can attach one Evidence anchor per
    cell without copying geometry or offsets across pages.
    """
    by_id = {_table_identity(table): table for table in tables}
    parent = {table_id: table_id for table_id in by_id}

    def find(table_id: str) -> str:
        while parent[table_id] != table_id:
            parent[table_id] = parent[parent[table_id]]
            table_id = parent[table_id]
        return table_id

    order = {table_id: index for index, table_id in enumerate(by_id)}
    for first, second in sorted((str(a), str(b)) for a, b in continuation_pairs):
        if first not in by_id or second not in by_id:
            raise ValueError("continuation_pair_references_unknown_table")
        first_root, second_root = find(first), find(second)
        if first_root != second_root:
            winner = min(first_root, second_root, key=order.__getitem__)
            parent[second_root if winner == first_root else first_root] = winner

    grouped: dict[str, list[Any]] = {}
    for table in tables:
        grouped.setdefault(find(_table_identity(table)), []).append(table)
    return tuple(
        LogicalTableGroup(
            root,
            tuple(sorted(fragments, key=lambda item: order[_table_identity(item)])),
            len(fragments) > 1,
        )
        for root, fragments in sorted(grouped.items(), key=lambda item: order[item[0]])
    )


__all__ = [
    "SemanticBlock",
    "TableSlot",
    "PlacementDiagnostic",
    "PlacementResult",
    "doctags_to_intermediate_blocks",
    "ocr_pages_to_blocks",
    "semantic_blocks_to_v2",
    "stable_stream_id",
    "match_table_slot",
    "place_table_slots",
    "derive_logical_table_groups",
    "LogicalTableGroup",
]
