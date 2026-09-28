"""The recipe Catalog's result shaping: how checked outcomes become the artifact's records, evidence links and review
items.

An accepted outcome's value is placed into its record at its path, and the record is conformed to the schema. Its
evidence link names the segment, page and box of its first span (the table cell instead, when every span lies in one
cell and the value has no alternative place), its raw source text and, when that text is a glossary key, the
expansion the glossary prints for it beside the raw value (`NORMALIZATION_VERSION`). A proposed or rejected outcome
becomes a review item with its quote, spans and reason. Nothing here calls a model.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from kei_exp.kie.blocks import GlossaryEntry, Span
from kei_exp.kie.extract.acceptance import Outcome
from kei_exp.kie.extract.schema import Schema, conform

NORMALIZATION_VERSION = 1        # verified glossary expansions beside accepted raw values; a change invalidates results


def place(record: dict, path: tuple, value: Any) -> None:
    """Sets `value` at `path` inside `record`, creating the objects and list slots on the way."""
    target: Any = record
    for step, following in zip(path, (*path[1:], None), strict=True):
        if following is None:
            if isinstance(target, list):
                target.extend([None] * (step + 1 - len(target)))
            target[step] = value
            return
        container = [] if isinstance(following, int) else {}
        if isinstance(target, list):
            target.extend([None] * (step + 1 - len(target)))
            target[step] = target[step] if target[step] is not None else container
        else:
            target.setdefault(step, container)
        target = target[step]


def conformed_record(schema: Schema, record: dict) -> dict:
    """The record restricted to the schema's record fields, every absent field null."""
    return conform(record, schema.record_nodes)


def spans_json(spans: list[Span]) -> list[dict]:
    """Spans as the artifact writes them."""
    return [{"segment": span.segment_id, "start": span.start, "end": span.end} for span in spans]


def _raw(spans: list[Span], texts: dict) -> str:
    return "".join(texts[span.segment_id].text[span.start:span.end] for span in spans)


def glossary_expansions(glossary: Sequence[GlossaryEntry]) -> dict[str, GlossaryEntry]:
    """The document's glossary by key without its closing period, since `G.` may be quoted as `G`; a key that the
    period's removal makes expand two ways is dropped, as the segmentation drops a key printed twice."""
    found: dict[str, list[GlossaryEntry]] = {}
    for entry in glossary:
        found.setdefault(entry.key.rstrip("."), []).append(entry)
    return {key: entries[0] for key, entries in found.items() if key and len({e.expansion for e in entries}) == 1}


def _normalized(outcome: Outcome, texts: dict, expansions: dict[str, GlossaryEntry]) -> dict | None:
    """An accepted string whose source text is a glossary key, expanded as the glossary prints it; the record keeps
    the raw value, and both glossary spans are the expansion's evidence."""
    if not isinstance(outcome.value, str):
        return None
    entry = expansions.get(_raw(outcome.spans, texts).rstrip("."))
    if entry is None:
        return None
    return {"value": entry.expansion, "rule": "glossary", "key_span": spans_json([entry.key_span])[0],
            "expansion_span": spans_json([entry.expansion_span])[0]}


def evidence_link(outcome: Outcome, texts: dict, expansions: dict[str, GlossaryEntry]) -> dict:
    """The artifact's `evidence` entry for an accepted outcome; `texts` maps segment IDs to passages."""
    first = texts[outcome.spans[0].segment_id]
    cells = [cell for cell in first.table.cells if cell.bbox_pt is not None
             and all(span.segment_id == first.id and cell.start <= span.start < span.end <= cell.end
                     for span in outcome.spans)] if first.table and not outcome.alternatives else []
    cell = cells[0] if len(cells) == 1 else None
    return {"path": list(outcome.path), "segment": first.id, "page": first.page,
            "bbox_pt": list(cell.bbox_pt if cell else first.bbox_pt), "cell": cell.cell_id if cell else None,
            "verbatim": True, "hits": 1 + len(outcome.alternatives), "linked_by": outcome.linked_by,
            "spans": spans_json(outcome.spans), "alternatives": [spans_json(spans) for spans in outcome.alternatives],
            "provenance": outcome.provenance, "key_spans": spans_json(outcome.key_spans), "heading": outcome.heading,
            "precision": "cell" if cell else first.precision, "raw": _raw(outcome.spans, texts),
            "normalized": _normalized(outcome, texts, expansions)}


def review_item(outcome: Outcome, texts: dict) -> dict:
    """The artifact's `proposed` or `rejected` entry for an outcome."""
    item = {"path": list(outcome.path), "value": outcome.value, "quote": outcome.quote, "key": outcome.key,
            "provenance": outcome.provenance, "spans": spans_json(outcome.spans),
            "alternatives": [spans_json(spans) for spans in outcome.alternatives], "window": outcome.window}
    if outcome.reason is not None:
        item["reason"] = outcome.reason
    if outcome.spans:
        item["raw"] = _raw(outcome.spans, texts)
    return item
