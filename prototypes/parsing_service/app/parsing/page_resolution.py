"""Resolve canonical page text, fallback, views, and parser decisions."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, NamedTuple

from app.models.parsed_document import (
    ArbitrationResult,
    CharSpan,
    PageDecision,
    PageQuality,
    ParsedPage,
    ParserRun,
    TextViews,
)
from app.parsing.adapters.pymupdf_inspect import PdfInspection
from app.parsing.doctags_to_markdown import compose_page_markdown

_DOCLING = "docling_doctags"
_OCR = "paddleocr_fallback"


# ponytail: these request objects only exist so the entry points below stay at
# one parameter; they carry no behaviour. Callers pass keywords, not instances.
@dataclass(frozen=True)
class _PageViewRequest:
    llm_markdown: str
    llm_spans: list[Any] | tuple[Any, ...]
    selected_parser: str
    inspection: PdfInspection
    parser_by_page: dict[int, str]
    doc_tags_simplified: str | None = None
    doc_tags_spans: list[Any] | tuple[Any, ...] = ()
    page_mapping_verified: bool = True
    ocr_blocks_by_page: dict[int, list[dict[str, Any]]] = field(default_factory=dict)


@dataclass(frozen=True)
class _PageFallbackRequest:
    docling_spans: list[Any] | tuple[Any, ...]
    inspection: PdfInspection
    fallback_pages: list[int] | frozenset[int]
    ocr_output: Any | None


@dataclass(frozen=True)
class _ArbitrationRequest:
    inspection: PdfInspection
    docling_run: ParserRun
    parser_by_page: dict[int, str]
    page_mapping_verified: bool = True
    table_pages: frozenset[int] = frozenset()
    table_parser_by_page: dict[int, str] = field(default_factory=dict)


class _PageViewResult(NamedTuple):
    pages: list[ParsedPage]
    text_views: TextViews


class _PageFallbackResult(NamedTuple):
    llm_markdown: str
    llm_spans: tuple[Any, ...]
    parser_by_page: dict[int, str]
    unresolved_pages: list[int]
    ocr_blocks_by_page: dict[int, list[dict[str, Any]]]


def _garbled_text_score(text: str) -> float:
    if not text:
        return 1.0
    suspicious = sum(
        1
        for character in text
        if character == "\ufffd"
        or (unicodedata.category(character) == "Cc" and character not in "\n\r\t")
    )
    non_space = [character for character in text if not character.isspace()]
    alphanumeric = sum(character.isalnum() for character in non_space)
    low_alphanumeric = (
        max(0.0, 0.35 - (alphanumeric / len(non_space))) if non_space else 0.35
    )
    repeated_runs = len(re.findall(r"(.)\1{7,}", text))
    return min(
        1.0,
        (suspicious / len(text)) * 4 + low_alphanumeric + min(0.5, repeated_runs * 0.1),
    )


def _quality_for_text(
    text: str, warnings: list[str], ocr_confidence: float | None = None
) -> PageQuality:
    return PageQuality(
        char_count=len(text),
        word_count=len(text.split()),
        ocr_confidence=ocr_confidence,
        garbled_text_score=_garbled_text_score(text),
        warnings=warnings,
    )


def _text_views(request: _PageViewRequest, page_marked_text: str) -> TextViews:
    return TextViews(
        plain_text=request.llm_markdown,
        page_marked_text=page_marked_text,
        markdown=request.llm_markdown,
        llm_markdown=request.llm_markdown,
        doc_tags_simplified=request.doc_tags_simplified,
    )


def _unmapped_pages_and_views(request: _PageViewRequest) -> _PageViewResult:
    pages = [
        ParsedPage(
            page=page.page,
            width_pt=page.width_pt,
            height_pt=page.height_pt,
            rotation=page.rotation,
            selected_parser=None,
            text="",
            markdown=None,
            char_span=None,
            quality=_quality_for_text(
                "",
                [*page.warnings, "physical_page_mapping_unavailable"],
            ),
        )
        for page in request.inspection.pages
    ]
    marked_text = f"[DOCUMENT]\n{request.llm_markdown}"
    return _PageViewResult(pages, _text_views(request, marked_text))


def _mapped_page(
    request: _PageViewRequest,
    page_number: int,
    span: Any | None,
    doctag_span: Any | None,
    marked_span: tuple[int, int],
) -> ParsedPage:
    inspected_pages = request.inspection.pages
    inspected = (
        inspected_pages[page_number - 1]
        if page_number <= len(inspected_pages)
        else None
    )
    text = span.text if span is not None else ""
    document_end = len(request.llm_markdown)
    llm_start = span.llm_markdown_start if span is not None else document_end
    llm_end = span.llm_markdown_end if span is not None else document_end
    warnings = list(getattr(inspected, "warnings", []))
    if span is None:
        warnings.append("Canonical parsing did not provide a physical page span.")
    blocks = request.ocr_blocks_by_page.get(page_number, [])
    confidence = (
        round(sum(block["confidence"] for block in blocks) / len(blocks), 4)
        if blocks
        else None
    )
    return ParsedPage(
        page=page_number,
        width_pt=getattr(inspected, "width_pt", None),
        height_pt=getattr(inspected, "height_pt", None),
        rotation=getattr(inspected, "rotation", None),
        selected_parser=request.parser_by_page.get(
            page_number, request.selected_parser
        ),
        text=text,
        markdown=text,
        char_span=CharSpan(
            plain_text_start=llm_start,
            plain_text_end=llm_end,
            page_marked_text_start=marked_span[0],
            page_marked_text_end=marked_span[1],
            llm_markdown_start=llm_start,
            llm_markdown_end=llm_end,
            doc_tags_simplified_start=getattr(doctag_span, "llm_markdown_start", None),
            doc_tags_simplified_end=getattr(doctag_span, "llm_markdown_end", None),
        ),
        quality=_quality_for_text(text, warnings, ocr_confidence=confidence),
        blocks=blocks,
    )


def _mapped_pages_and_views(request: _PageViewRequest) -> _PageViewResult:
    span_by_page = {span.page: span for span in request.llm_spans}
    doctag_span_by_page = {span.page: span for span in request.doc_tags_spans}
    page_count = max(
        request.inspection.page_count,
        max(span_by_page, default=0),
    )

    pages: list[ParsedPage] = []
    marked_chunks: list[str] = []
    cursor = 0
    for page_number in range(1, page_count + 1):
        span = span_by_page.get(page_number)
        text = span.text if span is not None else ""
        if marked_chunks:
            marked_chunks.append("\n\n")
            cursor += 2
        marker = f"[PAGE {page_number}]\n"
        marked_chunks.append(marker)
        cursor += len(marker)
        marked_start = cursor
        marked_chunks.append(text)
        cursor += len(text)
        pages.append(
            _mapped_page(
                request,
                page_number,
                span,
                doctag_span_by_page.get(page_number),
                (marked_start, cursor),
            )
        )
    return _PageViewResult(pages, _text_views(request, "".join(marked_chunks)))


def _pages_and_views_from_llm_markdown(**kwargs: Any) -> _PageViewResult:
    request = _PageViewRequest(**kwargs)
    if not request.page_mapping_verified:
        return _unmapped_pages_and_views(request)
    return _mapped_pages_and_views(request)


def _pages_requiring_fallback(
    docling_spans: list[Any] | tuple[Any, ...],
    inspection: PdfInspection,
) -> list[int]:
    span_by_page = {span.page: span for span in docling_spans}
    fallback_pages: list[int] = []
    for page_number in range(1, inspection.page_count + 1):
        span = span_by_page.get(page_number)
        doctag_text = span.text.strip() if span is not None else ""
        inspected_page = inspection.pages[page_number - 1]
        native_text = inspected_page.native_text.strip()
        # Unknown visual inventories still require OCR; only a fully inspected
        # empty page is safe to preserve as an intentional blank.
        verified_blank = (
            span is not None
            and not doctag_text
            and not native_text
            and not inspected_page.image_count
            # An unknown drawing inventory is not a verified blank page.
            and inspected_page.drawing_count == 0
        )
        low_quality = _garbled_text_score(doctag_text) >= 0.25 or (
            len(doctag_text) < 32 and len(native_text) >= 200
        )
        if not verified_blank and (not doctag_text or low_quality):
            fallback_pages.append(page_number)
    return fallback_pages


def _resolved_fallback_page(
    docling_text: str,
    page_number: int,
    ocr_output: Any | None,
) -> tuple[str, str, list[dict[str, Any]], bool]:
    """Return (text, parser, ocr_blocks, unresolved) for one fallback page."""
    completed = (
        ocr_output is not None
        and ocr_output.status == "success"
        and page_number in ocr_output.pages
    )
    ocr_text = (
        str(ocr_output.pages.get(page_number) or "").strip() if completed else ""
    )
    if ocr_text:
        lines = getattr(ocr_output, "page_lines", {}).get(page_number) or []
        return ocr_text, _OCR, lines, False
    if docling_text:
        return docling_text, _DOCLING, [], False
    if completed:
        # The OCR adapter processed the page and confirmed it is blank.
        return "", _OCR, [], False
    return "", _DOCLING, [], True


def _merge_page_fallback_text(**kwargs: Any) -> _PageFallbackResult:
    request = _PageFallbackRequest(**kwargs)
    span_by_page = {span.page: span for span in request.docling_spans}
    fallback_pages = set(request.fallback_pages)

    parser_by_page: dict[int, str] = {}
    page_texts: list[str] = []
    unresolved_pages: list[int] = []
    ocr_blocks_by_page: dict[int, list[dict[str, Any]]] = {}

    for page_number in range(1, request.inspection.page_count + 1):
        span = span_by_page.get(page_number)
        text = span.text.strip() if span is not None else ""
        parser = _DOCLING
        if page_number in fallback_pages:
            text, parser, blocks, unresolved = _resolved_fallback_page(
                text, page_number, request.ocr_output
            )
            if blocks:
                ocr_blocks_by_page[page_number] = blocks
            if unresolved:
                unresolved_pages.append(page_number)
        parser_by_page[page_number] = parser
        page_texts.append(text)

    composed = compose_page_markdown(page_texts)
    return _PageFallbackResult(
        llm_markdown=composed.markdown,
        llm_spans=tuple(composed.page_spans),
        parser_by_page=parser_by_page,
        unresolved_pages=unresolved_pages,
        ocr_blocks_by_page=ocr_blocks_by_page,
    )


def _page_decision(
    request: _ArbitrationRequest,
    page_number: int,
    layout_parser: str | None,
) -> PageDecision:
    selected_parser = request.parser_by_page.get(page_number, _DOCLING)
    fallback_used = selected_parser != _DOCLING
    scores = {_DOCLING: 0.0 if fallback_used else 1.0}
    if fallback_used:
        scores[selected_parser] = 1.0
    if not request.page_mapping_verified:
        reason = "document_level_mapping_unavailable"
    elif fallback_used:
        reason = f"{selected_parser}_page_fallback"
    else:
        reason = "docling_doctags_primary"
    return PageDecision(
        page=page_number,
        selected_text_parser=selected_parser,
        selected_layout_parser=layout_parser,
        selected_table_parser=(
            request.table_parser_by_page.get(page_number)
            or ("camelot_stream" if page_number in request.table_pages else None)
            or layout_parser
        ),
        fallback_used=fallback_used,
        reason=reason,
        scores=scores,
    )


def _docling_arbitration(**kwargs: Any) -> ArbitrationResult:
    request = _ArbitrationRequest(**kwargs)
    layout_parser = _DOCLING if request.docling_run.status == "success" else None
    return ArbitrationResult(
        primary_document_parser=(
            _DOCLING if _DOCLING in request.parser_by_page.values() else _OCR
        ),
        strategy=(
            "docling_primary_ocr_page_fallback"
            if request.page_mapping_verified
            else "docling_document_level_mapping_unavailable"
        ),
        page_decisions=[
            _page_decision(request, page_number, layout_parser)
            for page_number in range(1, request.inspection.page_count + 1)
        ],
    )
