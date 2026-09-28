"""Stage 0: the native raster of each spread, split into book-page images.

Contract: `docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md` section 4 (sections are cited as
"spec 4.3" below). Vocabulary: `CONTEXT.md`. The scan is already a 1-bit image inside the PDF, so nothing here
renders a page: the embedded bitmap is taken as it is, thresholded once, sliced at the gutter and saved. That
is also why unsupported input is refused (`IngestError`) instead of being rendered into something that looks
like a scan but carries different coordinates. The PDF is read once into memory: the hash and the pixels come
from one snapshot, so the run cannot bind one file's hash to another file's pixels (spec 5).

This module never imports the runner. `run` writes into the staging directory it is given and returns the
sealed artifact; publishing that directory is the runner's business.
"""

import hashlib
import time
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, Literal

import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image
from pydantic import ValidationError

from kei_exp._pdfium import pdfium_lock
from kei_exp.canonical import sha256_file
from kei_exp.kie.artifacts import (
    PAGE_IMAGE_MODE,
    fingerprint,
    save_ingest,
    seal,
)
from kei_exp.kie.ingest_model import (
    Envelope,
    GutterEvidence,
    IngestArtifact,
    IngestConfig,
    IngestReport,
    Page,
    Placement,
    Source,
    SpreadReport,
)
from kei_exp.kie.primitives import GutterMethod, GutterReason, IngestError, Side

# Bump on any change that can alter this stage's output for the same inputs: the namespace shape, the
# extraction or selection algorithm, a rounding rule, a threshold that is not in config, or a dependency whose
# behaviour the stage relies on (spec 5). It is not a git revision, so unrelated commits keep the cache warm.
STAGE_VERSION: Final = 3  # 3: the visible page's origin in the placement; 2: composite pages refused, `text_layers` reported, one snapshot of the source

# A black pixel. The embedded bitmap arrives as mode `L` holding only 0 and 255 (spec 4.1), so the threshold
# never has to decide anything: it names which of the two ends is ink.
BLACK_BELOW: Final = 128

# Rows per block when the painted image is compared with the decoded raster: the expected block is four
# bytes per pixel, some 2.5 MB at the reference width of 9928, beside the render itself.
_SHOWN_ROWS: Final = 64

# The digest is taken over the finished namespace, so the envelope is built with this placeholder and `seal`
# stamps the real value (spec 5). It never reaches a hash: the envelope is not part of the projection.
_UNSEALED: Final = "0" * 64

RunKind = Literal["blank", "dark"]

# The page objects that are not the scan, named the way spec 4.1 refuses them.
_OBJECT_KIND: Final = {
    pdfium_c.FPDF_PAGEOBJ_PATH: "path",
    pdfium_c.FPDF_PAGEOBJ_SHADING: "shading",
    pdfium_c.FPDF_PAGEOBJ_FORM: "form",
}


@dataclass(frozen=True, eq=False)  # a numpy array has no scalar equality, so these types are identities
class Raster:
    """One spread's native image: True is a black pixel, in spread pixels with the origin top-left."""

    spread: int  # 1-based, as spreads are numbered everywhere
    ink: np.ndarray  # bool, shape (height, width)
    placement: Placement
    text_layers: int = 0  # invisible text objects on the page, the one thing beside the scan that is accepted

    @property
    def width(self) -> int:
        return int(self.ink.shape[1])

    @property
    def height(self) -> int:
        return int(self.ink.shape[0])


@dataclass(frozen=True, eq=False)
class Profile:
    """The ink fraction of each spread column over the interior rows, whole and per band (spec 4.3 step 1).

    `columns` is indexed by spread column, not by position inside the search window: a run, an override and
    the evidence all name places in the one image, and re-basing them would be a second coordinate space.
    """

    width: int  # the spread width, so every step below resolves the same distances from one config
    columns: np.ndarray  # float, shape (width,)
    bands: np.ndarray  # float, shape (bands, width)


@dataclass(frozen=True)
class Run:
    """A maximal stretch of consecutive spread columns that are all blank or all dark (CONTEXT.md).

    Half-open, `[left, right)`, and never joined across a gap: two shadows with a thin light line between
    them are two candidates, which is what makes them ambiguous rather than one wide run.
    """

    left: int
    right: int
    kind: RunKind


@dataclass(frozen=True)
class GutterChoice:
    """Where a spread is split, by what rule, and what the rule saw (spec 4.3 step 3)."""

    x: int
    method: GutterMethod
    reason: GutterReason | None
    evidence: GutterEvidence


def extract_raster(page: pdfium.PdfPage, spread: int) -> Raster:
    """The spread's sole embedded image as a boolean ink array, with the placement it was put on the page by.

    The caller owns the page handle. The bitmap and its PIL view are released here, and the array returned is
    ours: `< BLACK_BELOW` allocates a new array rather than viewing the bitmap's buffer, which is freed on the
    way out. The input spec 4.1 enumerates is refused by naming the spread, because a grayscale or rotated
    page would otherwise be turned silently into coordinates nothing measured.

    The page is one scan and nothing visible beside it: a path, a shading or a Form XObject is refused, and so
    is text in any render mode but 3 (invisible), which is what an OCR layer is. Refusing the form refuses the
    image nested in it too, whose `get_matrix` is local to the form and not its placement on the page; mode 7
    text is refused with the rest because it clips what is painted after it. A clipping path (`re W n` before
    `Do`) is no page object at all: PDFium attaches it to the image, so it is read off the image and refused,
    since it changes what the page shows without changing the raster this stage would extract. Masks, alpha
    and image masks live inside the image or its graphics state and are caught last, by painting the image
    and comparing.
    """
    with pdfium_lock:
        rotation = page.get_rotation()
        if rotation != 0:
            raise IngestError(f"spread {spread} has page rotation {rotation}, and only an unrotated page is supported")
        images: list[pdfium.PdfImage] = []
        text_layers = 0
        for obj in page.get_objects():
            if isinstance(obj, pdfium.PdfImage):
                clip = pdfium_c.FPDFPageObj_GetClipPath(obj.raw)
                clipped = pdfium_c.FPDFClipPath_CountPaths(clip) if clip else 0
                if clipped > 0:
                    raise IngestError(
                        f"spread {spread} clips its scan with {clipped} clipping path(s), and only an unclipped scan is supported"
                    )
                images.append(obj)
            elif obj.type == pdfium_c.FPDF_PAGEOBJ_TEXT:
                mode = pdfium_c.FPDFTextObj_GetTextRenderMode(obj.raw)
                if mode != pdfium_c.FPDF_TEXTRENDERMODE_INVISIBLE:
                    raise IngestError(
                        f"spread {spread} carries text with render mode {mode}, and only invisible text (mode 3) is supported"
                    )
                text_layers += 1
            else:
                kind = _OBJECT_KIND.get(obj.type, "unknown")
                raise IngestError(
                    f"spread {spread} carries a {kind} object, and only one scan with invisible text is supported"
                )
        if len(images) != 1:
            raise IngestError(f"spread {spread} carries {len(images)} image objects, and only one scan is supported")
        width_pt, height_pt = page.get_size()
        left_pt, bottom_pt, _, _ = page.get_bbox()  # the visible page; its corner need not be the user-space origin
        matrix = images[0].get_matrix()
        placement = _placement(matrix, width_pt, height_pt, (left_pt, bottom_pt), spread)
        ink = _ink(images[0], spread)
        _check_shown(images[0], ink, spread)
        return Raster(spread=spread, ink=ink, placement=placement, text_layers=text_layers)


def _placement(matrix: pdfium.PdfMatrix, width_pt: float, height_pt: float, origin: tuple[float, float],
               spread: int) -> Placement:
    """All six coefficients are kept: the scan carries a small rotation, so `a` and `d` are not the whole map."""
    try:
        return Placement(
            a=matrix.a,
            b=matrix.b,
            c=matrix.c,
            d=matrix.d,
            e=matrix.e,
            f=matrix.f,
            page_width_pt=width_pt,
            page_height_pt=height_pt,
            origin_x_pt=origin[0],
            origin_y_pt=origin[1],
        )
    except ValidationError as error:
        raise IngestError(f"spread {spread} places its image by a matrix this stage cannot use: {error}") from error


def _ink(image: pdfium.PdfImage, spread: int) -> np.ndarray:
    bitmap = image.get_bitmap(render=False)
    try:
        with bitmap.to_pil() as pil:
            values = np.asarray(pil)
            if values.ndim != 2 or not ((values == 0) | (values == 255)).all():
                # Every value is one of the two ends, rather than the two ends being present: a uniformly
                # white or black raster is valid input. Any intermediate grey means this is not the 1-bit
                # scan, and must be caught before the threshold turns it into a boolean array that no longer
                # shows the difference (spec 4.1). Asking the predicate of each pixel, rather than collecting
                # the distinct values of a scan of tens of megapixels, is the same question far cheaper.
                raise IngestError(f"spread {spread} holds a mode {pil.mode!r} image that is not black and white")
            return values < BLACK_BELOW
    finally:
        bitmap.close()


def _check_shown(image: pdfium.PdfImage, ink: np.ndarray, spread: int) -> None:
    """The image as the page paints it is the raster decoded from it, byte for byte (spec 4.1).

    A soft mask, a stencil or colour-key mask, an alpha in the graphics state, or an image mask are inside
    the image or its state, not among the page objects, and the raw decode ignores every one of them: the
    page would show other pixels than the raster this stage extracts (an image mask decodes as the inverse
    of what it paints, and paints nothing where it has no ink). PDFium exposes none of them through its
    metadata, so the image is painted on its own, unrotated and unscaled (its matrix is set to the pixel
    size for the render and put back), and the render must be, pixel for pixel, the stored value on every
    colour channel and opaque: nothing else is the scan. The render is one BGRA copy of the raster, about
    280 MB and 0.6 s for the reference scan; the comparison is a byte compare in blocks of `_SHOWN_ROWS`.
    """
    height, width = ink.shape
    matrix = image.get_matrix()
    image.set_matrix(pdfium.PdfMatrix(width, 0, 0, height, 0, 0))
    try:
        bitmap = image.get_bitmap(render=True)
    finally:
        image.set_matrix(matrix)
    try:
        if (bitmap.width, bitmap.height) != (width, height):
            raise IngestError(
                f"spread {spread} paints its scan at {bitmap.width}x{bitmap.height}, not {width}x{height}"
            )
        channels = bitmap.n_channels
        pixels = np.frombuffer(bitmap.buffer, np.uint8).reshape(height, bitmap.stride)[:, : width * channels]
        pixels = pixels.reshape(height, width, channels)
        # Only BGRA carries an alpha; the fourth byte of BGRx is padding, and BGR and L have none.
        compared = 4 if bitmap.mode == "BGRA" else min(channels, 3)
        for top in range(0, height, _SHOWN_ROWS):
            rows = ink[top : top + _SHOWN_ROWS]
            expected = np.where(rows[..., None], np.uint8(0), np.uint8(255)).repeat(compared, axis=2)
            if compared == 4:
                expected[..., 3] = 255  # opaque, or it is not the scan the page shows
            if not np.array_equal(pixels[top : top + _SHOWN_ROWS, :, :compared], expected):
                raise IngestError(
                    f"spread {spread} shows other pixels than the scan it holds (a mask, an alpha, or an image "
                    f"mask), and only a scan painted as it is stored is supported"
                )
    finally:
        bitmap.close()


def ink_profile(raster: Raster, cfg: IngestConfig) -> Profile:
    """Black fraction per column over the interior rows, and the same per horizontal band (spec 4.3 step 1).

    The interior rows skip the scanner border without cropping the saved image: the border is noise for the
    selection but part of the page, and cropping it would move every coordinate downstream measures.
    """
    top, bottom = cfg.interior_rows_px(raster.height)
    interior = raster.ink[top:bottom]
    bands = np.array([band.mean(axis=0) for band in np.array_split(interior, cfg.bands, axis=0)])
    return Profile(width=raster.width, columns=interior.mean(axis=0), bands=bands)


def find_runs(profile: Profile, cfg: IngestConfig) -> list[Run]:
    """The qualifying blank and dark runs inside the search window, in column order (spec 4.3 step 2).

    The minimum widths are fractions of this spread's own width (spec 4.3), so one config keeps meaning the
    same physical distance on a catalogue scanned at another resolution.
    """
    start, end = cfg.window_px(profile.width)
    window = profile.columns[start:end]
    runs: list[Run] = []
    for kind, qualifies, minimum in (
        ("blank", window <= cfg.blank_ink, cfg.min_blank_px(profile.width)),
        ("dark", window >= cfg.dark_ink, cfg.min_dark_px(profile.width)),
    ):
        runs += [
            Run(start + left, start + right, kind) for left, right in _stretches(qualifies) if right - left >= minimum
        ]
    return sorted(runs, key=lambda candidate: (candidate.left, candidate.right))


def _stretches(qualifying: np.ndarray) -> list[tuple[int, int]]:
    """Every maximal half-open stretch of True, without joining across a gap."""
    padded = np.concatenate(([False], qualifying, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1]).tolist()
    return list(zip(edges[::2], edges[1::2], strict=True))


def band_support(profile: Profile, x: int, cfg: IngestConfig) -> float:
    """The fraction of bands whose columns around `x` are all blank or all dark (spec 4.3 step 4).

    A band that mixes the two does not qualify. The neighbourhood is clamped to the raster, not to the search
    window, so support can be measured for an override that names a column the window never looked at.
    """
    radius = cfg.support_radius_px(profile.width)
    left, right = max(0, x - radius), min(profile.width, x + radius + 1)
    qualifying = sum(
        1
        for band in profile.bands
        if bool((band[left:right] <= cfg.blank_ink).all() or (band[left:right] >= cfg.dark_ink).all())
    )
    return qualifying / len(profile.bands)


def choose_gutter(runs: list[Run], width: int, cfg: IngestConfig, *, spread: int, profile: Profile) -> GutterChoice:
    """Choose where this spread is split, and record what the choice was made on (spec 4.3 step 3).

    The reference policy, one valid answer among several (spec 7):

    - An override for this spread wins: `x = cfg.overrides[spread]`, method `override`, reason `config`.
    - Exactly one dark run: if a blank run ends immediately to its left, meaning
      `0 <= dark.left - blank.right <= cfg.min_blank_px(width)`, split at that blank run's right end;
      otherwise split at the dark run's left edge. Method `shadow` either way. The binding shadow belongs to
      the right page, whose inner margin it darkens.
    - No dark run and exactly one blank run: split at its centre, `(left + right) // 2`, method `blank`.
    - More than one dark run, or no dark run and more than one blank run: `width // 2`, method `midline`,
      reason `ambiguous_candidates`.
    - No qualifying run of either kind: `width // 2`, method `midline`, reason `no_candidate`.

    Evidence is part of the choice: the selected `dark_run` and `blank_run` as `[left, right)` pairs (a run
    the branch did not select stays null), the number of qualifying runs of each kind the window held,
    `band_support` at the chosen `x`, and the distance from the midline. The counts, the support and the
    distance are recorded on every branch, so a fallback or an override can be audited against what the
    projection saw.

    Transferability (spec 1.1): the policy reads only `runs`, `width`, `cfg` and `profile`, plus `spread` to
    look up `cfg.overrides`. Nothing here knows a file name or a particular spread of any document.
    """
    dark = [run for run in runs if run.kind == "dark"]
    blank = [run for run in runs if run.kind == "blank"]
    dark_run = blank_run = None
    reason: GutterReason | None = None
    if spread in cfg.overrides:
        x, method = cfg.overrides[spread], "override"
        reason = "config"
    elif len(dark) == 1:
        (shadow,) = dark
        # The blank run ending at or just before the shadow's left edge: the inner margin the cut goes on.
        margins = [run for run in blank if 0 <= shadow.left - run.right <= cfg.min_blank_px(width)]
        dark_run = (shadow.left, shadow.right)
        if margins:
            blank_run = (margins[-1].left, margins[-1].right)
            x = margins[-1].right
        else:
            x = shadow.left
        method = "shadow"
    elif not dark and len(blank) == 1:
        (margin,) = blank
        blank_run = (margin.left, margin.right)
        x, method = (margin.left + margin.right) // 2, "blank"
    else:
        x, method = width // 2, "midline"
        reason = "ambiguous_candidates" if runs else "no_candidate"
    evidence = GutterEvidence(
        dark_run=dark_run,
        blank_run=blank_run,
        dark_runs=len(dark),
        blank_runs=len(blank),
        band_support=band_support(profile, x, cfg),
        distance_from_midline_px=abs(x - width // 2),
    )
    return GutterChoice(x=x, method=method, reason=reason, evidence=evidence)


def split_raster(raster: Raster, x: int) -> tuple[np.ndarray, np.ndarray]:
    """The halves `[0, x)` and `[x, width)`, as exact slices: re-placing them at their rects rebuilds the raster."""
    if not 0 < x < raster.width:
        raise IngestError(f"spread {raster.spread} cannot be split at {x}, which is outside its {raster.width} columns")
    return raster.ink[:, :x], raster.ink[:, x:]


# Progress only: called with (spread, spreads) before each spread is read, and never when the runner reuses the
# accepted artifact. An exception from it fails the stage before anything is published. Not part of the config,
# the fingerprint or the stage version: it changes nothing the stage writes.
OnSpread = Callable[[int, int], None]


def run(pdf: Path, cfg: IngestConfig, out: Path, *, on_spread: OnSpread | None = None) -> IngestArtifact:
    """Read every spread of `pdf`, write its pages into `out`, and return the sealed artifact (spec 4.1).

    `out` is the staging directory the runner prepared; this stage writes `ingest.json` and `pages/NNN.png`
    there and renames nothing. The PDF is read whole, once: the hash and the document come from those bytes,
    so a file replaced under its name between the two cannot bind one PDF's pixels to another's hash (spec 5).
    Each spread's raster and profile are released before the next is read, so the working memory is the PDF
    plus one spread, not the PDF plus the document. A file mutated in place while open stays outside this.
    `on_spread`, when given, hears (spread, spreads) before each spread is read.
    """
    started = time.perf_counter()
    data = pdf.read_bytes()
    pdf_sha256 = hashlib.sha256(data).hexdigest()
    images = out / "pages"
    images.mkdir(parents=True, exist_ok=True)
    pages: list[Page] = []
    measured: list[SpreadReport] = []
    weak_support: list[int] = []
    text_layers: dict[int, int] = {}
    page_size_pt: dict[int, tuple[float, float]] = {}
    methods: Counter[GutterMethod] = Counter()
    checked: set[tuple[int, int]] = set()
    extract_seconds = write_seconds = 0.0
    with _open(data, pdf.name) as document:
        with pdfium_lock:
            spreads = len(document)
        if not spreads:
            raise IngestError(f"{pdf.name} has no pages to read")
        for spread in range(1, spreads + 1):
            if on_spread is not None:
                on_spread(spread, spreads)
            clock = time.perf_counter()
            raster = _read_spread(document, spread)
            extract_seconds += time.perf_counter() - clock
            if (raster.width, raster.height) not in checked:
                # Once per distinct raster size, not once per document: spreads of a source may differ in
                # size, and a later, shorter one can hold fewer interior rows than there are bands. That
                # would make an empty band, a NaN profile and a silent "no candidate" out of what is a
                # configuration error (spec 4.3). Each size is checked at the first spread that has it, so
                # the refusal names a spread the reader can look at.
                _check_source(cfg, raster, spreads)
                checked.add((raster.width, raster.height))
            # Per spread, not per distinct raster size: an override names a column of one particular
            # raster, so only that raster's width can say whether the column is inside it (spec 4.3).
            cfg.check_override(spread, raster.width)
            if raster.text_layers:
                text_layers[spread] = raster.text_layers
            page_size_pt[spread] = (raster.placement.page_width_pt, raster.placement.page_height_pt)
            choice = None if cfg.split == "single" else _select(raster, cfg)
            clock = time.perf_counter()
            pages += _write_pages(raster, choice, images, first=len(pages) + 1)
            write_seconds += time.perf_counter() - clock
            methods[choice.method if choice is not None else "none"] += 1
            if choice is not None:
                measured.append(_spread_report(raster, choice, cfg))
                if choice.evidence.band_support < cfg.min_band_support:
                    weak_support.append(spread)
    report = IngestReport(
        spreads_read=spreads,
        pages_written=len(pages),
        methods=dict(methods),
        spreads=measured,
        weak_support=weak_support,
        text_layers=text_layers,
        extract_seconds=extract_seconds,
        write_seconds=write_seconds,
        seconds=time.perf_counter() - started,
    )
    artifact = seal(
        IngestArtifact(
            envelope=Envelope(
                stage="ingest",
                stage_version=STAGE_VERSION,
                fingerprint=fingerprint(STAGE_VERSION, cfg, pdf_sha256),
                digest=_UNSEALED,
                upstream={},
                created=datetime.now(UTC).isoformat(),
            ),
            source=Source(pdf_name=pdf.name, sha256=pdf_sha256, spreads=spreads, page_size_pt=page_size_pt),
            config=cfg,
            pages=pages,
            report=report,
        )
    )
    save_ingest(artifact, out / "ingest.json")
    return artifact


@contextmanager
def _open(data: bytes, name: str) -> Iterator[pdfium.PdfDocument]:
    """Own the snapshot's native document; lock open/close, not image processing between reads."""
    try:
        with pdfium_lock:
            document = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as error:
        raise IngestError(f"{name} cannot be opened as a PDF: {error}") from error
    try:
        yield document
    finally:
        with pdfium_lock:
            document.close()


def _read_spread(document: pdfium.PdfDocument, spread: int) -> Raster:
    """One spread, with its PDFium page handle closed again before the next spread is read.

    Loading the page, enumerating its objects and decoding its bitmap can each fail with a `PdfiumError`, a
    bare `RuntimeError` to everything above this stage; here it becomes the refusal naming the spread that
    every other unreadable input gets.
    """
    page = None
    try:
        with pdfium_lock:
            page = document[spread - 1]
        return extract_raster(page, spread)
    except pdfium.PdfiumError as error:
        raise IngestError(f"spread {spread} cannot be read: {error}") from error
    finally:
        if page is not None:
            with pdfium_lock:
                page.close()


def _check_source(cfg: IngestConfig, raster: Raster, spreads: int) -> None:
    """The source-dependent config checks for one raster, refused with the spread they were measured on."""
    try:
        cfg.check_against_source(raster.width, raster.height, spreads)
    except IngestError as error:
        raise IngestError(f"spread {raster.spread}: {error}") from error


def _select(raster: Raster, cfg: IngestConfig) -> GutterChoice:
    """The selection for one spread. The profile dies with this call, so no spread's profile outlives it."""
    profile = ink_profile(raster, cfg)
    choice = choose_gutter(find_runs(profile, cfg), raster.width, cfg, spread=raster.spread, profile=profile)
    if not 0 < choice.x < raster.width:
        raise IngestError(f"the gutter policy chose {choice.x} on spread {raster.spread}, which is not a column of it")
    return choice


def _spread_report(raster: Raster, choice: GutterChoice, cfg: IngestConfig) -> SpreadReport:
    """The distances are recorded as resolved: they are what the rule applied to the raster it actually met."""
    return SpreadReport(
        spread=raster.spread,
        gutter_x_px=choice.x,
        method=choice.method,
        reason=choice.reason,
        evidence=choice.evidence,
        min_blank_px=cfg.min_blank_px(raster.width),
        min_dark_px=cfg.min_dark_px(raster.width),
        support_radius_px=cfg.support_radius_px(raster.width),
    )


def _write_pages(raster: Raster, choice: GutterChoice | None, images: Path, *, first: int) -> list[Page]:
    """The book pages of one spread, in reading order, with their images written under `images`."""
    if choice is None:
        cuts: list[tuple[Side, tuple[int, int, int, int], np.ndarray]] = [
            ("single", (0, 0, raster.width, raster.height), raster.ink)
        ]
    else:
        left, right = split_raster(raster, choice.x)
        cuts = [
            ("left", (0, 0, choice.x, raster.height), left),
            ("right", (choice.x, 0, raster.width, raster.height), right),
        ]
    return [
        _page(raster, choice, side, rect, ink, images, index=first + offset)
        for offset, (side, rect, ink) in enumerate(cuts)
    ]


def _page(
    raster: Raster,
    choice: GutterChoice | None,
    side: Side,
    rect: tuple[int, int, int, int],
    ink: np.ndarray,
    images: Path,
    *,
    index: int,
) -> Page:
    name = f"{index:03d}.png"
    path = images / name
    _write_png(ink, path, spread=raster.spread)
    placement = raster.placement
    return Page(
        index=index,
        spread=raster.spread,
        side=side,
        image=f"pages/{name}",
        width_px=rect[2] - rect[0],
        height_px=rect[3] - rect[1],
        sha256=sha256_file(path),
        source_rect=rect,
        spread_width_px=raster.width,
        spread_height_px=raster.height,
        placement=placement,
        # dpi follows from the placement and the full raster, not from this page's share of it (spec 3.2).
        dpi_x=72.0 * raster.width / placement.x_axis_pt,
        dpi_y=72.0 * raster.height / placement.y_axis_pt,
        gutter_x_px=choice.x if choice is not None else None,
        gutter_method=choice.method if choice is not None else "none",
        gutter_reason=choice.reason if choice is not None else None,
        gutter_evidence=choice.evidence if choice is not None else None,
    )


def _write_png(ink: np.ndarray, path: Path, *, spread: int) -> None:
    """The page image, bilevel and exactly the pixels that were extracted.

    True is ink and mode `1` is white-is-one, so the mask is inverted on the way in. No dithering and no
    conversion through another mode can happen: Pillow builds mode `1` straight from the boolean array, so
    every saved pixel is one extracted pixel and reloading the PNG gives the mask back.
    """
    with Image.fromarray(~ink) as image:
        if image.mode != PAGE_IMAGE_MODE:
            raise IngestError(
                f"the mask of spread {spread} became a mode {image.mode!r} image at {path}, "
                f"not the bilevel {PAGE_IMAGE_MODE!r} every page bbox is expressed on"
            )
        image.save(path, format="PNG")
