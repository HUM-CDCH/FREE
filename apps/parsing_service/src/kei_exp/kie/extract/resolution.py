"""Article resolution: the document's own values among the readings of its separately read parts.

A value context read on its own answers the whole root from what it alone shows, so a part without the document's
own value may return another one: a cited work's year, a section heading as the title, a running header's author
name or page number. Once a split source's contexts answered, `resolve` shows the reasoning model the document's
opening and every place's readings, each
with the pages and source text it was read from, and asks which reading is the document's own value (a candidate,
NONE when none is, UNSURE when the source does not settle it) and, for every list item, first the work or entity its
source gives it to, as printed (`of`), then whether it is the document's own, another work's or entity's (or a group's
summary given to one item), a repeat, or UNSURE. A chosen or NONE place replaces assembly's null-on-conflict; UNSURE
keeps the Value Disagreement. A list keeps every item not labelled another's or a repeat, in reading order. An item
labelled another's leaves only when its `of` is printed in the part it was read from (one that reached its length
limit: up to its last word, which may be cut): a bare label is a weak, order-dependent call that once emptied a
paper's own list, so without that attribution the item stays and, like an UNSURE one, is named for review
(`uncertain_items`). A repeat is only an item equal to one labelled own or another's beside it (a repeat of another
work's item is that work's too), or a string printed again shortened or differently cased after exactly one such
earlier item (`_form_of`: a running header's "A. LOVELACE" after the byline's "Ada B. Lovelace"), so a second reading
of an own item that differs from it otherwise is never one. An answer that leaves an item unlabelled changes nothing.
A long list is shown in parts that each fit one request; equal items, or a form and its earlier item, in different
list parts were never compared, so only an equal item's possible repeat stays named. A call that fails or answers
outside its labels changes nothing.
"""
from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Callable, Sequence
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
# shortcut: a list part holds at most this many items, and fewer when they do not fit one request, so an item
# repeating one in another part is kept and stays named as a possible repeat; resolve across parts (a second pass over
# the kept items) when long lists show them.
LIST_CHUNK = 60
SNIPPET = 160  # characters of source shown on each side of a reading: enough to show a citation beside a value
OF_CHARS = 100  # an item's `of`: a citation, reference or name, copied as printed
PRINTED = 3  # places shown of a value printed several times in its part
VALUE_CHARS = 200
OPENING_CHARS = 1500  # the document's opening, shown so the model knows which document is its own
# Not inside a longer word or number: 10 is not printed in 210, 10.5 or 1,100.
START, END = r"(?<!\w)(?<!\d[.,])", r"(?!\w|[.,]\d)"
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
    "(L...), label every item. OWN: an item of the document's own list, also when it was read only in part (another "
    "part read its other values, or only its method or conditions). OTHER: an item the source gives as another work's "
    "or entity's (a work the document cites, a reference, another document), or whose values the source gives to a "
    "group, not to the item (an average, range or total over several items). UNSURE: the source shown does not settle "
    "whether the item is the document's own; it is kept and marked for review. Answer each item as {{\"of\": ..., "
    "\"label\": ...}}: first `of`, the work, entity or group its source shown gives the item or its values to, as the "
    "shortest excerpt that names it (a citation, a reference's number and first author, another document's name, the "
    "group a summary is of), copied exactly as printed "
    "there, or \"\" when that source names none; then its label. "
    "An item labelled OTHER leaves only when its `of` is printed in its source shown; otherwise it is kept and marked "
    "for review. REPEAT, offered only for an item marked 'same value as' or 'a form of': the same thing printed again "
    "(a running header or footer, a repeated byline, a name shortened in a running header), and only when its source "
    "shows the same thing again; equal values that "
    "describe different things are separate items: label each OWN. A value printed several times is shown at each "
    "place, since which one a reading read is not known; when those places do not show that equal items are the same "
    "thing, label each OWN. Two readings of one of the document's own things that differ, or where one has values "
    "the other lacks, are both OWN, unless one is marked 'a form of' the other and its source only prints it again. "
    "Each item is shown whole, with the source around its value printed the fewest "
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


def _printed(needle: str, text: str, *, cut: bool = False) -> list[int]:
    """Where `needle` is printed in `text` as a whole word or number; `cut`, its last word may be a printed word's
    first letters (bac of backbone, never of bac123)."""
    # A value printed digits first is a number; a word keeps only the whole-word rule, so Smith is in Jones-Smith.
    pattern = ((NUMBER_START if needle[0].isdigit() else "") + START + re.escape(needle)
               + (r"(\w*)" if cut else "") + END)
    return [match.start() for match in re.finditer(pattern, text, re.IGNORECASE)
            if not cut or not match[1] or match[1].isalpha()]


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


def _spaced(text: str) -> str:
    """`text` with single spaces and none before a closing or after an opening mark: "172 , 836" reads "172, 836"."""
    return re.sub(r"([(\[])\s+", r"\1", re.sub(r"\s+([,.;:)\]])", r"\1", " ".join(text.split())))


def _attributed(of: str, context: Context) -> bool:
    """Whether `of` is printed in the part `context` an item was read from, as whole words, ignoring case and spacing:
    an item is another work's only where the source it came from names that work. An `of` that reached `OF_CHARS` may
    end in a word cut short, a sentence mark after it: then all but that mark is printed, its last word as a printed
    word's first letters ("…the backbone," of "…the backbone of"). Only a word of letters: a number, reference or
    identifier ending it ("[19]" of "[190]", "[Smith AB]" of "[Smith ABC]", "x_foo" of "x_foobar") is whole.
    """
    spaced, text = _spaced(of), _spaced(text_of(context.passages))
    if len(spaced) > 1 and _printed(spaced, text):
        return True
    cut = spaced.rstrip(",.;:")
    return (len(of) == OF_CHARS and len(cut) > 1 and cut.rsplit(" ", 1)[-1].isalpha()
            and bool(_printed(cut, text, cut=True)))


def _words(text: str) -> list[str]:
    """A string's words, accents, case and punctuation aside: "Zoë B. SMITH" is zoe, b, smith."""
    return re.findall(r"\w+", "".join(c for c in unicodedata.normalize("NFKD", text)
                                       if not unicodedata.combining(c)).casefold())


def _shortens(word: str, other: str) -> bool:
    """Whether `word` is `other` or its initial."""
    return word == other or len(word) == 1 and word.isalpha() and other.startswith(word)


def _form_of(item: Any, earlier: Any) -> bool:
    """Whether string `item` may be `earlier` printed again differently: the same words, or `earlier` shortened, its
    last word kept, perhaps moved first, its first word kept or cut to its initial, later ones kept, cut or left out in
    order, and at least one cut ("A. LOVELACE" or "Lovelace A" of "Ada B. Lovelace"; not "B. Lovelace", "A. C.
    Lovelace" or "Lovelace", nor "type I collagen" of "type I fish collagen"). Never the other way: a full name is no
    form of its initials, nor a name already given only by initials one with fewer ("A. Lovelace" of "A. B.
    Lovelace"), and a last word is letters."""
    if not isinstance(item, str) or not isinstance(earlier, str) or item == earlier:
        return False
    short, full = _words(item), _words(earlier)
    if short == full or len(short) < 2 or len(full) < 2:
        return bool(short) and short == full
    for first, *middle, last in (short, short[1:] + short[:1]):
        if last != full[-1] or len(last) < 2 or not last.isalpha() or not _shortens(first, full[0]):
            continue
        rest, cut = iter(full[1:-1]), first != full[0]
        for word in middle:
            other = next((other for other in rest if _shortens(word, other)), None)
            if other is None:
                break
            cut = cut or other != word
        else:
            if cut:
                return True
    return False


def _list_part(key: str, name: str, path: tuple[str, ...], items: Sequence[tuple[int, Any]], start: int, size: int,
               groups: Sequence[Context], item_sources: dict[tuple, list[dict]]) -> dict:
    """The section of `size` list items from `start`: each item shown and labelled, an equal one named."""
    part = items[start:start + size]
    labels = [f"I{number}" for number in range(1, len(part) + 1)]
    lines = [f"{key} · {name} (items {start + 1}-{start + len(part)} of {len(items)})"]
    first: dict[str, str] = {}  # an equal item's first label in this part, named so a repeat is seen
    equal: dict[str, str] = {}  # each item's first equal label: items with the same one are equal
    forms: dict[str, str] = {}  # an item that is a form of one earlier value (`_form_of`): that value's first label
    options = dict(zip(labels, (item for _, item in part)))
    for label, (index, item) in zip(labels, part):
        # A form of several earlier values does not say which one it repeats.
        earlier = {same for same in first.values() if _form_of(item, options[same])}
        if len(earlier) == 1:
            forms[label] = earlier.pop()
        same = equal[label] = first.setdefault(canonical(item), label)
        sources = item_sources[(*path, index)]
        lines.append(f"  {label} = {_shown(item, groups[sources[0]['unit']], whole=True)}"
                     + (f" (same value as {same})" if same != label else "")
                     + (f" (a form of {forms[label]})" if label in forms else ""))
    # Every item is answered, its attribution before its label; only an item equal to another, or a form of an earlier
    # one, may be a repeat. UNSURE is an item's abstention, so the list has none of its own.
    reasons = {label: [OWN, OTHER, UNSURE, REPEAT] if list(equal.values()).count(equal[label]) > 1 or label in forms
               else [OWN, OTHER, UNSURE] for label in labels}
    return {"key": key, "kind": "list", "path": path, "start": start,
            "options": options, "text": "\n".join(lines),
            "indices": dict(zip(labels, (index for index, _ in part))), "equal": equal, "forms": forms,
            "units": {label: item_sources[(*path, index)][0]["unit"] for label, (index, _) in zip(labels, part)},
            "schema": {"type": "object", "additionalProperties": False,
                       "properties": {label: {"type": "object", "additionalProperties": False,
                                              "properties": {"of": {"type": "string", "maxLength": OF_CHARS},
                                                             "label": {"type": "string", "enum": reasons[label]}},
                                              "required": ["of", "label"]} for label in labels},
                       "required": labels}}


def _sections(readings: Sequence[dict], groups: Sequence[Context], nodes: Sequence[Node], root: dict,
              item_sources: dict[tuple, list[dict]], fits: Callable[[dict], bool]) -> list[dict]:
    """One section per scalar place to settle and per list part: a scalar read by one part only or read differently,
    never one read alike by several parts; every list with items, in parts of at most `LIST_CHUNK` items that each
    `fits` one request alone. When not even one item fits, the part stays whole and its list keeps assembly."""
    sections: list[dict] = []
    for path, node in _places(nodes):
        name = ".".join(path)
        if node.type == "array":
            # Resolve assembled occurrences: overlap joins and reply coordinates already belong to assembly.
            items = list(enumerate(_at(root, path) or []))
            start = 0
            while start < len(items):
                key = f"L{sum(section['kind'] == 'list' for section in sections) + 1}"
                size = min(LIST_CHUNK, len(items) - start)
                section = _list_part(key, name, path, items, start, size, groups, item_sources)
                if size > 1 and not fits(section):
                    # Whole items made the part too long: the most items that fit, found by halving.
                    fitting, over = 0, size
                    while over - fitting > 1:
                        middle = (fitting + over) // 2
                        trial = _list_part(key, name, path, items, start, middle, groups, item_sources)
                        fitting, over = (middle, over) if fits(trial) else (fitting, middle)
                    if fitting:
                        section = _list_part(key, name, path, items, start, fitting, groups, item_sources)
                sections.append(section)
                start += len(section["options"])
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
              "required": [section["key"] for section in sections], "additionalProperties": False,
              "x-free-hidden": True}  # RESOLUTION states the reply's shape: constrained, not shown
    # A list item's answer: its label and, at most, a copied `of` of one token per two characters.
    reserve = 256 + sum(8 if section["kind"] == "scalar" else (16 + OF_CHARS // 2) * len(section["options"])
                        for section in sections)
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
    system = RESOLUTION.format(description=schema.record_description,
                               notes="".join(f"{line}\n" for line in notes(nodes)))
    opening = " ".join(text_of([p for group in groups for p in group.primary]).split())[:OPENING_CHARS]

    def fits(section: dict) -> bool:
        user, reply_schema, reserve = _request(opening, [section])
        return counter.request_tokens(system, user, reply_schema) + reserve <= counter.context_tokens

    sections = _sections(readings, groups, nodes, root, item_sources, fits)
    if not sections:
        return root, contested, repeats, joined, [], []
    # Each original list index's part, so a repeat whose copies stayed in different parts stays named.
    part_of = {(section["path"], index): section["start"] for section in sections if section["kind"] == "list"
               for index in section["indices"].values()}
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
                        or any(not isinstance(each, dict) or set(each) != {"of", "label"}
                               or not isinstance(each["of"], str)
                               or each["label"] not in reasons[label]["properties"]["label"]["enum"]
                               for label, each in choice.items())):
                    if parts is not None and attempts and attempts[-1].ok:
                        issues.append(Issue("resolution_not_applied", json.dumps(
                            {"path": list(path), "reason": "invalid_list_reply"}, ensure_ascii=False),
                            0, ("records", 0, *path)))
                    kept[path] = None
                    continue
                # Another's item leaves only where the part it was read from prints the work it was given to.
                left_out = {label for label, each in choice.items() if each["label"] == OTHER
                            and _attributed(each["of"], groups[section["units"][label]])}
                # A repeat is left out beside an equal item, or the earlier one it is a form of, labelled own (that copy
                # stays) or another's (the repeat of another work's item is that work's too): equal items all repeats
                # or UNSURE are kept, since UNSURE settles no copy for a repeat to be.
                anchored = {section["equal"][label] for label, each in choice.items() if each["label"] in (OWN, OTHER)}
                gone = left_out | {label for label, each in choice.items() if each["label"] == REPEAT
                                   and {section["equal"][label], section["forms"].get(label)} & anchored}
                doubted = [(section["indices"][label], each) for label, each in choice.items()
                           if each["label"] == UNSURE or (each["label"] == OTHER and label not in gone)]
                parts.append((section["start"],
                              [item for label, item in section["options"].items() if label not in gone],
                              [(item, choice[label]["of"]) for label, item in section["options"].items()
                               if label in gone],
                              [index for label, index in section["indices"].items() if label not in gone],
                              doubted))
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
        dropped = [each for _, _, gone, _, _ in parts for each in gone]
        positions = [index for _, _, _, indices, _ in parts for index in indices]
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
            if len(contexts) > 1 and len({part_of[(path, index)] for index in repeat["indices"] if index in moved}) > 1:
                left.append({**repeat, "contexts": contexts, "indices": indices})
        repeats = left
        _put(root, path, [item for _, items, _, _, _ in parts for item in items])
        if dropped:
            issues.append(Issue("dropped_items", json.dumps(
                {"path": list(path), "dropped": [item for item, _ in dropped], "of": [of for _, of in dropped]},
                ensure_ascii=False), 0, ("records", 0, *path)))
        if doubted := [{"index": moved[index], **each} for *_, doubts in parts for index, each in doubts]:
            # Kept: the source did not settle the item (UNSURE), or it was called another's without printing whose.
            issues.append(Issue("uncertain_items", json.dumps({"path": list(path), "items": doubted},
                                                              ensure_ascii=False), 0, ("records", 0, *path)))
    contested = [conflict for conflict in contested if tuple(conflict["path"]) not in settled]
    return root, contested, repeats, joined, calls, issues
