"""The field types and the base model every KIE model is built from, with their validation rules.

Vocabulary: `CONTEXT.md`. Contract: `docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md`
(sections are cited as "spec 3.1" below). Pixels, counts and offsets are strict integers, coordinates fixed-length
tuples and times zoned ISO 8601, so a block, an ingest artifact, the document and a run report refuse the same value
in the same way. `IngestError` is ingest's one refusal of input or configuration. This module imports no other KIE
module; every model module builds on it.
"""

from collections.abc import Hashable, Iterable
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from kei_exp.geometry import ordered_box

# An image axis under a point is not a scan of a page, whatever the raster claims (spec 4.1).
MIN_AXIS_PT = 1.0


class IngestError(Exception):
    """Input or configuration that ingest refuses, rather than guessing a reading of (spec 4.1, 4.3)."""


def _positive_interval(bounds: tuple[int, int]) -> tuple[int, int]:
    """Pixel intervals are half-open, so `start == end` is empty and never a one-pixel range (spec 3.1)."""
    start, end = bounds
    if start >= end:
        raise ValueError(f"interval [{start}, {end}) is empty")
    return bounds


def _ordered_fractions(bounds: tuple[float, float]) -> tuple[float, float]:
    """A fractional pair whose interval is empty is a configuration error, never silently widened (spec 3.1)."""
    start, end = bounds
    if start >= end:
        raise ValueError(f"fraction pair [{start}, {end}] is not ordered")
    return bounds


def _positive_size(size: tuple[float, float]) -> tuple[float, float]:
    width_pt, height_pt = size
    if width_pt <= 0 or height_pt <= 0:
        raise ValueError(f"page size {list(size)} pt is not positive")
    return size


def _timestamp(value: str) -> str:
    """Envelope times are compared across runs and machines, so a naive timestamp is ambiguous evidence."""
    try:
        moment = datetime.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{value!r} is not an ISO 8601 timestamp") from error
    if moment.tzinfo is None:
        raise ValueError(f"{value!r} has no time zone")
    return value


# Strict integers: a coordinate of 3.0 or True is a unit error upstream, not a value to coerce (brief).
Pixel = Annotated[int, Field(strict=True, ge=0)]
Extent = Annotated[int, Field(strict=True, gt=0)]
Index = Annotated[int, Field(strict=True, gt=0)]
Count = Annotated[int, Field(strict=True, ge=0)]
Offset = Annotated[int, Field(strict=True, ge=0)]  # code points, not pixels
# Dict keys survive a JSON round trip as decimal strings, so a key is the one integer parsed leniently (spec 5).
IndexKey = Annotated[int, Field(gt=0)]
Seconds = Annotated[float, Field(ge=0.0)]
Fraction = Annotated[float, Field(ge=0.0, le=1.0)]
OpenFraction = Annotated[float, Field(gt=0.0, lt=1.0)]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Timestamp = Annotated[str, AfterValidator(_timestamp)]
Name = Annotated[str, Field(min_length=1)]

# Fixed-length tuples are how coordinate arrays are spelled here; a list would admit a fifth coordinate.
Bbox = Annotated[tuple[Pixel, Pixel, Pixel, Pixel], AfterValidator(ordered_box)]
ColumnRun = Annotated[tuple[Pixel, Pixel], AfterValidator(_positive_interval)]
FractionPair = Annotated[tuple[Fraction, Fraction], AfterValidator(_ordered_fractions)]
PageSizePt = Annotated[tuple[float, float], AfterValidator(_positive_size)]

Side = Literal["left", "right", "single"]
GutterMethod = Literal["shadow", "blank", "midline", "override", "none"]
GutterReason = Literal["no_candidate", "ambiguous_candidates", "config"]
PageType = Literal["glossary", "catalogue", "figures", "bibliography", "prose", "cover"]


def _unique(values: Iterable[Hashable], what: str) -> None:
    seen: set[Hashable] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"duplicate {what}: {value!r}")
        seen.add(value)


class _Base(BaseModel):
    """Unknown fields are a contract mismatch, and a non-finite float cannot survive canonical JSON (spec 5)."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
