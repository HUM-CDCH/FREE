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
from kei_exp.kie.extract.durable import NeedsCall
from kei_exp.kie.extract.schema import Schema, describe
from kei_exp.kie.extract.stages import contains, leaves

# 2: the relevance query holds the claim's enclosing object's other values.
VERSION = 2


def value_origins(candidates: Sequence[dict], merged: dict, identity: dict,
                  identity_passages: Sequence[str], *, strict: bool = True,
                  item_sources: dict[tuple, list[dict]] | None = None) -> list[dict]:
    """Map assembled leaves to their actual reply occurrences, or legacy exact-union origins without `item_sources`.

    A scalar at another field never counts. A merged array item must equal the
    entire original item, not merely contain the same leaf value. Bound identity
    fields were supplied to value calls, so retain their inventory citations instead.
    Unless `strict`, a value no reply returned as such (`conform` coerced it) has no
    sources, and routing orders its contexts by value match and relevance alone.
    An assembled whole item's nested leaves keep its original indices; equal items
    at other positions are not origins of this occurrence.
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

    def assembled_sources(path):
        depth = next((index for index, step in enumerate(path) if isinstance(step, int)), None)
        if item_sources is None or depth is None:
            return None
        prefix, suffix = path[:depth + 1], path[depth + 1:]
        item = merged
        for step in prefix:
            item = item[step]
        sources = []
        for source in item_sources.get(prefix, []):
            original = candidates[source["unit"]]
            for step in source["path"]:
                original = original[step]
            if original == item:
                sources.append({"unit": source["unit"], "path": [*source["path"], *suffix]})
        return sources

    origins = []
    for path, _ in leaves(merged):
        if path[0] in identity:
            origins.append({"path": list(path), "kind": "inventory", "passages": list(identity_passages)})
        else:
            sources = assembled_sources(path)
            if sources is None:
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


OVERFLOW_VERSION = 1  # `grounding_overflow="windows"`: the windows below
# Halvings of one refused unit at most: windows down to an eighth of it, so each claim checks at most 14 windows of a
# refused unit (2 + 4 + 8); claims at the same window in the same round share its pass, one verifier pass as for a
# unit; a refused window sends no call.
WINDOW_DEPTH = 3


def verify_routed(contexts: Sequence[Context], fields: dict, schema: Schema, chat, *,
                  origins: Sequence[dict], value_contexts: Sequence[Context], record: int,
                  verifier, skip_paths: frozenset = frozenset(), windows: bool = False, **verification):
    """Batch claims sharing their next preferred unit; keep unresolved fallback exhaustive.

    A refusal is recorded separately from an attempted comparison. Missing/invalid
    replies and NONE do not end search. Success stops only that full record path.
    Under durable planning a unit whose check waits on a call (`NeedsCall`) does not
    end the round: the round's other units are independent of it, so their checks are
    captured, and their saved replies read, in the same planning round. The next round
    routes each claim by this round's outcomes, so it starts once every unit has replied.
    With `windows` (`grounding_overflow="windows"`), a claim refused because its check of a unit exceeds the budget is
    checked next in that unit's two halves of passages, each a window, halved again when refused (`WINDOW_DEPTH`
    times at most): claims at the same window in the same round share its pass. A window refused at the limit, or
    holding one passage, keeps the refusal. Windows are local to this routing and routes name only `contexts`, the published
    listing: a unit checked through its windows is attempted, or refused when one of its windows was.
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
    units = list(contexts)
    depth = [0] * len(units)
    context_of = list(range(len(units)))  # the published context a window is part of
    halves: dict[int, tuple[int, int]] = {}
    queued: dict[tuple, list[int]] = {path: [] for path in routes}  # each claim's windows, checked before `remaining`
    while True:
        batches = {}
        for path, route in routes.items():
            if not route["supported"] and (queued[path] or route["remaining"]):
                unit = queued[path].pop(0) if queued[path] else route["remaining"].pop(0)
                batches.setdefault(unit, set()).add(path)
        if not batches:
            break
        waiting = False  # a unit's check captured for the durable workflow to run: read next planning round
        for unit, paths in batches.items():
            try:
                found, attempts, problems = verifier(units[unit].passages, fields, schema, chat,
                    record=record, skip_paths=frozenset(all_paths - paths), **verification)
            except NeedsCall:
                waiting = True
                continue
            supported = {link.path for link in found}
            refused = {issue.path for issue in problems if issue.code == "grounding_exceeds_budget"}
            windowed = set()
            if windows and refused and depth[unit] < WINDOW_DEPTH and len(units[unit].passages) > 1:
                if unit not in halves:
                    shown, middle = units[unit].passages, len(units[unit].passages) // 2
                    units += [Context(shown[:middle]), Context(shown[middle:])]
                    depth += [depth[unit] + 1] * 2
                    context_of += [context_of[unit]] * 2
                    halves[unit] = (len(units) - 2, len(units) - 1)
                windowed = refused
                problems = [issue for issue in problems
                            if not (issue.code == "grounding_exceeds_budget" and issue.path in windowed)]
            if any(issue.code == "no_evidence" for issue in problems):
                refused = paths
            for path in paths:
                route = routes[path]
                route["supported"] = path in supported
                if path in windowed:  # its windows are checked next
                    queued[path][0:0] = halves[unit]
                    if unit == context_of[unit]:
                        route["attempted"].append(unit)
                elif unit != context_of[unit]:  # a window: a refusal in it leaves its context refused
                    if path in refused and context_of[unit] in route["attempted"]:
                        route["attempted"].remove(context_of[unit])
                        route["refused"].append(context_of[unit])
                else:
                    route["refused" if path in refused else "attempted"].append(unit)
            links += found
            calls += attempts
            issues += problems
        if waiting:  # the next round's units follow this round's outcomes: an unanswered one would reroute them
            raise NeedsCall()
    for route in routes.values():
        route["coverage"] = ("stopped_after_support" if route["supported"] else
                             "partial" if route["refused"] else "attempted_all")
    return links, calls, issues, list(routes.values())
