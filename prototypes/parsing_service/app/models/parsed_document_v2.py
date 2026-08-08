"""Canonical, portable ``parsed_document.v2`` contract.

The parser keeps richer generation state internally, but this module is the
only document shape that may cross the route/package boundary.  In
particular, producer observations live on table-cell anchors exactly once;
logical table cells and page spans contain only derived/public structure.
"""

from __future__ import annotations

import hashlib
import math
import re
from pathlib import PurePosixPath
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "parsed_document.v2"
V2_PDF_REQUIRED_ERROR_CODE = "v2_source_not_pdf"
V2_PAGE_MAPPING_ERROR_CODE = "v2_physical_page_mapping_unavailable"
V2_GEOMETRY_ERROR_CODE = "v2_evidence_geometry_unavailable"
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_PDF_MEDIA_TYPES = frozenset({"application/pdf", "application/x-pdf"})


class BoundingBox(BaseModel):
    """Finite positive-area geometry in displayed PDF-point page space."""

    model_config = ConfigDict(frozen=True)

    x0: float
    y0: float
    x1: float
    y1: float

    @model_validator(mode="after")
    def validate_geometry(self) -> BoundingBox:
        if not all(
            math.isfinite(value) for value in (self.x0, self.y0, self.x1, self.y1)
        ):
            raise ValueError("BoundingBox coordinates must be finite.")
        if self.x0 >= self.x1 or self.y0 >= self.y1:
            raise ValueError("BoundingBox must have positive area.")
        return self


class SourceInfo(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["upload"]
    original_filename: str | None = None
    media_type: str = "application/pdf"
    byte_size: int | None = Field(default=None, ge=0)


class InputProfile(BaseModel):
    model_config = ConfigDict(frozen=True)

    file_kind: Literal["pdf"] = "pdf"
    detected_mime: str = "application/pdf"
    pdf_version: str | None = None
    has_text_layer: bool | None = None
    has_images: bool | None = None


class DocumentMetadata(BaseModel):
    model_config = ConfigDict(frozen=True)

    document_id: str
    content_sha256: str
    source: SourceInfo
    created_at: str
    page_count: int | None = Field(default=None, ge=0)
    language_hints: list[str] = Field(default_factory=list)
    is_encrypted: bool | None = None
    input_profile: InputProfile = Field(default_factory=InputProfile)


def _require_identity(content_sha256: str, preprocess_id: str) -> None:
    if not _HASH_RE.fullmatch(content_sha256):
        raise ValueError("content_sha256 must be a lowercase SHA-256 digest")
    if not preprocess_id:
        raise ValueError("preprocess_id must be non-empty")


def deterministic_id(kind: str, content_sha256: str, preprocess_id: str, identity: str) -> str:
    if not kind or not identity:
        raise ValueError("deterministic IDs require kind and identity")
    _require_identity(content_sha256, preprocess_id)
    payload = "\0".join((SCHEMA_VERSION, kind, content_sha256, preprocess_id, identity))
    return f"{kind}_{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"


def deterministic_block_id(content_sha256: str, preprocess_id: str, identity: str) -> str:
    return deterministic_id("block", content_sha256, preprocess_id, identity)


def deterministic_table_id(content_sha256: str, preprocess_id: str, identity: str) -> str:
    return deterministic_id("table", content_sha256, preprocess_id, identity)


def deterministic_anchor_id(content_sha256: str, preprocess_id: str, identity: str) -> str:
    return deterministic_id("anchor", content_sha256, preprocess_id, identity)


def deterministic_occurrence_id(
    content_sha256: str, preprocess_id: str, identity: str
) -> str:
    return deterministic_id("occurrence", content_sha256, preprocess_id, identity)


class MarkdownByteSpan(BaseModel):
    """Half-open UTF-8 byte offsets into emitted canonical Markdown."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_order(self) -> MarkdownByteSpan:
        if self.end < self.start:
            raise ValueError("Markdown byte span end must not precede start")
        return self


class PublicParserProvenance(BaseModel):
    """Sanitized parser provenance; cache refs and digests stay internal."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    parser: str
    version: str | None = None
    status: Literal["success", "failed", "skipped"]
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None


class ParserDiagnostic(BaseModel):
    """Typed, portable diagnostic emitted by a parser/publication gate."""

    model_config = ConfigDict(frozen=True, extra="allow")

    code: str
    reason: str | None = None
    detail: str | None = None
    page_number: int | None = Field(default=None, ge=1)


class TextEvidenceAnchor(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["text"] = "text"
    anchor_id: str
    occurrence_id: str
    content_sha256: str
    preprocess_id: str
    block_id: str
    page_number: int = Field(ge=1)
    markdown_span: MarkdownByteSpan
    bbox: BoundingBox


class ProducerTableCellObservation(BaseModel):
    """One observed page-local producer location for one table cell."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    occurrence_id: str
    page_number: int = Field(ge=1)
    producer_ref: str | None = None
    row_offset: int = Field(ge=0)
    column_offset: int = Field(ge=0)
    row_span: int = Field(default=1, ge=1)
    column_span: int = Field(default=1, ge=1)
    bbox: BoundingBox


class TableCellEvidenceAnchor(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["table_cell"] = "table_cell"
    anchor_id: str
    content_sha256: str
    preprocess_id: str
    logical_table_id: str
    cell_id: str
    canonical_row: int = Field(ge=0)
    canonical_column: int = Field(ge=0)
    producer_observations: list[ProducerTableCellObservation] = Field(min_length=1)


EvidenceAnchor = Annotated[
    TextEvidenceAnchor | TableCellEvidenceAnchor,
    Field(discriminator="kind"),
]


class EvidenceIndex(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    anchors: list[EvidenceAnchor] = Field(default_factory=list)


class ParserAttribution(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    parser: str
    version: str | None = None


class TableParserAttribution(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    content_parser: ParserAttribution
    structure_parser: ParserAttribution
    geometry_parser: ParserAttribution | None = None


class ContentBlockBase(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    block_id: str
    page_number: int = Field(ge=1)
    parser: str
    bbox: BoundingBox | None = None
    markdown_span: MarkdownByteSpan | None = None


class HeadingBlock(ContentBlockBase):
    kind: Literal["heading"] = "heading"
    text: str
    level: int = Field(ge=1)


class ParagraphBlock(ContentBlockBase):
    kind: Literal["paragraph"] = "paragraph"
    text: str


class TextBlock(ContentBlockBase):
    kind: Literal["text"] = "text"
    text: str


class ListBlock(ContentBlockBase):
    kind: Literal["list"] = "list"
    ordered: bool
    items: list[str] = Field(min_length=1)


class CodeBlock(ContentBlockBase):
    kind: Literal["code"] = "code"
    text: str
    language: str | None = None


class FormulaBlock(ContentBlockBase):
    kind: Literal["formula"] = "formula"
    text: str


class CaptionBlock(ContentBlockBase):
    kind: Literal["caption"] = "caption"
    text: str


class TableReferenceBlock(ContentBlockBase):
    kind: Literal["table"] = "table"
    table_id: str


class PageBreakBlock(ContentBlockBase):
    kind: Literal["page_break"] = "page_break"
    next_page: int = Field(ge=1)


ContentBlock = Annotated[
    HeadingBlock
    | ParagraphBlock
    | TextBlock
    | ListBlock
    | CodeBlock
    | FormulaBlock
    | CaptionBlock
    | TableReferenceBlock
    | PageBreakBlock,
    Field(discriminator="kind"),
]


class CanonicalTableCell(BaseModel):
    """Canonical value/structure; its single anchor owns producer Evidence."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    cell_id: str
    row: int = Field(ge=0)
    column: int = Field(ge=0)
    text: str = ""
    role: str | None = None
    rowspan: int = Field(default=1, ge=1)
    colspan: int = Field(default=1, ge=1)
    bbox: BoundingBox | None = None
    evidence_anchor_id: str


class LogicalTablePageSpan(BaseModel):
    """Page/range/producer identity only; no duplicated anchor collection."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    page_number: int = Field(ge=1)
    producer_table_ref: str | None = None
    page_local_row_start: int = Field(default=0, ge=0)
    page_local_row_end: int | None = Field(default=None, ge=0)
    page_local_col_count: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_range(self) -> LogicalTablePageSpan:
        if self.page_local_row_end is not None and self.page_local_row_end < self.page_local_row_start:
            raise ValueError("page-local table span rows must be ordered")
        return self


class LogicalTable(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    table_id: str
    rows: int | None = Field(default=None, ge=0)
    cols: int | None = Field(default=None, ge=0)
    cells: list[CanonicalTableCell] = Field(default_factory=list)
    spans: list[LogicalTablePageSpan] = Field(min_length=1)
    parser_attribution: TableParserAttribution
    continuation: Literal["page_local", "derived_continuation"] = "page_local"

    @model_validator(mode="after")
    def validate_shape(self) -> LogicalTable:
        pages = [span.page_number for span in self.spans]
        if len(pages) != len(set(pages)):
            raise ValueError("logical table spans must have unique physical pages")
        ids = [cell.cell_id for cell in self.cells]
        if len(ids) != len(set(ids)):
            raise ValueError("logical table cell IDs must be unique")
        if self.rows is not None and any(cell.row >= self.rows for cell in self.cells):
            raise ValueError("table cell row is outside the logical table")
        if self.cols is not None and any(cell.column >= self.cols for cell in self.cells):
            raise ValueError("table cell column is outside the logical table")
        if self.continuation == "derived_continuation" and len(self.spans) < 2:
            raise ValueError("derived continuation requires multiple physical pages")
        return self


class ParsedPageV2(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    page_number: int = Field(ge=1)
    width_pt: float = Field(gt=0)
    height_pt: float = Field(gt=0)
    rotation: int
    ordered_content: list[str] = Field(default_factory=list)
    unplaced_content: list[str] = Field(default_factory=list)
    markdown_span: MarkdownByteSpan | None = None

    @model_validator(mode="after")
    def validate_geometry(self) -> ParsedPageV2:
        for value in (self.width_pt, self.height_pt):
            if not math.isfinite(value):
                raise ValueError("physical page geometry must be finite")
        if self.rotation % 90:
            raise ValueError("physical page rotation must be a multiple of 90 degrees")
        return self


class ArtifactManifestV2(BaseModel):
    """Fixed package-relative public artifacts; cache paths never enter JSON."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    source_ref: Literal["source.pdf"] = "source.pdf"
    parsed_json_ref: Literal["parsed_document.json"] = "parsed_document.json"
    markdown_ref: Literal["artifacts/document.llm.md"] = "artifacts/document.llm.md"


class PublicPreprocessingMetadata(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    preprocess_id: str
    profile: str = "production_default"
    service_version: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    status: Literal["completed", "completed_with_warnings", "failed"]
    warnings: list[str] = Field(default_factory=list)


class PublicPageDecision(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    page_number: int = Field(ge=1)
    selected_text_parser: str
    selected_layout_parser: str | None = None
    selected_table_parser: str | None = None
    fallback_used: bool = False
    reason: str
    scores: dict[str, float] = Field(default_factory=dict)


class PublicArbitrationResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    primary_document_parser: str
    strategy: str
    page_decisions: list[PublicPageDecision] = Field(default_factory=list)


class ParsedDocument(BaseModel):
    """The sole public typed document interface."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    schema_version: Literal["parsed_document.v2"] = SCHEMA_VERSION
    document: DocumentMetadata
    preprocessing: PublicPreprocessingMetadata
    page_count: int = Field(ge=1)
    page_mapping_verified: Literal[True] = True
    artifacts: ArtifactManifestV2 = Field(default_factory=ArtifactManifestV2)
    parser_runs: list[PublicParserProvenance] = Field(default_factory=list)
    arbitration: PublicArbitrationResult | None = None
    diagnostics: list[ParserDiagnostic] = Field(default_factory=list)
    content_stream: list[ContentBlock] = Field(default_factory=list)
    pages: list[ParsedPageV2] = Field(default_factory=list)
    tables: list[LogicalTable] = Field(default_factory=list)
    evidence_index: EvidenceIndex

    @model_validator(mode="after")
    def validate_contract(self) -> ParsedDocument:
        source = self.document.source
        media_type = (source.media_type or "").lower().split(";", 1)[0].strip()
        if source.kind != "upload" or self.document.input_profile.file_kind.lower() != "pdf" or media_type not in _PDF_MEDIA_TYPES:
            raise ValueError(f"{V2_PDF_REQUIRED_ERROR_CODE}: Source Document must be a PDF")
        if self.document.page_count is not None and self.document.page_count != self.page_count:
            raise ValueError("v2 page_count must match document.page_count")
        _require_identity(self.document.content_sha256, self.preprocessing.preprocess_id)
        if self.document.document_id != f"sha256:{self.document.content_sha256}":
            raise ValueError("v2 document_id must be derived from content_sha256")

        expected_pages = set(range(1, self.page_count + 1))
        page_numbers = [page.page_number for page in self.pages]
        if set(page_numbers) != expected_pages or len(page_numbers) != self.page_count:
            raise ValueError("v2 pages must provide complete unique physical-page coverage")
        pages_by_number = {page.page_number: page for page in self.pages}

        def require_safe_bbox(bbox: BoundingBox, page_number: int) -> None:
            page = pages_by_number[page_number]
            if bbox.x0 < 0 or bbox.y0 < 0 or bbox.x1 > page.width_pt or bbox.y1 > page.height_pt:
                raise ValueError(
                    f"{V2_GEOMETRY_ERROR_CODE}: Evidence geometry must stay inside its physical page"
                )

        blocks_by_id: dict[str, ContentBlockBase] = {}
        for block in self.content_stream:
            if block.block_id in blocks_by_id:
                raise ValueError("v2 content block IDs must be unique")
            if block.page_number not in expected_pages:
                raise ValueError("v2 content block references an unknown physical page")
            if isinstance(block, PageBreakBlock) and block.next_page not in expected_pages:
                raise ValueError("v2 page boundary references an unknown physical page")
            blocks_by_id[block.block_id] = block

        tables_by_id: dict[str, LogicalTable] = {}
        for table in self.tables:
            if table.table_id in tables_by_id:
                raise ValueError("v2 logical table IDs must be unique")
            tables_by_id[table.table_id] = table
            if any(span.page_number not in expected_pages for span in table.spans):
                raise ValueError("v2 logical table span references an unknown physical page")

        placed: set[str] = set()
        for page in self.pages:
            for block_id in page.ordered_content:
                block = blocks_by_id.get(block_id)
                if block is None or block.page_number != page.page_number:
                    raise ValueError("v2 ordered content references an invalid block")
                if isinstance(block, TableReferenceBlock):
                    if block.table_id not in tables_by_id:
                        raise ValueError("v2 table reference targets an unknown table")
                    placed.add(block.table_id)
            for table_id in page.unplaced_content:
                table = tables_by_id.get(table_id)
                if table is None or page.page_number not in {span.page_number for span in table.spans}:
                    raise ValueError("v2 unplaced table reference is invalid")
                placed.add(table_id)
        if placed != set(tables_by_id):
            raise ValueError("every v2 logical table must have a published placement")

        anchors_by_id: dict[str, EvidenceAnchor] = {}
        occurrence_ids: set[str] = set()
        for anchor in self.evidence_index.anchors:
            if anchor.anchor_id in anchors_by_id:
                raise ValueError("v2 Evidence Anchor IDs must be unique")
            if anchor.preprocess_id != self.preprocessing.preprocess_id or anchor.content_sha256 != self.document.content_sha256:
                raise ValueError("v2 Evidence Anchor identity does not match the document")
            occurrences = (
                [(anchor.occurrence_id, anchor.page_number)]
                if isinstance(anchor, TextEvidenceAnchor)
                else [
                    (observation.occurrence_id, observation.page_number)
                    for observation in anchor.producer_observations
                ]
            )
            for occurrence_id, page_number in occurrences:
                if occurrence_id in occurrence_ids:
                    raise ValueError("v2 Evidence occurrence IDs must be unique")
                if page_number not in expected_pages:
                    raise ValueError(
                        "v2 Evidence Anchor references an unknown physical page"
                    )
                occurrence_ids.add(occurrence_id)
            if isinstance(anchor, TextEvidenceAnchor):
                require_safe_bbox(anchor.bbox, anchor.page_number)
            else:
                for observation in anchor.producer_observations:
                    require_safe_bbox(observation.bbox, observation.page_number)
            anchors_by_id[anchor.anchor_id] = anchor

        for anchor in self.evidence_index.anchors:
            if isinstance(anchor, TextEvidenceAnchor):
                block = blocks_by_id.get(anchor.block_id)
                if block is None or isinstance(block, (TableReferenceBlock, PageBreakBlock)):
                    raise ValueError("v2 text Evidence Anchor references a non-text block")
                if (
                    block.page_number != anchor.page_number
                    or block.markdown_span != anchor.markdown_span
                    or block.bbox != anchor.bbox
                ):
                    raise ValueError("v2 text Evidence Anchor does not match its block span")
            else:
                table = tables_by_id.get(anchor.logical_table_id)
                if table is None:
                    raise ValueError("v2 table Evidence Anchor references an unknown table")
                cell = next((candidate for candidate in table.cells if candidate.cell_id == anchor.cell_id), None)
                if cell is None or cell.evidence_anchor_id != anchor.anchor_id:
                    raise ValueError("v2 table Evidence Anchor references an unknown cell")
                if anchor.canonical_row != cell.row or anchor.canonical_column != cell.column:
                    raise ValueError("v2 table Evidence Anchor canonical coordinates disagree")
                for observation in anchor.producer_observations:
                    spans = [
                        span
                        for span in table.spans
                        if span.page_number == observation.page_number
                        and (
                            span.producer_table_ref is None
                            or span.producer_table_ref == observation.producer_ref
                        )
                        and (
                            span.page_local_row_end is None
                            or span.page_local_row_start
                            <= observation.row_offset
                            <= span.page_local_row_end
                        )
                    ]
                    if len(spans) != 1:
                        raise ValueError(
                            "v2 table Evidence occurrence must resolve to one page span"
                        )

        expected_cell_anchors: set[str] = set()
        for table in self.tables:
            for cell in table.cells:
                anchor = anchors_by_id.get(cell.evidence_anchor_id)
                if not isinstance(anchor, TableCellEvidenceAnchor) or anchor.logical_table_id != table.table_id or anchor.cell_id != cell.cell_id:
                    raise ValueError("every canonical table cell requires exactly one table Evidence Anchor")
                expected_cell_anchors.add(anchor.anchor_id)
        actual_cell_anchors = {anchor.anchor_id for anchor in self.evidence_index.anchors if isinstance(anchor, TableCellEvidenceAnchor)}
        if actual_cell_anchors != expected_cell_anchors:
            raise ValueError("table Evidence must contain exactly one anchor per canonical cell")
        return self


__all__ = [
    "SCHEMA_VERSION", "V2_PDF_REQUIRED_ERROR_CODE", "V2_PAGE_MAPPING_ERROR_CODE", "V2_GEOMETRY_ERROR_CODE",
    "BoundingBox", "SourceInfo", "InputProfile", "DocumentMetadata",
    "deterministic_id", "deterministic_block_id", "deterministic_table_id", "deterministic_anchor_id", "deterministic_occurrence_id",
    "MarkdownByteSpan", "PublicParserProvenance", "ParserDiagnostic", "ParserAttribution", "TableParserAttribution",
    "ContentBlock", "ContentBlockBase", "HeadingBlock", "ParagraphBlock", "TextBlock", "ListBlock", "CodeBlock",
    "FormulaBlock", "CaptionBlock", "TableReferenceBlock", "PageBreakBlock", "CanonicalTableCell",
    "LogicalTablePageSpan", "LogicalTable", "ParsedPageV2", "ArtifactManifestV2", "PublicPreprocessingMetadata",
    "PublicPageDecision", "PublicArbitrationResult",
    "ParsedDocument", "EvidenceAnchor", "EvidenceIndex", "TextEvidenceAnchor",
    "ProducerTableCellObservation", "TableCellEvidenceAnchor",
]
