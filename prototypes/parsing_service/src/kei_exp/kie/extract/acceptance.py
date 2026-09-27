"""Candidate acceptance for the recipe Catalog: whether a candidate the model read off an entry is accepted, proposed or
rejected.

A candidate is `{value, quote, key, provenance}`, and code, never the model, decides what becomes of it. The value
must conform to its field (`typed_value`); the quote must be text of the entry, and the value must be readable off
the quote; and the field must be tied to the value by an explicit rule, here a recipe key that introduces the value
in the entry itself, at most `KEY_GAP` non-alphanumeric characters before it. Such a value is accepted. A
quote-supported value without a key rule is proposed for review, and so is a yes/no, which is read off its quote and
never off a span; a failed check is rejected with its reason. Candidates are checked against the whole entry (a
`BlockText`), never against the window a call saw. `candidates_schema` is the reply schema that asks for exactly
these candidates, and `bounded` finds a key where it stands as a whole token.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from kei_exp.kie.blocks import Span
from kei_exp.kie.extract.locate import BlockText, forms, locate, normalise, raw_range
from kei_exp.kie.extract.schema import Node, json_schema

KEY_GAP = 3                      # at most this many non-alphanumeric characters between a key and its value


@dataclass
class Outcome:
    """What became of one value: a candidate's verdict, or a structural value from the label or a heading."""
    kind: str                                    # accepted | proposed | rejected
    path: tuple
    value: Any
    spans: list[Span] = field(default_factory=list)
    alternatives: list[list[Span]] = field(default_factory=list)
    key_spans: list[Span] = field(default_factory=list)
    reason: str | None = None
    quote: str | None = None
    key: str | None = None
    provenance: str | None = None
    linked_by: str | None = None
    heading: str | None = None
    window: int = 0


def bounded(key: str, text: str) -> list[int]:
    """The start offsets, in normalised `text`, where normalised `key` occurs as a token of its own."""
    hay, needle = normalise(text).text, normalise(key).text
    return [m.start() for m in re.finditer(re.escape(needle), hay)
            if (m.start() == 0 or not hay[m.start() - 1].isalnum())
            and (m.end() == len(hay) or not hay[m.end()].isalnum() or not needle[-1].isalnum())]


def candidates_schema(nodes: Sequence[Node]) -> dict:
    """The reply schema of an entry call: one candidate, or null, for every field in `nodes`."""
    return {"type": "object", "properties": {node.name: candidate_schema(node) for node in nodes},
            "required": [node.name for node in nodes], "additionalProperties": False}


def _leaf(node: Node) -> dict:
    value = json_schema([node])["properties"][node.name]
    return {"type": ["object", "null"], "properties": {
        "value": value, "quote": {"type": "string"}, "key": {"type": ["string", "null"]},
        "provenance": {"type": "string", "enum": ["token", "positional"]}},
        "required": ["value", "quote", "key", "provenance"], "additionalProperties": False}


def candidate_schema(node: Node) -> dict:
    """One field's candidate schema: `{value, quote, key, provenance}` at every scalar leaf."""
    if node.type == "array" and node.item_type is not None:
        item = Node(id=f"{node.id}-item", name=node.name, type=node.item_type)
        return {"type": ["array", "null"], "items": _leaf(item)}
    if node.type == "array":
        return {"type": ["array", "null"], "items": candidates_schema(node.children or [])}
    if node.type == "object":
        return {**candidates_schema(node.children or []), "type": ["object", "null"]}
    return _leaf(node)


def typed_value(value: Any, node: Node) -> Any:
    """The value conformed to its field's type, or None when it cannot be."""
    kind = node.type if node.type != "array" else node.item_type
    if kind == "boolean" or isinstance(value, bool) or value is None:
        return value if kind == "boolean" and isinstance(value, bool) else None
    if kind == "integer":
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return int(value) if isinstance(value, str) and value.strip().isdigit() else None
    if kind == "number":
        if isinstance(value, (int, float)):
            return value
        try:
            return float(str(value).replace(",", "."))
        except ValueError:
            return None
    text = str(value).strip() if isinstance(value, (str, int, float)) else ""
    if not text:
        return None
    if node.allowed_values is not None and text not in node.allowed_values:
        return None
    return text


def assess(path: tuple, node: Node, answer: Any, view: BlockText, keys: list[str] | None, *,
           verify: bool = True) -> list[Outcome]:
    """The outcome of every candidate a reply gives for `node` at `path`, checked against the entry `view`; `keys`
    are the field's recipe keys (top-level scalars only). Without `verify`, a well-typed value is only proposed."""
    if answer is None:
        return []
    if node.type == "object":
        if not isinstance(answer, dict):
            return [Outcome("rejected", path, answer, reason="malformed_candidate")]
        return [outcome for child in node.children or []
                for outcome in assess((*path, child.name), child, answer.get(child.name), view, None, verify=verify)]
    if node.type == "array":
        if not isinstance(answer, list):
            return [Outcome("rejected", path, answer, reason="malformed_candidate")]
        if node.item_type is not None:
            item = Node(id=f"{node.id}-item", name=node.name, type=node.item_type)
            return [outcome for index, entry in enumerate(answer)
                    for outcome in assess((*path, index), item, entry, view, None, verify=verify)]
        child = Node(id=f"{node.id}-object", name=node.name, type="object", children=node.children)
        return [outcome for index, entry in enumerate(answer)
                for outcome in assess((*path, index), child, entry, view, None, verify=verify)]
    return [_scalar(path, node, answer, view, keys, verify=verify)]


def _scalar(path: tuple, node: Node, candidate: Any, view: BlockText, keys: list[str] | None, *,
            verify: bool = True) -> Outcome:
    if not isinstance(candidate, dict):
        return Outcome("rejected", path, candidate, reason="malformed_candidate")
    value, quote, key, provenance = (candidate.get(name) for name in ("value", "quote", "key", "provenance"))
    outcome = Outcome("rejected", path, value, quote=quote if isinstance(quote, str) else None,
                      key=key if isinstance(key, str) else None,
                      provenance=provenance if provenance in ("token", "positional") else None)
    typed = typed_value(value, node)
    if typed is None:
        outcome.reason = "type_mismatch"
        return outcome
    outcome.value = typed
    if not verify:
        outcome.kind, outcome.reason = "proposed", "verification_disabled"
        return outcome
    if not isinstance(quote, str) or not quote.strip():
        outcome.reason = "no_quote"
        return outcome
    quoted = locate(view, quote)
    if not quoted:
        outcome.reason = "quote_not_in_entry"
        return outcome
    if isinstance(typed, bool):  # a yes/no is read off its quote, never off a span, and no rule ties it to a field
        outcome.kind, outcome.spans, outcome.alternatives = "proposed", quoted[0], quoted[1:]
        return outcome
    numeric = isinstance(typed, (int, float))
    values = [found for spans in quoted for text in forms(typed)
              for found in locate(view, text, within=raw_range(view, spans), numeric=numeric)]
    if not values:
        outcome.reason = "value_not_in_quote"
        return outcome
    if keys:
        keyed = _after_keys(view, typed, keys)
        if not keyed:
            outcome.reason, outcome.spans = "key_context_missing", values[0]
            return outcome
        outcome.kind, outcome.linked_by, outcome.provenance = "accepted", "key", "token"  # a key introduces it
        outcome.spans, outcome.key_spans = keyed[0]
        outcome.alternatives = [spans for spans, _ in keyed[1:]]
        return outcome
    outcome.kind, outcome.spans, outcome.alternatives = "proposed", values[0], values[1:]
    return outcome


def _after_keys(view: BlockText, value: Any, keys: list[str]) -> list[tuple[list[Span], list[Span]]]:
    """Every place where one of the field's keys introduces the value, found in the entry itself rather than taken
    from the model's quote: (value spans, key spans)."""
    found = []
    for key in keys:
        for key_spans in locate(view, key):
            _, key_end = raw_range(view, key_spans)
            numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
            for text in forms(value):
                for spans in locate(view, text, within=(key_end, min(len(view.text), key_end + len(text) + KEY_GAP)),
                                    numeric=numeric):
                    start, _ = raw_range(view, spans)
                    if not any(char.isalnum() for char in view.text[key_end:start]):
                        found.append((spans, key_spans))
    return found
