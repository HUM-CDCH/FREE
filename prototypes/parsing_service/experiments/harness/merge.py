"""One shared merger: candidate records from chunks, field groups, samples and views become records, and every
contributing candidate stays on the record it fed.

Matching is conservative. A declared key makes records one; without a complete key two candidates are one record only
if separate replies cite the identical unambiguous span for a declared identity field, or (with
continuation flags) if one ends where the next begins across a chunk cut, and never if that would put two different
scalar values in one record: a candidate joins a cluster only when it is compatible with the whole cluster, so
transitive matches cannot merge records that disagree. A field's status keeps its reasons apart: `value`, `absent` (a
processed region asked for it and it was not there), `unresolved` (values conflict or do not conform), `omitted` (no
successful call covered it, or the record touches a region nobody read), `unsupported` (set later by an evidence gate).
Set-valued fields are unions; scalar conflicts are kept with every alternative and never resolved by order or by a
confidence number. Nested objects and collections stated by several candidates of one record are parts of it (`_parts`),
not rival answers. A case whose `record_scope` is "document" has one record per document: every candidate is a part of it.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

import numpy as np

from experiments.harness.config import Config
from experiments.harness.data import Case, assign, canon
from experiments.harness.evidence import _cited
from experiments.harness.model import BudgetExceeded, Metered, ask
from kei_exp.kie.extract.schema import Node
from kei_exp.kie.extract.stages import normal


@dataclass
class Coverage:
    """The fields each (chunk, group, sample) region read in full, and the chunks in reading order. Coverage is per sample and
    per field: one sample's success never vouches for another's silence, and a failed half of a subdivided task does not
    void the fields its sibling read."""
    order: list[str]
    read: dict[tuple[str, int, int], frozenset[str]]
    groups: list[list[str]]

    def covered(self, chunk: str, name: str, sample: int) -> bool:
        return any(name in self.read.get((chunk, g, sample), ()) for g, names in enumerate(self.groups) if name in names)

    def neighbour(self, chunk: str, step: int) -> str | None:
        at = self.order.index(chunk) + step
        return self.order[at] if 0 <= at < len(self.order) else None


def _span_ids(field: dict) -> set[tuple]:
    return {(s["segment"], s["start"], s["end"]) for e in field.get("entries", [])
            if e.get("exists", True) and not e.get("ambiguous") and not e.get("approximate") for s in e["spans"]}


def _reply(cand: dict) -> tuple:
    return (cand["chunk"], tuple(cand.get("part", cand.get("source_part", ()))), cand["group"], cand["sample"], cand["view"])


def _signature(cand: dict) -> frozenset:
    return frozenset((name, canon(f["value"])) for name, f in cand["fields"].items() if f["value"] is not None)


class _Cluster:
    def __init__(self, key: tuple | None):
        self.key, self.members = key, []
        self.values: dict[str, set] = defaultdict(set)     # scalar values seen, by field
        self.spans: dict[str, set] = defaultdict(set)      # cited spans, by field
        self.signatures: set[frozenset] = set()

    def add(self, cand: dict, scalars: set[str]) -> None:
        self.members.append(cand)
        self.signatures.add(_signature(cand))
        for name, f in cand["fields"].items():
            if f["value"] is not None and name in scalars:
                self.values[name].add(canon(f["value"]))
            self.spans[name] |= _span_ids(f)

    def compatible(self, cand: dict, scalars: set[str]) -> bool:
        return all(canon(f["value"]) in self.values[name] or not self.values[name]
                   for name, f in cand["fields"].items() if f["value"] is not None and name in scalars)

    def joins(self, cand: dict, scalars: set[str], identity_fields: tuple[str, ...]) -> bool:
        """A shared resolved identity-field occurrence can establish identity; equal values cannot.

        A shared contextual field (e.g. a site heading) is not a record occurrence.
        Distinct items in one reply stay distinct even when the model repeats their citations.
        """
        if any(_reply(m) == _reply(cand) for m in self.members) or not self.compatible(cand, scalars):
            return False
        return any(_span_ids(f) & self.spans[name] for name, f in cand["fields"].items() if name in identity_fields)


def key_of(cand: dict, case: Case, cfg: Config) -> tuple | None:
    if not (cfg.merge.keys and case.record_key):
        return None
    values = [cand["fields"].get(name, {}).get("value") for name in case.record_key]
    return None if any(v is None for v in values) else tuple(normal(str(v)) for v in values)


def cluster(cands: list[dict], case: Case, cfg: Config, coverage: Coverage) -> list[list[dict]]:
    """Group candidate records into records, in reading order (chunk, group, position in the reply)."""
    scalars = {node.name for node in case.schema.record_nodes if node.type not in ("array", "object")}
    where = {c: i for i, c in enumerate(coverage.order)}
    tasks: dict[tuple, list[dict]] = defaultdict(list)
    for cand in cands:
        tasks[_reply(cand)].append(cand)
    for members in tasks.values():
        lo, hi = min(c["index"] for c in members), max(c["index"] for c in members)
        for c in members:
            c["is_first"], c["is_last"] = c["index"] == lo, c["index"] == hi
    ordered = sorted(cands, key=lambda c: (where.get(c["chunk"], 0), tuple(c.get("source_part", ())), c["group"], c["index"]))
    if case.record_scope == "document":
        return [ordered] if ordered else []
    # A supposedly unique key repeated within a reply is an extraction ambiguity,
    # not permission to fold its items (or subsequent readings) into one occurrence.
    disputed = {key for members in tasks.values() for key, count in
                Counter(key_of(c, case, cfg) for c in members).items() if key is not None and count > 1}
    clusters: list[_Cluster] = []
    by_key: dict[tuple, _Cluster] = {}
    open_end: dict[tuple, _Cluster] = {}        # (chunk, group, sample) -> the cluster of its last record, when the model says it goes on
    source_order = {p.id: i for i, p in enumerate(case.evidence.passages)}
    bounds = {(where[c["chunk"]], tuple(c.get("source_part", ()))):
              (min(source_order[p] for p in c["primary"]), max(source_order[p] for p in c["primary"]))
              for c in ordered if c.get("primary")}
    boundary_previous = {}
    for group, sample, view in {(c["group"], c["sample"], c["view"]) for c in ordered}:
        own = sorted({(where[c["chunk"]], tuple(c.get("source_part", ()))) for c in ordered
                      if (c["group"], c["sample"], c["view"]) == (group, sample, view)})
        boundary_previous.update({(boundary, group, sample, view): own[i - 1] if i else None for i, boundary in enumerate(own)})
    for cand in ordered:
        boundary = (where[cand["chunk"]], tuple(cand.get("source_part", ())))
        key = key_of(cand, case, cfg)
        if key in disputed:
            cand["identity_ambiguous"] = True
            key = None
        home = by_key.get(key) if key is not None else None
        if (home is None and not cand.get("identity_ambiguous") and cfg.merge.continuation == "flags"
                and cand["is_first"] and cand.get("begins") is True):
            previous = boundary_previous[(boundary, cand["group"], cand["sample"], cand["view"])]
            adjacent = previous is not None and previous[0] in (boundary[0], boundary[0] - 1)
            if previous in bounds and boundary in bounds:
                adjacent = adjacent and bounds[previous][1] + 1 == bounds[boundary][0]
            pending = open_end.get((previous, cand["group"], cand["sample"])) if adjacent else None
            if pending is not None and pending.compatible(cand, scalars) and (key is None or pending.key in (None, key)):
                home = pending
        if home is None and key is None and not cand.get("identity_ambiguous"):
            matches = [c for c in clusters if c.key is None and c.joins(cand, scalars, case.record_key)]
            if len(matches) == 1:
                home = matches[0]
            elif matches:
                cand["identity_ambiguous"] = True
        if home is None:
            signature = _signature(cand)
            for other in clusters:
                if signature and signature in other.signatures:
                    cand["identity_ambiguous"] = True
                    for member in other.members:
                        member["identity_ambiguous"] = True
        if home is None:
            home = _Cluster(key)
            clusters.append(home)
        if key is not None and home.key is None:   # a fragment that gains its key: later candidates with that key belong here
            home.key = key
        if key is not None:
            by_key[key] = home
        home.add(cand, scalars)
        if cand["is_last"] and cand.get("ends") is True:
            open_end[(boundary, cand["group"], cand["sample"])] = home
    return [c.members for c in clusters]


def _covered(members: list[dict], name: str, coverage: Coverage) -> bool:
    """A null is an answer only where the whole record's region was read by that member's own sample: every chunk it
    touches, and the neighbour of a chunk whose edge it lies on (the record may continue there)."""
    for m in members:
        chunks, sample = m.get("chunks") or [m["chunk"]], m["sample"]
        if not all(coverage.covered(c, name, sample) for c in chunks):
            return False
        for c in chunks:
            for edge, step in (("is_first", -1), ("is_last", 1)):
                near = coverage.neighbour(c, step)
                if m.get(edge) and near is not None and not coverage.covered(near, name, sample):
                    return False
    return True


def _who(members_fields: list[tuple[dict, dict]]) -> list[dict]:
    return [{"chunk": m.get("chunk"), "group": m.get("group"), "sample": m.get("sample"), "view": m.get("view"),
             "index": m.get("index"), "raw": f["raw"], "value": f["value"]} for m, f in members_fields]


def _mean(values: list[float | None]) -> float | None:
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def _merge_checks(checks: list[dict | None]) -> dict | None:
    """The checks of a field stated by several candidates: a check holds only if it held for every one of them, and is
    unknown if any was unknown."""
    checks = [c for c in checks if c is not None]
    if not checks:
        return None

    def every(key: str) -> bool | None:
        values = [c[key] for c in checks]
        return None if any(v is None for v in values) else all(values)
    return {"type_ok": all(c["type_ok"] for c in checks), "cited_exists": every("cited_exists"), "literal": every("literal"),
            "expects_evidence": checks[0]["expects_evidence"]}


def _win(pairs: list[tuple[dict, dict]]) -> dict:
    """What a chosen value carries: the candidates that state it, their evidence, checks and token probabilities. One
    place builds it for scalars, sets, votes and the model resolver, so all of them keep the same provenance."""
    fields = [f for _, f in pairs]
    keys = ("p_first", "p_mean", "p_span", "margin", "entropy_topk")
    stats = [f["stats"] for f in fields if f.get("stats")]
    return {"winners": fields, "entries": [e for f in fields for e in f.get("entries", [])],
            "verbalized": _mean([f.get("verbalized") for f in fields if isinstance(f.get("verbalized"), (int, float))]),
            "stats": {k: _mean([s.get(k) for s in stats]) for k in keys} if stats else None,
            "checks": _merge_checks([f.get("checks") for f in fields])}


def _groups(present: list[tuple[dict, dict]]) -> list[list[tuple[dict, dict]]]:
    grouped: dict[Any, list] = defaultdict(list)
    for pair in present:
        grouped[canon(pair[1]["value"])].append(pair)
    return list(grouped.values())


def _alternatives(groups: list[list[tuple[dict, dict]]], nulls: int = 0) -> list[dict]:
    """Every distinct value with its votes and provenance, so a conflict or a dissent stays on the record."""
    found = [{"value": pairs[0][1]["value"], "raw": pairs[0][1]["raw"], "votes": len(pairs), **_win(pairs)} for pairs in groups]
    return found + ([{"value": None, "raw": None, "votes": nulls, "entries": [], "winners": [], "checks": None, "stats": None,
                      "verbalized": None}] if nulls else [])


def _empty(status: str, **more: Any) -> dict:
    return {"status": status, "raw": None, "value": None, "normalized": False, "alternatives": [], "flags": [], "contributors": [],
            "typed": True, "verbalized": None, "stats": None, "entries": [], "winners": [], "checks": None, "votes": None, **more}


def _union(present: list[tuple[dict, dict]], keep=lambda item, count: True) -> list:
    counts: dict[Any, list] = defaultdict(list)
    for _, f in present:
        for item in f["value"]:
            counts[canon(item)].append(item)
    return [items[0] for items in counts.values() if keep(items[0], len(items))]


CONFLICT = object()


def _parts(values: list, node: Node) -> tuple[Any, int]:
    """One nested value from the parts candidates of one record state, and how many of its items another candidate also
    gave: objects fill in child by child (a null or missing child erases nothing), collections keep every item of every
    candidate in reading order. An equal item from two candidates may be one row read twice or two rows that look alike;
    no item carries its own source reference, so both stay and the count flags the possible repeat. CONFLICT when two
    parts state different scalars for one place."""
    if values and node.type == "array" and all(isinstance(v, list) for v in values):
        given = Counter(c for items in values for c in {canon(item) for item in items})
        return [item for items in values for item in items], sum(given[canon(item)] > 1 for items in values for item in items)
    if len({canon(v) for v in values}) <= 1:
        return (values[0] if values else None), 0
    if node.type == "object" and all(isinstance(v, dict) for v in values):
        merged, repeats = {}, 0
        for child in node.children:
            merged[child.name], n = _parts([v[child.name] for v in values if v.get(child.name) not in (None, "", [])], child)
            if merged[child.name] is CONFLICT:
                return CONFLICT, 0
            repeats += n
        return merged, repeats
    return CONFLICT, 0


def _field(members: list[dict], node: Node, coverage: Coverage) -> dict:
    """One field of a record from its contributing candidates (chunks and groups of one sample)."""
    pairs = [(m, m["fields"][node.name]) for m in members if node.name in m["fields"]]
    present = [(m, f) for m, f in pairs if f["value"] is not None]
    invalid = [(m, f) for m, f in pairs if f["value"] is None and f["raw"] is not None]
    out = _empty("omitted", contributors=_who(pairs))
    if present and node.type == "array" and node.item_type is not None:
        items = _union(present)
        return {**out, "status": "value", "value": items, "raw": items, "normalized": any(f["normalized"] for _, f in present), **_win(present)}
    if present:
        groups = _groups(present)
        if len(groups) == 1 and (len(present) == 1 or node.type != "array"):    # equal collections are still two readings
            first = present[0][1]
            return {**out, "status": "value", "value": first["value"], "raw": first["raw"], "normalized": first["normalized"],
                    "alternatives": _alternatives(groups), **_win(present)}
        merged, repeats = _parts([f["value"] for _, f in present], node) if node.children is not None else (CONFLICT, 0)
        if merged is not CONFLICT:      # nested values are untyped, so value and raw are the same items in the same order
            return {**out, "status": "value", "value": merged, "raw": merged, "normalized": any(f["normalized"] for _, f in present),
                    "alternatives": _alternatives(groups), "flags": ["possible_repeated_items"] if repeats else [], **_win(present)}
        return {**out, "status": "unresolved", "alternatives": _alternatives(groups), "flags": ["conflict"]}
    if invalid:
        return {**out, "status": "unresolved", "raw": invalid[0][1]["raw"], "typed": False, "flags": ["type_mismatch"]}
    return {**out, "status": "absent" if _covered(members, node.name, coverage) else "omitted"}


def consolidate(members: list[dict], nodes: list[Node], coverage: Coverage) -> dict[str, dict]:
    return {node.name: _field(members, node, coverage) for node in nodes}


def _key_of_record(rec: dict, case: Case, cfg: Config) -> tuple | None:
    if not (cfg.merge.keys and case.record_key):
        return None
    fields = [rec["fields"][name] for name in case.record_key]
    return None if any(f["status"] != "value" for f in fields) else tuple(normal(str(f["value"])) for f in fields)


def _shared(a: dict, b: dict) -> int:
    """The fields two consolidated records agree on: the same value, or the identical cited span."""
    def agree(name: str, fa: dict) -> bool:
        fb = b["fields"][name]
        same = fa["status"] == "value" and fb["status"] == "value" and canon(fa["value"]) == canon(fb["value"])
        return same or bool(_span_ids(fa) & _span_ids(fb))
    return sum(agree(name, fa) for name, fa in a["fields"].items())


def align_samples(per_sample: list[list[dict]], case: Case, cfg: Config) -> list[list[tuple[int, dict]]]:
    """The records of every sample grouped into records, each holding at most one record per sample: by declared key, else by
    assignment (the evaluator's) on the values or cited spans two records share, at least `min_fields`. A record's fields may
    disagree between samples, which is what the vote is for, so agreement on a field is never a condition of being the same
    record. A record without a complete key may join one that has it, which then gains the key."""
    if case.record_scope == "document":
        return [[(s, rec) for s, records in enumerate(per_sample) for rec in records]] if any(per_sample) else []
    clusters: list[list[tuple[int, dict]]] = []
    keys: list[tuple | None] = []
    for s, records in enumerate(per_sample):
        free, loose = list(range(len(clusters))), []
        for rec in records:
            key = _key_of_record(rec, case, cfg)
            home = next((j for j in free if key is not None and keys[j] == key), None)
            if home is None:
                loose.append((rec, key))
            else:
                clusters[home].append((s, rec))
                free.remove(home)
        if loose and free:
            score = np.array([[(-1 if key is not None and keys[j] is not None else max(_shared(rec, m) for _, m in clusters[j]))
                               for j in free] for rec, key in loose], dtype=float)
            for row, col in assign(score, [cfg.merge.min_fields] * len(free)):
                rec, key = loose[row]
                clusters[free[col]].append((s, rec))
                keys[free[col]] = keys[free[col]] or key
                loose[row] = None
        for entry in loose:
            if entry is not None:
                clusters.append([(s, entry[0])])
                keys.append(entry[1])
    return sorted(clusters, key=lambda members: min(rec["first"] for _, rec in members))


ABSENT = "record not found"     # in `vote`: the sample read the region and found no such record (a null vote)


def vote(per_sample: list[dict | str | None], node: Node, majority: bool) -> dict:
    """One field over the samples of one record. `per_sample[s]` is that sample's consolidated field; ABSENT when the
    sample read the region and found no such record; None when it did not answer (its region failed): those samples are
    left out of the count, so a provider error never reads as dissent. Agreement is a signal, not proof: repeated calls
    are not independent. Under `majority` a value needs more than half of the answering samples; under `strict` every
    answering sample must state it, and any other answer, absence included, leaves the field unresolved."""
    ballots = []
    for f in per_sample:
        if f is None or (f != ABSENT and f["status"] == "omitted"):
            continue
        ballots.append(("null", None) if f == ABSENT or f["status"] == "absent" else
                       ("open", None) if f["status"] == "unresolved" else ("value", f))
    n = len(ballots)
    contributors = [c for f in per_sample if isinstance(f, dict) for c in f["contributors"]]
    if not n:
        return _empty("omitted", contributors=contributors)
    present = [({"sample": i}, f) for i, (kind, f) in enumerate(ballots) if kind == "value"]
    nulls = sum(kind == "null" for kind, _ in ballots)
    base = _empty("unresolved", contributors=contributors)
    is_set = node.type == "array" and node.item_type is not None
    groups = _groups(present)
    if is_set:
        kept = _union(present, lambda item, count: count * 2 > n) if majority else _union(present)
        exact = [pair for pair in present if canon(pair[1]["value"]) == canon(kept)]      # samples that state exactly this set
        if kept and (majority or (len(groups) <= 1 and len(present) == n)):
            # Only samples that state exactly the kept set carry its evidence and checks; a set no sample stated whole is a
            # composite, and whether its citations support it is unknown, not what a losing sample's citations say.
            win = _win(exact) if exact else {**_win(present), "checks": None}
            return {**base, "status": "value", "value": kept, "raw": kept, "votes": (len(exact), n), **win,
                    "alternatives": _alternatives(groups, nulls), "normalized": any(f["normalized"] for _, f in present)}
    else:
        winner = max(groups, key=len) if groups else None
        if winner is not None and (len(winner) * 2 > n if majority else len(winner) == n):
            first = winner[0][1]
            return {**base, "status": "value", "value": first["value"], "raw": first["raw"], "normalized": first["normalized"],
                    "votes": (len(winner), n), "alternatives": _alternatives(groups, nulls), **_win(winner)}
    if nulls and (nulls * 2 > n if majority else nulls == n):
        return {**base, "status": "absent", "votes": (nulls, n), "alternatives": _alternatives(groups, nulls)}
    return {**base, "status": "unresolved", "flags": ["conflict"], "alternatives": _alternatives(groups, nulls)}


RESOLVE = ("Several values were found for one field of one record of a source document. Choose the label of the value "
           "that the cited text states for this field of this record, or NONE if none does. Return only the JSON object.")


def resolve_conflict(name: str, field: dict, case: Case, cfg: Config, meter: Metered) -> list:
    """A costed model chooses among conflicting scalars from the text each cited. The alternatives are kept whatever it
    answers; a NONE or a failed call leaves the field unresolved. A chosen value carries its own candidates, evidence,
    checks and probabilities, exactly as if it had won without a conflict."""
    alternatives = [a for a in field["alternatives"] if a["value"] is not None]
    labels = [f"C{n}" for n in range(1, len(alternatives) + 1)]
    lines = [f"### Field\n{name}"]
    lines += [f"{label}: {a['value']!r}\ncited text:\n{_cited(case, a['entries'])}" for label, a in zip(labels, alternatives, strict=True)]
    schema = {"type": "object", "properties": {"choice": {"type": "string", "enum": [*labels, "NONE"]}},
              "required": ["choice"], "additionalProperties": False}
    try:
        parsed, calls, _ = ask(meter, stage="arbitration", system=RESOLVE, user="\n".join(lines) + "\n\nReturn the JSON object now.",
                               schema=schema if cfg.output.constraint == "schema" else None, max_tokens=cfg.output.max_tokens,
                               temperature=0.0)
    except BudgetExceeded:      # the field stays unresolved with every alternative, and says why
        field["flags"] = [*field["flags"], "resolver_unavailable"]
        return []
    choice = parsed.get("choice") if isinstance(parsed, dict) else None
    if choice in labels:
        picked = alternatives[labels.index(choice)]
        field |= {"status": "value", "value": picked["value"], "raw": picked["raw"], "flags": [*field["flags"], "model_resolved"],
                  **{k: picked[k] for k in ("winners", "entries", "verbalized", "stats", "checks")}}
    return calls
