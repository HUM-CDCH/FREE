"""The ingest artifact and its parts: the source, the book pages cut from its spreads with their placement and
gutter evidence, the ingest configuration, the envelope and the ingest report.

Vocabulary: `CONTEXT.md`. Contract: `docs/design/2026-09-14-kie-model-and-ingest-design.md`
(sections are cited as "spec 3.8" below). An artifact type checks what one stage file can know on its own. Nothing
here reads a file, renders a spread or hashes bytes: `kie/stages/ingest.py` produces the artifact and
`kie/artifacts.py` hashes it and reads it back.
"""

import math
from pathlib import PurePosixPath
from typing import Any, Literal, Self

from pydantic import Field, SerializerFunctionWrapHandler, model_serializer, model_validator

from kei_exp.kie.primitives import (
    MIN_AXIS_PT,
    Bbox,
    ColumnRun,
    Count,
    Extent,
    Fraction,
    FractionPair,
    GutterMethod,
    GutterReason,
    Index,
    IndexKey,
    IngestError,
    Name,
    OpenFraction,
    PageSizePt,
    Pixel,
    Seconds,
    Sha256,
    Side,
    Timestamp,
    _Base,
    _unique,
)


class Placement(_Base):
    """The PDF placement matrix of a spread's sole image, with the visible page's size and lower-left corner in
    points (spec 3.1; the corner amended 2026-09-17)."""

    a: float
    b: float
    c: float
    d: float
    e: float
    f: float
    page_width_pt: float = Field(gt=0)
    page_height_pt: float = Field(gt=0)
    origin_x_pt: float = 0.0  # the visible page's lower-left corner in user space (its CropBox within the
    origin_y_pt: float = 0.0  # MediaBox); 0 on every scan seen, so the default reads the hand-built fixtures

    @property
    def x_axis_pt(self) -> float:
        return math.hypot(self.a, self.b)

    @property
    def y_axis_pt(self) -> float:
        return math.hypot(self.c, self.d)

    @model_validator(mode="after")
    def _invertible(self) -> Self:
        # A singular matrix has no inverse, so page pixels could not be mapped back to PDF points at all.
        if self.a * self.d - self.b * self.c == 0:
            raise ValueError("placement matrix is singular")
        if self.x_axis_pt < MIN_AXIS_PT or self.y_axis_pt < MIN_AXIS_PT:
            raise ValueError(f"placement axes {self.x_axis_pt:g} x {self.y_axis_pt:g} pt are under {MIN_AXIS_PT} pt")
        return self


class Source(_Base):
    """The identity of the PDF an ingest artifact was built from (spec 3.7)."""

    pdf_name: Name  # the file's name, not its path: a path is not reproducible across machines
    sha256: Sha256  # of the PDF bytes; this is the identity every stage binds to
    spreads: Extent
    page_size_pt: dict[IndexKey, PageSizePt]  # keyed by spread; a uniform page size is an unmeasured assumption

    @model_validator(mode="after")
    def _one_size_per_spread(self) -> Self:
        if any(separator in self.pdf_name for separator in ("/", "\\")):
            raise ValueError(f"pdf_name {self.pdf_name!r} is a path, not a file name")
        expected = set(range(1, self.spreads + 1))
        if set(self.page_size_pt) != expected:
            raise ValueError(f"page_size_pt covers {sorted(self.page_size_pt)}, not spreads 1..{self.spreads}")
        return self


class GutterEvidence(_Base):
    """What the gutter rule saw when it chose a split. Null for a page that was never split (spec 3.2, 4.3)."""

    dark_run: ColumnRun | None  # the selected run, in spread pixels; null when an override chose the split
    blank_run: ColumnRun | None
    dark_runs: Count  # qualifying runs inside the window, so an override can be audited against them
    blank_runs: Count
    band_support: Fraction
    distance_from_midline_px: Pixel


class Page(_Base):
    """One book page, and the image ingest produced from a spread (spec 3.2). Owned by ingest."""

    index: Index  # reading order: left then right page of each spread
    spread: Index  # source PDF page
    side: Side
    image: Name  # relative to the artifact directory; the file name itself is ingest's business
    width_px: Extent
    height_px: Extent
    sha256: Sha256  # of the PNG bytes, verified on a cache hit
    source_rect: Bbox  # spread pixels
    spread_width_px: Extent
    spread_height_px: Extent
    placement: Placement
    dpi_x: float = Field(gt=0)
    dpi_y: float = Field(gt=0)
    gutter_x_px: Pixel | None  # the split, in spread pixels. Both pages of a spread carry the same value
    gutter_method: GutterMethod
    gutter_reason: GutterReason | None
    gutter_evidence: GutterEvidence | None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        path = PurePosixPath(self.image)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"page image {self.image!r} is not relative to the artifact directory")
        self._check_rect()
        self._check_gutter()
        # dpi is derived from the placement and the raster size, so a disagreeing value would be a second
        # owner of the same fact, silently differing from the one the coordinates were computed with.
        for name, stated, derived in (
            ("dpi_x", self.dpi_x, 72.0 * self.spread_width_px / self.placement.x_axis_pt),
            ("dpi_y", self.dpi_y, 72.0 * self.spread_height_px / self.placement.y_axis_pt),
        ):
            if not math.isclose(stated, derived, rel_tol=1e-6):
                raise ValueError(
                    f"page {self.index} {name} {stated:g} does not follow from its placement ({derived:g})"
                )
        return self

    def _check_rect(self) -> None:
        left, top, right, bottom = self.source_rect
        if (right - left, bottom - top) != (self.width_px, self.height_px):
            raise ValueError(f"page {self.index} image {self.width_px}x{self.height_px} is not its source rect")
        if (top, bottom) != (0, self.spread_height_px):
            raise ValueError(f"page {self.index} does not span the full height of its spread")
        if right > self.spread_width_px:
            raise ValueError(f"page {self.index} source rect reaches past the spread")

    def _check_gutter(self) -> None:
        left, _, right, _ = self.source_rect
        if self.side == "single":
            # No gutter profile was computed, so there is no support score to report and inventing one
            # would make a never-measured number look measured (spec 3.2).
            if (left, right) != (0, self.spread_width_px):
                raise ValueError(f"page {self.index} is single but does not cover the raster")
            if self.gutter_method != "none" or (self.gutter_x_px, self.gutter_reason, self.gutter_evidence) != (
                None,
                None,
                None,
            ):
                raise ValueError(f"page {self.index} is single but records a gutter or its evidence")
            return
        if self.gutter_x_px is None or self.gutter_evidence is None or self.gutter_method == "none":
            raise ValueError(f"page {self.index} was split but records no gutter")
        if not 0 < self.gutter_x_px < self.spread_width_px:
            raise ValueError(f"gutter {self.gutter_x_px} is not inside the spread of page {self.index}")
        expected = (0, self.gutter_x_px) if self.side == "left" else (self.gutter_x_px, self.spread_width_px)
        if (left, right) != expected:
            raise ValueError(f"page {self.index} is the {self.side} page but its rect is not {list(expected)}")
        reasons: dict[str, tuple[GutterReason, ...]] = {
            "midline": ("no_candidate", "ambiguous_candidates"),
            "override": ("config",),
        }
        allowed = reasons.get(self.gutter_method, ())
        if self.gutter_reason is not None and self.gutter_reason not in allowed:
            raise ValueError(f"gutter_reason {self.gutter_reason!r} does not belong to method {self.gutter_method!r}")
        if allowed and self.gutter_reason is None:
            raise ValueError(f"method {self.gutter_method!r} on page {self.index} states no reason")


class IngestConfig(_Base):
    """What ingest was told to do (spec 4.3). Shape and value checks happen here, at parse time.

    The three distances are fractions of the spread width rather than pixel constants, so the rule transfers
    to a catalogue scanned at another resolution; a pixel default would mean another physical distance there.
    """

    split: Literal["spread", "single"] = "spread"  # no automatic detection
    gutter_window: FractionPair = (0.40, 0.60)  # measured shadow at 0.49-0.52 of the width
    interior_rows: FractionPair = (0.10, 0.90)  # skips the scanner border without cropping the saved image
    bands: Extent = 5  # horizontal bands for the support measure
    blank_ink: Fraction = 0.005  # measured inner margins are 0.000-0.004
    dark_ink: Fraction = 0.15  # measured text tops out near 0.12, the shadow bottoms out at 0.15
    min_blank_fraction: OpenFraction = 0.004  # column gaps inside a page are wider, but lie outside the window
    min_dark_fraction: OpenFraction = 0.006  # on three measured spreads none qualifies and the blank margin decides
    support_radius_fraction: OpenFraction = 0.001  # half-width of the neighbourhood the support measure examines
    min_band_support: Fraction = 0.6  # below this the spread is listed as weak support; selection is unchanged
    overrides: dict[IndexKey, Pixel] = Field(default_factory=dict)  # spread -> gutter_x_px, in native spread pixels

    @model_validator(mode="after")
    def _thresholds_ordered(self) -> Self:
        if not self.blank_ink < self.dark_ink:
            raise ValueError(f"blank_ink {self.blank_ink} must be under dark_ink {self.dark_ink}")
        return self

    @model_serializer(mode="wrap")
    def _effective(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        """The effective config: settings inactive for the chosen mode are dropped (spec 5).

        A setting that changed nothing must not change the fingerprint, or it would re-run the stage. The
        supplied config is validated in full first, so a wrong gutter bound is still an error in single mode.
        """
        data = handler(self)
        return {"split": "single"} if self.split == "single" else data

    def window_px(self, width: int) -> tuple[int, int]:
        """The half-open columns searched for the gutter. A fractional bound names a place, so it floors."""
        start, end = self.gutter_window
        return math.floor(start * width), math.floor(end * width)

    def interior_rows_px(self, height: int) -> tuple[int, int]:
        start, end = self.interior_rows
        return math.floor(start * height), math.floor(end * height)

    def min_blank_px(self, width: int) -> int:
        return _distance_px(self.min_blank_fraction, width)

    def min_dark_px(self, width: int) -> int:
        return _distance_px(self.min_dark_fraction, width)

    def support_radius_px(self, width: int) -> int:
        return _distance_px(self.support_radius_fraction, width)

    def check_against_source(self, width: int, height: int, spreads: int) -> None:
        """The source-dependent checks of one raster size, once its dimensions and the spread count are known.

        Ingest calls this once per distinct raster size, before profiling, because a later spread of another
        size can hold fewer interior rows than there are bands (spec 4.3). What an override *names* is not
        judged here: its value is a column of one particular spread, and `check_override` checks it there.
        Under `split: single` every setting examined is inactive and excluded from the effective config, so
        refusing a run over one would abort on a knob that provably changed nothing.
        """
        if self.split == "single":
            return
        columns = self.window_px(width)
        if columns[0] >= columns[1]:
            raise IngestError(f"gutter_window {list(self.gutter_window)} is empty at width {width}")
        rows = self.interior_rows_px(height)
        if rows[0] >= rows[1]:
            raise IngestError(f"interior_rows {list(self.interior_rows)} is empty at height {height}")
        if rows[1] - rows[0] < self.bands:
            raise IngestError(f"{rows[1] - rows[0]} interior rows cannot be split into {self.bands} bands")
        for spread in sorted(self.overrides):
            if spread > spreads:
                raise IngestError(f"override for spread {spread}, which this document of {spreads} has not")

    def check_override(self, spread: int, width: int) -> None:
        """The override for one spread, against that spread's own width (spec 4.3).

        Spreads of one source may differ in raster size, so a column is only inside or outside the spread it
        names: checking every override against one document-wide width would refuse an override that is
        inside its own spread. Ingest calls this at each spread, before selection.
        """
        if self.split == "single":
            return
        x = self.overrides.get(spread)
        if x is not None and not 0 < x < width:
            raise IngestError(f"override {x} for spread {spread} is not inside a spread of width {width}")


def _distance_px(fraction: float, width: int) -> int:
    """A fractional distance is a length, not a place, so it rounds to the nearest pixel (spec 4.3)."""
    return max(1, math.floor(fraction * width + 0.5))


class Envelope(_Base):
    """An artifact's header: what the stage was, and what it was run on (spec 5)."""

    stage: Name
    stage_version: Extent  # one constant per stage module, bumped when output can change for the same inputs
    fingerprint: Sha256  # over the stage's inputs; decides whether the stage can be skipped
    digest: Sha256  # over the produced namespace; what a downstream consumer binds to
    upstream: dict[str, Sha256] = Field(default_factory=dict)  # upstream stage -> digest
    created: Timestamp


class SpreadReport(_Base):
    """What the gutter rule did on one spread, and the distances it actually applied (spec 4.4)."""

    spread: Index
    gutter_x_px: Pixel
    method: GutterMethod
    reason: GutterReason | None
    evidence: GutterEvidence
    min_blank_px: Extent  # resolved from the fractions against this raster's width, which is what the rule used
    min_dark_px: Extent
    support_radius_px: Extent

    @model_validator(mode="after")
    def _the_rule_ran(self) -> Self:
        if self.method == "none":
            raise ValueError(f"spread {self.spread} reports a selection but names no method")
        return self


class IngestReport(_Base):
    """What ingest did, per run and per spread (spec 4.4). Timings never enter a digest."""

    spreads_read: Count
    pages_written: Count
    methods: dict[GutterMethod, Count]  # counted per spread, not per page
    spreads: list[SpreadReport]  # empty under `split: single`, where no rule ran
    weak_support: list[Index]  # band support under `min_band_support`; the selection is unchanged
    text_layers: dict[IndexKey, Count]  # spread -> invisible text objects it carried; only spreads with any
    extract_seconds: Seconds
    write_seconds: Seconds
    seconds: Seconds

    @model_validator(mode="after")
    def _counts_agree(self) -> Self:
        _unique((report.spread for report in self.spreads), "spread report")
        _unique(self.weak_support, "weak support spread")
        if sum(self.methods.values()) != self.spreads_read:
            raise ValueError(f"methods count {sum(self.methods.values())} spreads, not the {self.spreads_read} read")
        measured = {report.spread for report in self.spreads}
        if not measured.issuperset(self.weak_support):
            raise ValueError(f"weak support {sorted(set(self.weak_support) - measured)} has no spread report")
        if any(spread > self.spreads_read or count == 0 for spread, count in self.text_layers.items()):
            raise ValueError(f"text layers {self.text_layers} name a spread not read, or a count of zero")
        return self


class IngestArtifact(_Base):
    """The ingest namespace as it is persisted, with the rules one stage file can check alone (spec 3.8)."""

    envelope: Envelope
    source: Source
    config: IngestConfig
    pages: list[Page]
    report: IngestReport

    @model_validator(mode="after")
    def _artifact_level(self) -> Self:
        if self.envelope.stage != "ingest":
            raise ValueError(f"envelope stage {self.envelope.stage!r} is not 'ingest'")
        if self.envelope.upstream:
            raise ValueError("ingest reads no upstream stage")
        if [page.index for page in self.pages] != list(range(1, len(self.pages) + 1)):
            raise ValueError("pages are not indexed 1..N in reading order")
        by_spread: dict[int, list[Page]] = {}
        for page in self.pages:
            by_spread.setdefault(page.spread, []).append(page)
        if set(by_spread) != set(range(1, self.source.spreads + 1)):
            raise ValueError(f"pages cover spreads {sorted(by_spread)}, not 1..{self.source.spreads}")
        for spread, pages in by_spread.items():
            _check_spread_pages(spread, pages, self.config.split, self.source.page_size_pt[spread])
        self._check_report(by_spread)
        return self

    def _check_report(self, by_spread: dict[int, list[Page]]) -> None:
        if (self.report.spreads_read, self.report.pages_written) != (self.source.spreads, len(self.pages)):
            raise ValueError("the report does not count the spreads it read and the pages it wrote")
        # Under `single` no rule ran, so there is nothing to report per spread (spec 3.2, 4.3).
        measured = {report.spread for report in self.report.spreads}
        expected = set() if self.config.split == "single" else set(by_spread)
        if measured != expected:
            raise ValueError(f"the report measures spreads {sorted(measured)}, not {sorted(expected)}")
        for report in self.report.spreads:
            page = by_spread[report.spread][0]
            chose = (page.gutter_x_px, page.gutter_method, page.gutter_reason, page.gutter_evidence)
            if (report.gutter_x_px, report.method, report.reason, report.evidence) != chose:
                raise ValueError(
                    f"the report and the pages of spread {report.spread} disagree about the gutter or its evidence"
                )


def _check_spread_pages(spread: int, pages: list[Page], split: str, page_size_pt: tuple[float, float]) -> None:
    """One page per spread for `single`, two complementary ones for `spread` (spec 3.8 rule 1)."""
    sides = [page.side for page in pages]
    if sides != (["single"] if split == "single" else ["left", "right"]):
        raise ValueError(f"spread {spread} has pages {sides} under split {split!r}")
    if [page.index for page in pages] != list(range(pages[0].index, pages[0].index + len(pages))):
        raise ValueError(f"the pages of spread {spread} are not consecutive in reading order")
    first = pages[0]
    # Both pages of a spread are two halves of one measurement, so their spread metadata is one fact.
    shared = (
        "spread_width_px",
        "spread_height_px",
        "placement",
        "gutter_x_px",
        "gutter_method",
        "gutter_reason",
        "gutter_evidence",
    )
    for page in pages[1:]:
        if any(getattr(page, name) != getattr(first, name) for name in shared):
            raise ValueError(f"the pages of spread {spread} disagree about the spread they came from")
    if len(pages) == 2 and pages[0].source_rect[2] != pages[1].source_rect[0]:
        raise ValueError(f"the rects of spread {spread} are not complementary")
    if (first.source_rect[0], pages[-1].source_rect[2]) != (0, first.spread_width_px):
        raise ValueError(f"the pages of spread {spread} do not cover its raster")
    if (first.placement.page_width_pt, first.placement.page_height_pt) != page_size_pt:
        raise ValueError(f"spread {spread} is {list(page_size_pt)} pt in the source but not in its placement")
