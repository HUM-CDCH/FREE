"""The document as the pipeline assembles it: the book pages, the OCR evidence placed on them as segments with
their evidence references, and the blocks and heading events read over it.

Vocabulary: `CONTEXT.md`. Contracts: `docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md`
(sections are cited as "spec 3.8" below) and, for the evidence types, the canonical evidence design
(`docs/superpowers/specs/2026-09-21-canonical-evidence-design.md`, cited as "design §6"). `Document` checks what only
the assembled document can know: each segment inside its page, each span inside its segment's text, primary
ownership disjoint, the optional namespaces on its own pages. It is never persisted; `kie/evidence.py` projects the
segments from the page files.
"""

from collections.abc import Iterable
from typing import Literal, Self

from pydantic import ConfigDict, Field, model_validator

from kei_exp.kie.blocks import Block, HeadingEvent, Span
from kei_exp.kie.ingest_model import Page, Source
from kei_exp.kie.primitives import Bbox, Count, Index, IndexKey, Name, PageType, _Base, _unique
from kei_exp.pagefile import segment_id as canonical_segment_id


def _check_inside(box: tuple[int, int, int, int], width: int, height: int, what: str) -> None:
    _, _, right, bottom = box
    if right > width or bottom > height:
        raise ValueError(f"{what} {list(box)} lies outside its {width}x{height} page image")


class EvidenceRef(_Base):
    """Where a segment came from in the OCR stage's accepted result (design §3.4): the result generation, the PDF
    page whose file holds it, and its position in that file's `segments` list. Resolvable for as long as that
    generation exists; a rerun is another generation, and a reference into it is another reference."""

    generation: Name
    page: Index  # the PDF page, which names the page file `pages/<page>.json`
    index: Count  # the 0-based position in that page file's `segments` list; the id's `n` counts per unit instead

    @property
    def segment_id(self) -> str:
        """The canonical id FREE and extraction evidence use. The one resolver from a book-page `Segment.id`: the two
        strings may look alike (`p2_s1` can be `p1_s5`) and are never compared."""
        return canonical_segment_id(self.page, self.index)


class Segment(_Base):
    """One immutable piece of OCR evidence: text, plus a bbox on its page (spec 3.3).

    Frozen because every span in the document indexes this text; rewriting it would move every span. Never
    persisted by KIE: it is projected from the page file its reference names (design §6).
    """

    model_config = ConfigDict(frozen=True)

    id: Name  # `p{page}_s{n}`, unique per document; not stable across OCR reruns
    page: Index
    bbox: Bbox  # page pixels
    text: str  # may be empty, and then nothing can point into it
    conf: float | None  # as the engine reported it
    label: Name  # the OCR label, an OCR fact and not a domain role
    status: Literal["ok", "error", "skipped"]
    crop: Index  # the OCR stage's crop ordinal the segment was read in, unique across the OCR run
    source: EvidenceRef


class Document(_Base):
    """The whole document as the pipeline sees it, assembled from the ingest artifact and the evidence read over
    it, and never persisted (spec 3.7)."""

    source: Source
    pages: list[Page] = Field(default_factory=list)
    segments: list[Segment] = Field(default_factory=list)
    blocks: list[Block] = Field(default_factory=list)
    heading_events: list[HeadingEvent] = Field(default_factory=list)
    # Optional namespaces, each None until the stage that owns it has been loaded.
    reading_order: dict[IndexKey, list[str]] | None = None  # segment ids, keyed by every page that has any
    columns: dict[IndexKey, list[Bbox]] | None = None  # page pixels
    page_types: dict[IndexKey, PageType] | None = None
    glossary_pages: list[Index] | None = None
    page_labels: dict[IndexKey, str] | None = None  # the number printed on the book page, which is not Page.index

    @model_validator(mode="after")
    def _assembled(self) -> Self:
        _unique((page.index for page in self.pages), "page index")
        _unique((segment.id for segment in self.segments), "segment id")
        _unique((block.id for block in self.blocks), "block id")
        _unique((heading.id for heading in self.heading_events), "heading event id")
        _unique(((block.entry_no, block.entry_suffix) for block in self.blocks), "entry identity")
        pages = {page.index: page for page in self.pages}
        segments = {segment.id: segment for segment in self.segments}
        headings = {heading.id: heading for heading in self.heading_events}
        for segment in self.segments:
            page = pages.get(segment.page)
            if page is None:
                raise ValueError(f"segment {segment.id} names page {segment.page}, which the document has not")
            _check_inside(segment.bbox, page.width_px, page.height_px, f"segment {segment.id} bbox")
        for heading in self.heading_events:
            _check_spans(heading.spans, segments, f"heading event {heading.id}")
        for block in self.blocks:
            _check_spans(block.primary_spans, segments, f"block {block.id} primary span")
            _check_spans(block.context_spans, segments, f"block {block.id} context span")
            for heading_id in block.heading_events:
                if heading_id not in headings:
                    raise ValueError(f"block {block.id} names heading event {heading_id}, which the document has not")
        _check_primary_ownership(self.blocks)
        self._check_optional_namespaces(pages)
        return self

    def _check_optional_namespaces(self, pages: dict[int, Page]) -> None:
        for name, namespace in (
            ("reading_order", self.reading_order),
            ("columns", self.columns),
            ("page_types", self.page_types),
            ("page_labels", self.page_labels),
            ("glossary_pages", self.glossary_pages),
        ):
            for index in namespace or ():
                if index not in pages:
                    raise ValueError(f"{name} names page {index}, which the document has not")
        for index, boxes in (self.columns or {}).items():
            for box in boxes:
                _check_inside(box, pages[index].width_px, pages[index].height_px, f"column on page {index}")
        if self.reading_order is None:
            return
        on_page: dict[int, list[str]] = {index: [] for index in pages}
        for segment in self.segments:
            on_page[segment.page].append(segment.id)
        # The namespace keys exactly the pages that hold evidence: a page left out is a missing order rather
        # than an empty one, and nothing downstream could tell the two apart.
        ordered = {index for index, ids in on_page.items() if ids}
        if set(self.reading_order) != ordered:
            raise ValueError(
                f"reading_order keys {sorted(self.reading_order)}, not the pages with segments {sorted(ordered)}"
            )
        for index, ids in self.reading_order.items():
            # A reading order that drops or repeats a segment is not an order of that page's evidence.
            if sorted(ids) != sorted(on_page[index]):
                raise ValueError(
                    f"reading_order for page {index} is not a permutation of its {len(on_page[index])} segments"
                )


def _check_spans(spans: Iterable[Span], segments: dict[str, Segment], what: str) -> None:
    for span in spans:
        segment = segments.get(span.segment_id)
        if segment is None:
            raise ValueError(f"{what} names segment {span.segment_id}, which the document has not")
        if span.end > len(segment.text):
            raise ValueError(f"{what} [{span.start}, {span.end}) runs past {span.segment_id} ({len(segment.text)})")


def _check_primary_ownership(blocks: Iterable[Block]) -> None:
    """The primary spans of two different blocks never overlap (CONTEXT.md invariant 2, spec 3.8 rule 7).

    Grouping by segment and carrying the furthest end reached keeps this near-linear; an all-pairs scan over
    a 30k-segment document would make assembly quadratic in the number of spans.
    """
    owned: dict[str, list[tuple[int, int, str]]] = {}
    for block in blocks:
        for span in block.primary_spans:
            owned.setdefault(span.segment_id, []).append((span.start, span.end, block.id))
    for segment_id, spans in owned.items():
        spans.sort()
        reach, owner = 0, ""
        for start, end, block_id in spans:
            # Half-open: [0, 10) and [10, 20) are adjacent, which is what two consecutive entries inside one
            # OCR segment look like, and is not an overlap.
            if start < reach and block_id != owner:
                raise ValueError(f"blocks {owner} and {block_id} both own characters of {segment_id}")
            if end > reach:
                reach, owner = end, block_id
