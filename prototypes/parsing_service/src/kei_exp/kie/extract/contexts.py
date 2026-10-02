"""Whole canonical passages with disjoint primary ownership and explicit optional overlap.

No passage text or table is cut. An indivisible oversized passage is returned as its own
unit, so the actual stage can refuse it and record the gap instead of silently dropping it.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from kei_exp.kie.extract.stages import occurrences
from kei_exp.kie.passages import Passage

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

    No 'first wins' or last-write rule can quietly turn contradictory units into a fact. The union drops equal list
    items, genuine occurrences included, so production assembly is `assemble_document`; this stays for the research
    replays of captured version 1 studies (`article.extract_records`, `experiments/extraction/fixed_upstream.py`).
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


def printed_once_in(item, text: str) -> bool:
    """Whether `text` shows a list item as exactly one occurrence: every string and number of it printed as a bounded
    token (`stages.occurrences`: case and spacing aside, never inside a longer word or number), and at least one of them
    printed only once. A value printed twice there may be two occurrences, so it identifies neither; an item with no
    string or number never can be identified."""
    def scalars(value):
        if isinstance(value, dict):
            return [leaf for each in value.values() for leaf in scalars(each)]
        if isinstance(value, list):
            return [leaf for each in value for leaf in scalars(each)]
        return [value] if isinstance(value, str | int | float) and not isinstance(value, bool) else []
    counts = [occurrences(text, leaf) for leaf in scalars(item)]
    return bool(counts) and min(counts) > 0 and 1 in counts


def sharing(units: Sequence[Context]) -> Callable[[int, int, object], bool]:
    """Whether a list item two value contexts both returned can be one occurrence: they were shown a passage in common
    (an overlap passage beside another's primary; the repeated heading is orientation, not shared source) that prints
    it as exactly one occurrence."""
    owned = [{p.id: p for p in (*context.overlap, *context.primary)} for context in units]

    def shared(first: int, second: int, item) -> bool:
        common = sorted(owned[first].keys() & owned[second].keys())
        return bool(common) and printed_once_in(item, "\n".join(owned[first][id_].text for id_ in common))
    return shared


def assemble_document(values: Sequence[dict],
                      shared: Callable[[int, int, object], bool] = lambda first, second, item: False
                      ) -> tuple[dict, list[dict], list[dict], list[dict]]:
    """One document root from its readings' answers, in reading order: the root, its conflicts, the possible repeats
    and the joined overlap items. Not `reconcile_values`, whose exact array union would collapse equal items into one.

    A list keeps every item one reading returned, equal ones included: they are separate occurrences. An item equal
    to one an earlier reading returned is that same occurrence only when the two readings were shown source in common
    that prints it as exactly one occurrence (`shared(first, second, item)`, by reading index): it joins it, one to
    one, and is named (`{"path", "contexts", "index"}` into the assembled list), since value-only replies cannot prove
    two equal items printed in shared source are not two occurrences. Equal items kept from different readings are named (`{"path", "contexts",
    "indices"}`) as possible repeats, never merged. Objects merge field by field; a missing or null contribution never
    erases another reading's value. Equal scalars are one value; different ones are null, with their conflict
    (`{"path", "candidates"}`) as `reconcile_values` reports it. Order is reading order, then each reply's own order.
    """
    conflicts: list[dict] = []
    repeats: list[dict] = []
    joined: list[dict] = []

    def combine(items, path):
        present = [(context, v) for context, v in items if v is not None]
        if not present:
            return None
        if all(isinstance(v, dict) for _, v in present):
            keys = dict.fromkeys(k for _, v in present for k in v)
            return {k: combine([(context, v.get(k)) for context, v in present], [*path, k]) for k in keys}
        if all(isinstance(v, list) for _, v in present):
            kept: list[tuple[int, object, list[int]]] = []  # origin, item, every reading that returned it
            for context, v in present:
                for item in v:
                    match = next((index for index, (_, other, readers) in enumerate(kept) if other == item
                                  and context not in readers and any(shared(reader, context, item) for reader in readers)),
                                 None)
                    if match is None:
                        kept.append((context, item, [context]))
                    else:
                        kept[match][2].append(context)
            joined.extend({"path": path, "contexts": readers, "index": index}
                          for index, (_, _, readers) in enumerate(kept) if len(readers) > 1)
            seen: list = []
            for _, item, _ in kept:
                if item in seen:
                    continue
                seen.append(item)
                indices = [index for index, (_, other, _) in enumerate(kept) if other == item]
                sources = sorted({kept[index][0] for index in indices})
                if len(sources) > 1:
                    repeats.append({"path": path, "contexts": sources, "indices": indices})
            return [item for _, item, _ in kept]
        unique = []
        for _, value in present:
            if value not in unique:
                unique.append(value)
        if len(unique) == 1:
            return unique[0]
        conflicts.append({"path": path, "candidates": unique})
        return None

    return combine(list(enumerate(values)), []) or {}, conflicts, repeats, joined
