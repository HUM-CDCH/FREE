"""Internal parser-stage records used before canonical v2 publication."""

from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.parsed_document_v2 import BoundingBox


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


__all__ = [
    "ParserRun",
    "TextViews",
    "CharSpan",
    "PageQuality",
    "TableCell",
    "ParsedTable",
    "ParsedPage",
]
