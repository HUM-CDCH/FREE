"""Whole canonical passages with disjoint primary ownership and explicit optional overlap.

No passage text or table is cut. An indivisible oversized passage is returned as its own
unit, so the actual stage can refuse it and record the gap instead of silently dropping it.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from kei_exp.kie.extract.evidence import Passage

GROUPING_VERSION = 1
HEADINGS = {"Title", "SectionHeader"}
FURNITURE = {"PageHeader", "PageFooter"}


@dataclass(frozen=True)
class Context:
    primary: tuple[Passage, ...]
    overlap: tuple[Passage, ...] = ()
    heading: Passage | None = None

    @property
    def passages(self) -> tuple[Passage, ...]:
        if self.heading is None:
            return self.overlap + self.primary
        shown = {p.id: p for p in (self.heading, *self.overlap, *self.primary)}
        return tuple(sorted(shown.values(), key=lambda p: (p.page, p.index)))

    def dumped(self) -> dict:
        return {"primary": [p.id for p in self.primary], "overlap": [p.id for p in self.overlap],
                **({"heading": self.heading.id} if self.heading is not None else {})}


def _structural_ends(passages: Sequence[Passage]) -> list[int]:
    """Indivisible neighbors from existing labels; no inferred table or heading hierarchy."""
    ends = set(range(1, len(passages) + 1))
    for index, passage in enumerate(passages):
        if passage.label in HEADINGS:
            end = index + 1
            while end < len(passages) and passages[end].label in FURNITURE | HEADINGS:
                end += 1
            ends.difference_update(range(index + 1, min(end + 1, len(passages))))
        if passage.label == "Table" or passage.table is not None:
            start, end = index, index + 1
            while start > 0 and passages[start - 1].label in FURNITURE | {"Caption", "Footnote"}:
                start -= 1
            while end < len(passages) and passages[end].label in FURNITURE | {"Caption", "Footnote"}:
                end += 1
            ends.difference_update(range(start + 1, end))
    return sorted(ends)


def partition(passages: Sequence[Passage], fits: Callable[[Sequence[Passage]], bool], *, overlap: int = 0,
              structural: bool = False
              ) -> list[Context]:
    contexts = []
    ends = _structural_ends(passages) if structural else list(range(1, len(passages) + 1))
    heading = None
    start = 0
    while start < len(passages):
        if passages[start].label in HEADINGS:
            heading = None  # this unit owns its new heading
        candidates = [end for end in ends if end > start]
        def context(end, extra=()):
            return Context(tuple(passages[start:end]), extra, heading if structural else None)
        # Binary search avoids one tokenizer HTTP request per passage in a long document.
        low, high, end = 0, len(candidates) - 1, candidates[0]
        while low <= high:
            middle = (low + high) // 2
            if fits(context(candidates[middle]).passages):
                end, low = candidates[middle], middle + 1
            else:
                high = middle - 1
        if structural and end < len(passages):
            # Prefer a section boundary over leaving the next section half-read.
            boundaries = [i for i in candidates if i <= end and i < len(passages)
                          and passages[i].label in HEADINGS]
            if boundaries:
                end = boundaries[-1]
        extra = tuple(passages[max(0, start - overlap):start])
        while extra and not fits(context(end, extra).passages):
            extra = extra[1:]
        contexts.append(context(end, extra))
        for passage in passages[start:end]:
            if passage.label in HEADINGS:
                heading = passage
        start = end
    return contexts


def reconcile_values(values: Sequence[dict]) -> tuple[dict, list[dict]]:
    """Exact array union; recursively merge objects; retain scalar conflicts separately and return null.

    No 'first wins' or last-write rule can quietly turn contradictory units into a fact.
    """
    conflicts = []

    def combine(items, path):
        present = [v for v in items if v is not None]
        if not present:
            return None
        if all(isinstance(v, dict) for v in present):
            keys = dict.fromkeys(k for v in present for k in v)
            return {k: combine([v.get(k) for v in present], [*path, k]) for k in keys}
        unique = []
        for value in present:
            if value not in unique:
                unique.append(value)
        if all(isinstance(v, list) for v in unique):
            merged = []
            for group in unique:
                for item in group:
                    if item not in merged:
                        merged.append(item)
            return merged
        if len(unique) == 1:
            return unique[0]
        conflicts.append({"path": path, "candidates": unique})
        return None

    return combine(values, []) or {}, conflicts
