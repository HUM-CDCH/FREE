"""One geometry: crop transforms as the renderers record them, the placement map onto the PDF page, the projection
of a crop box onto the unit's native pixels, and the clamp that places it (spec: canonical evidence design, §4)."""
import math

import numpy as np
import pytest
from PIL import Image

from kei_exp.geometry import CropTransform, clamp, ordered_box, unit_pixels
from kei_exp.kie.ingest_model import Page as IngestPage
from kei_exp.kie.ingest_model import Placement
from kei_exp.pages import BookPage, PdfPages

# A crop's native rectangle, 220 x 240 pixels, rendered to 110 x 80: a scale of 2 across and 3 down.
CROP_1 = (10, 20, 230, 260)


def close(a, b, tolerance=1e-6) -> bool:
    return all(abs(x - y) < tolerance for x, y in zip(a, b, strict=True))


def test_unit_pixels_scales_per_axis_and_rounds_outward():
    assert unit_pixels((1.0, 2.5, 10.0, 7.25), CROP_1, (110, 80)) == (12, 27, 30, 42)
    assert unit_pixels((0.0, 0.0, 110.0, 80.0), CROP_1, (110, 80)) == CROP_1  # the whole crop is the crop
    assert all(type(value) is int for value in unit_pixels((1.0, 2.5, 10.0, 7.25), CROP_1, (110, 80)))


@pytest.mark.parametrize("box, expected", [
    ((12, 27, 30, 42), (12, 27, 30, 42)),      # inside: untouched
    ((220, 20, 234, 50), (220, 20, 230, 50)),  # past the right edge: clamped
    ((-5, 15, 12, 25), (10, 20, 12, 25)),      # before the left and top edges: clamped
    ((230, 20, 240, 50), None),                # entirely outside: nothing to place
    ((0, 0, 400, 400), CROP_1),                # covering the crop: the crop
])
def test_clamp_places_a_box_inside_its_crop(box, expected):
    assert clamp(box, CROP_1) == expected


def test_ordered_box_keeps_a_box_and_refuses_an_empty_one():
    assert ordered_box((0, 0, 1, 1)) == (0, 0, 1, 1)
    for box in [(10, 0, 10, 5), (10, 0, 5, 5), (0, 5, 5, 5)]:
        with pytest.raises(ValueError):
            ordered_box(box)


def test_pdfium_transform_records_the_canvas_rounding(scan_pdf):
    """The canvas is ceil(W * s) pixels wide, so a pixel is W / ceil(W * s) points, and a crop's pixel (0, 0) sits at
    ceil(left * s) canvas pixels: 0.05 pt requested at 250 dpi is one canvas pixel, 0.287 pt. (The scan is 1190.52 pt
    wide; a Letter page would give every integer dpi an exact canvas and hide the rounding.)"""
    with PdfPages(scan_pdf) as pdf:
        page = pdf.page(1)
        width, height = page.get_size()
        scale = 250 / 72
        whole = page.crop_transform(250)
        canvas = page.render(250)
        assert canvas.size == (math.ceil(width * scale), math.ceil(height * scale))
        assert whole == CropTransform(0.0, 0.0, width / canvas.width, height / canvas.height, None), whole
        assert abs(whole.pt_per_px_x - 72 / 250) > 1e-6  # the nominal formula is wrong by the canvas rounding
        partial = page.crop_transform(250, (0.05, 0.0, 12.05, 12.0))
        assert partial.origin_x == 1 * whole.pt_per_px_x and partial.origin_y == 0.0, partial
        cropped = np.asarray(page.render(250, (0.05, 0.0, 12.05, 12.0))).astype(int)
        # One canvas pixel in. pdfium rasterises a crop on its own, so this rotated scan differs from the slice of the
        # whole render by one grey level of anti-aliasing in a few pixels; the offset is what the transform records.
        window = np.asarray(canvas)[:cropped.shape[0], 1:1 + cropped.shape[1]].astype(int)
        assert np.abs(cropped - window).max() <= 1
        assert close(whole.to_unit_points((0, 0, canvas.width, canvas.height)), (0.0, 0.0, width, height))


@pytest.fixture
def placed(tmp_path):
    """A 1200 x 600 book page, placed by a given matrix: a single page, or the left or right page of a spread."""
    Image.fromarray(np.ones((600, 1200), bool)).save(tmp_path / "page.png")

    def build(placement: Placement, *, side="single", spread_width=1200, left=0) -> BookPage:
        width_px = spread_width - left if side == "right" else (left or spread_width) if side == "left" else spread_width
        return BookPage(tmp_path / "page.png", IngestPage(
            index=1 if side != "right" else 2, spread=1, side=side, image="page.png", width_px=width_px, height_px=600,
            sha256="0" * 64, source_rect=(left, 0, left + width_px, 600), spread_width_px=spread_width,
            spread_height_px=600, dpi_x=72 * spread_width / placement.x_axis_pt, dpi_y=72 * 600 / placement.y_axis_pt,
            gutter_x_px=None if side == "single" else left or width_px, gutter_method="none" if side == "single" else "blank",
            gutter_reason=None, gutter_evidence=None if side == "single" else {
                "dark_run": None, "blank_run": [1, 2], "dark_runs": 0, "blank_runs": 1, "band_support": 1.0,
                "distance_from_midline_px": 0}, placement=placement))
    return build


PLAIN = Placement(a=144.0, b=0.0, c=0.0, d=72.0, e=0.0, f=0.0, page_width_pt=144.0, page_height_pt=72.0)


def test_book_page_transform_cuts_on_the_native_grid(placed):
    """42 pixels at 250 dpi stand for exactly 100 native pixels (12.0 pt), not the 12.096 pt a nominal 72 / 250 claims."""
    plain = placed(PLAIN)
    assert plain.get_size() == (144.0, 72.0) and plain.native_box() == (0, 0, 1200, 600)
    assert plain.native_box((0.05, 0.0, 12.05, 12.0)) == (0, 0, 100, 100)
    transform = plain.crop_transform(250, (0.05, 0.0, 12.05, 12.0))
    assert transform.source_px == (0, 0, 100, 100) and transform.origin_x == 0.0
    assert plain.render(250, (0.05, 0.0, 12.05, 12.0)).size == (42, 42)
    assert close(transform.to_unit_points((0, 0, 42, 42)), (0.0, 0.0, 12.0, 12.0), 1e-9)
    assert close(plain.to_page_points((10.0, 20.0, 30.0, 40.0)), (10.0, 20.0, 30.0, 40.0))


def test_offset_placement_shifts_the_page(placed):
    """e = 20 and a page 5 pt taller than the image: the corner moves right by 20 and down by the 15 - 10 difference."""
    offset = placed(Placement(a=144.0, b=0.0, c=0.0, d=72.0, e=20.0, f=10.0, page_width_pt=170.0, page_height_pt=87.0))
    assert close(offset.to_page_points((10.0, 20.0, 30.0, 40.0)), (30.0, 25.0, 50.0, 45.0))


def test_sheared_placement_maps_the_four_corners(placed):
    """The ingest derives dpi_y from the y axis's length (hypot(36, 72) = 80.5 pt for 600 px), so the book page is
    80.5 pt tall in its own points; the top row lands 36 pt to the right of the bottom one."""
    sheared = placed(Placement(a=144.0, b=0.0, c=36.0, d=72.0, e=0.0, f=0.0, page_width_pt=180.0, page_height_pt=72.0))
    width, height = sheared.get_size()
    assert close((width, height), (144.0, math.hypot(36.0, 72.0)))
    assert close(sheared.to_page_points((0.0, 0.0, width, height)), (0.0, 0.0, 180.0, 72.0))
    assert close(sheared.to_page_points((0.0, 0.0, width / 2, height / 2)), (18.0, 0.0, 108.0, 36.0))


def test_right_page_starts_at_its_rect(placed):
    right = placed(PLAIN, side="right", left=700)
    assert close(right.to_page_points((0.0, 0.0, 10.0, 10.0)), (84.0, 0.0, 94.0, 10.0))  # 700 px at 600 dpi
