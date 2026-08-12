"""Normalization of selected parser output into canonical pages and text views."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.models.parsed_document import (
    CharSpan,
    PageQuality,
    ParsedPage,
    ParserRun,
    TextViews,
)
from app.parsing.adapters.pymupdf_inspect import PdfInspection, PdfPageInspection

PAGE_SEGMENTATION_UNAVAILABLE_WARNING = (
    "selected parser produced document-level markdown; "
    "exact selected-parser page segmentation unavailable"
)


def read_text(path: Path) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as exc:
        raise FileNotFoundError(f"Markdown artifact not found: {path.name}") from exc


def selected_page_texts(task_dir: Path, selected: ParserRun) -> tuple[list[str], bool]:
    """Return the selected parser's page texts and whether they are exact per-page."""
    if not selected.output_ref:
        raise ValueError("Selected parser has no markdown artifact.")
    task_root = task_dir.resolve()
    markdown_path = (task_dir / selected.output_ref).resolve()
    if not markdown_path.is_relative_to(task_root):
        raise ValueError("Selected parser artifact path escaped task directory.")

    def _page_suffix(path: Path) -> int:
        try:
            return int(path.stem.rsplit("_", 1)[-1])
        except (TypeError, ValueError):
            return 0

    if selected.parser == "docling_images":
        page_files = sorted(markdown_path.parent.glob("page_*.md"), key=_page_suffix)
        if page_files:
            return [read_text(page_file) for page_file in page_files], True

    if selected.parser == "paddleocr":
        page_dirs = sorted(
            (path for path in markdown_path.parent.glob("page_*") if path.is_dir()),
            key=_page_suffix,
        )
        page_texts = []
        for page_dir in page_dirs:
            md_file = page_dir / f"{page_dir.name}.md"
            if md_file.exists():
                page_texts.append(read_text(md_file))
        if page_texts:
            return page_texts, True

    return [read_text(markdown_path)], False


def build_page_marked_text(pages: list[ParsedPage]) -> str:
    """Render pages as '[PAGE n]\\ntext' blocks separated by blank lines."""
    return "\n\n".join(f"[PAGE {page.page}]\n{page.text}" for page in pages)


def _page_quality(text: str, warnings: list[str]) -> PageQuality:
    return PageQuality(
        char_count=len(text), word_count=len(text.split()), warnings=warnings
    )


def _inspection_pages(inspection: PdfInspection) -> list[PdfPageInspection]:
    return list(inspection.pages) if inspection.status == "completed" else []


@dataclass(frozen=True)
class _NormalizationRequest:
    selected_page_markdown: list[str]
    selected_parser: str | None
    inspection: PdfInspection
    exact_page_segmentation: bool
    document_markdown: str


def _normalize_exact_pages(
    request: _NormalizationRequest,
    inspected_pages: list[PdfPageInspection],
) -> tuple[list[ParsedPage], TextViews]:
    """Emit one page per physical page with exact plain and page-marked spans."""
    selected = request.selected_page_markdown
    pages: list[ParsedPage] = []
    plain_chunks: list[str] = []
    marked_chunks: list[str] = []
    plain_cursor = 0
    marked_cursor = 0
    for page in range(1, max(request.inspection.page_count, len(selected)) + 1):
        text = selected[page - 1] if page <= len(selected) else ""
        inspected = inspected_pages[page - 1] if page <= len(inspected_pages) else None
        warnings = list(getattr(inspected, "warnings", ()))
        if page > len(selected):
            warnings.append(
                "selected parser did not produce page-specific text for this page"
            )
        separator = "\n\n" if plain_chunks else ""
        marker = f"[PAGE {page}]\n"
        plain_chunks.extend((separator, text))
        marked_chunks.extend((separator, marker, text))
        plain_start = plain_cursor + len(separator)
        marked_start = marked_cursor + len(separator) + len(marker)
        plain_cursor = plain_start + len(text)
        marked_cursor = marked_start + len(text)
        pages.append(
            ParsedPage(
                page=page,
                width_pt=getattr(inspected, "width_pt", None),
                height_pt=getattr(inspected, "height_pt", None),
                rotation=getattr(inspected, "rotation", None),
                selected_parser=request.selected_parser,
                text=text,
                markdown=text,
                char_span=CharSpan(
                    plain_text_start=plain_start,
                    plain_text_end=plain_cursor,
                    page_marked_text_start=marked_start,
                    page_marked_text_end=marked_cursor,
                ),
                quality=_page_quality(text, warnings),
            )
        )
    return pages, TextViews(
        plain_text="".join(plain_chunks),
        page_marked_text="".join(marked_chunks),
        markdown=request.document_markdown,
    )


def _normalize_document_pages(
    request: _NormalizationRequest,
    inspected_pages: list[PdfPageInspection],
) -> tuple[list[ParsedPage], TextViews]:
    """Fall back to inspected native text with no page-marked provenance."""
    pages: list[ParsedPage] = []
    plain_chunks: list[str] = []
    cursor = 0
    for page, inspected in enumerate(inspected_pages, start=1):
        text = inspected.native_text
        separator = "\n\n" if plain_chunks else ""
        plain_chunks.extend((separator, text))
        start = cursor + len(separator)
        cursor = start + len(text)
        pages.append(
            ParsedPage(
                page=page,
                width_pt=inspected.width_pt,
                height_pt=inspected.height_pt,
                rotation=inspected.rotation,
                selected_parser=request.selected_parser,
                text=text,
                markdown=None,
                char_span=CharSpan(plain_text_start=start, plain_text_end=cursor),
                quality=_page_quality(
                    text,
                    [*inspected.warnings, PAGE_SEGMENTATION_UNAVAILABLE_WARNING],
                ),
            )
        )
    return pages, TextViews(
        plain_text="".join(plain_chunks),
        page_marked_text=f"[DOCUMENT]\n{request.document_markdown}",
        markdown=request.document_markdown,
    )


def normalize_markdown_to_pages(
    **arguments: Any,
) -> tuple[list[ParsedPage], TextViews]:
    """Build canonical pages with exact char spans plus the document text views."""
    request = _NormalizationRequest(**arguments)
    inspected_pages = _inspection_pages(request.inspection)
    if request.exact_page_segmentation:
        return _normalize_exact_pages(request, inspected_pages)
    return _normalize_document_pages(request, inspected_pages)
