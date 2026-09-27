"""Layout-aware cuts (docs/ingest-cuts.md): the fixture spread cut for real, then synthetic pages whose ink is their
layout boxes plus whatever the layout model missed, for the X-Y cut, the policy hook, the recovery paths and the
document lifetime of cut_pages. Only the fixture spread runs the layout model; every other case patches it."""
from unittest.mock import patch

import numpy as np
import pytest
from PIL import Image

from kei_exp.cut import (
    DEFAULT_LAYOUT_MODEL,
    LAYOUT_MODELS,
    Box,
    CutError,
    Region,
    _Page,
    cut_pages,
    find_regions,
    render_region,
)
from kei_exp.pages import PdfPages


@pytest.fixture(scope="module")
def spread_cut(scan_pdf):
    """The fixture spread cut for real, once per module (the layout model runs on CPU, about eight seconds): the
    page, its regions and the _Page that measured its ink. The document stays open so a test can render from it."""
    with PdfPages(scan_pdf) as pdf:
        page = pdf.page(1)
        yield page, find_regions(page, 1), _Page(page, 1)


def test_spread_cuts_into_four_columns_in_reading_order(spread_cut):
    _, regions, _ = spread_cut
    assert [region.kind for region in regions] == ["column"] * 4, regions
    assert [region.order for region in regions] == [0, 1, 2, 3]
    assert all(regions[i].bbox[2] <= regions[i + 1].bbox[0] + 8 for i in range(3))  # reading order, only pad overlap


def test_column_cuts_match_the_golden_measurements(spread_cut):
    _, regions, _ = spread_cut
    # Golden cuts measured in docs/ingest-cuts.md: 323, 607 and 890 pt. Columns 0/1 share the first cut,
    # 1/2 stop 8 pt past their blocks either side of the gutter, 2/3 share the last cut.
    cuts = [regions[0].bbox[2] - 4, regions[3].bbox[0] + 4]
    assert abs(cuts[0] - 323) <= 3 and abs(cuts[1] - 890) <= 3, cuts
    assert regions[1].bbox[2] < 607 < regions[2].bbox[0], (regions[1].bbox, regions[2].bbox)


def test_four_columns_cover_nearly_all_of_the_spreads_ink(spread_cut):
    _, regions, spread = spread_cut
    # Every region carries its share of the page's ink; the four columns together cover nearly all of it.
    coverage = spread.ink_share(*(region.bbox for region in regions))
    assert coverage >= 0.9 and all(0 < region.ink <= coverage for region in regions), (coverage, regions)


def test_first_column_renders_grayscale_under_suryas_request_cap(spread_cut):
    page, regions, _ = spread_cut
    crop = render_region(page, regions[0], 250)
    assert crop.mode == "L" and 840 <= crop.width <= 870 and 2420 <= crop.height <= 2460, crop.size
    assert crop.width * crop.height < 3072 * 2048  # under Surya's request cap, so it is sent unscaled


def fake_page(boxes, size=(600, 800), unboxed=(), layout_model=DEFAULT_LAYOUT_MODEL):
    """A _Page whose ink is the filled layout boxes plus `unboxed` rectangles the layout model missed."""
    p = _Page.__new__(_Page)
    p.number, p.scale, p.origin = 9, 72 / 100, (0.0, 0.0)
    p.layout_model = layout_model
    p.bounds = (0.0, 0.0, float(size[0]), float(size[1]))
    ink = np.zeros((round(size[1] / p.scale), round(size[0] / p.scale)), bool)
    for l, t, r, b in [box[:4] for box in boxes] + list(unboxed):
        ink[round(t / p.scale):round(b / p.scale), round(l / p.scale):round(r / p.scale)] = True
    p.ink, p.boxes = ink, [Box(*box) for box in boxes]
    p.image = Image.fromarray(np.where(ink, 0, 255).astype(np.uint8))
    return p


# Layouts shared by several cases: a heading spanning two columns, a single-column page beside a two-column page,
# and a figure across both columns.
SPANNING = [(50, 40, 550, 70, "section_header"), (50, 90, 280, 700, "text"), (320, 90, 550, 700, "text")]
MIXED = [(50, 40, 270, 700, "text"), (320, 40, 420, 700, "text"), (450, 40, 550, 700, "text")]
FIGURE = [(50, 40, 280, 300, "text"), (320, 40, 550, 300, "text"), (50, 320, 550, 480, "picture"),
          (50, 500, 280, 760, "text"), (320, 500, 550, 760, "text")]


def test_a_spanning_heading_becomes_a_band_above_the_columns():
    # A heading spanning two columns: a band for it, then the columns beneath, cut near x = 300.
    regions = fake_page(SPANNING).regions()
    assert [r.kind for r in regions] == ["band", "column", "column"], regions
    assert abs(regions[1].bbox[2] - 292) <= 2 and abs(regions[2].bbox[0] - 308) <= 2, regions  # blocks + 8 + 4 pt
    assert regions[0].bbox[3] < regions[1].bbox[1]  # the band stops above the columns


def test_running_head_and_page_number_join_the_outermost_regions():
    # A running head and a corner page number outside the body join the outermost regions they fit.
    margins = SPANNING + [(50, 10, 200, 25, "page_header"), (50, 760, 80, 775, "page_footer")]
    regions = fake_page(margins).regions()
    assert regions[0].bbox[1] <= 10 and regions[1].bbox[3] >= 775 and regions[2].bbox[3] < 760, regions


def test_a_short_last_line_does_not_split_its_column():
    # A short last line inside a column is not a spanning block: the column stays whole.
    column = [(50, 90, 280, 300, "text"), (50, 310, 180, 320, "text"), (50, 330, 280, 600, "text")]
    assert [r.kind for r in fake_page(column).regions()] == ["page"]


def test_columns_of_unequal_widths_are_all_columns():
    # A single-column page beside a two-column page: widths 220, 100 and 100 are all legitimate columns.
    assert [r.kind for r in fake_page(MIXED).regions()] == ["column"] * 3


@pytest.mark.parametrize("boxes, bridge", [
    ([(50, 40, 280, 700, "text"), (320, 40, 550, 700, "text")], (280, 40, 320, 700)),
    ([(50, 40, 550, 80, "text"), (50, 130, 280, 700, "text"), (320, 130, 550, 700, "text")],
     (50, 80, 550, 130)),
])
def test_a_layout_gap_crossing_printed_content_keeps_the_region_whole(boxes, bridge):
    # Hamburg p3: layout boxes suggest a gap that the printed text crosses. Neither axis may cut that text.
    page = fake_page(boxes, unboxed=[bridge])
    regions = page.regions()
    assert len(regions) == 1
    assert page.ink_share(regions[0].bbox) == 1


def test_an_unsafe_boundary_does_not_discard_other_safe_column_cuts():
    page = fake_page([(50, 40, 180, 700, "text"), (220, 40, 350, 700, "text"),
                      (400, 40, 550, 700, "text")], unboxed=[(180, 40, 220, 700)])
    regions = page.regions()
    assert len(regions) == 2 and regions[0].bbox[2] < regions[1].bbox[0]
    assert page.ink_share(*(r.bbox for r in regions)) == 1


def test_a_figure_across_the_columns_cuts_y_between_the_x_cuts():
    # A figure across both columns: columns above, the figure, columns below (x, then y, then x again).
    assert [r.kind for r in fake_page(FIGURE).regions()] == ["column", "column", "figure", "column", "column"]


def test_the_policy_gets_the_cuts_coverage_and_each_regions_own_share():
    # Coverage: the layout model missed the second of two equal columns, so the cut covers half of the page's ink.
    # The policy gets that number and each region's own share.
    missed = fake_page([(50, 40, 280, 700, "text")], unboxed=[(320, 40, 550, 700)])
    seen = []
    missed.policy = lambda regions, coverage: seen.append(round(coverage, 2)) or regions
    regions = missed.regions()
    assert [r.kind for r in regions] == ["page"] and abs(regions[0].ink - 0.5) < 0.02, regions
    assert seen == [0.5], seen
    assert abs(missed.ink_share(*(r.bbox for r in regions)) - 0.5) < 0.02
    assert abs(missed.ink_share(missed.bounds) - 1) < 1e-6 and missed.ink_share() == 0


def test_a_page_whose_layout_found_nothing_still_reaches_the_policy():
    # A page whose layout found nothing still reaches the policy, with no regions and zero coverage.
    unfound = fake_page([], unboxed=[(320, 40, 550, 700)])
    seen = []
    unfound.policy = lambda regions, coverage: seen.append((regions, coverage)) or regions
    assert unfound.regions() == [] and seen == [([], 0.0)]


def test_order_is_assigned_after_the_policy():
    # Order is assigned after the policy, so it may drop, merge or add regions freely.
    missed = fake_page([(50, 40, 280, 700, "text")], unboxed=[(320, 40, 550, 700)])
    missed.policy = lambda regions, coverage: [missed.region("page", missed.bounds)] + regions
    assert [(r.kind, r.order, round(r.ink, 2)) for r in missed.regions()] == [("page", 0, 1.0), ("page", 1, 0.5)]


def test_a_missed_column_is_recovered_by_tiled_layout():
    # Retry layout when a column is missed; preserve the original column when only the missing one is found.
    missed = fake_page([(50, 40, 280, 700, "text")], unboxed=[(320, 40, 550, 700)])
    with patch("kei_exp.cut._layout", return_value=[Box(320, 40, 550, 700, "text")]) as layout:
        regions = missed.regions()
        assert layout.call_count == 4
    assert [r.kind for r in regions] == ["column", "column"], regions
    assert [r.order for r in regions] == [0, 1]
    assert missed.ink_share(*(r.bbox for r in regions)) == 1


def test_a_truncated_column_is_retried_over_its_own_span_only():
    # Page-wide coverage can hide a truncated column. Retry only its vertical span and keep the other cut intact.
    partial = fake_page([(50, 40, 280, 700, "text"), (320, 130, 550, 680, "text")],
                        unboxed=[(320, 40, 550, 130), (320, 680, 550, 700)])
    initial = partial._candidate_regions()
    assert partial.ink_share(*(r.bbox for r in initial)) > 0.9
    with patch("kei_exp.cut._layout", return_value=[Box(320, 40, 550, 700, "text")]) as layout:
        regions = partial.regions()
        assert layout.call_count == 2
        assert all(call.args[0].width < partial.image.width / 2 for call in layout.call_args_list)
    assert regions[0] == initial[0]
    assert regions[1].bbox[::2] == initial[1].bbox[::2]
    assert regions[1].bbox[1] <= 40 and regions[1].bbox[3] >= 700
    assert partial.ink_share(*(r.bbox for r in regions)) == 1


def test_a_few_missing_lines_still_extend_the_column():
    # Five missing lines can leave both the page and the affected column above 90 % coverage.
    short = fake_page([(50, 40, 280, 700, "text"), (320, 40, 550, 650, "text")],
                      unboxed=[(320, 650, 550, 700)])
    initial = short._candidate_regions()
    assert short.ink_share(*(r.bbox for r in initial)) > 0.9
    assert initial[1].ink / short.ink_share((320, 0, 550, 800)) > 0.9
    with patch("kei_exp.cut._layout", return_value=[Box(320, 40, 550, 700, "text")]) as layout:
        regions = short.regions()
        assert layout.call_count == 2
    assert regions[0] == initial[0] and regions[1].bbox[3] >= 700


def test_column_end_recovery_gives_small_text_more_vertical_resolution():
    # Beier spread 13, unit 26: full-height layout and its narrow-column retry both miss the last two lines.
    short = fake_page([(50, 40, 280, 700, "text"), (320, 40, 550, 670, "text")],
                      unboxed=[(320, 674, 550, 686), (320, 689, 550, 701)])
    initial = short._candidate_regions()

    def detect(image, scale, origin, model):
        if image.height == short.image.height:
            return [Box(320, 40, 550, 670, "text")]
        top, bottom = origin[1], origin[1] + image.height * scale
        return [Box(320, t, 550, b, "text") for t, b in [(674, 686), (689, 701)]
                if top <= t and b <= bottom]

    with patch("kei_exp.cut._layout", side_effect=detect):
        regions = short.regions()
    assert regions[0] == initial[0]
    assert regions[1].bbox[::2] == initial[1].bbox[::2]
    assert regions[1].bbox[3] >= 701


def test_content_in_another_band_does_not_make_a_column_look_truncated():
    # Content in another y-band must not make a complete column look truncated.
    with patch("kei_exp.cut._layout", side_effect=AssertionError("unexpected column retry")):
        assert [r.kind for r in fake_page(FIGURE).regions()] == ["column", "column", "figure", "column", "column"]


def test_a_sliver_grows_into_its_column_after_recovery():
    # A sliver caused by a partial detection grows into its complete column after layout recovery.
    sliver = fake_page([(50, 40, 280, 700, "text"), (320, 350, 512, 368, "text")],
                       unboxed=[(320, 40, 550, 700)])
    with patch("kei_exp.cut._layout", return_value=[Box(320, 40, 550, 700, "text")]):
        regions = sliver.regions()
    assert [r.kind for r in regions] == ["column", "column"]
    assert regions[1].bbox[1] <= 40 and regions[1].bbox[3] >= 700


def test_recovery_works_when_the_first_layout_found_no_body_blocks():
    # Recovery also works when the first layout found no body blocks.
    unfound = fake_page([], unboxed=[(50, 40, 280, 700), (320, 40, 550, 700)])
    with patch("kei_exp.cut._layout", return_value=[Box(50, 40, 280, 700, "text"), Box(320, 40, 550, 700, "text")]):
        assert [r.kind for r in unfound.regions()] == ["column", "column"]


def test_an_unchanged_retry_keeps_the_initial_regions():
    # Ink coverage includes decoration: an unchanged retry must keep useful crops below the retry threshold.
    decorated = fake_page([(50, 120, 550, 700, "text")], unboxed=[(50, 10, 550, 105)])
    initial = decorated._candidate_regions()
    coverage = decorated.ink_share(*(r.bbox for r in initial))
    assert 0.85 < coverage < 0.87
    with patch("kei_exp.cut._layout", return_value=[]) as layout:
        assert decorated.policy(initial, coverage) is initial
        assert layout.call_count == 4


def test_useful_recovery_is_accepted_below_the_retry_threshold():
    # Accept useful recovery even if decorative ink leaves total coverage below the retry threshold.
    decorated = fake_page([(50, 120, 280, 700, "text")],
                          unboxed=[(320, 120, 550, 700), (50, 10, 550, 90)])
    with patch("kei_exp.cut._layout", return_value=[Box(320, 120, 550, 700, "text")]):
        regions = decorated.regions()
    assert [r.kind for r in regions] == ["column", "column"]
    assert 0.8 < decorated.ink_share(*(r.bbox for r in regions)) < 0.9


def test_no_body_blocks_at_either_resolution_is_a_cut_error():
    # Finding no body blocks at either resolution still fails explicitly.
    unfound = fake_page([], unboxed=[(320, 40, 550, 700)])
    with patch("kei_exp.cut._layout", return_value=[]) as layout:
        with pytest.raises(CutError) as failure:  # an unsuccessful layout retry must fail
            unfound.regions()
        assert "page 9" in str(failure.value) and "after tiled layout" in str(failure.value), failure.value
        assert layout.call_count == 4


@pytest.mark.parametrize("found_initially", [True, False])
def test_a_numbered_blank_page_keeps_its_furniture(found_initially):
    # Katrinesminde p23 has only a page number, which must not abort the whole document.
    footer = Box(520, 760, 535, 780, "page_footer")
    page = fake_page([footer] if found_initially else [], unboxed=[footer[:4]])
    with patch("kei_exp.cut._layout", return_value=[] if found_initially else [footer]):
        regions = page.regions()
    assert len(regions) == 1 and regions[0].bbox == page.bounds and regions[0].ink == 1


def test_a_footer_does_not_hide_unrecognized_body_content():
    page = fake_page([(520, 760, 535, 780, "page_footer")], unboxed=[(50, 40, 550, 700)])
    with patch("kei_exp.cut._layout", return_value=[]), pytest.raises(CutError, match="no body blocks"):
        page.regions()


def test_good_cuts_and_blank_pages_need_no_more_inference():
    # Good cuts and truly blank pages do not need additional inference.
    with patch("kei_exp.cut._layout", side_effect=AssertionError("unexpected layout retry")):
        assert [r.kind for r in fake_page(MIXED).regions()] == ["column"] * 3
        assert fake_page([]).regions() == []


@pytest.mark.parametrize("model", list(LAYOUT_MODELS))
def test_the_runs_layout_model_reaches_initial_detection_and_the_tiled_retry(model, scan_pdf):
    # The run's choice reaches initial detection and both recovery paths without a model switch.
    with patch("kei_exp.cut._layout", return_value=[Box(50, 40, 280, 700, "text")]) as layout:
        with PdfPages(scan_pdf) as pdf:
            assert list(cut_pages(pdf, [1], 72, layout_model=model))
        assert layout.call_count == 5
        assert all(call.args[3] == model for call in layout.call_args_list)


@pytest.mark.parametrize("model", list(LAYOUT_MODELS))
def test_the_runs_layout_model_reaches_the_column_retry(model):
    # The run's choice reaches initial detection and both recovery paths without a model switch.
    partial = fake_page([(50, 40, 280, 700, "text"), (320, 40, 550, 650, "text")],
                        unboxed=[(320, 650, 550, 700)], layout_model=model)
    with patch("kei_exp.cut._layout", return_value=[Box(320, 40, 550, 700, "text")]) as layout:
        assert partial.regions()[1].bbox[3] >= 700
        assert layout.call_count == 2 and all(call.args[3] == model for call in layout.call_args_list)


def test_a_failing_cut_leaves_the_document_closed(scan_pdf):
    # A cut that fails partway leaves the source closed on the way out.
    pdf = PdfPages(scan_pdf)
    with (patch("kei_exp.cut.find_regions", side_effect=CutError("forced")),
          pytest.raises(CutError, match="forced"), pdf):  # else: the forced failure did not surface
        list(cut_pages(pdf, [1], 72))
    assert pdf._document is None, "the document was left open"


def test_a_page_outside_the_document_is_a_cut_error(scan_pdf):
    # A page outside the document is a CutError.
    with PdfPages(scan_pdf) as pdf, pytest.raises(CutError, match="no page 2"):  # else: the page was cut
        list(cut_pages(pdf, [2], 72))


def test_crops_come_out_as_each_page_is_cut(scan_pdf):
    # Crops come out as each page is cut: the first is in hand before the next page's layout runs, and a failure on
    # a later page surfaces from the iteration as the same CutError.
    cut_calls = []

    def regions_of(page, number, layout_model=DEFAULT_LAYOUT_MODEL):
        cut_calls.append(number)
        if len(cut_calls) == 2:
            raise CutError("forced on the second page")
        return [Region("page", (0.0, 0.0, *page.get_size()), 0, 1.0)]

    with patch("kei_exp.cut.find_regions", side_effect=regions_of), PdfPages(scan_pdf) as pdf:
        produced = cut_pages(pdf, [1, 1], 72)
        assert next(produced)[0] == 1 and cut_calls == [1], cut_calls
        with pytest.raises(CutError, match="second page"):  # else: the failure did not surface from the iteration
            next(produced)
