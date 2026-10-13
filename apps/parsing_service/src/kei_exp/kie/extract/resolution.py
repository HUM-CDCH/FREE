"""Article resolution: the document's own values among the readings of its separately read parts.

A value context read on its own answers the whole root from what it alone shows, so a part without the document's
own value may return another one: a cited work's year, a section heading as the title, a running header's author
name or page number. Once a split source's contexts answered, `resolve` shows the reasoning model the document's
opening and every place's readings, each
with the pages and source text it was read from, and asks which reading is the document's own value (a candidate,
NONE when none is, UNSURE when the source does not settle it) and which list items belong to the document's own list.
A chosen or NONE place replaces assembly's null-on-conflict; UNSURE keeps the Value Disagreement. A list keeps the
items the model kept, in reading order. A call that fails or answers outside its labels changes nothing.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import replace
from typing import Any

from kei_exp.kie.extract.calls import Call, complete
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.durable import canonical
from kei_exp.kie.extract.schema import Node, Schema, notes
from kei_exp.kie.extract.stages import Issue
from kei_exp.kie.extract.tokens import TokenCounter
from kei_exp.kie.passages import text_of

NONE, UNSURE = "NONE", "UNSURE"
# shortcut: a list longer than this is resolved in parts, so an item repeating one in another part is kept; resolve
# across parts (a second pass over the kept items) when long lists show cross-part repeats.
LIST_CHUNK = 60
SNIPPET = 70  # characters of source shown on each side of a reading
VALUE_CHARS = 200
OPENING_CHARS = 1500  # the document's opening, shown so the model knows which document is its own
RESOLUTION = (
    "Several parts of one document were each read on their own for the document's one record, so a part may have "
    "answered with a value that is not the document's own: a value of a work the document cites, a section heading, "
    "a running page header or page number, or another entity's value. The document's opening shows which document "
    "it is. A record is: {description}\n{notes}"
    "For each single-value place (S...), choose the label of the candidate that is the document's own value; answer "
    "NONE when no candidate is (a value only a cited work, a heading or another entity has is never the document's "
    "own, even when it is the only candidate; when the opening states the document's own value and no candidate is "
    "it, answer NONE), or UNSURE when the source does not settle it. For each list place "
    "(L...), return the labels of the items that belong to the document's own list: leave out an item of another work "
    "or entity, and an item that is the same thing printed again (a running header or footer, a repeated byline). An "
    "item marked 'same value as' is such a repeat only when its source shows the same thing again; equal values that "
    "describe different things are separate items: keep each. Return only the JSON object.")


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


def _needle(value: Any) -> str | None:
    """The text a reading's value is printed as: the value, or an item's first non-blank string."""
    if isinstance(value, dict):
        return next((found for item in value.values() if (found := _needle(item))), None)
    if isinstance(value, list):
        return next((found for item in value if (found := _needle(item))), None)
    return " ".join(str(value).split()) or None if value is not None else None


def _shown(value: Any, context: Context) -> str:
    """A reading as the model sees it: the value, its pages and the source around it ('' when not printed verbatim)."""
    pages = sorted({passage.page for passage in context.primary or context.passages})
    where = f"page {pages[0]}" if len(pages) == 1 else f"pages {pages[0]}-{pages[-1]}" if pages else "no page"
    text = " ".join(text_of(context.passages).split())
    needle = _needle(value)
    at = text.lower().find(needle.lower()) if needle else -1
    around = f": …{text[max(0, at - SNIPPET):at + len(needle) + SNIPPET]}…" if at >= 0 else " (not printed verbatim)"
    return f"{json.dumps(value, ensure_ascii=False)[:VALUE_CHARS]} — {where}{around}"


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
                for label, (index, item) in zip(labels, part):
                    same = first.setdefault(canonical(item), label)
                    sources = item_sources[(*path, index)]
                    lines.append(f"  {label} = {_shown(item, groups[sources[0]['unit']])}"
                                 + (f" (same value as {same})" if same != label else ""))
                sections.append({"key": key, "kind": "list", "path": path, "start": start,
                                 "options": dict(zip(labels, (item for _, item in part))), "text": "\n".join(lines),
                                 "indices": dict(zip(labels, (index for index, _ in part))),
                                 "schema": {"type": "array", "items": {"type": "string", "enum": labels}}})
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
    reserve = 256 + sum(8 if section["kind"] == "scalar" else 6 * len(section["options"]) for section in sections)
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
        # A singleton can exceed the served context. Do not admit it into the durable planner:
        # retaining assembly is the same fallback as an unanswered resolution, with no provider call.
        if counter.request_tokens(system, user, reply_schema) + reserve > counter.context_tokens:
            answer, attempts = None, []
            issues.append(Issue("resolution_exceeds_budget", "the resolution request does not fit; assembled values "
                                "are retained", 0))
        else:
            answer, attempts = complete(chat, stage="arbitration", record=0, system=system, user=user,
                                        schema=reply_schema, counter=counter, max_tokens=reserve)
        if attempts and not attempts[-1].ok:
            # Resolution is optional: a failed reply retains all assembled values and disagreements.
            attempts = [replace(call, recovered=True) if not call.ok else call for call in attempts]
            issues.append(Issue("resolution_failed", "the resolution reply failed; assembled values are retained", 0))
        calls += attempts
        answer = answer if isinstance(answer, dict) else {}
        for section in batch:
            choice, path = answer.get(section["key"]), section["path"]
            if section["kind"] == "list":
                parts = kept.setdefault(path, [])
                if (parts is None or not isinstance(choice, list)
                        or any(not isinstance(label, str) or label not in section["options"] for label in choice)):
                    kept[path] = None
                    continue
                parts.append((section["start"], [item for label, item in section["options"].items() if label in choice],
                              [item for label, item in section["options"].items() if label not in choice],
                              [index for label, index in section["indices"].items() if label in choice]))
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
        _put(root, path, [item for _, items, _, _ in parts for item in items])
        settled.add(path)
        if dropped:
            issues.append(Issue("dropped_items", json.dumps({"path": list(path), "dropped": dropped},
                                                            ensure_ascii=False), 0, ("records", 0, *path)))
    contested = [conflict for conflict in contested if tuple(conflict["path"]) not in settled]
    repeats = [repeat for repeat in repeats if tuple(repeat["path"]) not in settled]
    return root, contested, repeats, joined, calls, issues
