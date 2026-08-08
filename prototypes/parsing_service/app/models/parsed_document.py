"""The canonical parsed-document model support types.

``ParsedDocument`` is resolved lazily to the single public v2 model in
``parsed_document_v2``.  The small producer records in this module are kept
internal because table extraction and parser orchestration need a typed seam
before publication; they are not a second public document contract.
"""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "parsed_document.v2"


class BoundingBox(BaseModel):
    """Page-space bounding box when a parser can provide evidence geometry.

    Convention: PDF points, top-left origin (y grows downward), in the
    displayed (post-/Rotate) page space matching ParsedPage.width_pt/height_pt.
    Producers must convert (camelot: flip y against page height; OCR: scale
    image pixels by 72/dpi) before emitting.
    """

    model_config = ConfigDict(frozen=True)

    x0: float
    y0: float
    x1: float
    y1: float

    @model_validator(mode="after")
    def validate_geometry(self) -> BoundingBox:
        values = (self.x0, self.y0, self.x1, self.y1)
        if not all(math.isfinite(value) for value in values):
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

    file_kind: str = "pdf"
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


class PreprocessingMetadata(BaseModel):
    model_config = ConfigDict(frozen=True)

    preprocess_id: str
    profile: str = "production_default"
    config_hash: str
    service_version: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    status: Literal["completed", "completed_with_warnings", "failed"]
    warnings: list[str] = Field(default_factory=list)


class ParserRun(BaseModel):
    model_config = ConfigDict(frozen=True)

    parser: str
    version: str | None = None
    status: Literal["success", "failed", "skipped"]
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    input_ref: str | None = None
    output_ref: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None


class PageDecision(BaseModel):
    model_config = ConfigDict(frozen=True)

    page: int = Field(ge=1)
    selected_text_parser: str
    selected_layout_parser: str | None = None
    selected_table_parser: str | None = None
    fallback_used: bool = False
    reason: str
    scores: dict[str, float] = Field(default_factory=dict)


class ArbitrationResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    primary_document_parser: str
    strategy: str
    page_decisions: list[PageDecision] = Field(default_factory=list)


class TextViews(BaseModel):
    model_config = ConfigDict(frozen=True)

    plain_text: str
    page_marked_text: str
    markdown: str | None = None
    llm_markdown: str | None = None
    doc_tags_simplified: str | None = None


class CharSpan(BaseModel):
    """Exact character offsets of a page's text inside text views.

    Optional offsets are None when the selected parser did not produce exact
    page segmentation for that view.
    """

    model_config = ConfigDict(frozen=True)

    plain_text_start: int = Field(ge=0)
    plain_text_end: int = Field(ge=0)
    page_marked_text_start: int | None = Field(default=None, ge=0)
    page_marked_text_end: int | None = Field(default=None, ge=0)
    llm_markdown_start: int | None = Field(default=None, ge=0)
    llm_markdown_end: int | None = Field(default=None, ge=0)
    doc_tags_simplified_start: int | None = Field(default=None, ge=0)
    doc_tags_simplified_end: int | None = Field(default=None, ge=0)


class PageQuality(BaseModel):
    model_config = ConfigDict(frozen=True)

    char_count: int = Field(default=0, ge=0)
    word_count: int = Field(default=0, ge=0)
    text_density: float | None = None
    ocr_confidence: float | None = Field(default=None, ge=0, le=1)
    garbled_text_score: float | None = None
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_ocr_confidence(self) -> PageQuality:
        if self.ocr_confidence is not None and not math.isfinite(self.ocr_confidence):
            raise ValueError("OCR confidence must be finite.")
        return self


class TableCell(BaseModel):
    model_config = ConfigDict(frozen=True)

    row: int = Field(ge=0)
    col: int = Field(ge=0)
    text: str = ""
    role: str | None = None
    rowspan: int = Field(default=1, ge=1)
    colspan: int = Field(default=1, ge=1)
    bbox: BoundingBox | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def validate_confidence(self) -> TableCell:
        if self.confidence is not None and not math.isfinite(self.confidence):
            raise ValueError("Cell confidence must be finite.")
        return self


class ParsedTable(BaseModel):
    model_config = ConfigDict(frozen=True)

    table_id: str
    page_number: int = Field(ge=1)
    # Document-local producer observations; never logical-table identities.
    producer_ref: str | None = None
    producer_order: int | None = Field(default=None, ge=0)
    source_parser: str | None = None
    # Internal producer-stage role attribution; publication converts this to
    # the strict v2 table model.
    content_parser: str | None = None
    structure_parser: str | None = None
    geometry_parser: str | None = None
    bbox: BoundingBox | None = None
    rows: int | None = Field(default=None, ge=0)
    cols: int | None = Field(default=None, ge=0)
    cells: list[TableCell] = Field(default_factory=list)
    markdown_view: str | None = None


class ParsedPage(BaseModel):
    model_config = ConfigDict(frozen=True)

    page: int = Field(ge=1)
    width_pt: float | None = Field(default=None, ge=0)
    height_pt: float | None = Field(default=None, ge=0)
    rotation: int | None = None
    selected_parser: str | None = None
    text: str
    markdown: str | None = None
    char_span: CharSpan | None = None
    quality: PageQuality = Field(default_factory=PageQuality)
    blocks: list[dict[str, Any]] = Field(default_factory=list)
    word_boxes_ref: str | None = None


def __getattr__(name: str) -> Any:
    """Expose the one canonical model without introducing an import cycle."""
    if name == "ParsedDocument":
        from app.models.parsed_document_v2 import ParsedDocument

        return ParsedDocument
    raise AttributeError(name)


__all__ = [
    "BoundingBox",
    "SourceInfo",
    "InputProfile",
    "DocumentMetadata",
    "PreprocessingMetadata",
    "ParserRun",
    "PageDecision",
    "ArbitrationResult",
    "TextViews",
    "CharSpan",
    "PageQuality",
    "TableCell",
    "ParsedTable",
    "ParsedPage",
    "ParsedDocument",
]
