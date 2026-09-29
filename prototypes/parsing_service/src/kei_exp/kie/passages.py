"""A finished parse run's canonical result as the recipe stages and extraction see it: passages in reading order,
named by identity. It imports neither.

Extraction never reparses the PDF (plan B rule 4). It reads `result/result.json` and the page files through
`pagefile.load_result`, which proves they belong together, and projects every readable segment into a `Passage`
named `p{page}_s{index}`: the physical PDF page and the segment's position in that page file's `segments` list.
That name is the evidence identity every extracted value points at; it holds for the generation it was read from
and means nothing outside it. FREE derives its anchor ids from the same pair.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

from kei_exp.pagefile import CropResult, PageResult, PageTable, ResultError, load_result, page_path, segment_id


class EvidenceUnavailable(Exception):
    """The run has no complete canonical result to extract from; the message says why."""


@dataclass(frozen=True)
class Passage:
    """One segment as extraction sees it: its canonical identity, where the parser placed it, and its raw text.

    `unit` is 0 for the PDF page itself and the book page otherwise (both halves of a spread share one `page`);
    `crop`, `crop_order` and `crop_bbox_pt` name the cut's column the engine read it in, None for a native page.
    """
    id: str
    page: int
    index: int
    text: str
    label: str
    bbox_pt: tuple[float, float, float, float]
    extent: str                        # block: the engine's own box; input: the whole input, deliberately coarse
    unit: int = 0
    crop: int | None = None
    crop_order: int | None = None
    crop_bbox_pt: tuple[float, float, float, float] | None = None
    status: str = "ok"
    table: PageTable | None = None

    @property
    def precision(self) -> str:
        """The precision a span inside this passage can claim visually: its segment's box, or the whole input."""
        return "segment" if self.extent == "block" else "input"


@dataclass(frozen=True)
class Evidence:
    run_id: str
    generation: str
    digest: str
    source_name: str
    page_count: int
    passages: tuple[Passage, ...]      # pages ascending, then page-file order: the reading order
    withheld: tuple[Passage, ...] = () # segments the engine did not read ok, blank or not: never extracted from
    order_issues: tuple[str, ...] = () # where the page files' order disagrees with the cut's own order

    def by_id(self, passage_id: str) -> Passage:
        for passage in self.passages:
            if passage.id == passage_id:
                return passage
        raise KeyError(passage_id)


def order_issues(passages: Sequence[Passage]) -> list[str]:
    """Where consecutive passages of one page go backwards in (unit, crop order): the page file's reading order is
    units ascending, then crops by their cut order. Reported, never reordered."""
    issues = []
    for before, after in pairwise(passages):
        if before.page != after.page:
            continue
        if (after.unit, after.crop_order or 0) < (before.unit, before.crop_order or 0):
            issues.append(f"{after.id} (unit {after.unit}, crop order {after.crop_order}) follows {before.id} "
                          f"(unit {before.unit}, crop order {before.crop_order}) in the page file")
    return issues


def load(run_dir: Path) -> Evidence:
    """The run's result, verified and projected. Only complete results are extracted from: a truncated page
    would make every value read from it unverifiable."""
    try:
        loaded = load_result(run_dir / "result", require_complete=True)
    except ResultError as error:
        raise EvidenceUnavailable(str(error)) from error
    passages: list[Passage] = []
    withheld: list[Passage] = []
    for number in sorted(loaded.pages):
        page = loaded.pages[number]
        crops = _placement(page, page_path(run_dir / "result", number))
        for index, segment in enumerate(page.segments):
            if segment.status == "ok" and not segment.text.strip():
                continue
            crop = crops[segment.crop] if segment.crop is not None else None
            passage = Passage(id=segment_id(number, index), page=number, index=index, text=segment.text,
                              label=segment.label, bbox_pt=tuple(segment.bbox_pt), extent=segment.extent,
                              unit=segment.unit, crop=segment.crop, crop_order=crop.order if crop else None,
                              crop_bbox_pt=tuple(crop.bbox_pt) if crop else None, status=segment.status,
                              table=segment.table)
            (passages if segment.status == "ok" else withheld).append(passage)
    manifest = loaded.manifest
    return Evidence(run_id=run_dir.name, generation=manifest.generation, digest=manifest.digest,
                    source_name=manifest.source_name, page_count=manifest.page_count, passages=tuple(passages),
                    withheld=tuple(withheld), order_issues=tuple(order_issues(passages)))


def _placement(page: PageResult, path: Path) -> dict[int, CropResult]:
    """The page's crops by ordinal, once every segment is proven to sit on a unit the page has and in a crop of that
    unit. The hashes prove the bytes, not the placement: a segment naming a missing or foreign crop could be neither
    ordered nor placed on its column, so the result is refused rather than projected without it."""
    units: set[int] = set()
    crops: dict[int, tuple[int, CropResult]] = {}
    for unit in page.units:
        if unit.index in units:
            raise EvidenceUnavailable(f"{path}: unit {unit.index} appears twice")
        units.add(unit.index)
        for crop in unit.crops:
            if crop.crop in crops:
                raise EvidenceUnavailable(f"{path}: crop {crop.crop} appears twice")
            crops[crop.crop] = (unit.index, crop)
    for index, segment in enumerate(page.segments):
        if segment.unit not in units:
            raise EvidenceUnavailable(f"{path}: segment {index} names unit {segment.unit}, which the page has not")
        if segment.crop is not None and crops.get(segment.crop, (None,))[0] != segment.unit:
            raise EvidenceUnavailable(f"{path}: segment {index} names crop {segment.crop}, which unit "
                                      f"{segment.unit} has not")
    return {ordinal: crop for ordinal, (_, crop) in crops.items()}


def text_of(passages: Sequence[Passage]) -> str:
    """The passages' text in order, one blank line between them: what a model is shown."""
    return "\n\n".join(passage.text.strip() for passage in passages)
