"""Convert Docling DocTags into canonical LLM Markdown.

The converter keeps physical page boundaries as structured offsets while
rendering the subset of DocTags used by FREE. Unsupported table tokens are
preserved rather than silently deleting source content.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_LOC_RE = re.compile(r"<loc_[^>]+>")
_OTSL_BLOCK = re.compile(r"<otsl>(.*?)</otsl>", re.DOTALL)
_SECTION_HDR = re.compile(
    r"<section_header_level_(\d+)>(.*?)</section_header_level_\1>",
    re.DOTALL,
)
_TEXT_BLOCK = re.compile(r"<text>(.*?)</text>", re.DOTALL)
_TITLE_BLOCK = re.compile(r"<title>(.*?)</title>", re.DOTALL)
_CAPTION_BLOCK = re.compile(r"<caption>(.*?)</caption>", re.DOTALL)
_CODE_BLOCK = re.compile(r"<code>(.*?)</code>", re.DOTALL)
_CODE_LANGUAGE_TOKEN = re.compile(r"^<_[^<>\n]+_>")
_FORMULA_BLOCK = re.compile(r"<formula>(.*?)</formula>", re.DOTALL)
_LIST_TAG = re.compile(r"<(\/)?(ordered_list|unordered_list|list_item)>")
_PAGE_BREAK = re.compile(r"<page_break>\s*")
_PAGE_FOOTER = re.compile(r"<page_footer>(.*?)</page_footer>", re.DOTALL)
_PAGE_HEADER = re.compile(r"<page_header>(.*?)</page_header>", re.DOTALL)
_DOCTAG_WRAPPER = re.compile(r"</?doctag>")
_PAGE_SENTINEL = "\ue000FREE_PAGE_BREAK\ue001"
_CELL_WITH_TEXT = {"ched", "rhed", "srow", "fcel"}
_CELL_WITHOUT_TEXT = {"ecel", "lcel", "ucel", "xcel"}
_CELL_TOKEN_PATTERN = re.compile(r"<(ched|rhed|srow|fcel|ecel|lcel|ucel|xcel)>")
_TABLE_RESTART = "\ue000FREE_TABLE_RESTART\ue001"
_REMAINING_STRUCTURAL_TAGS = re.compile(
    r"</?(?:otsl|ched|rhed|srow|fcel|ecel|lcel|ucel|xcel|nl)>"
)
_TRANSPARENT_WRAPPERS = re.compile(
    r"</?(?:paragraph|reference|footnote|formula|code|list_item|ordered_list|"
    r"unordered_list|picture|table|inline|handwritten_text)>"
)


def strip_doctag_locations(value: str) -> str:
    return _LOC_RE.sub("", value)


def _escape_md_cell(value: str) -> str:
    return (
        (value or "")
        .replace("\\", "\\\\")
        .replace("\n", " ")
        .replace("|", "\\|")
        .strip()
    )


def _parse_otsl_row(row: str) -> list[str]:
    """Split on known OTSL tokens without treating source ``<`` as markup."""
    matches = list(_CELL_TOKEN_PATTERN.finditer(row))
    cells: list[str] = []
    for index, match in enumerate(matches):
        token = match.group(1)
        end = matches[index + 1].start() if index + 1 < len(matches) else len(row)
        content = row[match.end() : end].strip()
        if token in _CELL_WITH_TEXT:
            cells.append(content)
        elif token in _CELL_WITHOUT_TEXT:
            # Preserve unexpected content rather than silently discarding it.
            cells.append(content)
    return cells


def _row_uses_header(raw_row: str) -> bool:
    return "<ched>" in raw_row


def _md_table_row(cells: list[str]) -> str:
    return "| " + " | ".join(_escape_md_cell(cell) for cell in cells) + " |"


@dataclass
class _OtslTableBuf:
    """One logical Markdown table assembled from physical-page fragments."""

    caption_prefix: str = ""
    header_cells: list[str] = field(default_factory=list)
    body_entries: list[list[str] | str] = field(default_factory=list)

    def render(self) -> str:
        if not self.header_cells:
            return self.caption_prefix
        rows = [entry for entry in self.body_entries if isinstance(entry, list)]
        column_count = max(
            len(self.header_cells),
            max((len(row) for row in rows), default=0),
        )
        header = self.header_cells + [""] * (column_count - len(self.header_cells))
        header_line = _md_table_row(header)
        separator = "| " + " | ".join("---" for _ in header) + " |"
        lines = [header_line, separator]
        for entry in self.body_entries:
            if entry == _TABLE_RESTART:
                lines.extend((header_line, separator))
            elif isinstance(entry, str):
                lines.append(entry)
            else:
                row = entry + [""] * (column_count - len(entry))
                lines.append(_md_table_row(row))
        return self.caption_prefix + "\n".join(lines) + "\n"


def _otsl_inner_rows(inner: str) -> tuple[str, list[str], list[list[str]]]:
    inner = strip_doctag_locations(inner)
    caption_line = ""
    caption_match = _CAPTION_BLOCK.search(inner)
    if caption_match:
        caption = _escape_md_cell(caption_match.group(1))
        if caption:
            caption_line = f"\n*{caption}*\n"
        inner = _CAPTION_BLOCK.sub("", inner)

    candidates = [row.strip() for row in inner.split("<nl>") if row.strip()]
    parsed = [(raw, _parse_otsl_row(raw)) for raw in candidates]
    parsed = [(raw, cells) for raw, cells in parsed if cells]
    return (
        caption_line,
        [raw for raw, _ in parsed],
        [cells for _, cells in parsed],
    )


def _between_otsl_mergeable(doc: str, previous_end: int, next_start: int) -> bool:
    """Merge only fragments separated by a real physical page boundary."""
    between = doc[previous_end:next_start]
    if _PAGE_SENTINEL not in between:
        return False
    stripped = _PAGE_FOOTER.sub("", between)
    stripped = _PAGE_HEADER.sub("", stripped)
    stripped = _DOCTAG_WRAPPER.sub("", stripped)
    stripped = stripped.replace(_PAGE_SENTINEL, "")
    stripped = strip_doctag_locations(stripped)
    return not stripped.strip()


def _interstitial_table_entries(
    value: str,
    previous_end: int,
    next_start: int,
    *,
    drop_page_footers: bool,
) -> list[str]:
    between = value[previous_end:next_start]
    token_pattern = re.compile(
        rf"{re.escape(_PAGE_SENTINEL)}|<page_footer>(.*?)</page_footer>",
        re.DOTALL,
    )
    entries: list[str] = []
    for match in token_pattern.finditer(between):
        if match.group(0) == _PAGE_SENTINEL:
            entries.append(_PAGE_SENTINEL)
        elif not drop_page_footers:
            footer = _escape_md_cell(match.group(1) or "")
            if footer:
                entries.extend(("", f"*{footer}*", ""))
    entries.append(_TABLE_RESTART)
    return entries


def _replace_otsl_blocks_merged(value: str, *, drop_page_footers: bool) -> str:
    """Render OTSL tables and merge body-only fragments across page breaks."""
    matches = list(_OTSL_BLOCK.finditer(value))
    if not matches:
        return value

    output: list[str] = []
    position = 0
    buffer: _OtslTableBuf | None = None

    for index, match in enumerate(matches):
        caption, raw_rows, rows = _otsl_inner_rows(match.group(1))
        if not rows:
            if buffer is not None:
                output.append(buffer.render())
                buffer = None
            # Preserve both preceding text and the unsupported OTSL block. Silent
            # deletion is worse than leaving diagnostic source markup in the view.
            output.append(value[position : match.end()])
            position = match.end()
            continue

        first_is_header = bool(raw_rows) and _row_uses_header(raw_rows[0])
        merge = (
            buffer is not None
            and not first_is_header
            and not caption.strip()
            and index > 0
            and _between_otsl_mergeable(value, matches[index - 1].end(), match.start())
        )

        if buffer is not None and not merge:
            output.append(buffer.render())
            buffer = None

        if not merge:
            output.append(value[position : match.start()])

        if first_is_header:
            header, body = rows[0], rows[1:]
            column_count = max(len(header), max((len(row) for row in body), default=0))
            normalized_header = header + [""] * (column_count - len(header))
            body_entries: list[list[str] | str] = []
            body_entries.extend(body)
            buffer = _OtslTableBuf(
                caption_prefix=caption,
                header_cells=normalized_header,
                body_entries=body_entries,
            )
        elif merge and buffer is not None:
            buffer.body_entries.extend(
                _interstitial_table_entries(
                    value,
                    matches[index - 1].end(),
                    match.start(),
                    drop_page_footers=drop_page_footers,
                )
            )
            buffer.body_entries.extend(rows)
        else:
            column_count = max(len(row) for row in rows)
            normalized_rows = [row + [""] * (column_count - len(row)) for row in rows]
            header, body = normalized_rows[0], normalized_rows[1:]
            output.append(
                caption
                + "\n".join(
                    [
                        _md_table_row(header),
                        "| " + " | ".join("---" for _ in header) + " |",
                        *(_md_table_row(row) for row in body),
                    ]
                )
                + "\n"
            )

        position = match.end()

    if buffer is not None:
        output.append(buffer.render())
    output.append(value[position:])
    return "".join(output)


@dataclass(frozen=True)
class PageMarkdownSpan:
    page: int
    text: str
    llm_markdown_start: int
    llm_markdown_end: int


@dataclass(frozen=True)
class DocTagsMarkdownResult:
    markdown: str
    page_spans: tuple[PageMarkdownSpan, ...]


def _render_lists(value: str) -> str:
    output: list[str] = []
    list_types: list[str] = []
    position = 0

    for match in _LIST_TAG.finditer(value):
        output.append(value[position : match.start()])
        closing, tag = match.groups()
        if tag in {"ordered_list", "unordered_list"}:
            if closing:
                if len(list_types) == 1:
                    output.append("\n\n")
                if list_types:
                    list_types.pop()
            else:
                list_types.append(tag)
        elif not closing and list_types:
            wraps_nested_list = re.match(
                r"\s*<(?:ordered_list|unordered_list)>", value[match.end() :]
            )
            if not wraps_nested_list:
                marker = "1." if list_types[-1] == "ordered_list" else "-"
                output.append(f"\n{'   ' * (len(list_types) - 1)}{marker} ")
        position = match.end()

    output.append(value[position:])
    return "".join(output)


def compose_page_markdown(page_texts: list[str]) -> DocTagsMarkdownResult:
    """Compose exact page offsets using an unambiguous structured page list."""
    if not page_texts:
        return DocTagsMarkdownResult(markdown="", page_spans=())

    chunks: list[str] = []
    spans: list[PageMarkdownSpan] = []
    cursor = 0
    for page, raw_text in enumerate(page_texts, start=1):
        text = raw_text.strip()
        if page > 1:
            separator = "\n\n---\n\n"
            chunks.append(separator)
            cursor += len(separator)
        start = cursor
        chunks.append(text)
        cursor += len(text)
        spans.append(
            PageMarkdownSpan(
                page=page,
                text=text,
                llm_markdown_start=start,
                llm_markdown_end=cursor,
            )
        )
    return DocTagsMarkdownResult(markdown="".join(chunks), page_spans=tuple(spans))


def convert_doctags_to_markdown(
    doctags: str, *, drop_page_footers: bool = True
) -> DocTagsMarkdownResult:
    """Convert DocTags and retain exact page-derived Markdown offsets."""
    value = strip_doctag_locations(doctags or "")
    protected_blocks: list[str] = []
    semantic_sentinel = "\ue002"
    while semantic_sentinel in value:
        semantic_sentinel += "\ue002"

    def protect_block(match: re.Match[str]) -> str:
        source = match.group(1)
        if match.re is _CODE_BLOCK:
            source = _CODE_LANGUAGE_TOKEN.sub("", source)
            longest_run = max(
                (len(run) for run in re.findall(r"`+", source)), default=0
            )
            fence = "`" * max(3, longest_run + 1)
            rendered = f"{fence}\n{source}\n{fence}"
        else:
            rendered = f"$$\n{source}\n$$"
        protected_blocks.append(rendered)
        index = len(protected_blocks) - 1
        return f"\n\n{semantic_sentinel}{index}{semantic_sentinel}\n\n"

    value = _CODE_BLOCK.sub(protect_block, value)
    value = _FORMULA_BLOCK.sub(protect_block, value)
    value = _PAGE_BREAK.sub(_PAGE_SENTINEL, value)
    value = _replace_otsl_blocks_merged(
        value,
        drop_page_footers=drop_page_footers,
    )

    if drop_page_footers:
        value = _PAGE_FOOTER.sub("", value)
    else:
        value = _PAGE_FOOTER.sub(
            lambda match: "\n*" + _escape_md_cell(match.group(1)) + "*\n",
            value,
        )
    value = _PAGE_HEADER.sub("", value)

    def render_section(match: re.Match[str]) -> str:
        try:
            level = min(max(int(match.group(1)), 1), 6)
        except (TypeError, ValueError):
            level = 1
        return f"\n\n{'#' * level} {_escape_md_cell(match.group(2))}\n\n"

    value = _SECTION_HDR.sub(render_section, value)
    value = _TITLE_BLOCK.sub(
        lambda match: f"\n\n# {_escape_md_cell(match.group(1))}\n\n", value
    )
    value = _TEXT_BLOCK.sub(
        lambda match: "\n\n" + match.group(1).strip() + "\n\n", value
    )
    value = _CAPTION_BLOCK.sub(
        lambda match: f"\n\n> {match.group(1).strip()}\n\n", value
    )
    value = _render_lists(value)
    value = _DOCTAG_WRAPPER.sub("", value)
    value = _TRANSPARENT_WRAPPERS.sub("", value)
    value = _REMAINING_STRUCTURAL_TAGS.sub("", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    for index, rendered in enumerate(protected_blocks):
        value = value.replace(
            f"{semantic_sentinel}{index}{semantic_sentinel}", rendered
        )

    return compose_page_markdown(value.split(_PAGE_SENTINEL))


def doctags_to_markdown(doctags: str, *, drop_page_footers: bool = True) -> str:
    """Compatibility wrapper returning only canonical Markdown."""
    return convert_doctags_to_markdown(
        doctags, drop_page_footers=drop_page_footers
    ).markdown


def llm_markdown_page_spans(llm_markdown: str) -> list[PageMarkdownSpan]:
    """Best-effort compatibility parser for standalone page-rule Markdown.

    Production DocTags ingestion uses ``DocTagsMarkdownResult.page_spans`` and
    does not infer page boundaries from rendered Markdown.
    """
    if not llm_markdown:
        return []

    separator = re.compile(r"(?m)^[ \t]*---[ \t]*(?:\n|$)")
    spans: list[PageMarkdownSpan] = []
    cursor = 0
    page = 1
    for match in separator.finditer(llm_markdown):
        raw_chunk = llm_markdown[cursor : match.start()]
        text = raw_chunk.strip()
        start = cursor + (len(raw_chunk) - len(raw_chunk.lstrip()))
        spans.append(
            PageMarkdownSpan(
                page=page,
                text=text,
                llm_markdown_start=start,
                llm_markdown_end=start + len(text),
            )
        )
        cursor = match.end()
        page += 1

    raw_chunk = llm_markdown[cursor:]
    text = raw_chunk.strip()
    start = cursor + (len(raw_chunk) - len(raw_chunk.lstrip()))
    spans.append(
        PageMarkdownSpan(
            page=page,
            text=text,
            llm_markdown_start=start,
            llm_markdown_end=start + len(text),
        )
    )
    return spans


def load_doctags_from_parsed_json(path: str | Path) -> str:
    try:
        data: Any = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    if isinstance(data, dict):
        return str(data.get("raw_text") or "").strip()
    return ""
