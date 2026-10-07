"""The structural segmenter: routed lines and a recipe in, blocks and a complete coverage ledger out (grounded catalogue
design §4, §5). A pure function: no model, no file.

Start candidates take one role each: `entry`, `list_item` (a run of consecutive candidates 1..k inside an open
entry) or `exception`. The feasible interpretations are those with the fewest exceptions; a role is resolved only
when every feasible interpretation gives it, so a find that could be a missing entry stays an ambiguous start rather
than being guessed. Numbering gaps and jumps are reported, never used to decide. Blocks then own every line from
their start to the next start, heading, section heading, unclassified heading or unresolved start, across columns,
book pages and PDF pages; running heads, figures, duplicate observations and failed segments inside an entry are
accounted for without ending it.
"""
from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field

from kei_exp.kie.blocks import Block, Diagnostic, HeadingEvent, Span
from kei_exp.kie.passages import Evidence
from kei_exp.kie.recipe import Recipe, Structure, pattern
from kei_exp.kie.segmentation import (
    SEGMENTATION_VERSION,
    Coverage,
    Disposition,
    RecipeRef,
    RejectedStart,
    Segmentation,
    fingerprint,
    sealed,
)
from kei_exp.kie.stages.layout import Line
from kei_exp.kie.stages.route import Routed, route

ENDS_ENTRY = frozenset({"heading", "section", "hint", "unclassified_heading", "series"})
Identity = tuple[int, str]
State = tuple[Identity | None, bool, int]   # last entry identity, an entry is open, length of the open list


@dataclass(frozen=True)
class Candidate:
    number: int
    suffix: str
    barrier: bool                   # a line that ends any open entry lies between this candidate and the previous one
    inline: tuple[int, ...] = ()    # enumerators written mid-line since the previous candidate ("Funde: 1. Urne")


@dataclass(frozen=True)
class Resolution:
    roles: list[tuple[str, ...]]    # per candidate: every role it takes in some feasible interpretation
    exceptions: int                 # the minimum number of exceptions, which defines feasibility


def _moves(state: State, candidate: Candidate) -> Iterator[tuple[str, int, State]]:
    last, open_, length = state
    if candidate.barrier:
        open_, length = False, 0
    if open_:  # the entry's own text may already have numbered its finds: a line then continues that list
        for number in candidate.inline:
            if number in (1, length + 1):
                length = number
    yield "exception", 1, (last, False, 0)
    identity = (candidate.number, candidate.suffix)
    if last is None or identity > last:
        yield "entry", 0, (identity, True, 0)
    if open_ and not candidate.suffix and candidate.number in (1, length + 1):  # 1 opens another list in the entry
        yield "list_item", 0, (last, True, candidate.number)


def _prune(states: dict[State, int]) -> dict[State, int]:
    """Drop a state another state strictly dominates: an identity no higher (it allows every entry the other allows)
    at a strictly lower cost. Such a state is on no feasible interpretation; ties are kept, since they may be."""
    kept: dict[State, int] = {}
    groups: dict[tuple[bool, int], list[tuple[State, int]]] = {}
    for state, cost in states.items():
        groups.setdefault((state[1], state[2]), []).append((state, cost))
    for members in groups.values():
        members.sort(key=lambda item: (item[0][0] is not None, item[0][0] or (0, "")))
        lowest = math.inf
        for state, cost in members:
            if cost <= lowest:
                kept[state] = cost
            lowest = min(lowest, cost)
    return kept


def resolve_starts(candidates: Sequence[Candidate]) -> Resolution:
    """Forward and backward minimum-exception passes over (last entry, open entry, open list) states; a role belongs
    to a candidate's set exactly when some interpretation with the minimum number of exceptions uses it there."""
    forward: list[dict[State, int]] = [{(None, False, 0): 0}]
    for candidate in candidates:
        following: dict[State, int] = {}
        for state, cost in forward[-1].items():
            for _, step, target in _moves(state, candidate):
                if cost + step < following.get(target, math.inf):
                    following[target] = cost + step
        forward.append(_prune(following))
    best = min(forward[-1].values())
    backward: list[dict[State, float]] = [{} for _ in forward]
    backward[-1] = dict.fromkeys(forward[-1], 0)
    for index in range(len(candidates) - 1, -1, -1):
        ahead = backward[index + 1]
        backward[index] = {state: min((step + ahead[target] for _, step, target in _moves(state, candidates[index])
                                       if target in ahead), default=math.inf) for state in forward[index]}
    roles = []
    for index, candidate in enumerate(candidates):
        ahead = backward[index + 1]
        roles.append(tuple(sorted({role for state, cost in forward[index].items()
                                   for role, step, target in _moves(state, candidate)
                                   if target in ahead and cost + step + ahead[target] == best})))
    return Resolution(roles, int(best))


@dataclass
class _Cut:
    """The walk's mutable state: the open block, the run an unresolved start opened, the heading state."""
    recipe: Recipe
    blocks: list[dict] = field(default_factory=list)
    dispositions: list[Disposition] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)
    current: dict | None = None
    unresolved: str | None = None
    after_heading: bool = False
    in_force: dict[int, HeadingEvent] = field(default_factory=dict)
    uncertain: set[str] = field(default_factory=set)

    def close(self) -> None:
        self.current = None
        self.unresolved = None

    def dispose(self, line: Line, role: str, **extra) -> None:
        self.dispositions.append(Disposition(segment_id=line.segment, start=line.start, end=line.end, role=role,
                                             **extra))

    def open(self, item: Routed) -> None:
        self.close()
        kinds = set(self.recipe.structure.heading_levels)
        in_force = [event.id for _, event in sorted(self.in_force.items()) if event.kind not in self.uncertain]
        block = {"id": f"b{len(self.blocks) + 1}", "label": item.label, "number": item.number,
                 "suffix": item.suffix, "lines": [], "headings": in_force}
        if uncertain := sorted(kinds & self.uncertain):
            self.diagnostics.append(Diagnostic(code="heading_state_uncertain", detail=f"no {', '.join(uncertain)} "
                                               "is inherited: an unclassified heading came after the last one",
                                               block=block["id"]))
        self.blocks.append(block)
        self.current = block
        self.after_heading = False
        self.own(item.line)

    def own(self, line: Line) -> None:
        self.current["lines"].append(line)
        self.dispose(line, "entry", block=self.current["id"])

    def heading(self, event: HeadingEvent) -> None:
        self.in_force = {level: known for level, known in self.in_force.items() if level < event.level}
        self.in_force[event.level] = event
        deeper = {kind for kind, level in self.recipe.structure.heading_levels.items() if level >= event.level}
        self.uncertain -= deeper


def segment(evidence: Evidence, recipe: Recipe) -> Segmentation:
    """The blocks, heading events, dispositions and diagnostics of one canonical result under one recipe."""
    routing = route(evidence, recipe)
    structure = recipe.structure
    items = routing.lines
    main = [index for index, item in enumerate(items) if item.kind == "candidate" and not item.restart]
    candidates, previous = [], -1
    inline = pattern(structure.inline_marker)
    for index in main:
        stretch = items[previous + 1:index]
        barrier = any(item.kind in ENDS_ENTRY for item in stretch)
        text = [items[previous].line.passage.text[items[previous].marker_end:items[previous].line.end]] \
            if previous >= 0 else []
        text += [item.line.text for item in stretch if item.kind == "content"]
        numbers = tuple(int(match["number"]) for chunk in text for match in inline.finditer(chunk))
        candidates.append(Candidate(items[index].number, items[index].suffix, barrier, numbers))
        previous = index
    resolution = resolve_starts(candidates)
    role_of = dict(zip(main, resolution.roles, strict=True))
    identities = Counter((items[index].number, items[index].suffix) for index in main)

    cut = _Cut(recipe, diagnostics=list(routing.diagnostics))
    rejected: list[RejectedStart] = []
    last_entry: Routed | None = None
    unresolved_since: bool = False
    restart_reported = series_reported = False
    for index, item in enumerate(items):
        line, kind = item.line, item.kind
        if kind == "withheld":
            cut.dispose(line, "excluded", reason=f"segment_status:{line.passage.status}")
        elif kind == "duplicate":
            cut.dispose(line, "excluded", reason="duplicate_observation")
        elif kind == "furniture":
            cut.dispose(line, "excluded", reason="furniture")
        elif kind == "figure":
            cut.dispose(line, "figure")
        elif kind == "section":
            cut.close()
            cut.in_force, cut.uncertain = {}, set()
            cut.after_heading = True
            cut.dispose(line, "heading", reason=item.region)
        elif kind == "heading":
            cut.close()
            cut.heading(item.heading)
            cut.after_heading = True
            cut.dispose(line, "heading", heading=item.heading.id)
        elif kind in ("hint", "unclassified_heading"):
            cut.close()
            cut.uncertain = set(structure.heading_levels)
            cut.after_heading = True
            cut.dispose(line, "unresolved", reason="unclassified_heading")
        elif kind == "series" or (kind == "candidate" and item.restart):
            if kind == "series" and not series_reported:
                cut.diagnostics.append(Diagnostic(code="scoped_series", detail="prefixed entry labels need a scoped "
                                                  "identity (decision D4)", spans=[_span(line)]))
                series_reported = True
            if kind == "candidate" and not restart_reported:
                cut.diagnostics.append(Diagnostic(code="numbering_restart", detail="a section restarts its numbering, "
                                                  "which needs a scoped identity (decision D4)", spans=[_span(line)]))
                restart_reported = True
            cut.close()
            cut.unresolved = "scoped_identity_unsupported"
            cut.dispose(line, "unresolved", reason=cut.unresolved)
        elif kind == "candidate":
            options = role_of[index]
            if options == ("entry",):
                if last_entry is not None and not unresolved_since:
                    _gap(cut, last_entry, item, structure.numbering_max_gap)
                cut.open(item)
                last_entry, unresolved_since = item, False
            elif options == ("list_item",) and cut.current is not None:
                cut.own(line)
                rejected.append(RejectedStart(span=_span(line), label=item.label, role="list_item",
                                              reason="list_item"))
            else:
                reason = _reason(item, options, last_entry, identities)
                ambiguous = len(options) > 1
                cut.diagnostics.append(Diagnostic(code=reason, detail=f"start {item.label!r} could be "
                                                  f"{' or '.join(options)}" if ambiguous else
                                                  f"start {item.label!r} is not explained by the numbering",
                                                  spans=[_span(line)]))
                rejected.append(RejectedStart(span=_span(line), label=item.label,
                                              role="ambiguous_start" if ambiguous else "exception", reason=reason))
                cut.close()
                cut.unresolved = reason
                unresolved_since = True
                cut.dispose(line, "unresolved", reason=reason)
        elif kind == "glossary":
            cut.dispose(line, "glossary")
        elif kind == "reference":
            cut.dispose(line, "reference")
        elif kind == "excluded_region":
            cut.dispose(line, "excluded", reason=f"region:{item.region}")
        elif cut.current is not None and _marker_lost(line, structure):
            cut.close()  # its entry is unknown: neither the open entry's content nor an invented number
            cut.unresolved = "unnumbered_item"
            unresolved_since = True
            cut.dispose(line, "unresolved", reason="unnumbered_item")
        elif cut.current is not None:
            cut.own(line)
        elif cut.unresolved is not None:
            cut.dispose(line, "unresolved", reason=cut.unresolved)
        elif line.passage.label in structure.labels.list_item:
            cut.dispose(line, "unresolved", reason="unnumbered_item")
        else:
            cut.dispose(line, "unresolved", reason="orphan_after_heading" if cut.after_heading
                        else "orphan_before_first_entry")

    duplicates_open = routing.potential_duplicates
    for members in duplicates_open:
        cut.diagnostics.append(Diagnostic(code="potential_duplicate", detail=f"{', '.join(members)} may be one "
                                          "printed line read more than once; all are kept",
                                          spans=[Span(segment_id=member, start=0, end=len(evidence.by_id(member).text))
                                                 for member in members]))
    intentional = [p.id for p in evidence.withheld if p.status == "skipped" and p.label in structure.labels.figure]
    failures = [p.id for p in evidence.withheld if p.id not in intentional]
    if failures:
        cut.diagnostics.append(Diagnostic(code="engine_failure", detail=f"{len(failures)} segment(s) the engine did "
                                          f"not read: {', '.join(failures)}"))
    for issue in evidence.order_issues:
        cut.diagnostics.append(Diagnostic(code="reading_order", detail=issue))
    blocks = [_block(block, items, structure.context) for block in cut.blocks]
    if not blocks:
        cut.diagnostics.append(Diagnostic(code="no_records", detail="no entry start was resolved"))
    roles = Counter(d.role for d in cut.dispositions)
    unresolved = roles.get("unresolved", 0)
    coverage = Coverage(
        complete=unresolved == 0 and not duplicates_open and not evidence.order_issues,
        lines=len(cut.dispositions), entries=len(blocks), reading_order_issues=len(evidence.order_issues),
        unresolved=unresolved, roles=dict(sorted(roles.items())),
        excluded=dict(sorted(Counter(d.reason for d in cut.dispositions if d.role == "excluded").items())),
        potential_duplicates=len(duplicates_open), withheld_intentional=intentional, withheld_failures=failures)
    content = {
        "segmentation_version": SEGMENTATION_VERSION,
        "fingerprint": fingerprint(evidence.generation, evidence.digest, recipe),
        "generation": evidence.generation, "parse_digest": evidence.digest,
        "recipe": RecipeRef(id=recipe.id, version=recipe.version,
                            structure_sha256=recipe.structure_sha256).model_dump(),
        "blocks": [block.model_dump() for block in blocks],
        "heading_events": [event.model_dump() for event in routing.headings],
        "dispositions": [d.model_dump() for d in cut.dispositions],
        "rejected_starts": [start.model_dump() for start in rejected],
        "glossary": [entry.model_dump() for entry in routing.glossary],
        "diagnostics": [d.model_dump() for d in cut.diagnostics],
        "coverage": coverage.model_dump(),
    }
    return sealed(content)


def _span(line: Line) -> Span:
    return Span(segment_id=line.segment, start=line.start, end=line.end)


BULLETS = "\u2022\u00b7\u2023\u25e6\u25aa\u25cf\u25cb\u25a0\u25a1-\u2013\u2014*"


def _marker_lost(line: Line, structure: Structure) -> bool:
    """A born-digital list item that prints no marker at all: Docling keeps every list item's printed marker, so its
    number was lost, not absent (a bulleted item keeps its bullet and is content). Scanned layout labels are guesses
    and do not count; only a list item's first line carries its marker."""
    passage = line.passage
    return (passage.crop is None and passage.label in structure.labels.list_item
            and line.start == len(passage.text) - len(passage.text.lstrip())
            and not line.text.startswith(tuple(BULLETS)))


def _reason(item: Routed, options: tuple[str, ...], last_entry: Routed | None, identities: Counter) -> str:
    """Why a start opened no block: a label printed twice (either copy could be the entry), a label below the
    previous entry that continues no list (it cites something earlier), an outlier among consecutive entries (an
    OCR misreading, say), or several feasible readings."""
    identity = (item.number, item.suffix)
    if len(options) > 1:
        return "duplicate_identity" if identities[identity] > 1 and "exception" in options else "ambiguous_start"
    previous = (last_entry.number, last_entry.suffix) if last_entry is not None else None
    if previous == identity:
        return "duplicate_identity"
    if previous is not None and identity < previous:
        return "backward_label"
    return "sequence_exception"


def _gap(cut: _Cut, before: Routed, after: Routed, max_gap: int) -> None:
    missing = after.number - before.number - 1 if after.number != before.number else 0
    if missing <= 0:
        return
    code = "numbering_gap" if missing <= max_gap else "numbering_jump"
    labels = f"{before.number + 1}" if missing == 1 else f"{before.number + 1}–{after.number - 1}"
    cut.diagnostics.append(Diagnostic(code=code, detail=f"{labels} missing between {before.label} and {after.label}",
                                      spans=[_span(after.line)]))


def _block(block: dict, items: list[Routed], context) -> Block:
    """A block's primary spans (consecutive owned lines of one segment merged), continuation flag and context."""
    owned: list[Line] = block["lines"]
    spans: list[Span] = []
    for line in owned:
        last = spans[-1] if spans else None
        if last is not None and last.segment_id == line.segment and not _between(items, last, line):
            spans[-1] = Span(segment_id=last.segment_id, start=last.start, end=line.end)
        else:
            spans.append(Span(segment_id=line.segment, start=line.start, end=line.end))
    places = {(line.passage.page, line.passage.unit, line.passage.crop) for line in owned}
    return Block(id=block["id"], entry_label=block["label"], entry_no=block["number"], entry_suffix=block["suffix"],
                 primary_spans=spans, context_spans=_context(owned, items, context), continuation=len(places) > 1,
                 heading_events=block["headings"])


def _between(items: list[Routed], span: Span, line: Line) -> bool:
    """Whether another line of the same segment lies between the span's end and `line`."""
    return any(item.line.segment == line.segment and span.end <= item.line.start < line.start
               for item in items if item.line is not line)


VISIBLE = frozenset({"content", "candidate", "heading", "section", "hint", "unclassified_heading", "series",
                     "glossary", "reference", "excluded_region"})


def _context(owned: list[Line], items: list[Routed], context) -> list[Span]:
    """Up to `context.lines` visible lines before the first owned line and after the last, each clipped to
    `context.max_chars` next to the block. Visible means text a reader of the page would see around the entry: not
    running heads, figures, duplicate observations or failed segments."""
    if context.lines == 0:
        return []
    position = {(item.line.segment, item.line.start): number for number, item in enumerate(items)}
    first, last = position[(owned[0].segment, owned[0].start)], position[(owned[-1].segment, owned[-1].start)]
    before = [item.line for item in reversed(items[:first]) if item.kind in VISIBLE][:context.lines]
    after = [item.line for item in items[last + 1:] if item.kind in VISIBLE][:context.lines]
    spans = [Span(segment_id=line.segment, start=max(line.start, line.end - context.max_chars), end=line.end)
             for line in reversed(before)]
    spans += [Span(segment_id=line.segment, start=line.start, end=min(line.end, line.start + context.max_chars))
              for line in after]
    return spans
