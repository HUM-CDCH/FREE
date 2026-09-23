"""Reading order, source lines and duplicate observations over the extraction view (grounded catalogue design §3, §6).

The reading order is the page files' own: units ascending, crops by their cut order, blocks in engine order; the
view already reports where that disagrees with the cut. A line is a maximal newline-free run of a segment's text,
trimmed, with raw code-point offsets: a source line, not a printed one, because Surya's blocks are paragraphs and no
line geometry exists. A duplicate observation is one printed line read twice by two overlapping crops; it is only
recognised when the pair is unambiguous, so separate repeated text is never collapsed.
"""
from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from kei_exp.kie.extract.evidence import Passage

MIN_IOU = 0.5


@dataclass(frozen=True)
class Line:
    passage: Passage = field(repr=False)
    start: int
    end: int
    whole: bool                          # the line is the segment's whole trimmed text

    @property
    def segment(self) -> str:
        return self.passage.id

    @property
    def text(self) -> str:
        return self.passage.text[self.start:self.end]


def lines(passages: Iterable[Passage]) -> list[Line]:
    """Every non-blank line of the passages, in reading order."""
    found: list[Line] = []
    for passage in passages:
        runs, position = [], 0
        for raw in passage.text.split("\n"):
            start, end = position + len(raw) - len(raw.lstrip()), position + len(raw.rstrip())
            if end > start:
                runs.append((start, end))
            position += len(raw) + 1
        found += [Line(passage, start, end, len(runs) == 1) for start, end in runs]
    return found


def normal(text: str) -> str:
    """A comparison form only: NFKC, case folded, whitespace collapsed. Never used as evidence text."""
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


@dataclass(frozen=True)
class Duplicates:
    excluded: dict[str, str]             # the later observation -> the earlier one it repeats
    potential: list[tuple[str, ...]]     # segments in an ambiguous matching component, kept and reported


def duplicate_observations(passages: Sequence[Passage]) -> Duplicates:
    """Pairs of segments in two overlapping crops of one unit of one page with equal normalised text and page boxes that overlap
    (IoU >= 0.5). Only a mutually unique pair marks its later member; any segment with two or more such partners
    leaves its whole component in place, reported as a potential duplicate."""
    order = {passage.id: number for number, passage in enumerate(passages)}
    candidates: dict[str, set[str]] = {}
    units: dict[tuple[int, int], list[Passage]] = {}  # one physical page's unit: boxes are only comparable there
    for passage in passages:
        if passage.crop is not None and passage.crop_bbox_pt is not None:
            units.setdefault((passage.page, passage.unit), []).append(passage)
    pairs = ((first, second) for placed in units.values()
             for i, first in enumerate(placed) for second in placed[i + 1:])
    for first, second in pairs:
        if (first.crop == second.crop or not _overlap(first.crop_bbox_pt, second.crop_bbox_pt)
                or normal(first.text) != normal(second.text) or _iou(first.bbox_pt, second.bbox_pt) < MIN_IOU):
            continue
        candidates.setdefault(first.id, set()).add(second.id)
        candidates.setdefault(second.id, set()).add(first.id)
    excluded: dict[str, str] = {}
    potential: list[tuple[str, ...]] = []
    seen: set[str] = set()
    for segment in sorted(candidates, key=order.__getitem__):
        if segment in seen:
            continue
        component, frontier = {segment}, [segment]
        while frontier:
            for partner in candidates[frontier.pop()]:
                if partner not in component:
                    component.add(partner)
                    frontier.append(partner)
        seen |= component
        members = tuple(sorted(component, key=order.__getitem__))
        if len(members) == 2:
            excluded[members[1]] = members[0]
        else:
            potential.append(members)
    return Duplicates(excluded, potential)


def _overlap(a: tuple[float, ...], b: tuple[float, ...]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    width = min(a[2], b[2]) - max(a[0], b[0])
    height = min(a[3], b[3]) - max(a[1], b[1])
    if width <= 0 or height <= 0:
        return 0.0
    inter = width * height
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0
