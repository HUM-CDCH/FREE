"""The KIE model's validation rules, pinned on hand-built values (no PDF, no GPU): geometry, source, page, segment
and block, the assembled document and its optional namespaces, the ingest config at parse time and against a source,
the effective config, the pipeline config, the ingest artifact with its report and envelope, the evidence report and
the run report. Each section's refusals are one parametrized test; what each one refuses is its id."""

import hashlib

import pytest
from pydantic import ValidationError

from kei_exp.kie.blocks import Block, HeadingEvent, Span
from kei_exp.kie.document import Document, Segment
from kei_exp.kie.ingest_model import IngestArtifact, IngestConfig, IngestReport, Page, Placement, Source
from kei_exp.kie.primitives import IngestError
from kei_exp.kie.run_model import EvidenceReport, PipelineConfig, RunReport

SPREAD_W, SPREAD_H = 1000, 700
PAGE_PT = (500.0, 350.0)
GUTTER = 480


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def without(fields: dict, name: str) -> dict:
    """The same value with one field left out: a missing field, which is not a null one."""
    return {key: value for key, value in fields.items() if key != name}


def placement(size_pt: tuple[float, float] = PAGE_PT, **overrides) -> dict:
    width_pt, height_pt = size_pt
    fields = {
        "a": width_pt,
        "b": 0.0,
        "c": 0.0,
        "d": height_pt,
        "e": 0.0,
        "f": 0.0,
        "page_width_pt": width_pt,
        "page_height_pt": height_pt,
    }
    return {**fields, **overrides}


def evidence(**overrides) -> dict:
    fields = {
        "dark_run": (480, 520),
        "blank_run": (440, 480),
        "dark_runs": 1,
        "blank_runs": 1,
        "band_support": 0.8,
        "distance_from_midline_px": 20,
    }
    return {**fields, **overrides}


def page(
    index: int,
    spread: int,
    side: str,
    *,
    size_pt: tuple[float, float] = PAGE_PT,
    width: int = SPREAD_W,
    height: int = SPREAD_H,
    **overrides,
) -> dict:
    rects = {"left": (0, 0, GUTTER, height), "right": (GUTTER, 0, width, height), "single": (0, 0, width, height)}
    left, top, right, bottom = rects[side]
    fields = {
        "index": index,
        "spread": spread,
        "side": side,
        "image": f"pages/{index:03d}.png",
        "width_px": right - left,
        "height_px": bottom - top,
        "sha256": digest(f"page {index}"),
        "source_rect": (left, top, right, bottom),
        "spread_width_px": width,
        "spread_height_px": height,
        "placement": placement(size_pt),
        "dpi_x": 72.0 * width / size_pt[0],
        "dpi_y": 72.0 * height / size_pt[1],
        "gutter_x_px": None if side == "single" else GUTTER,
        "gutter_method": "none" if side == "single" else "shadow",
        "gutter_reason": None,
        "gutter_evidence": None if side == "single" else evidence(),
    }
    return {**fields, **overrides}


def source(spreads: int = 2, size_pt: tuple[float, float] = PAGE_PT, **overrides) -> dict:
    fields = {
        "pdf_name": "catalogue.pdf",
        "sha256": digest("pdf"),
        "spreads": spreads,
        "page_size_pt": {number: size_pt for number in range(1, spreads + 1)},
    }
    return {**fields, **overrides}


def segment(id: str, page_index: int, text: str, *, bbox: tuple = (0, 0, 100, 50), **overrides) -> dict:
    fields = {
        "id": id,
        "page": page_index,
        "bbox": bbox,
        "text": text,
        "conf": 0.98,
        "label": "Text",
        "status": "ok",
        "crop": 1,
        "source": {"generation": "g", "page": 1, "index": 0},
    }
    return {**fields, **overrides}


def span(segment_id: str, start: int, end: int) -> dict:
    return {"segment_id": segment_id, "start": start, "end": end}


def block(id: str, label: str, no: int, suffix: str, primary: list[dict], **overrides) -> dict:
    fields = {
        "id": id,
        "entry_label": label,
        "entry_no": no,
        "entry_suffix": suffix,
        "primary_spans": primary,
        "context_spans": [],
        "continuation": False,
        "heading_events": [],
    }
    return {**fields, **overrides}


# `31 ...` and `31a ...` inside one OCR block: two entries, adjacent primary spans, no shared character.
ENTRIES = "31 Grobers, Kr. Halle. 31a Wallendorf, Kr. Merseburg."
BOUNDARY = ENTRIES.index("31a")
# A heading and an astral character, so that offsets are code points rather than bytes or UTF-16 units.
HEADING = "Bezirk Halle \U0001d505 Kreis Grosse"
ASTRAL = HEADING.index("\U0001d505")


def document(**overrides) -> dict:
    fields = {
        "source": source(),
        "pages": [page(1, 1, "left"), page(2, 1, "right"), page(3, 2, "left"), page(4, 2, "right")],
        "segments": [segment("p1_s1", 1, ENTRIES), segment("p2_s1", 2, HEADING), segment("p3_s1", 3, "")],
        "blocks": [
            block(
                "b1",
                "31",
                31,
                "",
                [span("p1_s1", 0, BOUNDARY)],
                context_spans=[span("p1_s1", 0, len(ENTRIES))],
                heading_events=["h1"],
            ),
            block(
                "b2",
                "31a",
                31,
                "a",
                [span("p1_s1", BOUNDARY, len(ENTRIES))],
                context_spans=[span("p1_s1", 0, len(ENTRIES))],
                heading_events=["h1", "h2"],
            ),
        ],
        "heading_events": [
            {"id": "h1", "kind": "bezirk", "level": 1, "text": "Bezirk Halle", "spans": [span("p2_s1", 0, 12)]},
            {"id": "h2", "kind": "kreis", "level": 2, "text": "Kreis Grosse",
             "spans": [span("p2_s1", ASTRAL + 2, len(HEADING))]},
        ],
    }
    return {**fields, **overrides}


def spread_report(spread: int, **overrides) -> dict:
    fields = {
        "spread": spread,
        "gutter_x_px": GUTTER,
        "method": "shadow",
        "reason": None,
        "evidence": evidence(),
        "min_blank_px": 4,
        "min_dark_px": 6,
        "support_radius_px": 1,
    }
    return {**fields, **overrides}


def ingest_report(**overrides) -> dict:
    fields = {
        "spreads_read": 2,
        "pages_written": 4,
        "methods": {"shadow": 2},
        "spreads": [spread_report(1), spread_report(2)],
        "weak_support": [2],
        "text_layers": {},
        "extract_seconds": 0.4,
        "write_seconds": 1.2,
        "seconds": 1.8,
    }
    return {**fields, **overrides}


def envelope(**overrides) -> dict:
    fields = {
        "stage": "ingest",
        "stage_version": 1,
        "fingerprint": digest("inputs"),
        "digest": digest("namespace"),
        "upstream": {},
        "created": "2026-09-14T12:00:00+00:00",
    }
    return {**fields, **overrides}


def artifact(**overrides) -> dict:
    fields = {
        "envelope": envelope(),
        "source": source(),
        "config": {},
        "pages": [page(1, 1, "left"), page(2, 1, "right"), page(3, 2, "left"), page(4, 2, "right")],
        "report": ingest_report(),
    }
    return {**fields, **overrides}


def evidence_report(**overrides) -> dict:
    fields = {
        "generation": "g",
        "digest": "0" * 64,
        "pages_read": 1,
        "spreads_without_pages": [],
        "segments": 2,
        "rejected": [],
        "clamped": 0,
        "by_label": {"Text": 2},
        "by_status": {"ok": 2},
        "empty_text": 0,
        "overlaps": {},
        "seconds": 0.1,
    }
    return {**fields, **overrides}


def run_report(**overrides) -> dict:
    fields = {
        "run_id": "2026-09-14T12-00-00",
        "doc_id": "catalogue",
        "seconds": 0.05,
        "ingest": {"skipped": True, "seconds": 0.04, "report": ingest_report()},
    }
    return {**fields, **overrides}


# --- Geometry: strict integers, half-open intervals, invertible placement ------------------------------------


def test_the_smallest_bbox_is_one_pixel():
    assert Segment.model_validate(segment("p1_s1", 1, "x", bbox=(0, 0, 1, 1))).bbox == (0, 0, 1, 1)


def test_a_span_ends_where_its_half_open_range_stops():
    assert Span(segment_id="p1_s1", start=0, end=1).end == 1


def test_an_axis_aligned_placement_is_invertible():
    assert Placement.model_validate(placement()).x_axis_pt == PAGE_PT[0]


GEOMETRY_REJECTIONS = [
    pytest.param(lambda: Segment.model_validate(segment("p1_s1", 1, "x", bbox=(10, 0, 10, 5))), id="an empty bbox"),
    pytest.param(lambda: Segment.model_validate(segment("p1_s1", 1, "x", bbox=(10, 0, 5, 5))), id="a reversed bbox"),
    pytest.param(
        lambda: Segment.model_validate(segment("p1_s1", 1, "x", bbox=(0.0, 0, 10.0, 5))), id="a fractional bbox"
    ),
    pytest.param(
        lambda: Segment.model_validate(segment("p1_s1", 1, "x", bbox=(True, 0, 10, 5))),
        id="a boolean bbox coordinate",
    ),
    pytest.param(lambda: Segment.model_validate(segment("p1_s1", 1, "x", bbox=(-1, 0, 10, 5))), id="a negative bbox"),
    pytest.param(
        lambda: Segment.model_validate(segment("p1_s1", 1, "x", bbox=(0, 0, 10, 5, 5))), id="a five-coordinate bbox"
    ),
    pytest.param(lambda: Span(segment_id="p1_s1", start=3, end=3), id="an empty span"),
    pytest.param(lambda: Span(segment_id="p1_s1", start=4, end=3), id="a reversed span"),
    pytest.param(lambda: Span.model_validate(span("p1_s1", 0, 1.5)), id="a fractional span offset"),
    pytest.param(lambda: Span.model_validate(span("p1_s1", -1, 3)), id="a negative span offset"),
    pytest.param(lambda: Span.model_validate({**span("p1_s1", 0, 1), "page": 1}), id="an unknown span field"),
    pytest.param(
        lambda: Placement.model_validate(placement(a=10.0, b=0.0, c=10.0, d=0.0)), id="a singular placement"
    ),
    pytest.param(lambda: Placement.model_validate(placement(a=0.5, b=0.0)), id="a sub-point placement axis"),
    pytest.param(lambda: Placement.model_validate(placement(b=float("inf"))), id="a non-finite placement"),
    pytest.param(
        lambda: Placement.model_validate(placement(page_width_pt=0.0)), id="a placement on a zero-size page"
    ),
]


@pytest.mark.parametrize("build", GEOMETRY_REJECTIONS)
def test_geometry_refuses(build):
    with pytest.raises(ValidationError):
        build()


# --- Source: one identity, one size per spread ----------------------------------------------------------------


def test_a_source_states_its_spread_count_and_one_size_per_spread():
    assert Source.model_validate(source(45)).spreads == 45
    assert Source.model_validate(source()).page_size_pt[2] == PAGE_PT


def test_page_size_keys_parse_back_from_decimal_strings():
    # Canonical JSON writes integer keys as decimal strings; parsing converts them back (spec 5).
    parsed = Source.model_validate({**source(), "page_size_pt": {"1": PAGE_PT, "2": PAGE_PT}})
    assert parsed.page_size_pt[1] == PAGE_PT


SOURCE_REJECTIONS = [
    pytest.param(
        lambda: Source.model_validate({**source(), "page_size_pt": {1: PAGE_PT}}), id="a source missing a page size"
    ),
    pytest.param(
        lambda: Source.model_validate({**source(), "page_size_pt": {1: PAGE_PT, 2: PAGE_PT, 3: PAGE_PT}}),
        id="a source sized past its spreads",
    ),
    pytest.param(
        lambda: Source.model_validate({**source(), "pdf_name": "runs/catalogue.pdf"}), id="a path as a pdf name"
    ),
    pytest.param(lambda: Source.model_validate({**source(), "sha256": "abc"}), id="a truncated sha256"),
]


@pytest.mark.parametrize("build", SOURCE_REJECTIONS)
def test_source_refuses(build):
    with pytest.raises(ValidationError):
        build()


# --- Page: dimensions, sides, rectangles and gutter evidence agree ---------------------------------------------


@pytest.mark.parametrize("side", ["left", "right", "single"])
def test_each_side_builds_a_consistent_page(side):
    assert Page.model_validate(page(1, 1, side)).side == side


def test_a_reason_is_stated_for_the_methods_that_take_one():
    midline = Page.model_validate(page(1, 1, "left", gutter_method="midline", gutter_reason="ambiguous_candidates"))
    assert midline.gutter_reason == "ambiguous_candidates"
    override = Page.model_validate(page(1, 1, "left", gutter_method="override", gutter_reason="config"))
    assert override.gutter_reason == "config"


PAGE_REJECTIONS = [
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", width_px=479)), id="a page image that is not its source rect"
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", source_rect=(0, 0, GUTTER, 600), height_px=600)),
        id="a page shorter than its spread",
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", source_rect=(GUTTER, 0, SPREAD_W, SPREAD_H), width_px=520)),
        id="a left page whose rect starts at the gutter",
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "single", source_rect=(0, 0, GUTTER, SPREAD_H), width_px=GUTTER)),
        id="a single page that does not cover the raster",
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "single", gutter_evidence=evidence())),
        id="a single page carrying gutter evidence",
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "single", gutter_x_px=GUTTER)), id="a single page carrying a gutter"
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", gutter_evidence=None)), id="a split page without evidence"
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", gutter_method="none")), id="a split page with method none"
    ),
    pytest.param(
        lambda: Page.model_validate(
            page(1, 1, "left", gutter_x_px=SPREAD_W, source_rect=(0, 0, SPREAD_W, SPREAD_H), width_px=SPREAD_W)
        ),
        id="a gutter outside the spread",
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", gutter_reason="config")),
        id="a reason that does not belong to shadow",
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", gutter_method="midline")), id="a midline page without a reason"
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", dpi_x=300.0)),
        id="a dpi that does not follow from the placement",
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", image="/tmp/001.png")), id="an absolute page image path"
    ),
    pytest.param(
        lambda: Page.model_validate(page(1, 1, "left", image="../001.png")), id="a page image outside the artifact"
    ),
]


@pytest.mark.parametrize("build", PAGE_REJECTIONS)
def test_page_refuses(build):
    with pytest.raises(ValidationError):
        build()


# --- Segment, HeadingEvent, Block -----------------------------------------------------------------------------


def test_segment_text_is_immutable():
    kept = Segment.model_validate(segment("p1_s1", 1, ENTRIES))
    with pytest.raises(ValidationError):
        kept.text = "edited"  # type: ignore[misc]


def test_empty_text_is_evidence_too():
    assert Segment.model_validate(segment("p3_s1", 3, "")).text == ""  # empty text is evidence too


def test_a_block_label_carries_its_number_and_suffix():
    assert Block.model_validate(block("b2", "31a", 31, "a", [span("p1_s1", 0, 3)])).entry_suffix == "a"


SEGMENT_HEADING_BLOCK_REJECTIONS = [
    pytest.param(
        lambda: Segment.model_validate({**segment("p1_s1", 1, "x"), "order": 1}), id="an unknown segment field"
    ),
    pytest.param(
        lambda: Segment.model_validate(without(segment("p1_s1", 1, "x"), "crop")), id="a segment without a crop"
    ),
    pytest.param(
        lambda: Segment.model_validate(
            segment("p1_s1", 1, "x", source={"generation": "g", "page": 1, "index": 0, "spread": 1})
        ),
        id="a segment source with an unknown field",
    ),
    pytest.param(
        lambda: HeadingEvent.model_validate({"id": "h1", "kind": "bezirk", "level": 1, "text": "Bezirk Halle",
                                             "spans": []}),
        id="a heading event without evidence",
    ),
    pytest.param(
        lambda: HeadingEvent.model_validate({"id": "h1", "kind": "kreis", "level": 0, "text": "x",
                                             "spans": [span("p2_s1", 0, 1)]}),
        id="a heading level under 1",
    ),
    pytest.param(
        lambda: HeadingEvent.model_validate({"id": "h1", "kind": "", "level": 1, "text": "x",
                                             "spans": [span("p2_s1", 0, 1)]}),
        id="a heading without a kind",
    ),
    pytest.param(lambda: Block.model_validate(block("b1", "31", 31, "", [])), id="a block without primary spans"),
    pytest.param(
        lambda: Block.model_validate(block("b1", "31", 32, "", [span("p1_s1", 0, 3)])),
        id="a label that disagrees with its number",
    ),
    pytest.param(
        lambda: Block.model_validate(block("b1", "31a", 31, "", [span("p1_s1", 0, 3)])),
        id="a label that drops its suffix",
    ),
    pytest.param(
        lambda: Block.model_validate(block("b1", "a31", 31, "a", [span("p1_s1", 0, 3)])),
        id="a label without leading digits",
    ),
    pytest.param(
        lambda: Block.model_validate(block("b1", "31\n", 31, "", [span("p1_s1", 0, 3)])),
        id="a newline read as an empty suffix",
    ),
]


@pytest.mark.parametrize("build", SEGMENT_HEADING_BLOCK_REJECTIONS)
def test_segment_heading_event_and_block_refuse(build):
    with pytest.raises(ValidationError):
        build()


# --- Document: references, bounds, ownership ------------------------------------------------------------------


def test_the_assembled_document_keeps_its_pages_and_two_adjacent_entries():
    assembled = Document.model_validate(document())
    assert [page.index for page in assembled.pages] == [1, 2, 3, 4]
    assert {block.entry_label for block in assembled.blocks} == {"31", "31a"}
    # Adjacent primary spans own no character in common, and both blocks see the whole segment as context.
    first, second = assembled.blocks
    assert first.primary_spans[0].end == second.primary_spans[0].start
    assert first.context_spans[0] == second.context_spans[0]


def test_span_offsets_are_code_points():
    # Offsets are code points: the astral heading character is one position wide.
    assembled = Document.model_validate(document())
    astral_span = assembled.heading_events[1].spans[0]
    assert HEADING[ASTRAL : ASTRAL + 1] == "\U0001d505" and astral_span.end == len(HEADING)
    astral_only = Document.model_validate(
        document(
            heading_events=[
                {"id": "h1", "kind": "bezirk", "level": 1, "text": "\U0001d505", "spans": [span("p2_s1", ASTRAL, ASTRAL + 1)]},
            ],
            blocks=[block("b1", "31", 31, "", [span("p1_s1", 0, BOUNDARY)])],
        )
    )
    assert astral_only.heading_events[0].text == "\U0001d505"


def test_documents_of_another_page_count_or_page_size_are_ordinary_sources():
    # Two documents differing in page count and page size are both ordinary sources.
    wide = Document.model_validate(
        {
            "source": {**source(1), "page_size_pt": {1: (842.0, 1190.0)}},
            "pages": [page(1, 1, "single", size_pt=(842.0, 1190.0), width=2000, height=3000)],
        }
    )
    assert wide.pages[0].width_px == 2000 and wide.source.spreads == 1
    mixed = Document.model_validate(
        {
            "source": {**source(2), "page_size_pt": {1: PAGE_PT, 2: (600.0, 400.0)}},
            "pages": [page(1, 1, "single"), page(2, 2, "single", size_pt=(600.0, 400.0))],
        }
    )
    assert mixed.pages[0].dpi_x != mixed.pages[1].dpi_x


def test_a_shared_leading_number_is_still_two_identities():
    # `31` and `31a` share the leading number and are still two identities.
    assert len(Document.model_validate(document()).blocks) == 2


def test_interleaved_but_disjoint_primary_spans_are_two_owners():
    interleaved = Document.model_validate(
        document(
            blocks=[
                block("b1", "31", 31, "", [span("p1_s1", 0, 10), span("p1_s1", 20, 30)]),
                block("b2", "32", 32, "", [span("p1_s1", 10, 20)]),
            ]
        )
    )  # interleaved but disjoint ownership
    assert [block.id for block in interleaved.blocks] == ["b1", "b2"]


DOCUMENT_REJECTIONS = [
    pytest.param(
        lambda: Document.model_validate(document(pages=[page(1, 1, "left"), page(1, 1, "right")])),
        id="a duplicate page index",
    ),
    pytest.param(
        lambda: Document.model_validate(document(segments=[segment("p1_s1", 1, ENTRIES), segment("p1_s1", 1, "x")])),
        id="a duplicate segment id",
    ),
    pytest.param(
        lambda: Document.model_validate(
            document(
                blocks=[
                    block("b1", "31", 31, "", [span("p1_s1", 0, 5)]),
                    block("b1", "32", 32, "", [span("p1_s1", 6, 10)]),
                ]
            )
        ),
        id="a duplicate block id",
    ),
    pytest.param(
        lambda: Document.model_validate(
            document(
                heading_events=[
                    {"id": "h1", "kind": "bezirk", "level": 1, "text": "a", "spans": [span("p2_s1", 0, 1)]},
                    {"id": "h1", "kind": "kreis", "level": 2, "text": "b", "spans": [span("p2_s1", 1, 2)]},
                ]
            )
        ),
        id="a duplicate heading event id",
    ),
    pytest.param(
        lambda: Document.model_validate(
            document(
                blocks=[
                    block("b1", "31", 31, "", [span("p1_s1", 0, 5)]),
                    block("b2", "31", 31, "", [span("p1_s1", 6, 10)]),
                ]
            )
        ),
        id="a repeated entry identity",
    ),
    pytest.param(
        lambda: Document.model_validate(document(segments=[segment("p9_s1", 9, "x")])),
        id="a segment on a page the document has not",
    ),
    pytest.param(
        lambda: Document.model_validate(document(blocks=[block("b1", "31", 31, "", [span("p9_s1", 0, 3)])])),
        id="a span into a segment the document has not",
    ),
    pytest.param(
        lambda: Document.model_validate(
            document(blocks=[block("b1", "31", 31, "", [span("p1_s1", 0, 3)], heading_events=["h9"])])
        ),
        id="a heading event named by no heading",
    ),
    pytest.param(
        lambda: Document.model_validate(
            document(blocks=[block("b1", "31", 31, "", [span("p1_s1", 0, len(ENTRIES) + 1)])])
        ),
        id="a span past the end of its segment",
    ),
    pytest.param(
        lambda: Document.model_validate(document(blocks=[block("b1", "31", 31, "", [span("p3_s1", 0, 1)])])),
        id="a span into an empty segment",
    ),
    pytest.param(
        lambda: Document.model_validate(document(segments=[segment("p1_s1", 1, "x", bbox=(0, 0, GUTTER + 1, 50))])),
        id="a segment bbox outside its page",
    ),
    pytest.param(
        lambda: Document.model_validate(
            document(
                blocks=[
                    block("b1", "31", 31, "", [span("p1_s1", 0, 10)]),
                    block("b2", "32", 32, "", [span("p1_s1", 5, 15)]),
                ]
            )
        ),
        id="primary spans that share characters",
    ),
    # A wide first span still catches a later block nested inside it, without an all-pairs scan.
    pytest.param(
        lambda: Document.model_validate(
            document(
                blocks=[
                    block("b1", "31", 31, "", [span("p1_s1", 0, 40), span("p1_s1", 4, 6)]),
                    block("b2", "32", 32, "", [span("p1_s1", 10, 20)]),
                ]
            )
        ),
        id="a primary span nested in another block's",
    ),
]


@pytest.mark.parametrize("build", DOCUMENT_REJECTIONS)
def test_document_refuses(build):
    with pytest.raises(ValidationError):
        build()


# --- Document: the optional namespaces ------------------------------------------------------------------------


def test_the_optional_namespaces_load_and_default_to_none():
    loaded = Document.model_validate(
        document(
            reading_order={1: ["p1_s1"], 2: ["p2_s1"], 3: ["p3_s1"]},
            columns={1: [(0, 0, 200, 700), (200, 0, 480, 700)]},
            page_types={1: "catalogue", 2: "glossary"},
            glossary_pages=[2],
            page_labels={1: "90", 2: "91"},
        )
    )
    assert loaded.reading_order[1] == ["p1_s1"] and loaded.page_types[2] == "glossary"
    assert Document.model_validate(document()).reading_order is None


NAMESPACE_REJECTIONS = [
    pytest.param(
        lambda: Document.model_validate(document(reading_order={1: [], 2: ["p2_s1"], 3: ["p3_s1"]})),
        id="an incomplete reading order",
    ),
    pytest.param(
        lambda: Document.model_validate(document(reading_order={1: ["p1_s1", "p1_s1"], 2: ["p2_s1"], 3: ["p3_s1"]})),
        id="a repeated reading order entry",
    ),
    pytest.param(
        lambda: Document.model_validate(document(reading_order={1: ["p1_s1"], 2: ["p2_s1"]})),
        id="a reading order that omits a page holding segments",
    ),
    pytest.param(
        lambda: Document.model_validate(document(reading_order={1: ["p1_s1"], 2: ["p2_s1"], 3: ["p3_s1"], 4: []})),
        id="a reading order for a page with no segments",
    ),
    pytest.param(
        lambda: Document.model_validate(document(reading_order={9: []})),
        id="a reading order for a page the document has not",
    ),
    pytest.param(
        lambda: Document.model_validate(document(columns={1: [(0, 0, GUTTER + 1, SPREAD_H)]})),
        id="a column outside its page",
    ),
    pytest.param(lambda: Document.model_validate(document(page_types={1: "index"})), id="an unknown page type"),
    pytest.param(
        lambda: Document.model_validate(document(glossary_pages=[9])), id="a glossary page the document has not"
    ),
]


@pytest.mark.parametrize("build", NAMESPACE_REJECTIONS)
def test_the_optional_namespaces_refuse(build):
    with pytest.raises(ValidationError):
        build()


# --- IngestConfig: parse-time shape and value checks -----------------------------------------------------------


def test_the_defaults_and_their_pixel_projections():
    cfg = IngestConfig()
    assert (cfg.split, cfg.bands, cfg.min_band_support) == ("spread", 5, 0.6)
    assert cfg.window_px(9928) == (3971, 5956) and cfg.interior_rows_px(7016) == (701, 6314)
    assert (cfg.min_blank_px(9928), cfg.min_dark_px(9928), cfg.support_radius_px(9928)) == (40, 60, 10)


def test_distances_are_lengths_rather_than_pixel_constants():
    cfg = IngestConfig()
    # Half the raster width approximately halves the distances: they are lengths, not pixel constants.
    assert (cfg.min_blank_px(4964), cfg.min_dark_px(4964), cfg.support_radius_px(4964)) == (20, 30, 5)
    assert cfg.support_radius_px(100) == 1  # never zero: a neighbourhood of no columns measures nothing


INGEST_CONFIG_REJECTIONS = [
    pytest.param(lambda: IngestConfig(gutter_window=(0.6, 0.4)), id="an unordered gutter window"),
    pytest.param(lambda: IngestConfig(interior_rows=(0.5, 0.5)), id="an empty interior row pair"),
    pytest.param(lambda: IngestConfig(gutter_window=(0.4, 1.2)), id="a gutter window outside the image"),
    pytest.param(lambda: IngestConfig(bands=0), id="zero bands"),
    pytest.param(lambda: IngestConfig(bands=2.5), id="a fractional band count"),
    pytest.param(lambda: IngestConfig(blank_ink=0.2, dark_ink=0.15), id="blank ink at or above dark ink"),
    pytest.param(lambda: IngestConfig(min_blank_fraction=0.0), id="a zero distance fraction"),
    pytest.param(lambda: IngestConfig(min_dark_fraction=1.0), id="a whole-width distance fraction"),
    pytest.param(lambda: IngestConfig(min_band_support=1.5), id="support above one"),
    pytest.param(lambda: IngestConfig(overrides={0: 100}), id="an override on spread zero"),
    pytest.param(lambda: IngestConfig(overrides={1: 100.5}), id="a fractional override"),
    pytest.param(lambda: IngestConfig.model_validate({"min_dark_px": 60}), id="an unknown ingest setting"),
]


@pytest.mark.parametrize("build", INGEST_CONFIG_REJECTIONS)
def test_ingest_config_refuses_at_parse_time(build):
    with pytest.raises(ValidationError):
        build()


# --- IngestConfig: the source-dependent checks ------------------------------------------------------------------


def test_a_config_that_fits_its_source_is_accepted():
    IngestConfig().check_against_source(9928, 7016, 45)
    IngestConfig(overrides={45: 4700}).check_against_source(9928, 7016, 45)


def test_single_mode_profiles_nothing_so_no_inactive_setting_aborts_the_run():
    # Single mode profiles nothing, so a setting excluded from its effective config cannot abort the run.
    IngestConfig(split="single", gutter_window=(0.99, 1.0), overrides={99: 4700}).check_against_source(1, 1, 45)


def test_the_document_level_check_judges_no_override_value():
    # The document-level check knows the spread count, not each spread's width, so it judges no override value:
    # on a source of mixed raster sizes, 800 is a column of the second spread and not of this 500-wide one.
    IngestConfig(overrides={2: 800}).check_against_source(500, 700, 2)


def test_an_override_is_checked_at_its_own_spread_against_its_own_width():
    # An override value is checked at its own spread, against that spread's own width.
    IngestConfig(overrides={1: 4700}).check_override(1, 9928)
    IngestConfig(overrides={1: 4700}).check_override(2, 100)  # spread 2 has no override, whatever its width is
    # Inactive in single mode, like every other gutter setting: it could not have moved a split that never ran.
    IngestConfig(split="single", overrides={1: 4700}).check_override(1, 1)


SOURCE_DEPENDENT_REJECTIONS = [
    pytest.param(lambda: IngestConfig().check_against_source(1, 7016, 45), id="an empty window at this width"),
    pytest.param(
        lambda: IngestConfig().check_against_source(9928, 1, 45), id="an empty interior row interval at this height"
    ),
    pytest.param(lambda: IngestConfig().check_against_source(9928, 5, 45), id="fewer interior rows than bands"),
    pytest.param(
        lambda: IngestConfig(overrides={46: 4700}).check_against_source(9928, 7016, 45),
        id="an override for a spread this document has not",
    ),
    pytest.param(
        lambda: IngestConfig(overrides={1: 9928}).check_override(1, 9928), id="an override at the raster edge"
    ),
    pytest.param(lambda: IngestConfig(overrides={1: 0}).check_override(1, 9928), id="an override at column zero"),
]


@pytest.mark.parametrize("build", SOURCE_DEPENDENT_REJECTIONS)
def test_ingest_config_refuses_against_its_source(build):
    with pytest.raises(IngestError):
        build()


# --- Effective config: single mode persists only what was active -------------------------------------------------


def test_single_mode_persists_only_what_was_active():
    assert IngestConfig(split="single", overrides={1: 100}).model_dump(mode="json") == {"split": "single"}
    # Inactive fields may regain their defaults on parse; they must not come back on serialization.
    reparsed = IngestConfig.model_validate({"split": "single"})
    assert reparsed.gutter_window == (0.40, 0.60) and reparsed.model_dump(mode="json") == {"split": "single"}


def test_spread_mode_persists_every_setting():
    spread_mode = IngestConfig().model_dump(mode="json")
    assert spread_mode["gutter_window"] == [0.40, 0.60] and spread_mode["overrides"] == {}
    assert set(spread_mode) == set(IngestConfig.model_fields)


def test_a_config_survives_the_canonical_json_round_trip():
    # A config survives the canonical JSON round trip, integer override keys included.
    overridden = IngestConfig(overrides={3: 400})
    assert overridden.model_dump(mode="json")["overrides"] == {"3": 400}
    assert IngestConfig.model_validate(overridden.model_dump(mode="json")) == overridden


EFFECTIVE_CONFIG_REJECTIONS = [
    # A wrong gutter bound is still an error in single mode: the projection decides what is persisted, not what
    # is valid.
    pytest.param(
        lambda: IngestConfig(split="single", gutter_window=(0.9, 0.1)), id="a bad gutter bound in single mode"
    ),
]


@pytest.mark.parametrize("build", EFFECTIVE_CONFIG_REJECTIONS)
def test_the_effective_config_refuses(build):
    with pytest.raises(ValidationError):
        build()


# --- PipelineConfig: how to ingest, and what evidence to accept --------------------------------------------------


def test_the_default_pipeline_runs_ocr():
    assert PipelineConfig().ocr is not None


def test_the_ingest_config_nests_and_persists_in_its_effective_form():
    assert PipelineConfig.model_validate({"ingest": {"split": "single"}}).ingest.split == "single"
    assert PipelineConfig.model_validate({"ingest": {"split": "single"}}).model_dump(mode="json")["ingest"] == {
        "split": "single"
    }


PIPELINE_CONFIG_REJECTIONS = [
    pytest.param(lambda: PipelineConfig.model_validate({"stages": ["ingest"]}), id="a stage list, an unknown key"),
    pytest.param(
        lambda: PipelineConfig.model_validate({"ocr": {"transcriber": "surya"}}), id="an unknown OCR setting"
    ),
    pytest.param(
        lambda: PipelineConfig.model_validate({"evidence": {"transcriber": "vlm"}}),
        id="an external evidence section",
    ),
    # A path is a run argument, never a setting.
    pytest.param(
        lambda: PipelineConfig.model_validate({"evidence": {"result_dir": "x"}}), id="a result directory as a setting"
    ),
]


@pytest.mark.parametrize("build", PIPELINE_CONFIG_REJECTIONS)
def test_pipeline_config_refuses(build):
    with pytest.raises(ValidationError):
        build()


# --- Ingest artifact, report and envelope ---------------------------------------------------------------------


def test_an_ingest_artifact_reads_no_upstream_and_persists_its_full_config():
    loaded_artifact = IngestArtifact.model_validate(artifact())
    assert loaded_artifact.envelope.upstream == {} and len(loaded_artifact.pages) == 4
    assert loaded_artifact.model_dump(mode="json")["config"]["split"] == "spread"


def test_a_single_mode_artifact_persists_its_effective_config():
    single = IngestArtifact.model_validate(
        artifact(
            config={"split": "single"},
            pages=[page(1, 1, "single"), page(2, 2, "single")],
            report=ingest_report(pages_written=2, methods={"none": 2}, spreads=[], weak_support=[]),
        )
    )
    assert single.model_dump(mode="json")["config"] == {"split": "single"}


def test_text_layers_are_counted_per_spread_and_their_keys_parse_back():
    # Invisible text is counted per spread, only where there is any; JSON keys come back as strings and parse.
    assert IngestReport.model_validate(ingest_report(text_layers={"2": 3})).text_layers == {2: 3}


ARTIFACT_REJECTIONS = [
    pytest.param(
        lambda: IngestArtifact.model_validate(artifact(envelope=envelope(upstream={"ocr": digest("d")}))),
        id="an ingest artifact with an upstream stage",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(artifact(envelope=envelope(stage="ocr"))), id="another stage's envelope"
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(artifact(envelope=envelope(created="2026-09-14T12:00:00"))),
        id="a naive envelope timestamp",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(artifact(envelope=envelope(digest="abc"))),
        id="a digest that is not a sha256",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(pages=[page(2, 1, "left"), page(3, 1, "right"), page(4, 2, "left"), page(5, 2, "right")])
        ),
        id="pages that do not start at 1",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(artifact(source=source(1))), id="a spread the source does not have"
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(pages=[page(1, 1, "left"), page(2, 2, "left")], report=ingest_report(pages_written=2))
        ),
        id="one page for a spread split in two",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(pages=[page(1, 1, "right"), page(2, 1, "left"), page(3, 2, "left"), page(4, 2, "right")])
        ),
        id="a right page before its left page",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(
                pages=[
                    page(1, 1, "left"),
                    page(2, 1, "right", gutter_evidence=evidence(band_support=0.2)),
                    page(3, 2, "left"),
                    page(4, 2, "right"),
                ]
            )
        ),
        id="pages that disagree about their spread",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(
                pages=[
                    page(1, 1, "left", size_pt=(600.0, 400.0)),
                    page(2, 1, "right", size_pt=(600.0, 400.0)),
                    page(3, 2, "left"),
                    page(4, 2, "right"),
                ]
            )
        ),
        id="a page size the source does not state",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(
                pages=[page(1, 1, "single"), page(2, 2, "single")],
                report=ingest_report(pages_written=2, methods={"none": 2}, spreads=[], weak_support=[]),
            )
        ),
        id="a single page under split spread",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(
                config={"split": "single"},
                pages=[page(1, 1, "single"), page(2, 2, "single")],
                report=ingest_report(pages_written=2, methods={"none": 2}, weak_support=[]),
            )
        ),
        id="a report that measured a spread in single mode",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(report=ingest_report(spreads=[spread_report(1, gutter_x_px=400), spread_report(2)]))
        ),
        id="a report that disagrees with the pages about the gutter",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(
            artifact(
                report=ingest_report(
                    spreads=[spread_report(1, evidence=evidence(band_support=0.2)), spread_report(2)]
                )
            )
        ),
        id="a report that disagrees with the pages about the evidence",
    ),
    pytest.param(
        lambda: IngestArtifact.model_validate(artifact(report=ingest_report(pages_written=3))),
        id="a report that miscounts its pages",
    ),
    pytest.param(
        lambda: IngestReport.model_validate(ingest_report(methods={"shadow": 1})),
        id="methods that do not count every spread",
    ),
    pytest.param(
        lambda: IngestReport.model_validate(ingest_report(weak_support=[3])),
        id="weak support for an unmeasured spread",
    ),
    pytest.param(
        lambda: IngestReport.model_validate(ingest_report(text_layers={3: 1})),
        id="a text layer on a spread not read",
    ),
    pytest.param(
        lambda: IngestReport.model_validate(ingest_report(text_layers={1: 0})), id="a text layer counted as zero"
    ),
    pytest.param(
        lambda: IngestReport.model_validate(ingest_report(spreads=[spread_report(1), spread_report(1)])),
        id="a spread reported twice",
    ),
    pytest.param(
        lambda: IngestReport.model_validate(
            ingest_report(spreads=[spread_report(1, method="none"), spread_report(2)])
        ),
        id="a spread report with no method",
    ),
]


@pytest.mark.parametrize("build", ARTIFACT_REJECTIONS)
def test_ingest_artifact_report_and_envelope_refuse(build):
    with pytest.raises(ValidationError):
        build()


# --- EvidenceReport: what the loader read, counted and could not place ------------------------------------------


def test_an_evidence_report_counts_its_segments_by_label_and_status():
    report = EvidenceReport.model_validate(evidence_report())
    assert (report.generation, report.segments, report.rejected, report.overlaps) == ("g", 2, [], {})
    assert report.by_label == {"Text": 2} and report.by_status == {"ok": 2}


EVIDENCE_REPORT_REJECTIONS = [
    pytest.param(
        lambda: EvidenceReport.model_validate(evidence_report(by_label={"Text": 1})),
        id="labels that do not count every segment",
    ),
    pytest.param(
        lambda: EvidenceReport.model_validate(evidence_report(spreads_without_pages=[2, 2])),
        id="a spread without pages listed twice",
    ),
    pytest.param(
        lambda: EvidenceReport.model_validate(
            evidence_report(rejected=[{"page": 1, "unit": 1, "crop": 1, "index": 0, "bbox_px": None, "reason": "lost"}])
        ),
        id="a rejection for a reason the loader does not give",
    ),
    pytest.param(
        lambda: EvidenceReport.model_validate(evidence_report(overlaps={1: [1, 3]})),
        id="overlaps that are not pairs of crops",
    ),
]


@pytest.mark.parametrize("build", EVIDENCE_REPORT_REJECTIONS)
def test_evidence_report_refuses(build):
    with pytest.raises(ValidationError):
        build()


# --- Run report: this invocation's seconds, and the stored ingest timings ---------------------------------------


def test_a_skipped_ingest_reports_this_invocation_and_the_stored_timings():
    skipped = RunReport.model_validate(run_report())
    assert skipped.ingest.seconds == 0.04 and skipped.ingest.report.seconds == 1.8
    assert skipped.ocr is None


RUN_REPORT_REJECTIONS = [
    pytest.param(lambda: RunReport.model_validate(run_report(stages=[])), id="a run report with a stage list"),
    pytest.param(lambda: RunReport.model_validate(run_report(seconds=-1.0)), id="negative seconds"),
    pytest.param(
        lambda: RunReport.model_validate(without(run_report(), "ingest")), id="a run report without its ingest"
    ),
]


@pytest.mark.parametrize("build", RUN_REPORT_REJECTIONS)
def test_run_report_refuses(build):
    with pytest.raises(ValidationError):
        build()
