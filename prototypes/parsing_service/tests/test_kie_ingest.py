"""The KIE ingest stage on synthetic rasters and PDFs: no GPU and no fixture.

The selector-independent tests come first: profiles, runs, band support, extraction and the input the stage
refuses, one snapshot of the source, the command line, the source-dependent config, single mode. Then the tests
that depend on `choose_gutter`, in two groups that answer different questions. The reference branches assert the
exact coordinates of the policy in spec 4.3 step 3; a different policy may change one of them, and must then say
so and update it here. The input invariants after them hold for any policy: the cut lands inside the gutter the
synthetic spread was built with, the halves reconstruct the raster, the same layout at another raster scale
selects the proportionally same place, and a fallback is visible as `midline` with a reason rather than hidden
inside another method. Spread mode through the stage's `run` closes the module.

Nothing here knows a file name, a document or a spread number of the real catalogue; every raster is built as a
binary array at the size the case wants.
"""

import contextlib
import ctypes
import hashlib
import io
import os
import shutil
from collections import Counter
from collections.abc import Callable, Sequence
from functools import partial
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
import pytest
from PIL import Image

from kei_exp.canonical import sha256_file
from kei_exp.kie import cli, runner
from kei_exp.kie.artifacts import PAGE_IMAGE_MODE, load_ingest
from kei_exp.kie.model import GutterEvidence, IngestArtifact, IngestConfig, IngestError, Placement
from kei_exp.kie.stages.ingest import (
    GutterChoice,
    Profile,
    Raster,
    Run,
    band_support,
    choose_gutter,
    extract_raster,
    find_runs,
    ink_profile,
    run,
    split_raster,
)
from tests.helpers.pdfs import DPI, binary_pdf

WIDTH, HEIGHT = 1000, 700  # the 1x synthetic spread; every layout below is fractions of it
TEXT, SHADOW = 10, 1  # one black row in ten is 0.1 ink (neither blank nor dark); every row is 1.0 (dark)

Part = tuple[float, float, int]
# Left text, a blank inner margin, the binding shadow, right text: the layout of spec 4.2, as fractions.
SHADOW_WITH_MARGIN: tuple[Part, ...] = ((0.0, 0.44, TEXT), (0.48, 0.52, SHADOW), (0.52, 1.0, TEXT))
SHADOW_ALONE: tuple[Part, ...] = ((0.0, 0.48, TEXT), (0.48, 0.52, SHADOW), (0.52, 1.0, TEXT))
MARGIN_ALONE: tuple[Part, ...] = ((0.0, 0.441, TEXT), (0.482, 1.0, TEXT))
TWO_SHADOWS: tuple[Part, ...] = (
    (0.0, 0.46, TEXT),
    (0.46, 0.48, SHADOW),
    (0.48, 0.50, TEXT),
    (0.50, 0.52, SHADOW),
    (0.52, 1.0, TEXT),
)
NO_CANDIDATE: tuple[Part, ...] = ((0.0, 1.0, TEXT),)
EMPTY_INNER_COLUMN: tuple[Part, ...] = ((0.0, 0.30, TEXT), (0.48, 0.52, SHADOW), (0.52, 1.0, TEXT))

CFG = IngestConfig()
SPREAD, ALONE = IngestConfig(), IngestConfig(split="single")

Mutator = Callable[[pdfium.PdfDocument, pdfium.PdfPage], None]


def painted(width: int, height: int, parts: Sequence[Part]) -> np.ndarray:
    """A synthetic spread, built directly as a binary array so a change of scale interpolates nothing."""
    ink = np.zeros((height, width), dtype=bool)
    for left, right, every in parts:
        ink[::every, round(left * width) : round(right * width)] = True
    return ink


def shared(width: int, height: int, parts: Sequence[Part]) -> np.ndarray:
    """A spread every test reads: painted once, and read-only so that no test can paint on it."""
    ink = painted(width, height, parts)
    ink.setflags(write=False)
    return ink


PAGE = shared(WIDTH, HEIGHT, SHADOW_WITH_MARGIN)
OTHER = shared(WIDTH, HEIGHT, EMPTY_INNER_COLUMN)
NARROW = shared(WIDTH // 2, HEIGHT, SHADOW_WITH_MARGIN)
CATALOGUE = (PAGE, OTHER)  # the two spreads every end-to-end run reads


def raster(ink: np.ndarray, *, spread: int = 1) -> Raster:
    """The array as a spread, placed the way a scan at `DPI` would be placed on its PDF page."""
    height, width = ink.shape
    width_pt, height_pt = 72.0 * width / DPI, 72.0 * height / DPI
    placement = Placement(
        a=width_pt, b=0.0, c=0.0, d=height_pt, e=0.0, f=0.0, page_width_pt=width_pt, page_height_pt=height_pt
    )
    return Raster(spread=spread, ink=ink, placement=placement)


def selected(ink: np.ndarray, cfg: IngestConfig, *, spread: int = 1) -> GutterChoice:
    """One spread through the pure steps: profile, runs, selection."""
    spread_raster = raster(ink, spread=spread)
    profile = ink_profile(spread_raster, cfg)
    return choose_gutter(find_runs(profile, cfg), spread_raster.width, cfg, spread=spread, profile=profile)


def names(caught: pytest.ExceptionInfo[BaseException], *naming: str) -> None:
    """The refusal says each of `naming`, so a diagnosis stays a diagnosis."""
    silent = [word for word in naming if word not in str(caught.value)]
    assert not silent, f"refused, but the message does not say {silent}: {caught.value}"


@pytest.fixture(scope="module")
def workspace(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The inputs several tests share; what a test writes itself goes under its own `tmp_path`."""
    return tmp_path_factory.mktemp("kie-ingest")


@pytest.fixture(scope="module")
def one_spread(workspace: Path) -> Path:
    return binary_pdf(workspace / "one.pdf", PAGE)


# --- Profiles: black is true, spread columns keep their index, interior rows only ------------------------------
def test_the_config_resolves_its_fractions_against_the_synthetic_spread() -> None:
    assert (CFG.min_blank_px(WIDTH), CFG.min_dark_px(WIDTH), CFG.support_radius_px(WIDTH)) == (4, 6, 1)
    assert CFG.window_px(WIDTH) == (400, 600) and CFG.interior_rows_px(HEIGHT) == (70, 630)


def test_ink_profile_is_the_black_fraction_per_spread_column_over_the_interior_rows() -> None:
    marked = np.zeros((HEIGHT, WIDTH), dtype=bool)
    marked[::4, 100:110] = True  # 0.25 ink, and only in these columns
    marked[:70, 700:720] = True  # above the interior rows: the scanner border the profile must not see
    profile = ink_profile(raster(marked), CFG)
    assert profile.width == WIDTH and profile.columns.shape == (WIDTH,)
    assert np.array_equal(np.flatnonzero(profile.columns > 0), np.arange(100, 110))
    assert abs(float(profile.columns[105]) - 0.25) < 0.01 and float(profile.columns[50]) == 0.0
    assert profile.bands.shape == (CFG.bands, WIDTH)


def test_ink_profile_bands_split_the_interior_rows_with_the_extra_rows_in_the_earlier_bands() -> None:
    # `numpy.array_split` over the interior rows, and the earlier bands take the extra rows (spec 3.1): 23 interior
    # rows in five bands are 5, 5, 5, 4, 4, so the first five interior rows are exactly the first band.
    short = np.zeros((28, WIDTH), dtype=bool)
    assert CFG.interior_rows_px(28) == (2, 25)
    short[2:7, 300:310] = True
    bands = ink_profile(raster(short), CFG).bands
    assert float(bands[0][305]) == 1.0 and float(bands[1][305]) == 0.0


# --- Runs: maximal, half-open, never joined across a gap, filtered by the resolved widths ----------------------
def test_find_runs_yields_the_maximal_half_open_blank_and_dark_runs_in_column_order() -> None:
    runs = find_runs(ink_profile(raster(painted(WIDTH, HEIGHT, SHADOW_WITH_MARGIN)), CFG), CFG)
    assert runs == [Run(440, 480, "blank"), Run(480, 520, "dark")]


def test_find_runs_never_joins_across_a_gap() -> None:
    assert find_runs(ink_profile(raster(painted(WIDTH, HEIGHT, TWO_SHADOWS)), CFG), CFG) == [
        Run(460, 480, "dark"),
        Run(500, 520, "dark"),
    ]  # two candidates, not one joined across the text between them


def test_find_runs_finds_no_candidate_in_unbroken_text() -> None:
    assert find_runs(ink_profile(raster(painted(WIDTH, HEIGHT, NO_CANDIDATE)), CFG), CFG) == []


def test_find_runs_drops_runs_narrower_than_the_resolved_widths() -> None:
    # Too narrow to qualify: three blank columns under the resolved four, five dark under the resolved six.
    narrow: tuple[Part, ...] = ((0.0, 0.440, TEXT), (0.443, 0.448, SHADOW), (0.453, 1.0, TEXT))
    assert find_runs(ink_profile(raster(painted(WIDTH, HEIGHT, narrow)), CFG), CFG) == [Run(448, 453, "blank")]


def test_find_runs_clips_a_run_reaching_past_the_window_to_the_window() -> None:
    # A run reaching past the window is the part inside it: the window is where the gutter is looked for.
    wide: tuple[Part, ...] = ((0.0, 0.30, TEXT), (0.70, 1.0, TEXT))
    assert find_runs(ink_profile(raster(painted(WIDTH, HEIGHT, wide)), CFG), CFG) == [Run(400, 600, "blank")]


# --- Band support: all blank or all dark, per band, and measurable outside the window --------------------------
@pytest.fixture(scope="module")
def support_profile() -> Profile:
    """`SHADOW_WITH_MARGIN` with the shadow missing the first band, and a blank gap outside the search window."""
    ink = painted(WIDTH, HEIGHT, SHADOW_WITH_MARGIN)
    top, bottom = CFG.interior_rows_px(HEIGHT)
    ink[: top + (bottom - top) // CFG.bands, 480:520] = False  # the shadow misses the first band entirely
    ink[:, 340:360] = False  # a blank gap between text columns, well outside the search window
    return ink_profile(raster(ink), CFG)


def test_band_support_counts_the_bands_all_blank_or_all_dark_around_a_column(support_profile: Profile) -> None:
    assert band_support(support_profile, 460, CFG) == 1.0  # the blank margin: every band is blank around it
    assert band_support(support_profile, 500, CFG) == 1.0  # inside the shadow: four bands dark, the first blank
    assert band_support(support_profile, 480, CFG) == 0.2  # its left edge: blank meets dark in the four dark bands
    assert band_support(support_profile, 430, CFG) == 0.0  # inside the text: neither blank nor dark anywhere


def test_band_support_is_measurable_outside_the_search_window(support_profile: Profile) -> None:
    # Measurable outside the search window, which is what an override at a column nothing searched needs.
    assert band_support(support_profile, 350, CFG) == 1.0 and band_support(support_profile, 900, CFG) == 0.0


# --- Extraction: the embedded bitmap, its placement, and the input this stage refuses --------------------------
def test_extract_raster_returns_the_embedded_bitmap_and_its_placement(one_spread: Path) -> None:
    with pdfium.PdfDocument(str(one_spread)) as document:
        page = document[0]
        extracted = extract_raster(page, 1)
        page.close()
    assert np.array_equal(extracted.ink, PAGE) and extracted.ink.dtype == np.dtype(bool)
    assert (extracted.width, extracted.height) == (WIDTH, HEIGHT)
    assert abs(72.0 * extracted.width / extracted.placement.x_axis_pt - DPI) < 1e-6
    assert abs(72.0 * extracted.height / extracted.placement.y_axis_pt - DPI) < 1e-6
    assert (extracted.placement.page_width_pt, extracted.placement.page_height_pt) == (
        WIDTH * 72.0 / DPI,
        HEIGHT * 72.0 / DPI,
    )


def reject(path: Path, mutate: Mutator) -> Path:
    """A two-spread PDF whose second spread this stage must refuse, so the refusal must name spread 2."""
    with pdfium.PdfDocument(str(binary_pdf(path.with_name(f"src-{path.name}"), PAGE, PAGE))) as document:
        page = document[1]
        mutate(document, page)
        page.gen_content()
        document.save(path)
        page.close()
    return path


def turn(_: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
    page.set_rotation(90)


def shrink(_: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
    """An image under a point wide: nothing measured on it would be a page (spec 4.1)."""
    image = next(obj for obj in page.get_objects() if isinstance(obj, pdfium.PdfImage))
    image.set_matrix(pdfium.PdfMatrix(0.5, 0.0, 0.0, HEIGHT * 72.0 / DPI, 0.0, 0.0))


def duplicate(document: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
    bitmap = pdfium.PdfBitmap.from_pil(Image.fromarray(np.zeros((4, 4), np.uint8), mode="L"))
    second = pdfium.PdfImage.new(document)
    second.set_bitmap(bitmap)
    second.set_matrix(pdfium.PdfMatrix(10.0, 0.0, 0.0, 10.0, 0.0, 0.0))
    page.insert_obj(second)
    bitmap.close()


def strip(_: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
    image = next(obj for obj in page.get_objects() if isinstance(obj, pdfium.PdfImage))
    page.remove_obj(image)
    image.close()  # a detached page object is nobody's child, so it is freed here or never


def scan_bytes() -> bytes:
    """`PAGE` as a one-spread PDF in memory: the document `nest` copies its scan out of."""
    buffer = io.BytesIO()
    with Image.fromarray(~PAGE) as image:
        image.save(buffer, "PDF", resolution=DPI)
    return buffer.getvalue()


def nest(document: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
    """The scan inside a scaled, translated Form XObject: the image's own matrix no longer says where it is."""
    strip(document, page)
    with pdfium.PdfDocument(scan_bytes()) as source:
        xobject = pdfium_c.FPDF_NewXObjectFromPage(document.raw, source.raw, 0)
        form = pdfium_c.FPDF_NewFormObjectFromXObject(xobject)
        pdfium_c.FPDFPageObj_Transform(form, 2.0, 0.0, 0.0, 0.5, 20.0, 30.0)
        pdfium_c.FPDFPage_InsertObject(page.raw, form)
        pdfium_c.FPDF_CloseXObject(xobject)


def paint(_: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
    """A filled rectangle over the scan: visible content the image alone would not show."""
    path = pdfium_c.FPDFPageObj_CreateNewRect(10.0, 10.0, 50.0, 50.0)
    pdfium_c.FPDFPageObj_SetFillColor(path, 0, 0, 0, 255)
    pdfium_c.FPDFPath_SetDrawMode(path, pdfium_c.FPDF_FILLMODE_ALTERNATE, 0)
    pdfium_c.FPDFPage_InsertObject(page.raw, path)


def text(mode: int) -> Mutator:
    """A text object in the given render mode. Mode 3 is an OCR layer; every other mode paints or clips."""

    def add(document: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
        obj = pdfium_c.FPDFPageObj_NewTextObj(document.raw, b"Helvetica", 12.0)
        chars = ctypes.create_string_buffer("Katalog".encode("utf-16-le") + b"\x00\x00")
        assert pdfium_c.FPDFText_SetText(obj, ctypes.cast(chars, ctypes.POINTER(ctypes.c_ushort)))
        pdfium_c.FPDFTextObj_SetTextRenderMode(obj, mode)
        pdfium_c.FPDFPage_InsertObject(page.raw, obj)

    return add


def clip(_: pdfium.PdfDocument, page: pdfium.PdfPage) -> None:
    """A clipping rectangle before the scan (`re W n` before `Do`): attached to the image, not a page object."""
    rect = pdfium_c.FPDF_CreateClipPath(0.0, 0.0, 10.0, 10.0)
    pdfium_c.FPDFPage_InsertClipPath(page.raw, rect)
    pdfium_c.FPDF_DestroyClipPath(rect)  # the page objects hold their own copy


DEVICE_GRAY = b"/ColorSpace /DeviceGray"


def handwritten_pdf(
    path: Path,
    ink: np.ndarray,
    content: bytes,
    *,
    image: bytes = DEVICE_GRAY,
    resources: bytes = b"",
    extra: Sequence[bytes] = (),
) -> Path:
    """One page, one uncompressed 1-bit image `/Im0`, one Helvetica `/F1`, and exactly `content` as its stream.

    pypdfium2's `gen_content` wraps every object in `q ... Q`, so a clip set by one object never reaches the
    next; a case about what one object does to the next needs the content stream written by hand. `image`
    is spliced into the image dictionary, `resources` into the page's, and `extra` objects are numbered from
    7 in order, so `image` can name the first of them as `7 0 R`.
    """
    height, width = ink.shape
    packed = np.packbits(~ink, axis=1).tobytes()  # DeviceGray, 1 bit: 1 is white
    width_pt, height_pt = 72.0 * width / DPI, 72.0 * height / DPI
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width_pt} {height_pt}] "
        f"/Resources << /XObject << /Im0 4 0 R >> /Font << /F1 5 0 R >> ".encode()
        + resources
        + b" >> /Contents 6 0 R >>",
        f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} ".encode()
        + image
        + f" /BitsPerComponent 1 /Length {len(packed)} >>".encode()
        + b"\nstream\n"
        + packed
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(content)} >>".encode() + b"\nstream\n" + content + b"\nendstream",
        *extra,
    ]
    out, offsets = b"%PDF-1.4\n", []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(out)
    return path


def rendered_ink(pdf: Path) -> int:
    """How many black pixels the page shows when rendered at the scan's own resolution."""
    with pdfium.PdfDocument(str(pdf)) as document:
        page = document[0]
        with page.render(scale=DPI / 72.0).to_pil() as shown:
            count = int((np.asarray(shown.convert("L")) < 128).sum())
        page.close()
    return count


@pytest.fixture(scope="module")
def grey_pdf(workspace: Path) -> Path:
    """Two spreads, the second of them grey.

    A grey PDF cannot be written as a bilevel image, so it is written as one: the encoder produces intermediate
    values, which is exactly the input that must not reach the threshold at 128.
    """
    grey = np.full((HEIGHT, WIDTH), 255, np.uint8)
    grey[100:200, 100:200] = 128
    path = workspace / "grey.pdf"
    with Image.fromarray(~PAGE) as first, Image.fromarray(grey, mode="L") as second:
        first.save(path, "PDF", resolution=DPI, save_all=True, append_images=[second])
    return path


def test_a_grey_raster_is_refused_as_not_black_and_white(tmp_path: Path, grey_pdf: Path) -> None:
    # Refused while reading, before anything is selected, and named by the spread it was read from.
    with pytest.raises(IngestError) as caught:
        run(grey_pdf, ALONE, tmp_path / "rejected")
    names(caught, "spread 2", "not black and white")


REFUSED_SPREADS = [
    pytest.param(turn, "rotation", id="a rotated page"),
    pytest.param(shrink, "matrix", id="a degenerate placement"),
    pytest.param(duplicate, "2 image objects", id="two image objects"),
    pytest.param(strip, "0 image objects", id="no image object"),
    # A composite page (spec 1.1, 4.1): anything visible beside the scan, and a scan whose placement is not
    # its own matrix. The nested image is refused as the form it sits in, before its local matrix is read.
    pytest.param(nest, "form object", id="an image nested in a Form XObject"),
    pytest.param(paint, "path object", id="a painted path over the scan"),
    pytest.param(text(pdfium_c.FPDF_TEXTRENDERMODE_FILL), "render mode 0", id="visible text"),
    pytest.param(text(pdfium_c.FPDF_TEXTRENDERMODE_CLIP), "render mode 7", id="clipping text after the scan"),
    # No page object at all: the clip rides on the image, which extracts whole while the page shows a corner.
    pytest.param(clip, "clipping path", id="a clipping path over the scan"),
]


@pytest.mark.parametrize(("mutate", "said"), REFUSED_SPREADS)
def test_a_spread_that_is_not_one_plain_scan_is_refused_while_reading(
    tmp_path: Path, mutate: Mutator, said: str
) -> None:
    # Refused while reading, before anything is selected, and named by the spread it was read from.
    with pytest.raises(IngestError) as caught:
        run(reject(tmp_path / "rejected.pdf", mutate), ALONE, tmp_path / "rejected")
    names(caught, "spread 2", said)


# Clipping text before the scan, with the clip still in force when the scan is painted: the page shows a
# fraction of the raster the image holds. The hand-written plain page proves the fixture is otherwise a scan
# this stage accepts, pixel for pixel.
DRAW = f"q {72.0 * WIDTH / DPI} 0 0 {72.0 * HEIGHT / DPI} 0 0 cm /Im0 Do Q".encode()


@pytest.fixture(scope="module")
def plain_pdf(workspace: Path) -> Path:
    """The hand-written control: `PAGE` drawn by `DRAW`, and nothing else on the page."""
    return handwritten_pdf(workspace / "plain.pdf", PAGE, DRAW)


def test_the_hand_written_plain_page_is_accepted_pixel_for_pixel(tmp_path: Path, plain_pdf: Path) -> None:
    assert run(plain_pdf, ALONE, tmp_path / "plain").pages[0].width_px == WIDTH
    with Image.open(tmp_path / "plain" / "pages" / "001.png") as saved:
        assert np.array_equal(~np.asarray(saved), PAGE)


def test_clipping_text_before_the_scan_is_refused(tmp_path: Path, plain_pdf: Path) -> None:
    clipped = handwritten_pdf(
        tmp_path / "cliptext-before.pdf", PAGE, b"BT /F1 40 Tf 7 Tr 5 5 Td (Katalog) Tj ET " + DRAW
    )
    assert rendered_ink(clipped) < rendered_ink(plain_pdf) // 2, (rendered_ink(clipped), rendered_ink(plain_pdf))
    with pytest.raises(IngestError) as caught:
        run(clipped, ALONE, tmp_path / "rejected")
    names(caught, "spread 1", "render mode 7")


# What is inside the image or its graphics state, and no page object shows: a soft mask, a stencil mask, a
# colour-key mask, an alpha, an image mask painted in colour. Each paints other pixels than the raster holds;
# the page renders lighter than the plain control, and the stage refuses the spread. The rule is what is
# shown against what is decoded, byte for byte and opaque, so an image mask painted black is refused too,
# although the page renders exactly like the plain control: PDFium decodes a mask as the inverse of what it
# paints, and leaves it transparent where it has no ink.
HALF_HIDDEN = np.full((HEIGHT, WIDTH), 255, np.uint8)
HALF_HIDDEN[:, : WIDTH // 2] = 0
SOFT_MASK = (
    f"<< /Type /XObject /Subtype /Image /Width {WIDTH} /Height {HEIGHT} /ColorSpace /DeviceGray "
    f"/BitsPerComponent 8 /Length {HEIGHT * WIDTH} >>".encode()
    + b"\nstream\n"
    + HALF_HIDDEN.tobytes()
    + b"\nendstream"
)
ALL_ONES = np.packbits(np.ones((HEIGHT, WIDTH), bool), axis=1).tobytes()
STENCIL = (
    f"<< /Type /XObject /Subtype /Image /Width {WIDTH} /Height {HEIGHT} /ImageMask true "
    f"/BitsPerComponent 1 /Length {len(ALL_ONES)} >>".encode()
    + b"\nstream\n"
    + ALL_ONES
    + b"\nendstream"
)
HIDDEN = [
    pytest.param(DRAW, DEVICE_GRAY + b" /SMask 7 0 R", b"", [SOFT_MASK], id="a soft mask"),
    pytest.param(DRAW, DEVICE_GRAY + b" /Mask 7 0 R", b"", [STENCIL], id="a stencil mask"),
    pytest.param(DRAW, DEVICE_GRAY + b" /Mask [0 0]", b"", [], id="a colour-key mask"),
    pytest.param(
        b"/G0 gs " + DRAW,
        DEVICE_GRAY,
        b"/ExtGState << /G0 7 0 R >>",
        [b"<< /Type /ExtGState /ca 0 >>"],
        id="an alpha of zero",
    ),
    pytest.param(b"1 0 0 rg " + DRAW, b"/ImageMask true", b"", [], id="an image mask painted red"),
]


@pytest.mark.parametrize(("content", "image", "resources", "extra"), HIDDEN)
def test_a_mask_or_alpha_that_paints_other_pixels_than_the_scan_is_refused(
    tmp_path: Path, plain_pdf: Path, content: bytes, image: bytes, resources: bytes, extra: list[bytes]
) -> None:
    hidden = handwritten_pdf(tmp_path / "hidden.pdf", PAGE, content, image=image, resources=resources, extra=extra)
    assert rendered_ink(hidden) < rendered_ink(plain_pdf)
    with pytest.raises(IngestError) as caught:
        run(hidden, ALONE, tmp_path / "rejected")
    names(caught, "spread 1")


def test_an_image_mask_painted_black_is_refused_although_it_renders_like_the_scan(
    tmp_path: Path, plain_pdf: Path
) -> None:
    stencil_scan = handwritten_pdf(tmp_path / "stencil-scan.pdf", PAGE, DRAW, image=b"/ImageMask true")
    assert rendered_ink(stencil_scan) == rendered_ink(plain_pdf)
    with pytest.raises(IngestError) as caught:
        run(stencil_scan, ALONE, tmp_path / "rejected")
    names(caught, "spread 1", "other pixels")


# Partial transparency: the ink shows as a grey dark enough to count as ink under a threshold, and still is
# not the scan. The comparison is byte for byte, so these are refused although a threshold would keep
# nearly all their ink (the page render's resampled edge column is what keeps the counts from being equal).
DIM = np.full((HEIGHT, WIDTH), 192, np.uint8)
DIM_MASK = (
    f"<< /Type /XObject /Subtype /Image /Width {WIDTH} /Height {HEIGHT} /ColorSpace /DeviceGray "
    f"/BitsPerComponent 8 /Length {HEIGHT * WIDTH} >>".encode()
    + b"\nstream\n"
    + DIM.tobytes()
    + b"\nendstream"
)
DIMMED = [
    pytest.param(
        b"/G0 gs " + DRAW,
        DEVICE_GRAY,
        b"/ExtGState << /G0 7 0 R >>",
        [b"<< /Type /ExtGState /ca 0.75 >>"],
        id="an alpha of three quarters",
    ),
    pytest.param(DRAW, DEVICE_GRAY + b" /SMask 7 0 R", b"", [DIM_MASK], id="a soft mask of three quarters"),
]


@pytest.mark.parametrize(("content", "image", "resources", "extra"), DIMMED)
def test_partial_transparency_is_refused_although_a_threshold_would_keep_the_ink(
    tmp_path: Path, plain_pdf: Path, content: bytes, image: bytes, resources: bytes, extra: list[bytes]
) -> None:
    dimmed = handwritten_pdf(tmp_path / "dimmed.pdf", PAGE, content, image=image, resources=resources, extra=extra)
    assert rendered_ink(dimmed) > rendered_ink(plain_pdf) * 9 // 10
    with pytest.raises(IngestError) as caught:
        run(dimmed, ALONE, tmp_path / "rejected")
    names(caught, "spread 1", "other pixels")


def test_an_invisible_text_layer_is_accepted_and_counted_per_spread(tmp_path: Path) -> None:
    # An invisible text layer, which is what OCR leaves behind, is inside the input family: accepted, and counted
    # per spread in the report so a reader knows the scan was not alone (spec 4.4).
    ocr = run(reject(tmp_path / "ocr.pdf", text(pdfium_c.FPDF_TEXTRENDERMODE_INVISIBLE)), ALONE, tmp_path / "ocr")
    assert ocr.report.text_layers == {2: 1}
    with Image.open(tmp_path / "ocr" / ocr.pages[1].image) as saved:
        assert np.array_equal(~np.asarray(saved), PAGE)  # the pixels are the scan's, untouched by the text


def test_text_layers_are_counted_per_spread_in_spread_mode_too(tmp_path: Path) -> None:
    # Counted in spread mode too, per spread and not per page.
    pdf = reject(tmp_path / "ocr-spread.pdf", text(pdfium_c.FPDF_TEXTRENDERMODE_INVISIBLE))
    layered = run(pdf, SPREAD, tmp_path / "ocr-spread")
    assert layered.report.text_layers == {2: 1} and len(layered.pages) == 4


@pytest.fixture(scope="module")
def corrupt_pdf(workspace: Path, grey_pdf: Path) -> Path:
    """A PDFium failure inside a spread, not at the document: the JPEG stream of spread 2 zeroed after writing.

    Loading a page, listing its objects and decoding its image each raise a bare `RuntimeError` otherwise.
    """
    raw = grey_pdf.read_bytes()  # its second image is mode `L`, which Pillow writes as DCTDecode
    stream = raw.index(b"stream\n", raw.index(b"/DCTDecode")) + len(b"stream\n")
    end = raw.index(b"endstream", stream)
    path = workspace / "corrupt.pdf"
    path.write_bytes(raw[:stream] + b"\x00" * (end - stream) + raw[end:])
    return path


def test_a_spread_whose_image_stream_is_corrupt_is_refused_naming_the_spread(tmp_path: Path, corrupt_pdf: Path) -> None:
    with pytest.raises(IngestError) as caught:
        run(corrupt_pdf, ALONE, tmp_path / "rejected")
    names(caught, "spread 2", "cannot be read")


def test_a_file_that_is_not_a_pdf_is_refused_by_its_name(tmp_path: Path) -> None:
    # A file that is not a PDF at all: PDFium raises a bare `RuntimeError` for it, which belongs to no taxonomy
    # the runner or the command line reads, so the stage must name the file the way it names every other input
    # it cannot use.
    not_a_pdf = tmp_path / "prose.pdf"
    not_a_pdf.write_text("This is prose with a PDF's name on it.\n", encoding="utf-8")
    with pytest.raises(IngestError) as caught:
        run(not_a_pdf, ALONE, tmp_path / "rejected")
    names(caught, "prose.pdf")


# --- One snapshot of the source: the hash and the pixels come from the same bytes (spec 5) -------------------
def test_the_hash_and_the_pixels_come_from_one_snapshot_of_the_source(tmp_path: Path) -> None:
    # The file is replaced under its name the moment it has been read, which is the rename replacement a hash
    # taken over one open and pixels taken over another could straddle. The artifact must describe the bytes read.
    first = binary_pdf(tmp_path / "first.pdf", PAGE)
    second = binary_pdf(tmp_path / "second.pdf", painted(WIDTH, HEIGHT, NO_CANDIDATE))
    swapped = tmp_path / "swapped.pdf"
    shutil.copyfile(first, swapped)
    real_read_bytes = Path.read_bytes

    def replaced_once_read(self: Path) -> bytes:
        data = real_read_bytes(self)
        if self == swapped:
            os.replace(second, swapped)
        return data

    with patch.object(Path, "read_bytes", replaced_once_read):
        snapshot = run(swapped, ALONE, tmp_path / "swapped")
    assert snapshot.source.sha256 == hashlib.sha256(first.read_bytes()).hexdigest() != sha256_file(swapped)
    with Image.open(tmp_path / "swapped" / snapshot.pages[0].image) as saved:
        assert np.array_equal(~np.asarray(saved), PAGE)


def test_a_source_that_cannot_be_read_is_fatal_before_anything_is_written(tmp_path: Path, one_spread: Path) -> None:
    # A source that cannot be read is fatal before anything is written: no artifact, no pages directory.
    with patch.object(Path, "read_bytes", side_effect=OSError(5, "Input/output error")), pytest.raises(OSError):
        run(one_spread, ALONE, tmp_path / "unread")
    assert not (tmp_path / "unread").exists()


# --- The command line: a stage failure is exit 1 and one line, an unreadable config is exit 2 ----------------
def command(runs_root: Path, *argv: str) -> tuple[int, str]:
    """`kie run ...` under `runs_root`, with what it printed to stderr.

    The run root is named twice: `main` passes `--runs-root` to `run` by keyword, which overrides the keyword
    the partial binds, so the option is what keeps the run out of the repository's `runs/`.
    """
    stderr = io.StringIO()
    with patch.object(cli, "run", partial(runner.run, runs_root=runs_root)), contextlib.redirect_stderr(stderr):
        code = cli.main(["run", "--runs-root", str(runs_root), *argv])
    return code, stderr.getvalue()


def test_a_stage_failure_is_exit_1_and_one_line_naming_the_spread(tmp_path: Path, corrupt_pdf: Path) -> None:
    config = tmp_path / "single.yaml"
    config.write_text("ingest:\n  split: single\n", encoding="utf-8")
    code, said = command(tmp_path / "runs", "--config", str(config), "--pdf", str(corrupt_pdf))
    assert code == cli.EXIT_FAILED and said.startswith("kie: ") and said.count("\n") == 1 and "spread 2" in said, said


def test_an_unreadable_config_is_exit_2(tmp_path: Path, one_spread: Path) -> None:
    latin = tmp_path / "latin.yaml"
    latin.write_bytes(b"ingest: {split: single}  # caf\xe9\n")  # not UTF-8, which is a `ValueError` and no `OSError`
    code, said = command(tmp_path / "runs", "--config", str(latin), "--pdf", str(one_spread))
    assert code == cli.EXIT_USAGE and said.startswith("kie: ") and "cannot be read" in said, said


# --- Source-dependent config, checked once the raster dimensions are known (spec 4.3) --------------------------
SOURCE_DEPENDENT = [
    pytest.param(IngestConfig(gutter_window=(0.40, 0.4005)), "gutter_window", id="an empty gutter window"),
    pytest.param(IngestConfig(interior_rows=(0.10, 0.1005)), "interior_rows", id="an empty interior"),
    pytest.param(
        IngestConfig(interior_rows=(0.10, 0.105), bands=5), "into 5 bands", id="fewer interior rows than bands"
    ),
    pytest.param(
        IngestConfig(overrides={9: 500}), "override for spread 9", id="an override for a spread the document has not"
    ),
    pytest.param(
        IngestConfig(overrides={1: WIDTH}), f"override {WIDTH} for spread 1", id="an override outside the raster"
    ),
]


@pytest.mark.parametrize(("cfg", "said"), SOURCE_DEPENDENT)
def test_source_dependent_config_is_refused_naming_the_setting_and_the_spread_it_was_measured_on(
    tmp_path: Path, one_spread: Path, cfg: IngestConfig, said: str
) -> None:
    # The refusal comes before the selector, so no `choose_gutter` runs, and it names both the setting and the
    # spread whose raster the setting was measured against.
    with pytest.raises(IngestError) as caught:
        run(one_spread, cfg, tmp_path / "rejected")
    names(caught, said, "spread 1")


def test_an_override_is_checked_at_its_own_spread_against_that_spreads_width() -> None:
    # An override names a column of one particular spread, so it is checked at that spread and against that
    # spread's own width: one width for the whole document would refuse an override inside its own spread.
    IngestConfig(overrides={2: 800}).check_override(2, WIDTH)
    IngestConfig(overrides={2: 800}).check_override(1, WIDTH // 2)  # not this spread's override, not its width
    with pytest.raises(IngestError) as caught:
        IngestConfig(overrides={1: 800}).check_override(1, WIDTH // 2)
    names(caught, "override 800 for spread 1")


@pytest.mark.parametrize(
    "x", [pytest.param(WIDTH, id="a split outside the raster"), pytest.param(0, id="a split at column zero")]
)
def test_split_raster_refuses_a_column_that_is_not_inside_the_spread(x: int) -> None:
    with pytest.raises(IngestError) as caught:
        split_raster(raster(PAGE), x)
    names(caught, "spread 1")


# --- Single mode end to end: one page per spread, no selection, and pixels that survive the PNG ----------------
@pytest.fixture(scope="module")
def single_mode(workspace: Path) -> tuple[IngestArtifact, Path]:
    """The two-spread catalogue through single mode: the artifact, and the directory it was written into."""
    out = workspace / "single"
    return run(binary_pdf(workspace / "two-spreads.pdf", *CATALOGUE), ALONE, out), out


def test_on_spread_names_each_spread_before_it_is_read(tmp_path: Path) -> None:
    # Progress: the stage names each spread before it reads it, so the first call comes before any page exists.
    out = tmp_path / "progress"
    announced: list[tuple[int, int]] = []

    def on_spread(spread: int, spreads: int) -> None:
        if spread == 1:
            assert not list((out / "pages").glob("*.png")), "a page was written before the first spread was announced"
        announced.append((spread, spreads))

    run(binary_pdf(tmp_path / "two-spreads-progress.pdf", *CATALOGUE), ALONE, out, on_spread=on_spread)
    assert announced == [(1, 2), (2, 2)], announced


def test_single_mode_writes_one_unsplit_page_per_spread_and_selects_nothing(
    single_mode: tuple[IngestArtifact, Path],
) -> None:
    single, _ = single_mode
    assert single.config.model_dump() == {"split": "single"}  # the effective config, with every gutter knob dropped
    assert [(p.index, p.spread, p.side) for p in single.pages] == [(1, 1, "single"), (2, 2, "single")]
    assert all(p.source_rect == (0, 0, WIDTH, HEIGHT) for p in single.pages)
    assert all(
        (p.gutter_x_px, p.gutter_method, p.gutter_reason, p.gutter_evidence) == (None, "none", None, None)
        for p in single.pages
    )


def test_single_mode_reports_no_selection_and_seals_an_artifact_that_loads_back(
    single_mode: tuple[IngestArtifact, Path],
) -> None:
    single, out = single_mode
    assert single.report.methods == {"none": 2} and single.report.spreads == [] and single.report.weak_support == []
    assert single.report.extract_seconds > 0 and single.report.write_seconds > 0
    assert single.report.seconds >= single.report.extract_seconds + single.report.write_seconds
    assert single.envelope.stage == "ingest" and single.envelope.upstream == {}
    assert single.envelope.created.endswith("+00:00")
    assert load_ingest(out / "ingest.json") == single  # the digest and every page hash verify on the way back


@pytest.mark.parametrize("spread", [1, 2])
def test_single_mode_pages_survive_the_png_losslessly(single_mode: tuple[IngestArtifact, Path], spread: int) -> None:
    single, out = single_mode
    page_model, source = single.pages[spread - 1], CATALOGUE[spread - 1]
    with Image.open(out / page_model.image) as saved:
        assert saved.mode == PAGE_IMAGE_MODE and saved.size == (WIDTH, HEIGHT)
        assert np.array_equal(~np.asarray(saved), source)  # lossless: true is ink, and mode `1` is white-is-one
        grey_values = np.asarray(saved.convert("L"))
    ink_row, ink_column = (int(index[0]) for index in np.nonzero(source))
    blank_row, blank_column = (int(index[0]) for index in np.nonzero(~source))
    assert grey_values[ink_row, ink_column] == 0 and grey_values[blank_row, blank_column] == 255


def test_spreads_of_one_source_may_differ_in_raster_size(tmp_path: Path) -> None:
    # Spreads of one source may differ in raster size; nothing is assumed uniform, and the page size is recorded
    # per spread because that is the only thing that makes the assumption unnecessary (spec 3.7).
    mixed = run(binary_pdf(tmp_path / "widths.pdf", PAGE, NARROW), ALONE, tmp_path / "widths")
    assert [(page.width_px, page.height_px) for page in mixed.pages] == [(WIDTH, HEIGHT), (WIDTH // 2, HEIGHT)]
    assert mixed.source.page_size_pt == {
        1: (72.0 * WIDTH / DPI, 72.0 * HEIGHT / DPI),
        2: (72.0 * (WIDTH // 2) / DPI, 72.0 * HEIGHT / DPI),
    }
    assert {page.spread: round(page.dpi_x) for page in mixed.pages} == {1: round(DPI), 2: round(DPI)}


# --- The reference policy: the exact coordinates of spec 4.3 step 3, at the 1x synthetic width ----------------
# A policy that decides one of these branches differently must say so and change that expectation here; the
# invariants after them stand whatever the policy decides.
def test_policy_a_shadow_with_a_margin_to_its_left_splits_at_the_margins_right_end() -> None:
    # A shadow with a blank margin immediately to its left: the split is the margin's right end, and the
    # shadow stays with the right page, whose inner margin it darkens.
    choice = selected(painted(WIDTH, HEIGHT, SHADOW_WITH_MARGIN), CFG)
    assert (choice.x, choice.method, choice.reason) == (480, "shadow", None)
    assert choice.evidence == GutterEvidence(
        dark_run=(480, 520),
        blank_run=(440, 480),
        dark_runs=1,
        blank_runs=1,
        band_support=0.0,
        distance_from_midline_px=20,
    )


def test_policy_a_shadow_the_text_runs_into_splits_at_its_left_edge() -> None:
    # A shadow the text runs into: the split is its left edge, and no blank run was selected.
    choice = selected(painted(WIDTH, HEIGHT, SHADOW_ALONE), CFG)
    assert (choice.x, choice.method, choice.reason) == (480, "shadow", None)
    assert choice.evidence == GutterEvidence(
        dark_run=(480, 520), blank_run=None, dark_runs=1, blank_runs=0, band_support=0.0, distance_from_midline_px=20
    )


def test_policy_a_blank_margin_without_a_shadow_splits_at_its_floored_centre() -> None:
    # A blank margin with no qualifying shadow: the split is the margin's centre, floored, which is what makes
    # an odd run width land on its left half rather than nowhere defined.
    choice = selected(painted(WIDTH, HEIGHT, MARGIN_ALONE), CFG)
    assert find_runs(ink_profile(raster(painted(WIDTH, HEIGHT, MARGIN_ALONE)), CFG), CFG) == [Run(441, 482, "blank")]
    assert (choice.x, choice.method, choice.reason) == (461, "blank", None)
    assert choice.evidence == GutterEvidence(
        dark_run=None, blank_run=(441, 482), dark_runs=0, blank_runs=1, band_support=1.0, distance_from_midline_px=39
    )


def test_policy_two_shadows_are_ambiguous_and_fall_back_to_the_midline() -> None:
    # Two shadows: the reference policy calls that ambiguous rather than ranking them, and falls back to the
    # midline, which for an even width is exactly half of it.
    choice = selected(painted(WIDTH, HEIGHT, TWO_SHADOWS), CFG)
    assert (choice.x, choice.method, choice.reason) == (500, "midline", "ambiguous_candidates")
    assert choice.evidence == GutterEvidence(
        dark_run=None, blank_run=None, dark_runs=2, blank_runs=0, band_support=0.0, distance_from_midline_px=0
    )


def test_policy_no_candidate_at_an_odd_width_floors_the_midline() -> None:
    # No qualifying run of either kind, at an odd width, where the midline floors.
    odd = 999
    choice = selected(painted(odd, HEIGHT, NO_CANDIDATE), CFG)
    assert (choice.x, choice.method, choice.reason) == (499, "midline", "no_candidate")
    assert choice.evidence == GutterEvidence(
        dark_run=None, blank_run=None, dark_runs=0, blank_runs=0, band_support=0.0, distance_from_midline_px=0
    )


def test_policy_a_uniformly_blank_spread_is_one_blank_run_split_at_the_windows_centre() -> None:
    # A uniformly blank spread is one qualifying blank run, not a failure: the window's centre (spec 4.3).
    choice = selected(np.zeros((HEIGHT, WIDTH), dtype=bool), CFG)
    assert (choice.x, choice.method, choice.reason) == (500, "blank", None)
    assert choice.evidence.blank_run == (400, 600) and choice.evidence.band_support == 1.0


def test_policy_an_empty_inner_column_widens_the_blank_run_and_the_split_stays_beside_the_shadow() -> None:
    # An empty inner column on the left page widens the blank run; the split still sits beside the shadow.
    choice = selected(painted(WIDTH, HEIGHT, EMPTY_INNER_COLUMN), CFG)
    assert (choice.x, choice.method, choice.reason) == (480, "shadow", None)
    assert choice.evidence.blank_run == (400, 480)  # clipped to the window, which is where runs are looked for


def test_policy_an_override_wins_and_records_what_the_projection_saw() -> None:
    # An override wins, and still records what the projection saw, so it can be audited against it.
    overridden = IngestConfig(overrides={1: 512, 2: 530})
    choice = selected(painted(WIDTH, HEIGHT, SHADOW_WITH_MARGIN), overridden)
    assert (choice.x, choice.method, choice.reason) == (512, "override", "config")
    assert choice.evidence == GutterEvidence(
        dark_run=None, blank_run=None, dark_runs=1, blank_runs=1, band_support=1.0, distance_from_midline_px=12
    )
    # Two spreads, two overrides: the only thing a spread number may select is its own override.
    second = selected(painted(WIDTH, HEIGHT, SHADOW_WITH_MARGIN), overridden, spread=2)
    assert (second.x, second.method, second.reason) == (530, "override", "config")
    assert selected(painted(WIDTH, HEIGHT, SHADOW_WITH_MARGIN), overridden, spread=3).method == "shadow"


# --- Invariants: what any policy must satisfy, on spreads whose gutter is known because they were built with one
# `gutter` is the stretch between the last column of left-page text and the first column of right-page text: a
# cut anywhere in it is a valid split, and a cut outside it takes text from one page to the other.
INVARIANTS = [
    pytest.param((WIDTH, HEIGHT), SHADOW_WITH_MARGIN, (440, 520), CFG, id="a margin left of the shadow"),
    pytest.param(
        (WIDTH, HEIGHT),
        ((0.0, 0.48, TEXT), (0.48, 0.52, SHADOW), (0.56, 1.0, TEXT)),
        (480, 560),
        CFG,
        id="a margin right of the shadow",
    ),
    pytest.param(
        (WIDTH, HEIGHT),
        ((0.0, 0.44, TEXT), (0.48, 0.52, SHADOW), (0.56, 1.0, TEXT)),
        (440, 560),
        CFG,
        id="margins on both sides",
    ),
    pytest.param((WIDTH, HEIGHT), MARGIN_ALONE, (441, 482), CFG, id="no shadow at all"),
    pytest.param(
        (WIDTH, HEIGHT),
        ((0.05, 0.44, TEXT), (0.48, 0.52, SHADOW), (0.56, 0.95, TEXT)),
        (440, 560),
        CFG,
        id="one text column per page",
    ),
    pytest.param(
        (WIDTH, HEIGHT),
        (
            (0.02, 0.15, TEXT),
            (0.17, 0.30, TEXT),
            (0.32, 0.44, TEXT),
            (0.48, 0.52, SHADOW),
            (0.56, 0.68, TEXT),
            (0.70, 0.83, TEXT),
            (0.85, 0.98, TEXT),
        ),
        (440, 560),
        CFG,
        id="three text columns per page",
    ),
    pytest.param((WIDTH, 2 * HEIGHT), SHADOW_WITH_MARGIN, (440, 520), CFG, id="a taller spread"),
    pytest.param(
        (WIDTH, HEIGHT),
        ((0.0, 0.31, TEXT), (0.35, 0.39, SHADOW), (0.39, 1.0, TEXT)),
        (310, 390),
        IngestConfig(gutter_window=(0.25, 0.75)),
        id="an off-centre gutter in a widened window",
    ),
]


@pytest.mark.parametrize(("size", "parts", "gutter", "cfg"), INVARIANTS)
def test_any_policy_cuts_inside_the_gutter_and_its_halves_rebuild_the_raster(
    size: tuple[int, int], parts: Sequence[Part], gutter: tuple[int, int], cfg: IngestConfig
) -> None:
    ink = painted(*size, parts)
    choice = selected(ink, cfg)
    assert gutter[0] <= choice.x <= gutter[1], f"the cut at {choice.x} is outside {gutter}"
    assert (choice.method == "midline") == (choice.reason in ("no_candidate", "ambiguous_candidates"))
    left, right = split_raster(raster(ink), choice.x)
    assert np.array_equal(np.concatenate([left, right], axis=1), ink)
    assert (left.shape[1], right.shape[1]) == (choice.x, ink.shape[1] - choice.x)


def test_ambiguity_is_resolved_inside_the_gutter_or_said_through_the_midline() -> None:
    # Ambiguity must be visible: either the policy resolves the two candidates inside the gutter, or it says
    # so through `midline` and a reason. What it may not do is choose silently.
    ambiguous = selected(painted(WIDTH, HEIGHT, TWO_SHADOWS), CFG)
    assert ambiguous.reason == "ambiguous_candidates" or 460 <= ambiguous.x <= 520


def test_the_same_layout_at_another_scale_selects_the_proportionally_same_column() -> None:
    # The same layout at 1x, 2x and 4x under one fractional config selects the proportionally same column.
    # The tolerance is the pixel rounding the window bound, the run edges and the resolved distances can each
    # contribute at the coarsest scale; it is not room for a different decision.
    places = [
        selected(painted(WIDTH * scale, HEIGHT * scale, SHADOW_WITH_MARGIN), CFG).x / (WIDTH * scale)
        for scale in (1, 2, 4)
    ]
    assert max(places) - min(places) <= 4 / WIDTH, places


# --- Spread mode through the runner: two pages per spread, one gutter between them, and a report of it --------
@pytest.fixture(scope="module")
def spread_mode(workspace: Path) -> tuple[IngestArtifact, Path]:
    """The two-spread catalogue through spread mode: the artifact, and the directory it was written into."""
    out = workspace / "spread"
    return run(binary_pdf(workspace / "catalogue.pdf", *CATALOGUE), SPREAD, out), out


def test_spread_mode_writes_two_pages_per_spread_in_reading_order(spread_mode: tuple[IngestArtifact, Path]) -> None:
    artifact, _ = spread_mode
    assert [(p.index, p.spread, p.side) for p in artifact.pages] == [
        (1, 1, "left"),
        (2, 1, "right"),
        (3, 2, "left"),
        (4, 2, "right"),
    ]


def test_spread_mode_reports_the_decision_and_the_resolved_distances_per_spread(
    spread_mode: tuple[IngestArtifact, Path],
) -> None:
    artifact, _ = spread_mode
    assert artifact.report.methods == Counter(s.method for s in artifact.report.spreads)
    assert artifact.report.weak_support == [
        s.spread for s in artifact.report.spreads if s.evidence.band_support < SPREAD.min_band_support
    ]
    assert [s.spread for s in artifact.report.spreads] == [1, 2]
    assert artifact.report.text_layers == {}
    for measured in artifact.report.spreads:
        assert (measured.min_blank_px, measured.min_dark_px, measured.support_radius_px) == (
            SPREAD.min_blank_px(WIDTH),
            SPREAD.min_dark_px(WIDTH),
            SPREAD.support_radius_px(WIDTH),
        )


@pytest.mark.parametrize("spread", [1, 2])
def test_spread_mode_pages_are_two_halves_of_one_measurement(
    spread_mode: tuple[IngestArtifact, Path], spread: int
) -> None:
    artifact, out = spread_mode
    source = CATALOGUE[spread - 1]
    left, right = (page for page in artifact.pages if page.spread == spread)
    gutter = left.gutter_x_px
    assert gutter is not None and 0 < gutter < WIDTH
    # Two halves of one measurement: the same gutter and the same evidence, and rects that tile the spread.
    assert (left.gutter_x_px, left.gutter_method, left.gutter_reason, left.gutter_evidence) == (
        right.gutter_x_px,
        right.gutter_method,
        right.gutter_reason,
        right.gutter_evidence,
    )
    assert left.source_rect == (0, 0, gutter, HEIGHT) and right.source_rect == (gutter, 0, WIDTH, HEIGHT)
    halves = []
    for page in (left, right):
        with Image.open(out / page.image) as saved:
            assert saved.mode == PAGE_IMAGE_MODE and saved.size == (page.width_px, page.height_px)
            halves.append(~np.asarray(saved))
    assert np.array_equal(np.concatenate(halves, axis=1), source)


def test_spread_mode_seals_an_artifact_that_loads_back_verified(spread_mode: tuple[IngestArtifact, Path]) -> None:
    artifact, out = spread_mode
    assert load_ingest(out / "ingest.json") == artifact


def test_a_later_spread_too_short_for_the_bands_is_a_configuration_error(tmp_path: Path) -> None:
    # The source-dependent config is checked against every distinct raster size, not only the first one: a
    # later, shorter spread whose interior holds fewer rows than there are bands is a configuration error,
    # not a spread with no candidate. It goes through `run`, and not through the config check alone, only
    # because spread 1 has to be selected before spread 2 is read at all.
    flat = np.zeros((4, WIDTH), dtype=bool)  # three interior rows, which five bands cannot be cut from
    with pytest.raises(IngestError) as caught:
        run(binary_pdf(tmp_path / "short.pdf", PAGE, flat, dpi=30.0), SPREAD, tmp_path / "short")
    names(caught, "spread 2", "into 5 bands")


def test_an_override_inside_its_own_spread_is_accepted_whatever_the_other_spreads_width(tmp_path: Path) -> None:
    # An override is a column of its own spread's raster, and only that spread's width says whether it is
    # inside it: 800 is outside the 500-wide first spread and inside the 1000-wide second one, so a check
    # against one width for the whole document would refuse this config. It goes through `run` for the same
    # reason as the case before it: spread 1 is selected before spread 2 is read.
    widths = run(
        binary_pdf(tmp_path / "override-widths.pdf", NARROW, PAGE),
        IngestConfig(overrides={2: 800}),
        tmp_path / "override-widths",
    )
    split_at = {page.spread: (page.gutter_x_px, page.gutter_method) for page in widths.pages}
    assert split_at[2] == (800, "override"), split_at
    assert 0 < split_at[1][0] < WIDTH // 2, split_at
