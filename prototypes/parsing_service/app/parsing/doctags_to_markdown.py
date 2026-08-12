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
# Docling emits exactly four consecutive <loc_N> tokens (x0,y0,x1,y1, each
# normalized 0-499 relative to page size) immediately inside a rendered
# element's opening tag — confirmed against real Docling output, e.g.
# "<text><loc_60><loc_107><loc_321><loc_124>FREE Docling integration fixture</text>".
_LOC_QUAD_RE = re.compile(r"<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>")
_OTSL_BLOCK = re.compile(r"<otsl>(.*?)</otsl>", re.DOTALL)
_SECTION_HDR = re.compile(
    r"<section_header_level_(\d+)>(.*?)</section_header_level_\1>",
    re.DOTALL,
)
_NUMBERED_HEADING = re.compile(r"^\s*(\d+(?:\.\d+){0,5})\.?(?=\s+\S)")
_TEXT_BLOCK = re.compile(r"<text>(.*?)</text>", re.DOTALL)
_TITLE_BLOCK = re.compile(r"<title>(.*?)</title>", re.DOTALL)
_CAPTION_BLOCK = re.compile(r"<caption>(.*?)</caption>", re.DOTALL)
_CODE_BLOCK = re.compile(r"<code>(.*?)</code>", re.DOTALL)
_CODE_LANGUAGE_TOKEN = re.compile(r"^<_[^<>\n]+_>")
_FORMULA_BLOCK = re.compile(r"<formula>(.*?)</formula>", re.DOTALL)
_LIST_TAG = re.compile(r"<(\/)?(ordered_list|unordered_list|list_item)>")
_LIST_CONTAINER_START = re.compile(r"\s*<(?:ordered_list|unordered_list)>")
_PAGE_BREAK = re.compile(r"<page_break>\s*")
_PAGE_FOOTER = re.compile(r"<page_footer>(.*?)</page_footer>", re.DOTALL)
_PAGE_HEADER = re.compile(r"<page_header>(.*?)</page_header>", re.DOTALL)
_DOCTAG_WRAPPER = re.compile(r"</?doctag>")
_PAGE_SENTINEL = "\ue000FREE_PAGE_BREAK\ue001"
_LIST_MARKERS = {"ordered_list": "1.", "unordered_list": "-"}
_CELL_TOKEN_PATTERN = re.compile(
    r"<(?:ched|rhed|srow|fcel|ecel|lcel|ucel|xcel)>"
)
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


def _numbered_heading_level(text: str) -> int | None:
    """Infer scientific-article heading depth from leading numbering only."""
    match = _NUMBERED_HEADING.match(strip_doctag_locations(text))
    if not match:
        return None
    return min(match.group(1).count(".") + 1, 6)


def _parse_otsl_row(row: str) -> list[str]:
    """Split on known OTSL tokens without treating source ``<`` as markup."""
    matches = list(_CELL_TOKEN_PATTERN.finditer(row))
    if not matches:
        return []
    boundaries = [match.start() for match in matches[1:]]
    boundaries.append(len(row))
    return [
        row[match.end() : boundary].strip()
        for match, boundary in zip(matches, boundaries, strict=True)
    ]


def _row_uses_header(raw_row: str) -> bool:
    return "<ched>" in raw_row


def _md_table_row(cells: list[str]) -> str:
    return "| " + " | ".join(_escape_md_cell(cell) for cell in cells) + " |"


@dataclass
class _OtslTableBuf:
    """One logical Markdown table assembled from physical-page fragments."""

    caption_prefix: str
    header_cells: list[str]
    body_entries: list[list[str] | str]

    @classmethod
    def from_rows(cls, caption: str, rows: list[list[str]]) -> _OtslTableBuf:
        return cls(
            caption_prefix=caption,
            header_cells=rows[0],
            body_entries=[*rows[1:]],
        )

    def render(self) -> str:
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
    caption_match = _CAPTION_BLOCK.search(inner)
    caption = _escape_md_cell(caption_match.group(1)) if caption_match else ""
    caption_line = f"\n*{caption}*\n" if caption else ""
    inner = _CAPTION_BLOCK.sub("", inner)
    parsed = [
        (raw, cells)
        for candidate in inner.split("<nl>")
        if (raw := candidate.strip())
        if (cells := _parse_otsl_row(raw))
    ]
    return (
        caption_line,
        [raw for raw, _ in parsed],
        [cells for _, cells in parsed],
    )


@dataclass(frozen=True)
class _OtslFragment:
    start: int
    end: int
    caption: str
    rows: list[list[str]]
    starts_with_header: bool

    @classmethod
    def from_match(cls, match: re.Match[str]) -> _OtslFragment:
        caption, raw_rows, rows = _otsl_inner_rows(match.group(1))
        starts_with_header = (
            _row_uses_header(raw_rows[0]) if raw_rows else False
        )
        return cls(
            start=match.start(),
            end=match.end(),
            caption=caption,
            rows=rows,
            starts_with_header=starts_with_header,
        )


@dataclass
class _OtslRenderer:
    value: str
    page_sentinel: str
    drop_page_footers: bool
    output: list[str] = field(default_factory=list, init=False)
    position: int = field(default=0, init=False)
    previous_end: int | None = field(default=None, init=False)
    buffer: _OtslTableBuf | None = field(default=None, init=False)
    interstitial_tokens: re.Pattern[str] = field(init=False)

    def __post_init__(self) -> None:
        self.interstitial_tokens = re.compile(
            rf"{re.escape(self.page_sentinel)}|"
            r"<page_footer>(.*?)</page_footer>",
            re.DOTALL,
        )

    def render(self) -> str:
        for match in _OTSL_BLOCK.finditer(self.value):
            self._consume(_OtslFragment.from_match(match))
            self.previous_end = match.end()
        self._flush()
        self.output.append(self.value[self.position :])
        return "".join(self.output)

    def _consume(self, fragment: _OtslFragment) -> None:
        if not fragment.rows:
            self._preserve_unsupported(fragment)
            return
        merge_target = self._merge_target(fragment)
        if merge_target is None:
            self._start(fragment)
        else:
            self._merge(merge_target, fragment)
        self.position = fragment.end

    def _preserve_unsupported(self, fragment: _OtslFragment) -> None:
        self._flush()
        self.output.append(self.value[self.position : fragment.end])
        self.position = fragment.end

    def _merge_target(
        self, fragment: _OtslFragment
    ) -> tuple[_OtslTableBuf, int] | None:
        buffer = self.buffer
        previous_end = self.previous_end
        target = None
        if buffer is not None and previous_end is not None:
            may_continue = not fragment.starts_with_header and not fragment.caption
            if may_continue and self._between_mergeable(previous_end, fragment.start):
                target = (buffer, previous_end)
        return target

    def _between_mergeable(self, previous_end: int, next_start: int) -> bool:
        between = self.value[previous_end:next_start]
        if self.page_sentinel not in between:
            return False
        stripped = _PAGE_FOOTER.sub("", between)
        stripped = _PAGE_HEADER.sub("", stripped)
        stripped = _DOCTAG_WRAPPER.sub("", stripped)
        stripped = stripped.replace(self.page_sentinel, "")
        stripped = strip_doctag_locations(stripped)
        return not stripped.strip()

    def _start(self, fragment: _OtslFragment) -> None:
        self._flush()
        self.output.append(self.value[self.position : fragment.start])
        table = _OtslTableBuf.from_rows(fragment.caption, fragment.rows)
        if fragment.starts_with_header:
            self.buffer = table
        else:
            self.output.append(table.render())

    def _merge(
        self,
        target: tuple[_OtslTableBuf, int],
        fragment: _OtslFragment,
    ) -> None:
        buffer, previous_end = target
        buffer.body_entries.extend(
            self._interstitial_entries(previous_end, fragment.start)
        )
        buffer.body_entries.extend(fragment.rows)

    def _interstitial_entries(
        self, previous_end: int, next_start: int
    ) -> list[str]:
        between = self.value[previous_end:next_start]
        entries: list[str] = []
        for match in self.interstitial_tokens.finditer(between):
            entries.extend(self._interstitial_token(match))
        entries.append(_TABLE_RESTART)
        return entries

    def _interstitial_token(self, match: re.Match[str]) -> list[str]:
        if match.group(0) == self.page_sentinel:
            return [self.page_sentinel]
        if self.drop_page_footers:
            return []
        footer = _escape_md_cell(match.group(1) or "")
        if not footer:
            return []
        return ["", f"*{footer}*", ""]

    def _flush(self) -> None:
        if self.buffer is None:
            return
        self.output.append(self.buffer.render())
        self.buffer = None


def _replace_otsl_blocks_merged(
    value: str,
    *,
    drop_page_footers: bool,
    page_sentinel: str,
) -> str:
    """Render OTSL tables and merge body-only fragments across page breaks."""
    return _OtslRenderer(value, page_sentinel, drop_page_footers).render()


@dataclass(frozen=True)
class PageMarkdownSpan:
    page: int
    text: str
    llm_markdown_start: int
    llm_markdown_end: int


@dataclass(frozen=True)
class MarkdownAnchor:
    """A rendered block's absolute position, keyed to the final Markdown.

    ``bbox`` is ``(x0, y0, x1, y1)`` in PDF points, top-left origin, already
    converted from Docling's normalized 0-500 location tokens using the
    block's page width/height — never left as raw normalized values.
    """

    markdown_start: int
    markdown_end: int
    page: int
    bbox: tuple[float, float, float, float]


@dataclass(frozen=True)
class DocTagsMarkdownResult:
    markdown: str
    page_spans: tuple[PageMarkdownSpan, ...]
    anchors: tuple[MarkdownAnchor, ...] = ()


@dataclass
class _ListRenderer:
    value: str
    list_types: list[str] = field(default_factory=list)

    def render(self) -> str:
        return _LIST_TAG.sub(self._render_tag, self.value)

    def _render_tag(self, match: re.Match[str]) -> str:
        closing, tag = match.groups()
        if tag == "list_item":
            return self._render_item(closing, match.end())
        return self._render_container(closing, tag)

    def _render_container(self, closing: str | None, tag: str) -> str:
        if not closing:
            self.list_types.append(tag)
            return ""
        separator = "\n\n" if len(self.list_types) == 1 else ""
        del self.list_types[-1:]
        return separator

    def _render_item(self, closing: str | None, end: int) -> str:
        if closing:
            return ""
        if not self.list_types:
            return ""
        if _LIST_CONTAINER_START.match(self.value, end):
            return ""
        marker = _LIST_MARKERS[self.list_types[-1]]
        indent = "   " * (len(self.list_types) - 1)
        return f"\n{indent}{marker} "


def _render_lists(value: str) -> str:
    return _ListRenderer(value).render()


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


def _sentinelize_anchor_locations(
    value: str, sentinel_base: str, sentinel_end: str
) -> tuple[str, list[tuple[int, int, int, int]]]:
    """Replace each location-token quadruple with a sentinel, recording its
    raw normalized (x0, y0, x1, y1) values by sentinel index. Any leftover
    individual <loc_...> token that isn't part of a clean quadruple (e.g.
    malformed input) is stripped exactly as `strip_doctag_locations` already
    did, so no stray location token can ever reach the rendered Markdown.

    Location tokens inside `<otsl>...</otsl>` table blocks are left completely
    untouched here: table cells get their bounding boxes from a separate,
    purpose-built pipeline, and `_otsl_inner_rows` still discards their raw
    `<loc_...>` tokens unchanged via `strip_doctag_locations` later.
    """
    raw_boxes: list[tuple[int, int, int, int]] = []

    def replace_quad(match: re.Match[str]) -> str:
        raw_boxes.append(tuple(int(match.group(i)) for i in range(1, 5)))  # type: ignore[arg-type]
        return f"{sentinel_base}{len(raw_boxes) - 1}{sentinel_end}"

    def sentinelize_segment(segment: str) -> str:
        segment = _LOC_QUAD_RE.sub(replace_quad, segment)
        return _LOC_RE.sub("", segment)

    otsl_matches = list(_OTSL_BLOCK.finditer(value))
    if not otsl_matches:
        return sentinelize_segment(value), raw_boxes

    parts: list[str] = []
    cursor = 0
    for match in otsl_matches:
        parts.append(sentinelize_segment(value[cursor : match.start()]))
        parts.append(match.group(0))  # OTSL block verbatim, untouched
        cursor = match.end()
    parts.append(sentinelize_segment(value[cursor:]))
    return "".join(parts), raw_boxes


def _resolve_anchors(
    markdown: str,
    page_spans: tuple[PageMarkdownSpan, ...],
    sentinel_base: str,
    sentinel_end: str,
    raw_boxes: list[tuple[int, int, int, int]],
    page_dims: dict[int, tuple[float, float]],
) -> tuple[str, tuple[PageMarkdownSpan, ...], tuple[MarkdownAnchor, ...]]:
    """Resolve anchor sentinels in the fully-composed Markdown into
    MarkdownAnchor records, then strip the sentinels from the visible output
    — also re-expressing `page_spans` in the post-strip coordinate space,
    since they were computed while the sentinels were still embedded in the
    text and would otherwise go stale the moment sentinels are removed.

    Each anchor spans from its own sentinel's position to the next anchor
    sentinel's position (or end of document) — Docling emits a location tag
    for essentially every rendered block, so this partitions the document
    into contiguous, anchored spans. A block with no page-dimensions entry
    for its page (e.g. `page_dims` wasn't supplied) is skipped rather than
    given a wrong/unscaled bbox.

    Known limitation: a table sitting between two anchored text blocks has no
    anchor of its own (table content keeps discarding its location tokens —
    see the module docstring / design.md), so the preceding anchor's span
    extends across it. Anchor-based lookup is only ever tried for non-table
    evidence, so this doesn't affect table highlighting, but a snippet whose
    offset merely falls within that stretched span could resolve to the wrong
    (preceding) anchor's bbox.
    """
    if not raw_boxes:
        return markdown, page_spans, ()

    pattern = re.compile(
        rf"{re.escape(sentinel_base)}(\d+){re.escape(sentinel_end)}"
    )
    matches = list(pattern.finditer(markdown))
    if not matches:
        return markdown, page_spans, ()

    def shifted(raw_offset: int) -> int:
        """Translate an offset from the sentinel-laden coordinate space into
        the cleaned-markdown coordinate space, by subtracting the length of
        every sentinel that sits strictly before it. Never called with an
        offset that falls inside a sentinel's own span (page/anchor
        boundaries never land there — see design.md)."""
        removed = 0
        for m in matches:
            if m.start() >= raw_offset:
                break
            removed += m.end() - m.start()
        return raw_offset - removed

    def page_for_offset(offset: int) -> int:
        for span in page_spans:
            if span.llm_markdown_start <= offset < span.llm_markdown_end:
                return span.page
        return page_spans[-1].page if page_spans else 1

    def bbox_for(index: int, page: int) -> tuple[float, float, float, float] | None:
        dims = page_dims.get(page)
        if dims is None or index >= len(raw_boxes):
            return None
        width_pt, height_pt = dims
        x0n, y0n, x1n, y1n = raw_boxes[index]
        return (
            (x0n / 500.0) * width_pt,
            (y0n / 500.0) * height_pt,
            (x1n / 500.0) * width_pt,
            (y1n / 500.0) * height_pt,
        )

    anchors: list[MarkdownAnchor] = []
    for i, match in enumerate(matches):
        index = int(match.group(1))
        end_raw = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        page = page_for_offset(match.start())
        bbox = bbox_for(index, page)
        if bbox is not None:
            anchors.append(
                MarkdownAnchor(
                    markdown_start=shifted(match.start()),
                    markdown_end=shifted(end_raw),
                    page=page,
                    bbox=bbox,
                )
            )

    cleaned_markdown = pattern.sub("", markdown)
    cleaned_spans = tuple(
        PageMarkdownSpan(
            page=span.page,
            text=pattern.sub("", span.text),
            llm_markdown_start=shifted(span.llm_markdown_start),
            llm_markdown_end=shifted(span.llm_markdown_end),
        )
        for span in page_spans
    )
    return cleaned_markdown, cleaned_spans, tuple(anchors)


def _unique_token(value: str, token: str, extension: str) -> str:
    while token in value:
        token += extension
    return token


@dataclass
class _SemanticBlockRenderer:
    sentinel: str
    blocks: list[str] = field(default_factory=list)

    def protect(self, value: str) -> str:
        value = _CODE_BLOCK.sub(self._protect_code, value)
        return _FORMULA_BLOCK.sub(self._protect_formula, value)

    def _protect_code(self, match: re.Match[str]) -> str:
        source = _CODE_LANGUAGE_TOKEN.sub("", match.group(1))
        longest_run = max(
            (len(run) for run in re.findall(r"`+", source)),
            default=0,
        )
        fence = "`" * max(3, longest_run + 1)
        return self._placeholder(f"{fence}\n{source}\n{fence}")

    def _protect_formula(self, match: re.Match[str]) -> str:
        source = match.group(1)
        return self._placeholder(f"$$\n{source}\n$$")

    def _placeholder(self, rendered: str) -> str:
        self.blocks.append(rendered)
        index = len(self.blocks) - 1
        return f"\n\n{self.sentinel}{index}{self.sentinel}\n\n"

    def restore(self, value: str) -> str:
        placeholder = re.compile(
            rf"{re.escape(self.sentinel)}(\d+){re.escape(self.sentinel)}"
        )
        return placeholder.sub(
            lambda match: self.blocks[int(match.group(1))],
            value,
        )


def _render_footer(match: re.Match[str]) -> str:
    return "\n*" + _escape_md_cell(match.group(1)) + "*\n"


def _render_page_furniture(value: str, *, drop_page_footers: bool) -> str:
    if drop_page_footers:
        value = _PAGE_FOOTER.sub("", value)
    else:
        value = _PAGE_FOOTER.sub(_render_footer, value)
    return _PAGE_HEADER.sub("", value)


def _render_section(match: re.Match[str]) -> str:
    level = min(max(int(match.group(1)), 1), 6)
    text = match.group(2)
    numbered_level = _numbered_heading_level(text)
    if numbered_level is not None:
        level = numbered_level
    return f"\n\n{'#' * level} {_escape_md_cell(text)}\n\n"


def _render_title(match: re.Match[str]) -> str:
    return f"\n\n# {_escape_md_cell(match.group(1))}\n\n"


def _render_text(match: re.Match[str]) -> str:
    return "\n\n" + match.group(1).strip() + "\n\n"


def _render_caption(match: re.Match[str]) -> str:
    return f"\n\n> {match.group(1).strip()}\n\n"


def _render_content_tags(value: str) -> str:
    value = _SECTION_HDR.sub(_render_section, value)
    value = _TITLE_BLOCK.sub(_render_title, value)
    value = _TEXT_BLOCK.sub(_render_text, value)
    value = _CAPTION_BLOCK.sub(_render_caption, value)
    return _render_lists(value)


def _remove_structural_tags(value: str) -> str:
    value = _DOCTAG_WRAPPER.sub("", value)
    value = _TRANSPARENT_WRAPPERS.sub("", value)
    value = _REMAINING_STRUCTURAL_TAGS.sub("", value)
    return re.sub(r"\n{3,}", "\n\n", value)


def convert_doctags_to_markdown(
    doctags: str,
    *,
    drop_page_footers: bool = True,
    page_dims: dict[int, tuple[float, float]] | None = None,
) -> DocTagsMarkdownResult:
    """Convert DocTags and retain exact page-derived Markdown offsets.

    `page_dims` (page number -> (width_pt, height_pt)) is used to convert
    Docling's normalized location tokens into absolute anchor bounding boxes;
    when omitted, location tokens are still stripped from the output exactly
    as before, but no anchors are produced (`DocTagsMarkdownResult.anchors`
    is empty).
    """
    raw = doctags or ""
    anchor_sentinel_base = "FREE_ANCHOR"
    anchor_sentinel_end = ""
    while anchor_sentinel_base in raw or anchor_sentinel_end in raw:
        anchor_sentinel_base += ""
        anchor_sentinel_end += ""
    value, raw_anchor_boxes = _sentinelize_anchor_locations(
        raw, anchor_sentinel_base, anchor_sentinel_end
    )
    semantic_sentinel = _unique_token(value, "\ue002", "\ue002")
    page_sentinel = _unique_token(value, _PAGE_SENTINEL, "\ue000")
    semantic_blocks = _SemanticBlockRenderer(semantic_sentinel)

    value = semantic_blocks.protect(value)
    value = _PAGE_BREAK.sub(page_sentinel, value)
    value = _replace_otsl_blocks_merged(
        value,
        drop_page_footers=drop_page_footers,
        page_sentinel=page_sentinel,
    )
    value = _render_page_furniture(
        value,
        drop_page_footers=drop_page_footers,
    )
    value = _render_content_tags(value)
    value = _remove_structural_tags(value)
    value = semantic_blocks.restore(value)
    composed = compose_page_markdown(value.split(page_sentinel))
    cleaned_markdown, cleaned_spans, anchors = _resolve_anchors(
        composed.markdown,
        composed.page_spans,
        anchor_sentinel_base,
        anchor_sentinel_end,
        raw_anchor_boxes,
        page_dims or {},
    )
    return DocTagsMarkdownResult(
        markdown=cleaned_markdown,
        page_spans=cleaned_spans,
        anchors=anchors,
    )


def doctags_to_markdown(doctags: str, *, drop_page_footers: bool = True) -> str:
    """Compatibility wrapper returning only canonical Markdown."""
    return convert_doctags_to_markdown(
        doctags, drop_page_footers=drop_page_footers
    ).markdown


def _page_markdown_span(page: int, raw_chunk: str, offset: int) -> PageMarkdownSpan:
    text = raw_chunk.strip()
    start = offset + len(raw_chunk) - len(raw_chunk.lstrip())
    return PageMarkdownSpan(
        page=page,
        text=text,
        llm_markdown_start=start,
        llm_markdown_end=start + len(text),
    )


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
        spans.append(_page_markdown_span(page, raw_chunk, cursor))
        cursor = match.end()
        page += 1

    raw_chunk = llm_markdown[cursor:]
    spans.append(_page_markdown_span(page, raw_chunk, cursor))
    return spans


def load_doctags_from_parsed_json(path: str | Path) -> str:
    try:
        data: Any = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    if isinstance(data, dict):
        return str(data.get("raw_text") or "").strip()
    return ""
