"""Article resolution: the document's own values among the readings of its separately read parts.

A value context read on its own answers the whole root from what it alone shows, so a part without the document's
own value may return another one: a cited work's year, a section heading as the title, a running header's author
name or page number. Once a split source's contexts answered, `resolve` shows the reasoning model the document's
opening and every place's readings, each
with the pages and source text it was read from, and asks which reading is the document's own value (a candidate,
NONE when none is, UNSURE when the source does not settle it) and, for every list item, whether it is the document's
own, another work's or entity's, or a repeat (null when the source does not settle the list). A chosen or NONE place
replaces assembly's null-on-conflict; UNSURE keeps the Value Disagreement. A list keeps every item not labelled
another's or a repeat, in reading order; a repeat is only an item equal to one labelled own beside it, so a second
reading of an own item that differs from it is never one. An answer that leaves an item unlabelled changes nothing. Equal items in different list parts were never compared, so
their possible repeat stays named. A call that fails or answers outside its labels changes nothing.
"""
from __future__ import annotations

import json
import re
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import replace
from time import monotonic
from typing import Any

from kei_exp.kie.extract.calls import Call, complete
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.durable import canonical
from kei_exp.kie.extract.schema import Node, Schema, notes
from kei_exp.kie.extract.stages import Issue
from kei_exp.kie.extract.tokens import TokenCounter
from kei_exp.kie.passages import text_of

NONE, UNSURE = "NONE", "UNSURE"
# A list item is the document's own, another work's or entity's, or the same thing printed again.
OWN, OTHER, REPEAT = "OWN", "OTHER", "REPEAT"
# shortcut: a list longer than this is resolved in parts, so an item repeating one in another part is kept and stays
# named as a possible repeat; resolve across parts (a second pass over the kept items) when long lists show them.
LIST_CHUNK = 60
SNIPPET = 70  # characters of source shown on each side of a reading
PRINTED = 3  # places shown of a value printed several times in its part
VALUE_CHARS = 200
OPENING_CHARS = 1500  # the document's opening, shown so the model knows which document is its own
# Not inside a longer word or number: 10 is not printed in 210, 10.5 or 1,100.
WHOLE = r"(?<!\w)(?<!\d[.,]){}(?!\w|[.,]\d)"
# Digits are not the end of a number that starts before them: 10 is not printed in -10, −10, .10, 1e-10 or 1e+10.
# A hyphen, minus or point starts a number only after no word character, so 10 is printed in pp. 5-10 and p.10.
NUMBER_START = r"(?<!(?<!\w)[-\u2212.])(?<!\d[eE][-\u2212+])"
RESOLUTION = (
    "Several parts of one document were each read on their own for the document's one record, so a part may have "
    "answered with a value that is not the document's own: a value of a work the document cites, a section heading, "
    "a running page header or page number, or another entity's value. The document's opening shows which document "
    "it is. A record is: {description}\n{notes}"
    "For each single-value place (S...), choose the label of the candidate that is the document's own value; answer "
    "NONE when no candidate is (a value only a cited work, a heading or another entity has is never the document's "
    "own, even when it is the only candidate; when the opening states the document's own value and no candidate is "
    "it, answer NONE), or UNSURE when the source does not settle it. For each list place "
    "(L...), label every item, or answer null for the place when the source does not settle it. OWN: an item of the "
    "document's own list. OTHER: an item of another work or entity (a work the document cites, a reference, another "
    "document). REPEAT, offered only for an item marked 'same value as': the same thing printed again (a running "
    "header or footer, a repeated byline), and only when its source shows the same thing again; equal values that "
    "describe different things are separate items: label each OWN. A value printed several times is shown at each "
    "place, since which one a reading read is not known; when those places do not show that equal items are the same "
    "thing, label each OWN. Two readings of one of the document's own things that differ, or where one has values "
    "the other lacks, are both OWN. Each item is shown whole, with the source around its value printed the fewest "
    "times. Return only the JSON object.")


def _places(nodes: Sequence[Node], path: tuple[str, ...] = ()):
    """Every scalar and list place of the root outside lists, through objects."""
    for node in nodes:
        here = (*path, node.name)
        if node.type == "object":
            yield from _places(node.children or [], here)
        else:
            yield here, node


def _at(value: Any, path: Sequence[str]) -> Any:
    for name in path:
        value = value.get(name) if isinstance(value, dict) else None
    return value


def _put(root: dict, path: Sequence[str], value: Any) -> None:
    for name in path[:-1]:
        if not isinstance(root.get(name), dict):
            root[name] = {}
        root = root[name]
    root[path[-1]] = value


def _leaves(value: Any):
    """The texts a reading's value is printed as: the value, or each of an item's non-blank values in order."""
    if isinstance(value, dict | list):
        for item in value.values() if isinstance(value, dict) else value:
            yield from _leaves(item)
    elif value is not None and (text := " ".join(str(value).split())):
        yield text


def _printed(needle: str, text: str) -> list[int]:
    """Where `needle` is printed in `text` as a whole word or number."""
    # A value printed digits first is a number; a word keeps only the whole-word rule, so Smith is in Jones-Smith.
    pattern = (NUMBER_START if needle[0].isdigit() else "") + WHOLE.format(re.escape(needle))
    return [match.start() for match in re.finditer(pattern, text, re.IGNORECASE)]


def _compact(value: Any) -> Any:
    """A value without its empty fields: null, blank text, empty lists and objects."""
    if isinstance(value, dict | list):
        kept = [(key, _compact(item)) for key, item in (value.items() if isinstance(value, dict) else enumerate(value))]
        kept = [(key, item) for key, item in kept if item is not None and item != "" and item != [] and item != {}]
        return dict(kept) if isinstance(value, dict) else [item for _, item in kept]
    return value


def _shown(value: Any, context: Context, *, whole: bool = False) -> str:
    """A reading as the model sees it: the value (`whole`, an item, without its empty fields and never cut, since a cut
    item hides the values that tell it from another), its pages and the source around where it is printed as a whole
    word or number. An item is shown where its value printed the fewest times is: its sample's name is printed
    everywhere, its measured value where it was read. A value printed several times is shown at its first `PRINTED`
    places with its count, never as one occurrence: a reply names no position, so which one it read is unknown."""
    pages = sorted({passage.page for passage in context.primary or context.passages})
    where = f"page {pages[0]}" if len(pages) == 1 else f"pages {pages[0]}-{pages[-1]}" if pages else "no page"
    text = " ".join(text_of(context.passages).split())
    needle, found = "", []
    for leaf in _leaves(value):
        places = _printed(leaf, text)
        if places and (not found or len(places) < len(found)):
            needle, found = leaf, places
    shown = " | ".join(f"…{text[max(0, at - SNIPPET):at + len(needle) + SNIPPET]}…" for at in found[:PRINTED])
    around = (" (not printed verbatim)" if not found else f": {shown}" if len(found) == 1
              else f" (printed {len(found)} times; which one was read is not known): {shown}")
    printed = (json.dumps(_compact(value), ensure_ascii=False) if whole
               else json.dumps(value, ensure_ascii=False)[:VALUE_CHARS])
    return f"{printed} — {where}{around}"


def _sections(readings: Sequence[dict], groups: Sequence[Context], nodes: Sequence[Node], root: dict,
              item_sources: dict[tuple, list[dict]]) -> list[dict]:
    """One section per scalar place to settle and per list part: a scalar read by one part only or read differently,
    never one read alike by several parts; every list with items."""
    sections: list[dict] = []
    for path, node in _places(nodes):
        name = ".".join(path)
        if node.type == "array":
            # Resolve assembled occurrences: overlap joins and reply coordinates already belong to assembly.
            items = list(enumerate(_at(root, path) or []))
            for start in range(0, len(items), LIST_CHUNK):
                part = items[start:start + LIST_CHUNK]
                labels = [f"I{number}" for number in range(1, len(part) + 1)]
                key = f"L{sum(section['kind'] == 'list' for section in sections) + 1}"
                lines = [f"{key} · {name} (items {start + 1}-{start + len(part)} of {len(items)})"]
                first: dict[str, str] = {}  # an equal item's first label in this part, named so a repeat is seen
                equal: dict[str, str] = {}  # each item's first equal label: items with the same one are equal
                for label, (index, item) in zip(labels, part):
                    same = equal[label] = first.setdefault(canonical(item), label)
                    sources = item_sources[(*path, index)]
                    lines.append(f"  {label} = {_shown(item, groups[sources[0]['unit']], whole=True)}"
                                 + (f" (same value as {same})" if same != label else ""))
                # Every item is labelled; only an item equal to another may be a repeat.
                reasons = {label: [OWN, OTHER, REPEAT] if list(equal.values()).count(equal[label]) > 1
                           else [OWN, OTHER] for label in labels}
                sections.append({"key": key, "kind": "list", "path": path, "start": start,
                                 "options": dict(zip(labels, (item for _, item in part))), "text": "\n".join(lines),
                                 "indices": dict(zip(labels, (index for index, _ in part))), "equal": equal,
                                 "schema": {"type": ["object", "null"], "additionalProperties": False,
                                            "properties": {label: {"type": "string", "enum": reasons[label]}
                                                           for label in labels}, "required": labels}})
            continue
        alternatives: dict[str, dict] = {}
        for index, reading in enumerate(readings):
            value = _at(reading, path)
            if value is not None:
                alternatives.setdefault(canonical(value), {"value": value, "readings": []})["readings"].append(index)
        found = list(alternatives.values())
        if not found or (len(found) == 1 and len(found[0]["readings"]) > 1):
            continue
        labels = [f"C{number}" for number in range(1, len(found) + 1)]
        key = f"S{sum(section['kind'] == 'scalar' for section in sections) + 1}"
        lines = [f"{key} · {name}"] + [f"  {label} = {_shown(alternative['value'], groups[alternative['readings'][0]])}"
                                       for label, alternative in zip(labels, found)]
        sections.append({"key": key, "kind": "scalar", "path": path,
                         "options": {label: alternative["value"] for label, alternative in zip(labels, found)},
                         "text": "\n".join(lines),
                         "schema": {"type": "string", "enum": [*labels, NONE, UNSURE]}})
    return sections


def _request(opening: str, sections: Sequence[dict]) -> tuple[str, dict, int]:
    """The user prompt, reply schema and reply reserve of one call over `sections`."""
    user = f"### Document opening\n{opening}\n\n### Places\n" + "\n\n".join(section["text"] for section in sections)
    schema = {"type": "object", "properties": {section["key"]: section["schema"] for section in sections},
              "required": [section["key"] for section in sections], "additionalProperties": False}
    reserve = 256 + sum(8 if section["kind"] == "scalar" else 10 * len(section["options"]) for section in sections)
    return user, schema, reserve


def resolve(readings: Sequence[dict], groups: Sequence[Context], root: dict, contested: list[dict],
            repeats: list[dict], joined: list[dict], schema: Schema, chat, counter: TokenCounter, *,
            item_sources: dict[tuple, list[dict]]) -> tuple[dict, list[dict], list[dict], list[dict], list[Call], list[Issue]]:
    """`root`, its remaining conflicts, repeats and overlap joins, the calls and the issues once each part's readings
    (`readings`, one per value context in `groups`, in source order) are resolved: sections are packed into as few
    reasoning calls as `counter`'s context fits, each call's labels settle its places, and a place left unsettled
    (UNSURE, a failed call, an answer outside its labels, a list part unsettled) keeps assembly's result.
    Kept list occurrences remap `item_sources` and overlap joins to their new positions, without matching by value."""
    nodes = schema.record_nodes
    sections = _sections(readings, groups, nodes, root, item_sources)
    if not sections:
        return root, contested, repeats, joined, [], []
    system = RESOLUTION.format(description=schema.record_description,
                               notes="".join(f"{line}\n" for line in notes(nodes)))
    opening = " ".join(text_of([p for group in groups for p in group.primary]).split())[:OPENING_CHARS]
    batches: list[list[dict]] = []
    for section in sections:
        trial = [*batches[-1], section] if batches else [section]
        user, reply_schema, reserve = _request(opening, trial)
        if batches and counter.request_tokens(system, user, reply_schema) + reserve <= counter.context_tokens:
            batches[-1] = trial
        else:
            batches.append([section])
    root, calls, issues = deepcopy(root), [], []
    settled: set[tuple[str, ...]] = set()
    kept: dict[tuple[str, ...], list | None] = {}  # a list place's kept items by part start; None once a part fails
    for batch in batches:
        user, reply_schema, reserve = _request(opening, batch)
        counted = counter.request_tokens(system, user, reply_schema)
        # A singleton can exceed the served context. Do not admit it into the durable planner:
        # retaining assembly is the same fallback as an unanswered resolution, with no provider call.
        if counted + reserve > counter.context_tokens:
            answer, attempts = None, []
            issues.append(Issue("resolution_exceeds_budget", "the resolution request does not fit; assembled values "
                                "are retained", 0))
        else:
            started = monotonic()
            try:
                answer, attempts = complete(chat, stage="arbitration", record=0, system=system, user=user,
                                            schema=reply_schema, counter=counter, max_tokens=reserve)
            except Exception as error:
                if getattr(chat, "runtime", None) is not None:
                    raise  # the durable worker commits provider failures (`invoke_capture`); persistence must halt
                # The failed call the durable worker commits for a raising provider: only the exception's type.
                answer, attempts = None, [Call("arbitration", 0, None, None, monotonic() - started, None, False,
                                               f"provider call raised {type(error).__name__}", counted,
                                               counter.context_tokens, reserve)]
        if attempts and not attempts[-1].ok:
            # Resolution is optional: a failed reply retains all assembled values and disagreements.
            answer = None
            attempts = [replace(call, recovered=True) if not call.ok else call for call in attempts]
            issues.append(Issue("resolution_failed", "the resolution reply failed; assembled values are retained", 0))
        calls += attempts
        answer = answer if isinstance(answer, dict) else {}
        for section in batch:
            choice, path = answer.get(section["key"]), section["path"]
            if section["kind"] == "list":
                parts = kept.setdefault(path, [])
                reasons = section["schema"]["properties"]
                if (parts is None or not isinstance(choice, dict) or set(choice) != set(reasons)
                        or any(reason not in reasons[label]["enum"] for label, reason in choice.items())):
                    kept[path] = None
                    continue
                # A repeat is left out only beside an equal item labelled own: equal items all repeats are kept.
                staying = {section["equal"][label] for label, reason in choice.items() if reason == OWN}
                gone = {label for label, reason in choice.items()
                        if reason == OTHER or (reason == REPEAT and section["equal"][label] in staying)}
                parts.append((section["start"],
                              [item for label, item in section["options"].items() if label not in gone],
                              [item for label, item in section["options"].items() if label in gone],
                              [index for label, index in section["indices"].items() if label not in gone]))
            elif isinstance(choice, str) and (choice in section["options"] or choice == NONE):
                value = section["options"].get(choice)
                _put(root, path, value)
                settled.add(path)
                issues.append(Issue("resolved_value", json.dumps(
                    {"path": list(path), "chosen": value, "alternatives": list(section["options"].values())},
                    ensure_ascii=False), 0, ("records", 0, *path)))
    for path, parts in kept.items():
        if parts is None:
            continue
        parts.sort(key=lambda part: part[0])
        dropped = [item for _, _, gone, _ in parts for item in gone]
        positions = [index for _, _, _, indices in parts for index in indices]
        sources = {index: item_sources.pop((*path, index)) for index in range(len(_at(root, path) or []))}
        item_sources.update({(*path, index): sources[original] for index, original in enumerate(positions)})
        moved = {original: index for index, original in enumerate(positions)}
        joined = [({**join, "index": moved[join["index"]]} if tuple(join["path"]) == path else join)
                  for join in joined if tuple(join["path"]) != path or join["index"] in moved]
        # A repeat whose kept copies were shown in one part is resolved; copies kept in several parts never met.
        left = []
        for repeat in repeats:
            if tuple(repeat["path"]) != path:
                left.append(repeat)
                continue
            indices = [moved[index] for index in repeat["indices"] if index in moved]
            contexts = sorted({item_sources[(*path, index)][0]["unit"] for index in indices})
            if len(contexts) > 1 and len({index // LIST_CHUNK for index in repeat["indices"] if index in moved}) > 1:
                left.append({**repeat, "contexts": contexts, "indices": indices})
        repeats = left
        _put(root, path, [item for _, items, _, _ in parts for item in items])
        if dropped:
            issues.append(Issue("dropped_items", json.dumps({"path": list(path), "dropped": dropped},
                                                            ensure_ascii=False), 0, ("records", 0, *path)))
    contested = [conflict for conflict in contested if tuple(conflict["path"]) not in settled]
    return root, contested, repeats, joined, calls, issues
