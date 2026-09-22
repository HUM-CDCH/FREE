"""Verify the OCR stage's page files and project their evidence into book-page segments in memory.

The page-file reader proves the generation; this module checks its binding to ingest and assigns segment ids
and boxes. Text stays in the canonical page files. Geometry follows the canonical evidence design §6.
"""
import time
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from kei_exp.geometry import clamp, unit_pixels
from kei_exp.kie.model import EvidenceRef, EvidenceReport, IngestArtifact, Rejected, Segment
from kei_exp.pagefile import CropResult, PageResult, load_result, page_path


class EvidenceError(Exception):
    """A result the reader accepted that does not fit this ingest, naming the file, unit, crop or entry concerned."""


@dataclass(frozen=True)
class Evidence:
    """The projected segments and the report identifying and counting the evidence read."""
    segments: list[Segment]
    report: EvidenceReport


def crop_overlaps(crops: Sequence[CropResult]) -> list[tuple[int, int]]:
    """The pairs of crop ordinals, in list order, whose native rectangles share a pixel (design §6).

    The cut lets neighbouring crops reach past their blocks, so one printed line can be read in two crops. That
    is reported here and resolved by the reading order, which is stage 2's business, not by dropping evidence.
    """
    placed = [(crop.crop, crop.source_px) for crop in crops if crop.source_px is not None]
    pairs = []
    for i, (first, a) in enumerate(placed):
        for second, b in placed[i + 1:]:
            if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                pairs.append((first, second))
    return pairs


def load_evidence(result_dir: Path, ingest: IngestArtifact) -> Evidence:
    """The segments of the completed OCR stage in `result_dir` over `ingest` (design §6).

    The reader proves the files and their binding to the ingest's source and digest; what only the ingest can know
    is checked here: every unit of a page file is a book page of that spread, every segment sits in a crop of its
    unit that has a native rectangle. Ids are `p{unit}_s{n}`, positional per unit over every entry, so a rejected
    entry keeps its number; boxes go through the crop's recorded rectangle and are clamped into it.
    """
    started = time.perf_counter()
    loaded = load_result(result_dir, source_sha256=ingest.source.sha256, ingest_digest=ingest.envelope.digest,
                         transcriber="surya", page_source="ingest", require_complete=True)
    segments: list[Segment] = []
    rejected: list[Rejected] = []
    clamped = 0
    overlaps: dict[int, list[tuple[int, int]]] = {}
    for number, page in loaded.pages.items():
        path = page_path(result_dir, number)
        crops = _check_units(page, number, path, ingest)
        found, refused, moved = _project(page, number, loaded.manifest.generation, path, crops)
        segments += found
        rejected += refused
        clamped += moved
        for unit in page.units:
            if pairs := crop_overlaps(unit.crops):
                overlaps[unit.index] = pairs
    report = EvidenceReport(
        generation=loaded.manifest.generation,
        digest=loaded.manifest.digest,
        pages_read=len(loaded.pages),
        spreads_without_pages=[n for n in range(1, ingest.source.spreads + 1) if n not in loaded.pages],
        segments=len(segments),
        rejected=rejected,
        clamped=clamped,
        by_label=dict(Counter(segment.label for segment in segments)),
        by_status=dict(Counter(segment.status for segment in segments)),
        empty_text=sum(1 for segment in segments if not segment.text),
        overlaps=overlaps,
        seconds=time.perf_counter() - started,
    )
    return Evidence(segments, report)


def _check_units(page: PageResult, number: int, path: Path, ingest: IngestArtifact) -> dict[int, tuple[int, CropResult]]:
    """The file's units are exactly the ingest's book pages of this spread, and unit 0 is refused. Returns the file's
    crops by ordinal, each with the unit it belongs to."""
    expected = {book_page.index for book_page in ingest.pages if book_page.spread == number}
    seen: list[int] = []
    crops: dict[int, tuple[int, CropResult]] = {}
    for unit in page.units:
        if unit.index == 0:
            raise EvidenceError(f"{path}: unit 0 is the PDF page itself, not a book page of the ingest")
        if unit.index not in expected:
            raise EvidenceError(f"{path}: unit {unit.index} is not a book page of spread {number} in the ingest")
        if unit.index in seen:
            raise EvidenceError(f"{path}: unit {unit.index} appears twice")
        seen.append(unit.index)
        for crop in unit.crops:
            if crop.crop in crops:
                raise EvidenceError(f"{path}: crop {crop.crop} appears twice")
            crops[crop.crop] = (unit.index, crop)
    for missing in sorted(expected - set(seen)):
        raise EvidenceError(f"{path}: unit {missing} (book page {missing} of spread {number}) has no unit in the file")
    return crops


def _project(page: PageResult, number: int, generation: str, path: Path,
             crops: dict[int, tuple[int, CropResult]]) -> tuple[list[Segment], list[Rejected], int]:
    """One segment per page segment that can be placed, one rejected entry per one that cannot, and the count of
    boxes the placement moved. Ids count per unit over every entry, so a rejected one keeps its n."""
    segments: list[Segment] = []
    rejected: list[Rejected] = []
    clamped = 0
    counters: Counter[int] = Counter()
    for index, entry in enumerate(page.segments):
        counters[entry.unit] += 1
        n = counters[entry.unit]
        if entry.crop is None:
            raise EvidenceError(f"{path}: segment {index} is a whole-page segment (crop None); over the ingest every "
                                "input is a crop")
        owner = crops.get(entry.crop)
        if owner is None or owner[0] != entry.unit:
            raise EvidenceError(f"{path}: segment {index} names crop {entry.crop}, which unit {entry.unit} has not")
        crop = owner[1]
        if crop.source_px is None:
            raise EvidenceError(f"{path}: crop {crop.crop} has no source_px, so its blocks cannot be placed on book "
                                f"page {entry.unit}")
        if not entry.label:
            raise EvidenceError(f"{path}: segment {index} has an empty label")
        if entry.bbox_px is None:
            rejected.append(Rejected(page=number, unit=entry.unit, crop=entry.crop, index=index, bbox_px=None,
                                     reason="no_box"))
            continue
        rounded = unit_pixels(entry.bbox_px, crop.source_px, crop.image_px)
        placed = clamp(rounded, crop.source_px)
        if placed is None:
            rejected.append(Rejected(page=number, unit=entry.unit, crop=entry.crop, index=index,
                                     bbox_px=entry.bbox_px, reason="empty_after_clamp"))
            continue
        if placed != rounded:
            clamped += 1
        segments.append(Segment(id=f"p{entry.unit}_s{n}", page=entry.unit, bbox=placed, text=entry.text,
                                conf=entry.confidence, label=entry.label, status=entry.status, crop=entry.crop,
                                source=EvidenceRef(generation=generation, page=number, index=index)))
    return segments, rejected, clamped
