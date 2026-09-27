"""What each source line is, by recipe syntax and parser hints (grounded catalogue design §4–§6).

Routing names every line once: a section heading that switches the region, a heading event with its value's span,
a start candidate with its printed label, a prefixed-series line, a heading hint or an unclassified heading, a
running head, a figure, a duplicate observation, a line of a segment the engine did not read, glossary or
bibliography material, other excluded material, or plain content. Which candidates become entries, and who owns
content, is the segmenter's decision (`segment.py`); routing never reads a model and never drops a line.
"""
from __future__ import annotations

from dataclasses import dataclass

from kei_exp.kie.model import Diagnostic, GlossaryEntry, HeadingEvent, Span
from kei_exp.kie.passages import Evidence
from kei_exp.kie.recipe import Recipe, pattern
from kei_exp.kie.stages.layout import Line, duplicate_observations, lines


@dataclass(frozen=True)
class Routed:
    line: Line
    kind: str                            # see the module docstring; one word per case
    region: str                          # the region the line lies in
    restart: bool = False                # the region's section restarts its numbering
    number: int | None = None            # a candidate's printed number
    suffix: str = ""
    label: str | None = None             # a candidate's printed label, `31a`
    marker_end: int | None = None        # raw offset just after the entry marker
    heading: HeadingEvent | None = None
    duplicate_of: str | None = None


@dataclass(frozen=True)
class Routing:
    lines: list[Routed]
    headings: list[HeadingEvent]
    glossary: list[GlossaryEntry]
    diagnostics: list[Diagnostic]
    potential_duplicates: list[tuple[str, ...]]


def route(evidence: Evidence, recipe: Recipe) -> Routing:
    """Every non-blank line of the result, withheld segments included, routed in reading order."""
    structure = recipe.structure
    labels = structure.labels
    duplicates = duplicate_observations(evidence.passages)
    ordered = sorted((*evidence.passages, *evidence.withheld), key=lambda passage: (passage.page, passage.index))
    region, restart = "catalogue", False
    routed: list[Routed] = []
    headings: list[HeadingEvent] = []
    diagnostics: list[Diagnostic] = []
    glossary: list[tuple[GlossaryEntry, Line]] = []
    for line in lines(ordered):
        passage, text = line.passage, line.text
        if passage.status != "ok":
            routed.append(Routed(line, "withheld", region, restart))
        elif passage.id in duplicates.excluded:
            routed.append(Routed(line, "duplicate", region, restart, duplicate_of=duplicates.excluded[passage.id]))
        elif passage.label in labels.furniture:
            routed.append(Routed(line, "furniture", region, restart))
        elif passage.label in labels.figure:
            routed.append(Routed(line, "figure", region, restart))
        elif (section := next((rule for rule in structure.sections if pattern(rule.pattern).fullmatch(text)), None)):
            region, restart = section.region, section.numbering == "restart"
            routed.append(Routed(line, "section", region, restart))
        elif region == "catalogue":
            item = _catalogue(line, recipe, restart, len(headings) + 1)
            if item.heading is not None:
                headings.append(item.heading)
            if item.kind == "hint":
                diagnostics.append(Diagnostic(code="heading_hint", detail=f"{text!r} names a region no heading rule "
                                              "classifies", spans=[_span(line)]))
            routed.append(item)
        elif region == "glossary":
            match = pattern(structure.glossary_line).fullmatch(text)
            if match is None:
                diagnostics.append(Diagnostic(code="glossary_malformed", detail=f"{text!r} is no `key — expansion` "
                                              "line", spans=[_span(line)]))
            else:
                glossary.append((GlossaryEntry(key=match["key"], expansion=match["expansion"],
                                               key_span=_group(line, match, "key"),
                                               expansion_span=_group(line, match, "expansion")), line))
            routed.append(Routed(line, "glossary", region))
        elif region == "references":
            routed.append(Routed(line, "reference", region))
        else:
            routed.append(Routed(line, "excluded_region", region))
    usable, conflicts = _unambiguous(glossary)
    diagnostics += conflicts
    return Routing(routed, headings, usable, diagnostics, duplicates.potential)


def _catalogue(line: Line, recipe: Recipe, restart: bool, next_heading: int) -> Routed:
    structure = recipe.structure
    text = line.text
    if (marker := pattern(structure.entry_marker).match(text)) is not None:
        suffix = marker.groupdict().get("suffix") or ""
        label_end = marker.end("suffix") if suffix else marker.end("number")
        return Routed(line, "candidate", "catalogue", restart, number=int(marker["number"]), suffix=suffix,
                      label=text[marker.start("number"):label_end], marker_end=line.start + marker.end())
    if structure.series_marker is not None and pattern(structure.series_marker).match(text):
        return Routed(line, "series", "catalogue", restart)
    for rule in structure.headings:
        if len(text) <= rule.max_chars and (match := pattern(rule.pattern).fullmatch(text)) is not None:
            event = HeadingEvent(id=f"h{next_heading}", kind=rule.kind, level=rule.level, text=text,
                                 spans=[_group(line, match, "value")])
            return Routed(line, "heading", "catalogue", restart, heading=event)
    if line.whole and len(text) <= structure.hint_max_chars and any(
            pattern(hint).search(text) for hint in structure.heading_hints):
        return Routed(line, "hint", "catalogue", restart)
    if line.passage.label in structure.labels.heading:
        return Routed(line, "unclassified_heading", "catalogue", restart)
    return Routed(line, "content", "catalogue", restart)


def _span(line: Line) -> Span:
    return Span(segment_id=line.segment, start=line.start, end=line.end)


def _group(line: Line, match, group: str) -> Span:
    return Span(segment_id=line.segment, start=line.start + match.start(group), end=line.start + match.end(group))


def _unambiguous(entries: list[tuple[GlossaryEntry, Line]]) -> tuple[list[GlossaryEntry], list[Diagnostic]]:
    """A key the glossary expands two ways is never used; each of its lines is reported."""
    expansions: dict[str, set[str]] = {}
    for entry, _ in entries:
        expansions.setdefault(entry.key, set()).add(entry.expansion)
    usable, conflicts = [], []
    for entry, line in entries:
        if len(expansions[entry.key]) == 1:
            usable.append(entry)
        else:
            conflicts.append(Diagnostic(code="glossary_ambiguous", detail=f"{entry.key!r} is expanded as "
                                        f"{sorted(expansions[entry.key])}", spans=[_span(line)]))
    return usable, conflicts
