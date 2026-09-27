"""Whole canonical passages with disjoint primary ownership and explicit optional overlap.

No passage text or table is cut. An indivisible oversized passage is returned as its own
unit, so the actual stage can refuse it and record the gap instead of silently dropping it.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from kei_exp.kie.extract.evidence import Passage


@dataclass(frozen=True)
class Context:
    primary: tuple[Passage, ...]
    overlap: tuple[Passage, ...] = ()

    @property
    def passages(self) -> tuple[Passage, ...]:
        return self.overlap + self.primary

    def dumped(self) -> dict:
        return {"primary": [p.id for p in self.primary], "overlap": [p.id for p in self.overlap]}


def partition(passages: Sequence[Passage], fits: Callable[[Sequence[Passage]], bool], *, overlap: int = 0
              ) -> list[Context]:
    contexts = []
    start = 0
    while start < len(passages):
        # Binary search avoids one tokenizer HTTP request per passage in a long document.
        low, high, end = start + 1, len(passages), start + 1
        while low <= high:
            middle = (low + high) // 2
            if fits(passages[start:middle]):
                end, low = middle, middle + 1
            else:
                high = middle - 1
        primary = tuple(passages[start:end])
        extra = tuple(passages[max(0, start - overlap):start])
        while extra and not fits(extra + primary):
            extra = extra[1:]
        contexts.append(Context(primary, extra))
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
