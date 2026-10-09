"""The unified Catalog's source units, counted windows and general record discovery with its source ledger.

The admitted canonical text is cut into units: its nonblank source lines, as raw code-point ranges of their segments
(only Unicode White_Space is blank). `plan` groups consecutive units into windows whose rendered request fits a
stage's budget, with disjoint primary text and up to `overlap` units of context on each side; a unit too long for any
window is cut at whitespace, then at code points (`windows.windows_of`), keeping its raw offsets. Supplementary
context that does not fit is dropped and named, never primary text. `split` halves a window whose reply failed.

Each discovery reply names, by line label and the exact text where it starts, every place in its window's primary
text where a record or record-free text ("other": front matter, headings, an index) begins, and says whether the
window begins and ends inside a record. A place counts only where that text occurs exactly once in the named line;
a line with a place that cannot be located stays unresolved up to the next place. A record continues across a window
boundary only when the earlier window says it ends inside a record and the later one says it begins inside one:
silence, disagreement or a failed window leaves the affected text unresolved, never the preceding record's. A record
the last window says continues after it is cut by the end of the supplied source (an excerpt): its end is
`source_end`, as settled as a `validated` one, when no nonblank withheld text follows it in reading order, since then
nothing after it was left unread; when withheld text does follow, the record may continue there and its end is
`unresolved`. A failed or cut-off reply is retried on the window's two halves a bounded number of times.

The ledger gives every nonblank canonical range one disposition: `entry` (a record's own text), `other`,
`unresolved` or `withheld`. A disposition is a recorded decision, not a measure of recall. Nothing here knows a
recipe, a language, a numbering convention or a field name.
"""
from __future__ import annotations

import json
import re
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import groupby

from kei_exp.kie.extract.locate import normalise
from kei_exp.kie.extract.stages import Issue
from kei_exp.kie.extract.windows import Unit, windows_of
from kei_exp.kie.passages import Evidence, Passage

VERSION = 3  # 2: a record the last window says continues ends at the source end, not beyond scope; 3: unless nonblank
# withheld text follows it, where it may continue: then its end is unresolved
# Unicode White_Space, the only characters that are blank: every other character, punctuation included, is source.
WHITE_SPACE = ("\t\n\v\f\r \x85\xa0            "
               "    　")
CONTEXT_UNITS = 3  # the record-free lines before an entry kept as its context references
DISCOVERY = (
    "You find where records begin in a source document. A record is: {description}\n"
    "The WINDOW lists source lines, each after a label such as [L1]. Report, in source order, every place in the "
    "WINDOW where a record begins (\"record\") and where text that belongs to no record begins (\"other\": front "
    "matter, a heading between records, an index or a bibliography). A record may begin in the middle of a line and "
    "one line may hold several records. Give each place as a list: the label of its line; \"record\" or \"other\"; "
    "the record's printed number or label when it has one, else null; and, only when the place begins after the "
    "start of its line, a fourth item: the exact characters where it begins, copied from that line (a few words). "
    "Answer "
    "\"begins_inside_record\": true when the first WINDOW line continues a record that began before the WINDOW, false "
    "when it does not, null when you cannot tell; and \"ends_inside_record\": true when the last record in the WINDOW "
    "continues after it, false when it does not, null when you cannot tell. CONTEXT lines are shown for orientation "
    "only: never report a place in them. Return only the JSON object, on one line, without indentation.")


@dataclass(frozen=True)
class Window:
    """Consecutive primary units with the context shown beside them; `omitted` names context left out to fit."""
    primary: tuple[Unit, ...]
    before: tuple[Unit, ...] = ()
    after: tuple[Unit, ...] = ()
    heading: tuple[Unit, ...] = ()
    omitted: tuple[tuple[str, Unit], ...] = ()

    def dropped(self, kind: str) -> tuple[Unit, ...]:
        return tuple(unit for each, unit in self.omitted if each == kind)


def trimmed(segment: str, text: str, start: int, end: int) -> list[Unit]:
    """[start, end) of the segment's text without leading and trailing White_Space, or nothing when it is blank."""
    while start < end and text[start] in WHITE_SPACE:
        start += 1
    while end > start and text[end - 1] in WHITE_SPACE:
        end -= 1
    return [Unit(segment, start, end)] if end > start else []


def units_of(passages: Sequence[Passage]) -> list[Unit]:
    """Every nonblank source line of the passages in reading order."""
    found: list[Unit] = []
    for passage in passages:
        position = 0
        for line in passage.text.split("\n"):
            found += trimmed(passage.id, passage.text, position, position + len(line))
            position += len(line) + 1
    return found


def plan(units: Sequence[Unit], texts: dict[str, str], fits: Callable[[Window], bool], *, overlap: int,
         lead: Sequence[Unit] = (), trail: Sequence[Unit] = (), heading: Sequence[Unit] = ()) -> list[Window] | None:
    """Consecutive windows over `units`, each with as many units as fit beside its full context; `lead` and `trail`
    are the units just outside. None when not even one code point fits beside the instructions."""
    pieces = list(units)
    windows: list[Window] = []
    start = 0
    while start < len(pieces):
        if not fits(Window((pieces[start],))):
            cut = windows_of([pieces[start]], texts, lambda part: fits(Window(tuple(part))), overlap=False)
            if cut is None:
                return None
            pieces[start:start + 1] = [piece for part in cut for piece in part]

        def window(end: int, dropped: tuple[str, ...] = (), start=start) -> Window:
            shown = {"before": tuple((*lead, *pieces[:start])[-overlap:]) if overlap else (),
                     "after": tuple((*pieces[end:], *trail)[:overlap]) if overlap else (), "heading": tuple(heading)}
            kept = {kind: () if kind in dropped else units for kind, units in shown.items()}
            return Window(tuple(pieces[start:end]), kept["before"], kept["after"], kept["heading"],
                          tuple((kind, unit) for kind in dropped for unit in shown[kind]))

        end = _longest(start, len(pieces), lambda end: fits(window(end)))
        if end > start:
            windows.append(window(end))
        else:  # the unit fits alone: drop supplementary context until it fits with the unit
            end = start + 1
            windows.append(next(each for dropped in (("heading",), ("heading", "after"), ("heading", "after", "before"))
                                if fits(each := window(end, dropped))))
        start = end
    return windows


def _longest(start: int, total: int, fits_end: Callable[[int], bool]) -> int:
    """The largest end in (start, total] whose window fits, by galloping then bisecting; `start` when none does."""
    good, probe = start, start + 1
    while probe <= total and fits_end(probe):
        good, probe = probe, start + 2 * (probe - start)
    bad = min(probe, total + 1)
    while bad - good > 1:
        middle = (good + bad) // 2
        if fits_end(middle):
            good = middle
        else:
            bad = middle
    return good


def split(window: Window, texts: dict[str, str], fits: Callable[[Window], bool], *, overlap: int) -> list[Window]:
    """A window of several units as the windows of its two halves, each with its context re-fitted."""
    before = window.before or window.dropped("before")
    after = window.after or window.dropped("after")
    heading = window.heading or window.dropped("heading")
    middle = len(window.primary) // 2
    first, second = window.primary[:middle], window.primary[middle:]
    return [*plan(first, texts, fits, overlap=overlap, lead=before, trail=(*second, *after), heading=heading),
            *plan(second, texts, fits, overlap=overlap, lead=(*before, *first), trail=after, heading=heading)]


def text_of(units: Sequence[Unit], texts: dict[str, str], labels: Sequence[str] | None = None) -> str:
    return "\n".join((f"[{label}] " if labels else "") + texts[unit.segment][unit.start:unit.end]
                     for label, unit in zip(labels or [None] * len(units), units, strict=True))


def ranges_json(units: Sequence[Unit]) -> list[dict]:
    return [{"segment": unit.segment, "start": unit.start, "end": unit.end} for unit in units]


# --- discovery -----------------------------------------------------------------------------------------------------

@dataclass
class _Seen:
    window: Window
    ok: bool
    places: list[tuple[int, int, str, str | None]]  # (primary unit index, raw offset, record|other|unresolved, label)
    begins: bool | None = None
    ends: bool | None = None


def _render(window: Window, texts: dict[str, str]) -> tuple[str, list[str]]:
    labels = [f"L{number}" for number in range(1, len(window.primary) + 1)]
    parts = ([f"### CONTEXT BEFORE\n{text_of(window.before, texts)}"] if window.before else []) + \
        [f"### WINDOW\n{text_of(window.primary, texts, labels)}"] + \
        ([f"### CONTEXT AFTER\n{text_of(window.after, texts)}"] if window.after else [])
    return "\n\n".join(parts) + "\n\nReturn the JSON object now.", labels


def _reply(labels: list[str]) -> dict:
    place = {"type": "array", "prefixItems": [{"type": "string", "enum": labels},
                                              {"type": "string", "enum": ["record", "other"]},
                                              {"type": ["string", "null"]}, {"type": "string"}],
             "items": False, "minItems": 3, "maxItems": 4}
    return {"type": "object", "properties": {
        "places": {"type": "array", "items": place},
        "begins_inside_record": {"type": ["boolean", "null"]}, "ends_inside_record": {"type": ["boolean", "null"]}},
        "required": ["places", "begins_inside_record", "ends_inside_record"], "additionalProperties": False}


def occurrences(haystack: str, needle: str) -> list[tuple[int, int]]:
    """The raw ranges of `haystack` where `needle` occurs, compared as `locate` compares text (NFKC, case folded,
    whitespace collapsed) but without requiring word boundaries; overlapping occurrences count apart."""
    view, wanted = normalise(haystack), normalise(needle).text
    found, at = [], view.text.find(wanted) if wanted else -1
    while at != -1:
        found.append((view.ranges[at][0], view.ranges[at + len(wanted) - 1][1]))
        at = view.text.find(wanted, at + 1)
    return found


def _observe(answer: dict, window: Window, texts: dict[str, str], labels: list[str],
             issues: list[Issue]) -> _Seen | None:
    """The window's places located in its own lines, or None when the reply is not the requested shape."""
    places, begins, ends = (answer.get(key) for key in ("places", "begins_inside_record", "ends_inside_record"))
    if not isinstance(places, list) or begins not in (True, False, None) or ends not in (True, False, None):
        return None
    found: dict[int, list[tuple[int, str, str | None]]] = {}
    unplaced: set[int] = set()
    for place in places:
        if not isinstance(place, list) or len(place) not in (3, 4) or place[0] not in labels or \
                place[1] not in ("record", "other"):
            return None
        line_label, kind, label, text = (*place, None)[:4]
        index = labels.index(line_label)
        unit = window.primary[index]
        line = texts[unit.segment][unit.start:unit.end]
        starts = [0] if not isinstance(text, str) or not text.strip() else [a for a, _ in occurrences(line, text)]
        if len(starts) != 1:
            issues.append(Issue("boundary_unplaced", f"a {kind} start {text!r} occurs {len(starts)} times in "
                                f"{unit.segment} [{unit.start}:{unit.end}]"))
            unplaced.add(index)
            continue
        if isinstance(label, str) and label.strip() and not occurrences(line[starts[0]:], label):
            issues.append(Issue("label_not_in_source", f"printed label {label!r} is not in {unit.segment} after "
                                f"offset {unit.start + starts[0]}"))
            label = None
        found.setdefault(index, []).append((unit.start + starts[0], kind,
                                            label if isinstance(label, str) and label.strip() else None))
    located: list[tuple[int, int, str, str | None]] = []
    for index in sorted({*found, *unplaced}):
        if index in unplaced:  # where in the line the unplaced start lies is unknown, so the line is
            located.append((index, window.primary[index].start, "unresolved", None))
            continue
        for offset in sorted({offset for offset, _, _ in found[index]}):
            same = {(kind, label) for at, kind, label in found[index] if at == offset}
            kinds = {kind for kind, _ in same}
            labels_at = {label for _, label in same if label is not None}
            kind = kinds.pop() if len(kinds) == 1 else "unresolved"
            located.append((index, offset, kind, labels_at.pop() if len(labels_at) == 1 else None))
    return _Seen(window, True, located, begins, ends)


def groups_of(units: Sequence[Unit], passages: Sequence[Passage], by: str) -> list[list[Unit]]:
    """The units in consecutive runs that share a printed page (`page`: a PDF page's book page) or one of its columns
    (`column`); `budget` is one run, cut by the budget alone."""
    if by == "budget":
        return [list(units)] if units else []
    where = {passage.id: (passage.page, passage.unit, passage.crop if by == "column" else None) for passage in passages}
    return [list(run) for _, run in groupby(units, key=lambda unit: where[unit.segment])]


def discover(evidence: Evidence, description: str, fits_budget: Callable[[str, str, dict], bool],
             ask: Callable[..., dict | None], *, overlap: int, splits: int, by: str = "budget", workers: int = 1,
             progress: Callable[[list[dict], list[dict]], None] | None = None, frontier: bool = False,
             unanswered: tuple[type[BaseException], ...] = ()) -> dict | None:
    """The discovery body: entries, ledger, windows, issues and calls (as `Call`s), or None when not even one code
    point fits a discovery request. `fits_budget(system, user, schema)` counts a request against the stage's budget;
    `ask(record, system, user, schema, calls, issues)` makes one counted call. Windows never cross a `groups_of(by)`
    boundary; context does. Windows are asked in source order, `workers` at once, slice by slice, then every failed
    one's halves. Once an `ask` in a slice raises, no later window is asked, and the first raised in source order is
    raised once the slice has stopped: a durable planning round yields at most `workers` discovery calls. Before each
    call, `progress` is given the record starts the earlier slices found, in source order, and the lines the window
    labels: a view of the run while it reads, never an input to discovery.

    With `frontier`, windows are read as a sliding frontier instead: no slices, a failed window's halves asked as soon
    as it fails, and the body also says whether it is `complete`. `unanswered` are the exceptions an `ask` raises for a
    call whose reply is not there yet, a durable planning round's: such an `ask` never waits on a model, so windows are
    read in turn, without threads, until `workers` are unanswered, and nothing of `unanswered` is raised. Until the
    body is complete, it holds only the windows of the read prefix (the windows before the first one not yet read
    whole, halves included) and those of their entries whose end that prefix already decides (`_assemble`). Without
    `unanswered`, every window is answered: `workers` are asked at once, and the first error stops the rest."""
    texts = {passage.id: passage.text for passage in evidence.passages}
    system = DISCOVERY.format(description=description)

    def fits(window: Window) -> bool:
        user, labels = _render(window, texts)
        return fits_budget(system, user, _reply(labels))
    units, windows, at = units_of(evidence.passages), [], 0
    for group in groups_of(units, evidence.passages, by):
        planned = plan(group, texts, fits, overlap=overlap, lead=units[max(0, at - overlap):at],
                       trail=units[at + len(group):at + len(group) + overlap])
        if planned is None:
            return None
        windows += planned
        at += len(group)
    rank = {passage.id: number for number, passage in enumerate(evidence.passages)}
    done: list[_Seen] = []

    def one(window: Window, found: list[dict]) -> tuple[_Seen | None, list, list[Issue]]:
        user, labels = _render(window, texts)
        if progress is not None:
            progress(found, ranges_json(window.primary))
        calls: list = []
        issues: list[Issue] = []
        answer = ask(None, system, user, _reply(labels), calls, issues)
        return (_observe(answer, window, texts, labels, issues) if answer is not None else None), calls, issues

    def read(batch: list[Window], depth: int) -> list[list[tuple[_Seen | None, list, list[Issue]]]]:
        """Per window of `batch`, in order: its reading, then its halves' when it failed and may still be halved."""
        size, results = max(1, workers), []
        with ThreadPoolExecutor(max_workers=size, thread_name_prefix="discovery") as pool:
            for at in range(0, len(batch), size):
                found = record_starts(sorted(done, key=lambda each: (rank[each.window.primary[0].segment],
                                                                    each.window.primary[0].start)))
                futures = [pool.submit(one, window, found) for window in batch[at:at + size]]
                for future in futures:
                    if (error := future.exception()) is not None:
                        raise error
                results += [future.result() for future in futures]
                done.extend(observed for observed, _, _ in results[-len(futures):] if observed is not None)
        cut = [split(window, texts, fits, overlap=overlap) if observed is None and len(window.primary) > 1
               and depth < splits else [] for window, (observed, _, _) in zip(batch, results, strict=True)]
        halves = iter(read([half for each in cut for half in each], depth + 1) if any(cut) else ())
        readings = []
        for window, (observed, calls, issues), each in zip(batch, results, cut, strict=True):
            if each:
                readings.append([(None, calls, issues), *[item for _ in each for item in next(halves)]])
                continue
            if observed is None:
                issues.append(Issue("discovery_window_failed", f"no valid discovery reply for {_where(window)}"))
            readings.append([(observed or _Seen(window, False, []), calls, issues)])
        return readings

    def resolve(window: Window, depth: int) -> list | None:
        """The window's reading, then its halves' when it failed and may still be halved, each half once the one
        before it is read; None once one of them is unanswered."""
        try:
            observed, calls, issues = one(window, sorted_starts())
        except unanswered:
            return None
        if observed is not None:
            with lock:
                done.append(observed)
        elif len(window.primary) > 1 and depth < splits:
            readings = [(None, calls, issues)]
            for half in split(window, texts, fits, overlap=overlap):
                if (more := resolve(half, depth + 1)) is None:
                    return None
                readings += more
            return readings
        else:
            issues.append(Issue("discovery_window_failed", f"no valid discovery reply for {_where(window)}"))
        return [(observed or _Seen(window, False, []), calls, issues)]

    def sorted_starts() -> list[dict]:
        with lock:
            return record_starts(sorted(done, key=lambda each: (rank[each.window.primary[0].segment],
                                                                each.window.primary[0].start)))

    if frontier:
        lock, resolved, waiting = threading.Lock(), [], 0
        if unanswered:
            for window in windows:
                resolved.append(each := resolve(window, 0))
                waiting += each is None
                if waiting == max(1, workers):
                    break
        else:
            halt = threading.Event()

            def turn(window: Window) -> list:
                if halt.is_set():
                    return []
                try:
                    return resolve(window, 0)
                except BaseException:
                    halt.set()
                    raise
            with ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="discovery") as pool:
                futures = [pool.submit(turn, window) for window in windows]
            for future in futures:  # the first error in source order, once every window has stopped
                if (error := future.exception()) is not None:
                    raise error
            resolved = [future.result() for future in futures]
        complete = None not in resolved
        readings = [item for each in resolved[:None if complete else resolved.index(None)] for item in each]
    else:
        readings, complete = [item for each in read(windows, 0) for item in each], True
    seen = [observed for observed, _, _ in readings if observed is not None]
    return {**_assemble(seen, evidence, texts, prefix=not complete), "windows": [_window_json(each) for each in seen],
            "issues": [*(Issue("reading_order", detail) for detail in evidence.order_issues),
                       *(issue for _, _, issues in readings for issue in issues)],
            "calls": [call for _, calls, _ in readings for call in calls]} | ({"complete": complete} if frontier else {})


def record_starts(seen: Sequence[_Seen]) -> list[dict]:
    """The record starts the windows read so far found, each by its segment and printed label."""
    return [{"segment": each.window.primary[index].segment, "label": label}
            for each in seen for index, _, kind, label in each.places if kind == "record"]


class StreamedPlaces:
    """The places a discovery reply has completed while it is still generated, for display only: discovery reads
    the saved reply alone (`_observe`). A place is complete once its list closes; nothing is repaired."""

    def __init__(self) -> None:
        self.text, self.at, self.places = "", None, []
        self._decoder = json.JSONDecoder(strict=False)  # source lines may hold control characters, as `parse_json`

    def feed(self, delta: str) -> bool:
        """Whether `delta` completed another place."""
        self.text += delta
        if self.at is None:
            start = re.search(r'"places"\s*:\s*\[', self.text)
            if start is None:
                return False
            self.at = start.end()
        before = len(self.places)
        while True:
            at = self.at
            while at < len(self.text) and self.text[at] in " \t\r\n,":
                at += 1
            if at >= len(self.text) or self.text[at] == "]":
                break
            try:
                place, self.at = self._decoder.raw_decode(self.text, at)
            except json.JSONDecodeError:
                break
            self.places.append(place)
        return len(self.places) > before


def _where(window: Window) -> str:
    first, last = window.primary[0], window.primary[-1]
    return f"{first.segment} [{first.start}:] to {last.segment} [:{last.end}]"


def _window_json(seen: _Seen) -> dict:
    return {"primary": ranges_json(seen.window.primary[:1] + seen.window.primary[-1:]), "ok": seen.ok,
            "begins_inside_record": seen.begins, "ends_inside_record": seen.ends, "places": len(seen.places),
            "context_omitted": [{"kind": kind, **ranges_json([unit])[0]} for kind, unit in seen.window.omitted]}


def _assemble(seen: list[_Seen], evidence: Evidence, texts: dict[str, str], *, prefix: bool = False) -> dict:
    """Regions from the windows' places and their explicit continuation observations; then entries and the ledger.

    A `prefix` is the windows read so far from the start of the source: a later window only adds entries after them,
    so every entry here is final (number, ranges, context, end) except the one still open at the prefix's end, whose
    end the next window decides; it is left out."""
    units: list[Unit] = [unit for each in seen for unit in each.window.primary]
    regions: list[list] = []  # [kind, entry index or None, (unit index, offset)]
    entries: list[dict] = []
    open_entry: int | None = None
    previous: _Seen | None = None
    first = 0

    def close(end: str) -> None:
        if open_entry is not None:
            entries[open_entry]["end"] = end

    for each in seen:
        start = (first, units[first].start)
        first += len(each.window.primary)
        places = [((first - len(each.window.primary) + index, offset), kind, label)
                  for index, offset, kind, label in each.places]
        if not each.ok:
            close("unresolved")
            regions.append(["unresolved", None, start])
            open_entry, previous = None, each
            continue
        closed_cleanly = previous is not None and previous.ok and previous.ends is False
        if not places or places[0][0] != start:  # the head: text before the window's first place
            joins = (previous is not None and previous.ok and previous.ends is True and each.begins is True
                     and open_entry is not None)
            if not joins:
                close("validated" if closed_cleanly else "unresolved")
                head = "other" if each.begins is False and (previous is None or closed_cleanly) else "unresolved"
                regions.append([head, None, start])
                open_entry = None
        else:
            close("validated" if closed_cleanly and each.begins is False else "unresolved")
            open_entry = None
        for position, kind, label in places:
            close("unresolved" if kind == "unresolved" else "validated")
            open_entry = None
            if kind == "record":
                entries.append({"id": f"{units[position[0]].segment}@{position[1]}", "label": label, "ranges": [],
                                "context": [], "end": "validated"})
                open_entry = len(entries) - 1
            regions.append([kind, open_entry, position])
        previous = each
    if prefix:
        body = _ledger(regions, units, entries, evidence, texts)
        return body if open_entry is None else {**body, "entries": entries[:open_entry]}
    if previous is not None and previous.ok:
        close({False: "validated", True: "unresolved" if _unread_after(units[-1], evidence) else "source_end",
               None: "unresolved"}[previous.ends])
    return _ledger(regions, units, entries, evidence, texts)


def _unread_after(last: Unit, evidence: Evidence) -> bool:
    """Whether nonblank withheld text follows `last` in reading order (page, then index): a record the last window
    says continues may continue there. A blank withheld segment, such as a skipped picture, has no text to continue
    it."""
    order = {passage.id: (passage.page, passage.index) for passage in (*evidence.passages, *evidence.withheld)}
    return any(order[unit.segment] > order[last.segment] for unit in units_of(evidence.withheld))


def _ledger(regions: list[list], units: list[Unit], entries: list[dict], evidence: Evidence,
            texts: dict[str, str]) -> dict:
    ledger: list[dict] = []
    others: list[Unit] = []
    ends = [region[2] for region in regions[1:]] + [(len(units), 0)] * bool(regions)
    for (kind, entry, (first, offset)), (last, stop) in zip(regions, ends, strict=True):
        owned = [piece for index in range(first, min(last, len(units) - 1) + 1)
                 for piece in trimmed(units[index].segment, texts[units[index].segment],
                                      offset if index == first else units[index].start,
                                      stop if index == last else units[index].end)]
        if entry is not None:
            entries[entry]["ranges"] = ranges_json(owned)
            entries[entry]["context"] = ranges_json(others[-CONTEXT_UNITS:])
        elif kind == "other":
            others += owned
        for piece in owned:
            row = {"segment": piece.segment, "start": piece.start, "end": piece.end,
                   "disposition": "entry" if entry is not None else kind,
                   "entry": entries[entry]["id"] if entry is not None else None}
            if ledger and {**ledger[-1], "start": 0, "end": 0} == {**row, "start": 0, "end": 0}:
                ledger[-1]["end"] = piece.end  # the same region's next line of one segment: only White_Space between
            else:
                ledger.append(row)
    ledger += [{"segment": unit.segment, "start": unit.start, "end": unit.end, "disposition": "withheld", "entry": None}
               for unit in units_of(evidence.withheld)]
    return {"entries": entries, "ledger": ledger}
