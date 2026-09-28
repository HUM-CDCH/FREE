"""The converter over the KIE ingest's book pages: page-source renders, whole pages as crops, the cut over book pages,
`--page-source ingest` through convert() with its cache.
The layout model runs on CPU, no GPU and no server: the transcriber is a fake. One workspace for the module: the
fixture spread is ingested once, with the layout model, and every later conversion reuses that ingest."""
import json
from dataclasses import replace
from pathlib import Path
from typing import NamedTuple
from unittest.mock import patch

import numpy as np
import pypdfium2 as pdfium
import pytest
from PIL import Image

from kei_exp.geometry import CropTransform, PointBox
from kei_exp.kie.ingest_model import IngestArtifact, Placement
from kei_exp.kie.ingest_model import Page as IngestPage
from kei_exp.kie.runner import convert
from kei_exp.kie.stages.ocr import resolve
from kei_exp.pages import BookPage, BookPages, PdfPages
from kei_exp.transcription.types import ConversionError, Execution, RunParams
from tests.helpers.fake import FakeTranscriber, registered

SPREAD_PT = (1190.52, 841.92)  # the fixture's PDF page, in points


def single_page(width_px: int, height_px: int, dpi: float = 600.0) -> IngestPage:
    """An ingest page standing alone on its spread, placed to fill a page of its own size at `dpi`."""
    width_pt, height_pt = width_px * 72 / dpi, height_px * 72 / dpi
    return IngestPage(index=1, spread=1, side="single", image="page.png", width_px=width_px, height_px=height_px,
                      sha256="0" * 64, source_rect=(0, 0, width_px, height_px), spread_width_px=width_px,
                      spread_height_px=height_px, dpi_x=dpi, dpi_y=dpi, gutter_x_px=None, gutter_method="none",
                      gutter_reason=None, gutter_evidence=None,
                      placement=Placement(a=width_pt, b=0.0, c=0.0, d=height_pt, e=0.0, f=0.0,
                                          page_width_pt=width_pt, page_height_pt=height_pt))


def best_shift(ours: Image.Image, theirs: Image.Image, reach: int = 3) -> tuple[int, int]:
    """The shift of `theirs` against `ours`, in pixels, at which the two renders agree best within `reach`."""
    a, b = np.asarray(ours, dtype=float), np.asarray(theirs, dtype=float)
    height, width = min(a.shape[0], b.shape[0]) - reach, min(a.shape[1], b.shape[1]) - reach
    core = a[reach:height, reach:width]
    return min((np.abs(core - b[reach + dy:height + dy, reach + dx:width + dx]).mean(), (dx, dy))
               for dx in range(-reach, reach + 1) for dy in range(-reach, reach + 1))[1]


def close(bbox, expected, tolerance: float = 1e-6) -> bool:
    """The same box to a millionth of a point: 10 pixels at 72 / 100 points each is 7.2 up to a rounding error."""
    return all(abs(a - b) < tolerance for a, b in zip(bbox, expected, strict=True))


def page_file(result_dir: Path, number: int) -> dict:
    """A page file as the viewer reads it: a dict, through the keys page files of version 3 and 4 share."""
    return json.loads((result_dir / "pages" / f"{number}.json").read_text(encoding="utf-8"))


def transform_of(crop: dict) -> CropTransform:
    """A crop's recorded transform as the page file keeps it: the origin and scale pairs and the native rectangle."""
    return CropTransform(*crop["origin_pt"], *crop["pt_per_px"], tuple(crop["source_px"]))


def placed(book: BookPages, unit: dict, crop: dict, segment: dict) -> PointBox:
    """Where a segment's engine box lands on the PDF page by the design's arithmetic (canonical evidence §3.1): the
    crop's pixels through the crop's recorded transform into the book page's points, then the book page's placement
    onto the spread. The writer applied exactly this; nothing nominal (no 72 / dpi, no gutter constant) is in it."""
    return book.page(unit["index"]).to_page_points(transform_of(crop).to_unit_points(tuple(segment["bbox_px"])))


# A BookPage is a bilevel PNG at its own dpi; points are pixels over dpi / 72, renders resample by area.


@pytest.fixture
def page(tmp_path) -> BookPage:
    """A 1200 x 600 bilevel page at 600 dpi (144 x 72 pt) whose top-left quarter is black."""
    ink = np.ones((600, 1200), bool)
    ink[:300, :600] = False  # the top-left quarter is black
    Image.fromarray(ink).save(tmp_path / "page.png")
    return BookPage(tmp_path / "page.png", single_page(1200, 600))


def test_a_book_page_is_its_pixels_over_its_dpi_and_renders_by_area(page):
    assert page.get_size() == (144.0, 72.0)
    assert page.render(100).size == (200, 100) and page.render(100).mode == "L"
    native = page.render(600, (0.0, 0.0, 72.0, 36.0))
    assert native.size == (600, 300) and not np.asarray(native).any()  # the black quarter, pixel for pixel
    assert page.render(300, (0.0, 0.0, 72.0, 36.0)).size == (300, 150)
    assert page.render(600, (72.0, 36.0, 144.0, 72.0)).getextrema() == (255, 255)


def test_a_box_past_the_page_is_cut_at_the_page_never_padded_black(page):
    past = page.render(600, (72.0, 36.0, 150.0, 80.0))  # a bbox past the page is cut at the page, never padded black
    assert past.size == (600, 300) and past.getextrema() == (255, 255), (past.size, past.getextrema())


def test_a_fractional_box_starts_on_the_native_grid_and_the_transform_records_where(page):
    # A fractional bbox: the crop starts on the native grid and keeps the scale, so 12 pt at 250 dpi is 42 px
    # (pdfium's ceil gives the same), and a bbox that rounds to no pixel is refused rather than painted black.
    assert page.render(250, (0.05, 0.0, 12.05, 12.0)).size == (42, 42)
    # The recorded transform says where those 42 pixels really sit: the native box (0, 0, 100, 100) at 600 dpi, so
    # 12.0 pt wide, not the 12.096 pt that 42 pixels at a nominal 72 / 250 would claim.
    transform = page.crop_transform(250, (0.05, 0.0, 12.05, 12.0))
    assert transform.source_px == (0, 0, 100, 100) and transform.origin_x == 0.0
    assert abs(transform.to_unit_points((0, 0, 42, 42))[2] - 12.0) < 1e-9, transform


def test_a_box_covering_no_pixel_is_refused(page):
    with pytest.raises(ValueError, match="covers no pixel"):  # an empty crop must be refused
        page.render(250, (0.01, 0.0, 0.02, 1.0))


# The converter over the ingest: the spread becomes book pages 1 and 2, each cut into its two columns, and the
# second conversion of the same file finds the ingest cached.


@pytest.fixture(scope="module")
def workspace(tmp_path_factory) -> Path:
    """One temporary directory for the module: the ingests, the debug and result directories, the fake API runs."""
    return tmp_path_factory.mktemp("pages")


@pytest.fixture(scope="module")
def fake():
    """The check's transcriber, registered as the `fake` model for the module: one Surya-like block per crop at crop
    pixels (10, 20)-(30, 40), and no knobs."""
    with registered(FakeTranscriber(knobs=frozenset(), blocks=True)) as transcriber:
        yield transcriber


class Converted(NamedTuple):
    params: RunParams
    execution: Execution
    markdown: str
    events: list[dict]
    crops: list[tuple]    # the transcriber's inputs: (book page, region, image)
    report: dict          # the debug report
    result_dir: Path
    published: Path       # the accepted ingest artifact of the fixture spread, under `workspace / "ingest"`


@pytest.fixture(scope="module")
def converted(workspace, scan_pdf, fake) -> Converted:
    """The fixture spread through convert() over its ingest, once for the module: the ingest runs into
    `workspace / "ingest"` (every later conversion of the spread finds it there), the layout model cuts the two book
    pages at 100 dpi, and the debug report and the accepted result are written."""
    events: list[dict] = []
    params = RunParams(pdf=scan_pdf, model="fake", page_source="ingest", ingest_dir=workspace / "ingest", crop_dpi=100,
                       debug_dir=workspace / "debug", result_dir=workspace / "result")
    execution = resolve(params)
    markdown = convert(execution, emit=events.append)
    _, crops = fake.calls[-1]
    report = json.loads((workspace / "debug" / "report.json").read_text(encoding="utf-8"))
    return Converted(params, execution, markdown, events, crops, report, workspace / "result",
                     workspace / "ingest" / scan_pdf.stem / "ingest")


@pytest.fixture(scope="module")
def book(converted) -> BookPages:
    """The book pages of the published ingest, as the converter's page source reads them."""
    artifact = IngestArtifact.model_validate_json((converted.published / "ingest.json").read_bytes())
    return BookPages(converted.published, artifact.pages)


def test_resolve_keeps_the_ingest_page_source_and_its_directory(converted, workspace):
    assert converted.execution.page_source == "ingest" and converted.execution.ingest_dir == workspace / "ingest"


def test_the_spread_becomes_two_book_pages_each_cut_into_two_crops(converted):
    assert converted.markdown == "\n\n".join(["text"] * 4)  # one record per crop
    crops = converted.crops
    assert [number for number, _, _ in crops] == [1, 1, 2, 2], [number for number, _, _ in crops]
    # Two regions per page: page 1's right column is a "figure" because the layout model labels one of its lines
    # a key_value_region, which is the cut's label rule at work and not the page source's business.
    assert all(region.kind in ("column", "figure") for _, region, _ in crops), [c[1].kind for c in crops]
    assert all(image.mode == "L" and 300 < image.width < 450 for _, _, image in crops), [c[2].size for c in crops]


def test_the_debug_report_records_the_page_source_and_names_book_pages(converted):
    # The debug report records the page source and names book pages (the units).
    report = converted.report
    assert report["page_source"] == "ingest" and report["crop_dpi"] == 100
    assert [entry["region"]["source_page"] for entry in report["pages"]] == [1, 1, 2, 2]


def test_the_page_result_names_the_pdf_page_its_two_units_and_their_crops(converted):
    # The page result names the PDF page, its two units and their crops, with the crops of the right page on the
    # spread past the gutter.
    result = page_file(converted.result_dir, 1)
    assert [unit["index"] for unit in result["units"]] == [1, 2]
    crops = [(crop, unit["index"]) for unit in result["units"] for crop in unit["crops"]]
    assert [(crop["crop"], unit) for crop, unit in crops] == [(1, 1), (2, 1), (3, 2), (4, 2)]
    assert len(result["segments"]) == 4
    third = crops[2][0]  # the first crop of book page 2, on the spread
    assert 594.2 < third["bbox_pt"][0] < 700, third


def test_a_block_of_a_column_crop_is_placed_through_the_crop_transform_and_the_placement(converted, book):
    """The page result places a block of a column crop through the crop's own transform: its corner on the native
    grid plus its pixels at 100 dpi, then the book page's placement onto the spread."""
    result = page_file(converted.result_dir, 1)
    unit = result["units"][1]
    crop, segment = unit["crops"][0], result["segments"][2]  # crop 3, the first of book page 2, and its one block
    assert (unit["index"], crop["crop"], segment["unit"], segment["crop"]) == (2, 3, 2, 3)
    assert segment["bbox_px"] == [10, 20, 30, 40] and segment["extent"] == "block"
    block = list(segment["bbox_pt"])
    # Not `third["bbox"][0] + 7.2`: the scan is placed with a -0.11 degree rotation, so the crop's bbox_pt is the
    # bounding box of its rotated rectangle. That box is 678 pt tall and starts about 1.3 pt (678 pt times the sine
    # of 0.11 degrees) before the crop's own top-left corner, and a block 10 px into the crop is not 7.2 pt into it.
    # What holds is the design's invariant: the block's box is its crop pixels through the recorded transform and
    # the placement, the arithmetic `placed` spells out.
    assert close(block, placed(book, unit, crop, segment)), (block, crop)
    corner = book.page(2).to_page_points(transform_of(crop).to_unit_points((0, 0, 0, 0)))
    print("ROTATION", crop["bbox_pt"], corner, block, book.page(1).to_page_points((0.0, 0.0, 10.0, 20.0)),
          book.page(2).to_page_points((0.0, 0.0, 10.0, 20.0)))
    assert 1.0 < corner[0] - crop["bbox_pt"][0] < 1.6, (corner, crop["bbox_pt"])


def test_region_events_name_the_pdf_page_the_unit_and_the_crop(converted):
    # Region events name the PDF page, the unit and the crop, with the box on the spread.
    regions = [event for event in converted.events if event["type"] == "region"]
    assert [(event["page"], event["unit"], event["crop"]) for event in regions] == [
        (1, 1, 1), (1, 1, 2), (1, 2, 3), (1, 2, 4)]
    assert 594.2 < regions[2]["bbox"][0] < 700 and "index" not in regions[2], regions[2]


def test_the_phases_are_the_ingest_then_the_cut_and_the_ingest_ran(converted):
    events = converted.events
    assert [event["name"] for event in events if event["type"] == "phase"] == ["ingest", "cut"]
    assert any(event["type"] == "log" and "Ingest ran" in event["text"] for event in events)
    assert (converted.published / "pages" / "002.png").exists()


def test_a_second_conversion_of_the_same_file_finds_the_ingest_cached(converted):
    """The same request again (without the debug and result directories, which stay as the first conversion wrote
    them): the ingest is skipped, the cut runs again."""
    events: list[dict] = []
    again = replace(converted.params, debug_dir=None, result_dir=None)
    assert convert(resolve(again), emit=events.append).startswith("text")
    assert any(event["type"] == "log" and "skipped, cached" in event["text"] for event in events)


def test_cut_none_over_book_pages_sends_each_page_whole_at_crop_dpi(converted, workspace, scan_pdf, fake):
    # --cut none over book pages sends each page whole, at crop_dpi.
    assert convert(resolve(RunParams(pdf=scan_pdf, model="fake", page_source="ingest", ingest_dir=workspace / "ingest",
                                     cut="none", crop_dpi=100)), emit=lambda event: None) == "text\n\ntext"
    _, crops = fake.calls[-1]
    assert [(number, region.kind) for number, region, _ in crops] == [(1, "page"), (2, "page")]
    artifact = json.loads((converted.published / "ingest.json").read_text(encoding="utf-8"))
    sizes = {page["index"]: (page["width_px"], page["height_px"]) for page in artifact["pages"]}
    assert sizes[1][0] + sizes[2][0] == 9928 and sizes[1][1] == 7016
    assert all(abs(image.width - sizes[number][0] / 6) < 1 and abs(image.height - sizes[number][1] / 6) < 1
               for number, _, image in crops), [c[2].size for c in crops]


def test_book_page_points_map_onto_the_spread(book):
    # Book-page points onto the spread: the left page starts at the spread's corner, the right page at the gutter
    # (4952 px at 600 dpi is 594.24 pt). The placed scan extends beyond the PDF page's bounds. Neither map
    # is a pure translation: the scan is placed with a -0.11 degree rotation, so a mapped box is the bounding box
    # of a rotated rectangle. The full right page starts before the gutter; its small top-left box starts
    # around 595.02 pt because it does not reach the scan's lower-left corner.
    left = book.page(1).to_page_points((0.0, 0.0, 10.0, 20.0))
    assert abs(left[0]) < 1 and abs(left[1]) < 1.5, left
    corner = book.page(2).to_page_points((0.0, 0.0, 10.0, 20.0))
    assert corner == pytest.approx((595.023043, -0.001989, 605.062087, 20.017505), rel=0, abs=1e-6)
    right = book.page(2).to_page_points((0.0, 0.0, *book.page(2).get_size()))
    assert right == pytest.approx((593.417727, -0.001989, 1192.182098, 843.084244), rel=0, abs=1e-6)


class Shifted(NamedTuple):
    pdf: Path
    markdown: str
    placement: Placement
    corner: BookPage      # book page 1 of the shifted PDF's ingest


@pytest.fixture(scope="module")
def shifted(workspace, scan_pdf, fake) -> Shifted:
    """The fixture spread with its CropBox moved off the user-space origin, converted whole over its own ingest
    (`workspace / "ingest3"`)."""
    path = workspace / "shifted.pdf"
    with pdfium.PdfDocument(str(scan_pdf)) as original:
        original[0].set_cropbox(10, 20, *original[0].get_size())
        original.save(path)
    markdown = convert(resolve(RunParams(pdf=path, model="fake", page_source="ingest", ingest_dir=workspace / "ingest3",
                                         cut="none", crop_dpi=100)), emit=lambda event: None)
    moved = workspace / "ingest3" / path.stem / "ingest"
    artifact = IngestArtifact.model_validate_json((moved / "ingest.json").read_bytes())
    return Shifted(path, markdown, artifact.pages[0].placement, BookPages(moved, artifact.pages).page(1))


def test_a_cropbox_off_the_origin_puts_the_scans_corner_left_of_the_visible_page(shifted, book):
    # Moving the CropBox's left edge by 10 pt translates the same rotated scan box by -10 pt.
    # Moving its bottom edge leaves top-down y coordinates unchanged.
    assert shifted.markdown == "text\n\ntext"
    assert (shifted.placement.origin_x_pt, shifted.placement.origin_y_pt) == (10.0, 20.0), shifted.placement
    before = book.page(1).to_page_points((0.0, 0.0, 10.0, 20.0))
    after = shifted.corner.to_page_points((0.0, 0.0, 10.0, 20.0))
    assert close(after, (before[0] - 10, before[1], before[2] - 10, before[3]))


def test_a_window_of_print_renders_alike_from_the_book_page_and_from_the_pdf_at_the_mapped_box(shifted):
    # And against the pixels: a window of print rendered from the book page and from the PDF page at the mapped
    # box agree within a pixel at 100 dpi, where the same window asked 2.5 pt to the right is seen off by pixels.
    window = (100.0, 150.0, 500.0, 450.0)
    mapped = shifted.corner.to_page_points(window)
    with PdfPages(shifted.pdf) as pdf:
        ours, theirs = shifted.corner.render(100, window), pdf.page(1).render(100, mapped)
        aside = pdf.page(1).render(100, (mapped[0] + 2.5, mapped[1], mapped[2] + 2.5, mapped[3]))
    assert np.asarray(ours).std() > 20, "the window must hold print"
    assert max(map(abs, best_shift(ours, theirs))) <= 1, best_shift(ours, theirs)
    assert best_shift(ours, aside, reach=6)[0] <= -2, best_shift(ours, aside, reach=6)


class TwoSpreads(NamedTuple):
    markdown: str
    crops: list[tuple]
    result_dir: Path
    book: BookPages       # the four book pages of the two-spread file's ingest


@pytest.fixture(scope="module")
def two_spreads(workspace, scan_pdf, fake) -> TwoSpreads:
    """The fixture spread twice, with spread 2 alone converted whole over the file's own ingest (`workspace /
    "ingest2"`) into `workspace / "result2"`."""
    two = workspace / "two.pdf"
    with pdfium.PdfDocument(str(scan_pdf)) as one, pdfium.PdfDocument.new() as twice:
        twice.import_pages(one, [0, 0])
        twice.save(two)
    markdown = convert(resolve(RunParams(pdf=two, model="fake", page_source="ingest", ingest_dir=workspace / "ingest2",
                                         pages=(2, 2), cut="none", crop_dpi=100, result_dir=workspace / "result2")),
                       emit=lambda event: None)
    _, crops = fake.calls[-1]
    published = workspace / "ingest2" / two.stem / "ingest"
    artifact = IngestArtifact.model_validate_json((published / "ingest.json").read_bytes())
    return TwoSpreads(markdown, crops, workspace / "result2", BookPages(published, artifact.pages))


def test_a_page_range_names_spreads_and_selects_their_book_pages(two_spreads):
    # A page range still names PDF pages (spreads): spread 2 of a two-spread file is book pages 3 and 4, and a
    # whole-page block sits at the page's own corner.
    assert two_spreads.markdown == "text\n\ntext"
    assert [(number, region.kind) for number, region, _ in two_spreads.crops] == [(3, "page"), (4, "page")]
    assert not (two_spreads.result_dir / "pages" / "1.json").exists()  # only the selected spread has a result
    result = page_file(two_spreads.result_dir, 2)
    assert [(crop["crop"], unit["index"], crop["kind"]) for unit in result["units"] for crop in unit["crops"]] == [
        (1, 3, "page"), (2, 4, "page")]


def test_a_whole_page_block_is_placed_through_the_recorded_transform_and_the_placement(two_spreads):
    # Book page 3 is the left page, through the whole page's recorded transform: 4952 native pixels became 825 at
    # 100 dpi, so a pixel is 0.72029 pt, not the nominal 0.72; book page 4 sits past the gutter. Not `[7.2, 14.4,
    # 21.6, 28.8]` and not `594.24 + 7.2`, though: the same -0.11 degree rotation as above puts neither page's
    # corner where a pure translation would, so each block is checked as its crop pixels through the transform and
    # the page's placement, the invariant the writer applied.
    result = page_file(two_spreads.result_dir, 2)
    assert [unit["index"] for unit in result["units"]] == [3, 4]
    for unit, segment in zip(result["units"], result["segments"], strict=True):
        (crop,) = unit["crops"]
        assert (segment["unit"], segment["crop"], segment["bbox_px"]) == (unit["index"], crop["crop"], [10, 20, 30, 40])
        print("ROTATION2", unit["index"], crop["bbox_pt"], crop["image_px"], crop["pt_per_px"], segment["bbox_pt"])
        assert close(segment["bbox_pt"], placed(two_spreads.book, unit, crop, segment)), (segment, crop)
    left = result["units"][0]["crops"][0]
    assert left["image_px"][0] == 825 and abs(left["pt_per_px"][0] - 0.72029) < 1e-5, left
    assert result["segments"][1]["bbox_pt"][0] > 594.24, result["segments"][1]  # book page 4 past the gutter


def test_a_spread_outside_the_pdf_is_refused_before_anything_runs(workspace, scan_pdf, fake):
    # A page range still names PDF pages (spreads), and is judged against the PDF before anything runs.
    with pytest.raises(ConversionError, match="outside 1-1"):  # a spread outside the PDF must be refused
        convert(resolve(RunParams(pdf=scan_pdf, model="fake", page_source="ingest", ingest_dir=workspace / "ingest",
                                  pages=(2, 2))), emit=lambda event: None)


def test_a_pdf_the_ingest_refuses_is_a_failed_conversion(workspace, digital_pdf, fake):
    # A PDF the ingest refuses is a failed conversion, not a traceback (a digital one would take the native
    # path first, so that choice is patched away to reach the ingest with pages it cannot read).
    with patch("kei_exp.kie.stages.ocr.has_native_text", return_value=False), \
            pytest.raises(ConversionError, match="^Ingest failed"):  # the ingest must refuse a digital PDF
        convert(resolve(RunParams(pdf=digital_pdf, model="fake", page_source="ingest",
                                  ingest_dir=workspace / "ingest-digital")), emit=lambda event: None)


def test_an_unknown_page_source_is_refused(scan_pdf):
    with pytest.raises(ValueError, match="page_source"):  # an unknown page source must be refused
        resolve(RunParams(pdf=scan_pdf, model="fake", page_source="bogus"))


def test_a_gutter_override_reaches_the_ingest_and_binds_the_parse(converted, workspace, scan_pdf, fake):
    """The source layout is part of the request: an override chosen at upload is what ingest applies, and the
    parse recipe's ingest digest changes with it, so a result under another split is another fingerprint."""
    execution = resolve(RunParams(pdf=scan_pdf, model="fake", page_source="ingest", ingest_dir=workspace / "override",
                                  crop_dpi=100, result_dir=workspace / "override-result",
                                  ingest={"overrides": {"1": 4800}}))
    assert execution.ingest == {"overrides": {"1": 4800}}
    convert(execution, emit=lambda event: None)
    artifact = IngestArtifact.model_validate_json(
        (workspace / "override" / scan_pdf.stem / "ingest" / "ingest.json").read_bytes())
    assert {(page.gutter_method, page.gutter_x_px) for page in artifact.pages} == {("override", 4800)}
    default = json.loads((converted.result_dir / "result.json").read_text(encoding="utf-8"))
    overridden = json.loads((workspace / "override-result" / "result.json").read_text(encoding="utf-8"))
    assert overridden["recipe"]["ingest_digest"] == artifact.envelope.digest != default["recipe"]["ingest_digest"]


def test_a_malformed_ingest_setting_is_refused_before_anything_runs(workspace, scan_pdf, fake):
    with pytest.raises(ValueError, match="ingest"):
        resolve(RunParams(pdf=scan_pdf, model="fake", page_source="ingest", ingest_dir=workspace / "bad",
                          ingest={"split": "triptych"}))
    with pytest.raises(ValueError, match="page_source"):
        resolve(RunParams(pdf=scan_pdf, model="fake", page_source="pdf", ingest={"split": "single"}))
