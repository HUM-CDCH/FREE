"""Normalization of selected parser output into canonical pages and text views."""

from __future__ import annotations

from pathlib import Path

from app.models.parsed_document import (
    CharSpan,
    PageQuality,
    ParsedPage,
    ParserRun,
    TextViews,
)
from app.parsing.adapters.pymupdf_inspect import PdfInspection

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


def _inspection_pages(inspection: PdfInspection) -> list:
    return list(inspection.pages) if inspection.status == "completed" else []


def normalize_markdown_to_pages(
    *,
    selected_page_markdown: list[str],
    selected_parser: str | None,
    inspection: PdfInspection,
    exact_page_segmentation: bool,
    document_markdown: str,
) -> tuple[list[ParsedPage], TextViews]:
    """Build canonical pages with exact char spans plus the document text views."""
    inspected_pages = _inspection_pages(inspection)

    if exact_page_segmentation:
        pages: list[ParsedPage] = []
        plain_cursor = 0
        marked_cursor = 0
        plain_chunks: list[str] = []
        marked_chunks: list[str] = []
        page_count = max(inspection.page_count, len(selected_page_markdown))
        for index in range(1, page_count + 1):
            text = (
                selected_page_markdown[index - 1]
                if index <= len(selected_page_markdown)
                else ""
            )
            inspected = (
                inspected_pages[index - 1] if index <= len(inspected_pages) else None
            )
            if plain_chunks:
                plain_chunks.append("\n\n")
                plain_cursor += 2
                marked_chunks.append("\n\n")
                marked_cursor += 2
            marker = f"[PAGE {index}]\n"
            marked_chunks.append(marker)
            marked_cursor += len(marker)

            char_span = CharSpan(
                plain_text_start=plain_cursor,
                plain_text_end=plain_cursor + len(text),
                page_marked_text_start=marked_cursor,
                page_marked_text_end=marked_cursor + len(text),
            )
            plain_chunks.append(text)
            plain_cursor += len(text)
            marked_chunks.append(text)
            marked_cursor += len(text)

            page_warnings = list(
                getattr(inspected, "warnings", []) if inspected else []
            )
            if index > len(selected_page_markdown):
                page_warnings.append(
                    "selected parser did not produce page-specific text for this page"
                )
            pages.append(
                ParsedPage(
                    page=index,
                    width_pt=getattr(inspected, "width_pt", None),
                    height_pt=getattr(inspected, "height_pt", None),
                    rotation=getattr(inspected, "rotation", None),
                    selected_parser=selected_parser,
                    text=text,
                    markdown=text,
                    char_span=char_span,
                    quality=_page_quality(text, page_warnings),
                )
            )
        return pages, TextViews(
            plain_text="".join(plain_chunks),
            page_marked_text="".join(marked_chunks),
            markdown=document_markdown,
        )

    # Document-level markdown only: pages carry native PyMuPDF text with exact
    # plain_text spans; the page-marked view keeps the whole selected markdown.
    pages = []
    plain_chunks = []
    plain_cursor = 0
    for index, inspected in enumerate(inspected_pages, start=1):
        text = inspected.native_text
        if plain_chunks:
            plain_chunks.append("\n\n")
            plain_cursor += 2
        char_span = CharSpan(
            plain_text_start=plain_cursor,
            plain_text_end=plain_cursor + len(text),
        )
        plain_chunks.append(text)
        plain_cursor += len(text)
        pages.append(
            ParsedPage(
                page=index,
                width_pt=inspected.width_pt,
                height_pt=inspected.height_pt,
                rotation=inspected.rotation,
                selected_parser=selected_parser,
                text=text,
                markdown=None,
                char_span=char_span,
                quality=_page_quality(
                    text, [*inspected.warnings, PAGE_SEGMENTATION_UNAVAILABLE_WARNING]
                ),
            )
        )
    return pages, TextViews(
        plain_text="".join(plain_chunks),
        page_marked_text=f"[DOCUMENT]\n{document_markdown}",
        markdown=document_markdown,
    )
