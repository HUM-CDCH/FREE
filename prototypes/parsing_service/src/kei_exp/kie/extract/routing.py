"""Origin and lexical ordering of whole source units, followed by unresolved fallback.

Origins record where a returned value came from, not where it is true. The shared
verifier still makes every support decision and retains complete table context.
"""
from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Sequence

from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.schema import Schema, describe
from kei_exp.kie.extract.stages import contains, leaves

# 2: the relevance query holds the claim's enclosing object's other values.
VERSION = 2


def value_origins(candidates: Sequence[dict], merged: dict, identity: dict,
                  identity_passages: Sequence[str], *, strict: bool = True) -> list[dict]:
    """Map reconciled leaves back to reply paths under exact array-union semantics.

    A scalar at another field never counts. A merged array item must equal the
    entire original item, not merely contain the same leaf value. Bound identity
    fields were supplied to value calls, so retain their inventory citations instead.
    Unless `strict`, a value no reply returned as such (`conform` coerced it) has no
    sources, and routing orders its contexts by value match and relevance alone.
    """
    def locate(value, candidate, path, candidate_path=()):
        if not path:
            return [list(candidate_path)] if candidate == value else []
        step, *rest = path
        if isinstance(step, str):
            if not isinstance(candidate, dict) or step not in candidate:
                return []
            return locate(value[step], candidate[step], rest, (*candidate_path, step))
        if not isinstance(candidate, list):
            return []
        # A single source was never reconciled: preserve repeated occurrences by index.
        indexes = ([step] if len(candidates) == 1 and step < len(candidate) else
                   [i for i, item in enumerate(candidate) if item == value[step]])
        return [found for index in indexes
                for found in locate(value[step], candidate[index], rest, (*candidate_path, index))]

    origins = []
    for path, _ in leaves(merged):
        if path[0] in identity:
            origins.append({"path": list(path), "kind": "inventory", "passages": list(identity_passages)})
        else:
            sources = [{"unit": unit, "path": original}
                       for unit, candidate in enumerate(candidates)
                       for original in locate(merged, candidate, path)]
            if not sources and strict:
                raise ValueError(f"reconciled value has no extraction origin: {path!r}")
            origins.append({"path": list(path), "kind": "value", "sources": sources})
    return origins


def _terms(text: str) -> list[str]:
    # Retain scientific abbreviations and numbers; this ranks, never validates, support.
    return re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold())


def rank_units(contexts: Sequence[Context], value_contexts: Sequence[Context], origin: dict,
               value, description: str) -> dict:
    """Prefer owning origin units, then exact value matches and BM25 field/value relevance.

    No top-k exclusion: all remaining units stay in the deterministic order. There
    is no embedding service or learned relevance/recall claim. Only whole contexts
    are reordered; headers, overlap and table cells remain attached.
    """
    source_ids = (set(origin["passages"]) if origin["kind"] == "inventory" else
                  {p.id for item in origin["sources"] for p in value_contexts[item["unit"]].primary})
    preferred = {index for index, context in enumerate(contexts)
                 if source_ids & {p.id for p in context.primary}}
    texts = ["\n".join(p.text for p in context.passages) for context in contexts]
    counts = [Counter(_terms(text)) for text in texts]
    lengths = [sum(count.values()) for count in counts]
    average = sum(lengths) / max(1, len(lengths)) or 1
    frequency = Counter(term for count in counts for term in count)
    query = set(_terms(description + " " + str(value)))
    scores = [sum(math.log(1 + (len(counts) - frequency[term] + 0.5) / (frequency[term] + 0.5))
                  * (count[term] * 2.2) / (count[term] + 1.2 * (0.25 + 0.75 * lengths[index] / average))
                  for term in sorted(query & count.keys())) for index, count in enumerate(counts)]
    matches = [contains(text, value) for text in texts]
    order = sorted(range(len(contexts)), key=lambda index:
                   (index not in preferred, not matches[index], -scores[index], index))
    return {"order": order, "origin_units": sorted(preferred),
            "value_match_units": [index for index, matched in enumerate(matches) if matched],
            "lexical_scores": [round(score, 8) for score in scores]}


def verify_routed(contexts: Sequence[Context], fields: dict, schema: Schema, chat, *,
                  origins: Sequence[dict], value_contexts: Sequence[Context], record: int,
                  verifier, skip_paths: frozenset = frozenset(), **verification):
    """Batch claims sharing their next preferred unit; keep unresolved fallback exhaustive.

    A refusal is recorded separately from an attempted comparison. Missing/invalid
    replies and NONE do not end search. Success stops only that full record path.
    """
    by_path = {tuple(item["path"]): item for item in origins}
    routes = {}
    for path, value in leaves(fields):
        full_path = ("records", record, *path)
        if full_path not in skip_paths:
            # The relevance query also holds the enclosing object's other values: a value printed in many units
            # (a quantity, a brand) ranks first the unit printing its own item (its article number).
            parent: dict = fields
            for step in path[:-1]:
                parent = parent[step]
            others = " ".join(str(other) for key, other in parent.items() if key != path[-1]
                              and isinstance(other, (str, int, float)) and not isinstance(other, bool)
                              ) if isinstance(parent, dict) else ""
            ranked = rank_units(contexts, value_contexts, by_path[path], value,
                                f"{describe(schema.record_nodes, path)} {others}")
            routes[full_path] = {"path": list(full_path), **ranked, "attempted": [], "refused": [],
                                 "remaining": list(ranked["order"]), "supported": False}
    all_paths = {("records", record, *path) for path, _ in leaves(fields)}
    links, calls, issues = [], [], []
    while True:
        batches = {}
        for path, route in routes.items():
            if not route["supported"] and route["remaining"]:
                unit = route["remaining"].pop(0)
                batches.setdefault(unit, set()).add(path)
        if not batches:
            break
        for unit, paths in batches.items():
            found, attempts, problems = verifier(contexts[unit].passages, fields, schema, chat,
                record=record, skip_paths=frozenset(all_paths - paths), **verification)
            supported = {link.path for link in found}
            refused = {issue.path for issue in problems if issue.code == "grounding_exceeds_budget"}
            if any(issue.code == "no_evidence" for issue in problems):
                refused = paths
            for path in paths:
                routes[path]["refused" if path in refused else "attempted"].append(unit)
                routes[path]["supported"] = path in supported
            links += found
            calls += attempts
            issues += problems
    for route in routes.values():
        route["coverage"] = ("stopped_after_support" if route["supported"] else
                             "partial" if route["refused"] else "attempted_all")
    return links, calls, issues, list(routes.values())
