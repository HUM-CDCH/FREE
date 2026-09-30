"""One evaluation path for every variant: additive counts per document, pooled, and resampled by document group.

A prediction is `{"records": [...], "fields": [row, ...], "cost": ..., "validity": ...}` where a row is one
(record, field) with a `status`: value | absent (the model said the source does not give it) | unresolved (conflict or
ambiguity) | omitted (no successful call covered it) | unsupported (withheld by an evidence gate). Gold says value |
absent | unannotated. Nothing is silently mapped to null: each pairing has its own count, and only annotated gold
enters a denominator. Extra predicted records are wrong only when the gold is exhaustive; a duplicate of a gold record
is a precision error either way. Fields are scored at top level: a nested value is compared whole.

Every rate is reported with its denominator. Evidence denominators are fixed by the gold (an evidence-annotated field
counts whether or not it was predicted), so abstaining cannot raise a joint rate; the conditional rates are separate.
"""
from __future__ import annotations

import difflib
import copy
import math
import unicodedata
from datetime import datetime
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from experiments.extraction.manifest import digest
from experiments.harness.data import Case, assign, canon
from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import normal


@dataclass(frozen=True)
class Eval:
    """Scoring rules, fixed across every variant of a study (a comparator is not a system factor)."""
    evaluator_version: int = 4     # 4: an unpaired parent's collection is scored only where its annotation is known; counts per path
    comparators: dict[str, str] = field(default_factory=dict)   # field -> exact|normalized|numeric|set|deep|fuzzy
    rel_tol: float = 1e-9
    abs_tol: float = 0.0
    fuzzy: float = 0.9
    min_matches: int = 2            # annotated field values two records must share to be one record (fewer if gold has fewer)
    iou: float = 0.5                # character IoU for a span hit
    excluded_flags: tuple[str, ...] = ()   # rows carrying one of these flags are not counted as predicted values

    def sha256(self) -> str:
        return digest(canonical_json(asdict(self)))


def normalized(value: Any) -> str:
    """Unicode/case/whitespace only. Punctuation is meaningful and is never discarded."""
    return " ".join(unicodedata.normalize("NFKC", str(value)).casefold().split())


_deep = canon


def accepted(kind: str, pred: Any, item: dict, rules: Eval) -> bool:
    return any(equal(kind, pred, value, rules) for value in [item.get("value"), *item.get("accepted_values", [])])


def _items(value: Any) -> frozenset:
    return frozenset(_deep(item) for item in (value if isinstance(value, (list, tuple)) else [value]))


def equal(kind: str, pred: Any, gold: Any, rules: Eval) -> bool:
    try:
        match kind:
            case "exact":
                return canonical_json(pred) == canonical_json(gold)
            case "normalized":
                return normalized(pred) == normalized(gold)
            case "date":
                def date(value):
                    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y", "%d-%b-%y"):
                        try:
                            return datetime.strptime(str(value).strip(), fmt).date()
                        except ValueError:
                            pass
                    return normalized(value)
                return date(pred) == date(gold)
            case "numeric":
                return math.isclose(float(str(pred).replace(",", ".")), float(str(gold).replace(",", ".")),
                                    rel_tol=rules.rel_tol, abs_tol=rules.abs_tol)
            case "set":
                return _items(pred) == _items(gold)
            case "deep":
                return _deep(pred) == _deep(gold)
            case "fuzzy":
                return difflib.SequenceMatcher(None, normal(str(pred)), normal(str(gold))).ratio() >= rules.fuzzy
    except (TypeError, ValueError):
        return False
    raise ValueError(f"unknown comparator {kind!r}")


def kinds_for(schema: Schema, rules: Eval) -> dict[str, str]:
    def default(node) -> str:
        if node.type == "array":
            return "set" if node.item_type else "deep"
        return {"object": "deep", "number": "numeric", "integer": "numeric", "boolean": "exact",
                "verbatim-string": "exact"}.get(node.type, "normalized")
    return {node.name: rules.comparators.get(node.name, default(node)) for node in schema.record_nodes}


def gold_state(item: dict) -> str:
    return "value" if "value" in item else "absent" if item.get("absent") else "unannotated"


def _spans_of(row: dict) -> list[dict]:
    return [span for cited in row.get("evidence", []) for span in cited["spans"]]


def _intervals(spans: list[dict]) -> dict[str, list[tuple[int, int]]]:
    merged: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for span in sorted(spans, key=lambda s: (s["segment"], s["start"])):
        runs = merged[span["segment"]]
        if runs and span["start"] <= runs[-1][1]:
            runs[-1] = (runs[-1][0], max(runs[-1][1], span["end"]))
        else:
            runs.append((span["start"], span["end"]))
    return merged


def _overlap(left: list[dict], right: list[dict]) -> tuple[int, int]:
    """Characters both span lists cover, and characters either covers."""
    a, b = _intervals(left), _intervals(right)
    both = sum(max(0, min(x1, y1) - max(x0, y0)) for seg in a.keys() & b.keys()
               for x0, x1 in a[seg] for y0, y1 in b[seg])
    total = sum(e - s for runs in (*a.values(), *b.values()) for s, e in runs)
    return both, total - both


def _iou(left: list[dict], right: list[dict]) -> float:
    both, either = _overlap(left, right)
    return both / either if either else 0.0


class _Records:
    """The predicted rows of one document, by record."""

    def __init__(self, pred: dict, rules: Eval):
        self.by_record: dict[int, dict[str, dict]] = defaultdict(dict)
        for row in pred["fields"]:
            self.by_record[row["record"]][row["field"]] = row
        self.count = len(pred["records"])
        self.rules = rules

    def value(self, index: int, name: str) -> dict | None:
        row = self.by_record[index].get(name)
        counted = row is not None and row["status"] == "value" and not set(row.get("flags", [])) & set(self.rules.excluded_flags)
        return row if counted else None

    def values(self, index: int) -> list[tuple[str, dict]]:
        return [(name, row) for name in self.by_record[index] if (row := self.value(index, name)) is not None]


def _key(getter, names: tuple[str, ...]) -> tuple | None:
    values = [getter(name) for name in names]
    return None if any(v is None for v in values) else tuple(normal(str(v)) for v in values)


def _match(case: Case, gold: list[dict], pred: _Records, kinds: dict[str, str], rules: Eval) -> tuple[dict, dict, list]:
    """Pairs {pred index: gold index}, predicted records that duplicate a paired gold record {pred: gold}, and the
    unpaired rest. Declared keys pair first: a repeated key is a duplicate and a complete key the gold lacks is another
    record. Records without a complete key are paired by shared annotated values, each pair needing `min_matches` of them
    (or all the gold record has): ineligible edges are masked before the Hungarian assignment, so it maximises the number
    of eligible pairs first and their total agreement second. A keyless record sharing that much with an already paired
    gold record is its duplicate."""
    if case.annotations.get("fixed_document_root") and pred.count == len(gold) == 1:
        return {0: 0}, {}, []  # one known wrapper; wrong headers must not erase correctly extracted nested arrays
    pairs: dict[int, int] = {}
    duplicates: dict[int, int] = {}
    other: set[int] = set()
    if case.record_key:
        gold_keys = {key: j for j, record in enumerate(gold)
                     if (key := _key(lambda n, r=record: r["fields"].get(n, {}).get("value"), case.record_key)) is not None}
        for i in range(pred.count):
            key = _key(lambda n, i=i: (pred.value(i, n) or {}).get("value"), case.record_key)
            if key is None:
                continue
            j = gold_keys.get(key)
            if j is None:
                other.add(i)
            elif j in pairs.values():
                duplicates[i] = j
            else:
                pairs[i] = j

    def shared(i: int, j: int) -> int:
        return sum(1 for name, item in gold[j]["fields"].items()
                   if gold_state(item) == "value" and (row := pred.value(i, name)) is not None
                   and accepted(kinds[name], row.get("value"), item, rules))

    def need(j: int) -> int:
        return max(1, min(rules.min_matches, sum(gold_state(item) == "value" for item in gold[j]["fields"].values())))
    free_p = [i for i in range(pred.count) if i not in pairs and i not in duplicates and i not in other]
    free_g = [j for j in range(len(gold)) if j not in pairs.values()]
    if free_p and free_g:
        score = np.array([[shared(i, j) for j in free_g] for i in free_p], dtype=float)
        for row, col in assign(score, [need(j) for j in free_g]):
            pairs[free_p[row]] = free_g[col]
    for i in free_p:
        if i not in pairs:
            best = max(set(pairs.values()), key=lambda j: shared(i, j), default=None)
            if best is not None and shared(i, best) >= need(best):
                duplicates[i] = best
    return pairs, duplicates, [i for i in range(pred.count) if i not in pairs and i not in duplicates]


def score_case(case: Case, pred: dict, rules: Eval) -> tuple[dict, list[dict]]:
    """Canonicalized and untouched raw-value scores share canonical record pairing; never filter verifier flags."""
    # Re-score old replies under the same annotation-free evidence refinement as new runs.
    if pred.get("config", {}).get("evidence", {}).get("mode") in ("quote", "ids"):
        from experiments.harness.config import Config
        from experiments.harness.evidence import entries_for, disambiguate
        cfg = Config.model_validate(pred["config"])
        pred = copy.deepcopy(pred)
        for row in pred["fields"]:
            if row.get("evidence") and any(e.get("evidence_protocol") != 2 for e in row["evidence"]):
                citations = row["evidence"]
                candidate = {"value": row.get("value"), "raw": row.get("raw"),
                             "quotes": list(dict.fromkeys(e["quote"] for e in citations if e.get("quote"))),
                             "ids": list(dict.fromkeys(i for e in citations for i in e.get("ids", [])))}
                # Quote search is confined to its originally aligned locations; no retrieval is rerun.
                from experiments.harness.evidence import refine_entries
                row["evidence"] = (entries_for(candidate, row.get("value"), case.inference(), case.evidence.passages, cfg)
                                   if cfg.evidence.mode == "ids" else refine_entries(citations, row.get("value"), case.inference(), cfg.evidence.alignment))
        if cfg.evidence.alignment.disambiguate == "record":
            for i in range(len(pred["records"])):
                disambiguate({r["field"]: r.get("evidence", []) for r in pred["fields"] if r["record"] == i}, case.inference())
    if case.annotations.get("adapter") == "extractbench-v1":
        return score_structured(case, pred, rules)
    counts, outcomes = _score_case(case, pred, rules)
    raw, _ = _score_case(case, pred, rules, raw=True)
    counts.update({"raw_" + key: value for key, value in raw.items()})
    return counts, outcomes


def evidence_options(item: dict) -> list[dict]:
    return [e for e in item.get("accepted_evidence", []) if e.get("page") is not None]


def _score_case(case: Case, pred: dict, rules: Eval, *, raw: bool = False) -> tuple[dict, list[dict]]:
    """Additive counts for one document, and one outcome row per predicted value that has a defined correctness."""
    kinds = kinds_for(case.schema, rules)
    pages = {p.id: p.page for p in case.evidence.passages}
    lengths = {p.id: len(p.text) for p in case.evidence.passages}
    for row in pred["fields"]:      # a citation that does not resolve in this snapshot is another source's, never approximated
        for cited in row.get("evidence", []):
            for span in (*cited["spans"], *(s for alternative in cited.get("alternatives", []) for s in alternative)):
                if not 0 <= span["start"] < span["end"] <= lengths.get(span["segment"], -1):
                    raise ValueError(f"predicted evidence {span} does not resolve in the source snapshot of case {case.id}")
    gold = list(case.gold)
    records = _Records(pred, rules)
    pairs, duplicates, extra = _match(case, gold, records, kinds, rules)
    count: dict[str, int] = defaultdict(int)
    outcomes: list[dict] = []
    matched_gold = {j: i for i, j in pairs.items()}
    count.update(gold_records=len(gold), pred_records=records.count, matched_records=len(pairs),
                 missing_records=len(gold) - len(pairs), duplicated_records=len(duplicates), documents=1,
                 cross_page_fragments=sum(bool(gold[j].get("cross_page")) for j in duplicates.values()))
    count["hallucinated_records" if case.exhaustive else "unadjudicated_records"] += len(extra)
    for i in duplicates:    # a copy of an annotated record is output the gold lacks: a precision error and a wrong prediction
        for name, row in records.values(i):
            count["duplicate_values"] += 1
            outcomes.append({"doc": case.id, "record": i, "field": name, "correct": False, "supported": None, "row": row})
    if case.exhaustive:
        for i in extra:
            for name, row in records.values(i):
                count["extra_record_values"] += 1
                outcomes.append({"doc": case.id, "record": i, "field": name, "correct": False, "supported": None, "row": row})
    strict_records = []
    for j, record in enumerate(gold):
        cross = bool(record.get("cross_page"))
        i = matched_gold.get(j)
        count["cross_page_gold"] += cross
        count["cross_page_matched"] += cross and i is not None
        strict = i is not None
        for name, item in record["fields"].items():
            state = gold_state(item)
            if state == "unannotated":
                count["unannotated_fields"] += 1
                continue
            row = records.by_record[i].get(name) if i is not None else None
            status = row["status"] if row else None
            counted = records.value(i, name) if i is not None else None
            if state == "absent":
                count["gold_absent_fields"] += 1
                optional = item.get("accepted_values", [])
                if counted is not None and any(equal("exact" if raw else kinds[name], counted.get("raw" if raw else "value"), value, rules) for value in optional):
                    count["optional_values_accepted"] += 1
                    # An optional populated reading is allowed, but does not enlarge the fixed populated-gold denominator.
                elif counted is not None:
                    count["hallucinated_fields"] += 1
                    strict = False
                    outcomes.append({"doc": case.id, "record": i, "field": name, "correct": False, "supported": None,
                                     "row": counted})
                elif status == "absent":
                    count["absent_ok"] += 1
                elif i is not None:
                    count["absent_not_answered"] += 1   # unresolved, omitted, withheld: neither credit nor error
                    strict = False
                continue
            count["gold_value_fields"] += 1
            true = [s for s in item.get("evidence", []) if s.get("supports", True)]
            count["ev_localization_gold"] += bool(true)
            count["ev_gold_fields"] += bool(true or evidence_options(item))        # fixed by the gold: abstaining cannot shrink it
            if i is None:
                count["fn_missing_record"] += 1
                strict = False
            elif counted is not None:
                right = accepted("exact" if raw else kinds[name], counted.get("raw" if raw else "value"), item, rules)
                count["tp" if right else "wrong_values"] += 1
                strict = strict and right
                outcomes.append({"doc": case.id, "record": i, "field": name, "correct": right, "row": counted,
                                 "supported": _evidence(count, counted, item, right, pages, rules)})
            else:
                strict = False
                count[{"absent": "missed_as_absent", "unresolved": "unresolved_fields", "omitted": "omitted_fields",
                       "unsupported": "withheld_fields", "value": "excluded_values"}.get(status or "", "omitted_fields")] += 1
                if status == "unsupported" and equal(kinds[name], row.get("raw"), item["value"], rules):
                    count["withheld_correct"] += 1
        strict_records.append(strict)
        count["strict_records"] += strict
        count["cross_page_strict"] += cross and strict
    count["strict_documents"] += all(strict_records) and not extra and not duplicates
    for key, value in (pred.get("validity") or {}).items():
        count[f"replies_{key}"] += value
    for side in ("fresh", "replayed"):
        for key, value in ((pred.get("cost") or {}).get(side) or {}).items():
            count[f"{side}_{key}"] += value
    for outcome in outcomes:
        flag = "unsupported" in outcome["row"].get("flags", [])
        error = not outcome["correct"]
        count["detector_" + {(True, True): "tp", (True, False): "fp", (False, True): "fn", (False, False): "tn"}[(flag, error)]] += 1
    return dict(count), outcomes


def _evidence(count: dict, row: dict, item: dict, right: bool, pages: dict[str, int], rules: Eval) -> bool | None:
    """Evidence counts of one predicted value against its gold; the joint correctness (value and span) when the gold
    annotates supporting spans, else None: unannotated evidence is neither right nor wrong. The verifier's verdict is
    scored against the label of the tuple (predicted value, cited text): a wrong value is unsupported whatever it cites,
    a right value is supported by a citation that is the gold span and unsupported by one that is only a decoy."""
    true = [s for s in item.get("evidence", []) if s.get("supports", True)]
    decoys = [s for s in item.get("evidence", []) if not s.get("supports", True)]
    cited = _spans_of(row)
    verdict = (row.get("verdict") or {}).get("supports_value")
    if verdict in (True, False) and cited:
        if right and true and _iou(cited, true) >= rules.iou:
            label: bool | None = True
        else:
            label = False if decoys and _overlap(cited, decoys)[0] > 0 else None
        if label is not None:
            count["verdict_" + {(True, True): "tp", (True, False): "fp", (False, True): "fn", (False, False): "tn"}[(verdict, label)]] += 1
    options = evidence_options(item)
    if options:
        raw_cited = [span for e in row.get("evidence", []) for span in e.get("raw_spans", e["spans"])]
        selected_pages = {pages.get(s["segment"]) for s in raw_cited}
        hit_page = bool(selected_pages & {e["page"] for e in options})
        count["ev_predicted"] += 1
        count["ev_value_correct"] += right
        count["ev_cited"] += bool(cited)
        count["ev_page_hit"] += hit_page
        count["ev_page_joint"] += right and hit_page
        count["ev_page_annotated"] += 1
        # PDF boxes remain original annotations. Native line text supplies no word boxes,
        # so exact value localization and semantic support are unmeasured here.
        return None
    if not true:
        return None
    raw_cited = [span for e in row.get("evidence", []) for span in e.get("raw_spans", e["spans"])]
    count["ev_raw_span_hit"] += bool(raw_cited) and _iou(raw_cited, true) >= rules.iou
    count["ev_localization_annotated"] += 1
    count["ev_localization_correct"] += right
    hit = bool(cited) and _iou(cited, true) >= rules.iou
    count["ev_predicted"] += 1
    count["ev_value_correct"] += right
    count["ev_cited"] += bool(cited)
    count["ev_page_hit"] += bool(cited) and bool({pages.get(s["segment"]) for s in cited} & {pages.get(s["segment"]) for s in true})
    count["ev_segment_hit"] += bool({s["segment"] for s in cited} & {s["segment"] for s in true})
    count["ev_span_hit"] += hit
    count["ev_decoy_hit"] += bool(decoys) and _overlap(cited, decoys)[0] > 0
    count["ev_joint"] += right and hit
    return right and hit


def pool(counts: list[dict]) -> dict[str, int]:
    total: dict[str, int] = defaultdict(int)
    for each in counts:
        for key, value in each.items():
            total[key] += value
    return dict(total)


def _ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def metrics(total: dict[str, int]) -> dict[str, Any]:
    canonical = _metrics(total)
    strict = _metrics({key[4:]: value for key, value in total.items() if key.startswith("raw_")})
    return {**canonical, "evaluator_version": 4,
            "raw_exact": {"field": strict["field"], "records": strict["records"]},
            "canonicalized": {"field": canonical["field"], "records": canonical["records"]},
            "repeated_records": {key: total.get("repeated_" + key, 0) for key in ("gold_records", "pred_records", "matched_records", "missing_records", "duplicated_records", "hallucinated_records", "strict_records", "cross_page_gold", "cross_page_strict")},
            "verifier_error_detection": {key: total.get("detector_" + key, 0) for key in ("tp", "fp", "fn", "tn")}}


def _metrics(total: dict[str, int]) -> dict[str, Any]:
    """Rates with their denominators beside them; a rate without a denominator is None, never zero."""
    g = total.get
    predicted = g("tp", 0) + g("wrong_values", 0) + g("hallucinated_fields", 0) + g("extra_record_values", 0) + g("duplicate_values", 0)
    precision, recall = _ratio(g("tp", 0), predicted), _ratio(g("tp", 0), g("gold_value_fields", 0))
    f1 = _ratio(2 * g("tp", 0), predicted + g("gold_value_fields", 0))     # 2TP / (2TP + FP + FN): 0 for a run that found nothing
    return {
        "field": {"precision": precision, "recall": recall, "f1": f1, "predicted_values": predicted,
                  "gold_value_fields": g("gold_value_fields", 0), "unannotated_fields": g("unannotated_fields", 0),
                  "optional_values_accepted": g("optional_values_accepted", 0),
                  "absent_accuracy": _ratio(g("absent_ok", 0), g("absent_ok", 0) + g("hallucinated_fields", 0)),
                  "abstained": {"unresolved": g("unresolved_fields", 0), "omitted": g("omitted_fields", 0),
                                "excluded_values": g("excluded_values", 0),
                                "withheld": g("withheld_fields", 0), "withheld_correct": g("withheld_correct", 0),
                                "missed_as_absent": g("missed_as_absent", 0), "missing_record": g("fn_missing_record", 0)}},
        "records": {"gold": g("gold_records", 0), "predicted": g("pred_records", 0), "matched": g("matched_records", 0),
                    "missing": g("missing_records", 0), "hallucinated": g("hallucinated_records", 0),
                    "duplicated": g("duplicated_records", 0), "unadjudicated": g("unadjudicated_records", 0),
                    "unscored": g("unscored_records", 0),
                    "strict_correct": _ratio(g("strict_records", 0), g("gold_records", 0)),
                    "strict_documents": _ratio(g("strict_documents", 0), g("documents", 0)),
                    "cross_page": {"gold": g("cross_page_gold", 0), "matched": g("cross_page_matched", 0),
                                   "strict": g("cross_page_strict", 0), "fragments": g("cross_page_fragments", 0)}},
        "evidence": {"annotated_fields": g("ev_gold_fields", 0), "predicted_annotated": g("ev_predicted", 0),
                     "cited": g("ev_cited", 0),
                     "joint": _ratio(g("ev_joint", 0), g("ev_localization_gold", 0)),
                     "raw_span_hit": _ratio(g("ev_raw_span_hit", 0), g("ev_localization_gold", 0)),
                     "annotated_page_joint": _ratio(g("ev_page_joint", 0), g("ev_gold_fields", 0)),
                     "semantic_support": None,
                     "joint_given_predicted": _ratio(g("ev_joint", 0), g("ev_localization_annotated", 0)),
                     "span_hit_given_correct": _ratio(g("ev_joint", 0), g("ev_localization_correct", 0)),
                     "page_hit": _ratio(g("ev_page_hit", 0), g("ev_predicted", 0)),
                     "segment_hit": _ratio(g("ev_segment_hit", 0), g("ev_localization_annotated", 0)),
                     "span_hit": _ratio(g("ev_span_hit", 0), g("ev_localization_annotated", 0)),
                     "decoy_hit": _ratio(g("ev_decoy_hit", 0), g("ev_localization_annotated", 0)),
                     "correct_with_annotated_evidence": g("ev_value_correct", 0),
                     "verifier": {key: g("verdict_" + key, 0) for key in ("tp", "fp", "fn", "tn")}},
        "validity": {"schema_valid_reply_rate": _ratio(g("replies_valid", 0), g("replies_total", 0)),
                     "replies": g("replies_total", 0)},
        "cost": {side: {key: g(f"{side}_{key}", 0) for key in ("calls", "input_tokens", "output_tokens", "seconds")}
                 for side in ("fresh", "replayed")},
    }


def check_invariants(total: dict[str, int]) -> list[str]:
    """Denominator identities every pooled count must satisfy; a violation means a counting bug, not a result."""
    g = total.get
    problems = []
    if g("tp", 0) > g("gold_value_fields", 0):
        problems.append("more true positives than annotated gold values")
    if g("matched_records", 0) > min(g("gold_records", 0), g("pred_records", 0)):
        problems.append("more matched records than gold or predicted records")
    if g("pred_records", 0) != g("matched_records", 0) + g("duplicated_records", 0) + g("hallucinated_records", 0) + g("unadjudicated_records", 0):
        problems.append("predicted records are not partitioned into matched, duplicated and extra")
    parts = (g("tp", 0) + g("wrong_values", 0) + g("missed_as_absent", 0) + g("unresolved_fields", 0)
             + g("omitted_fields", 0) + g("withheld_fields", 0) + g("excluded_values", 0) + g("fn_missing_record", 0))
    if parts != g("gold_value_fields", 0):
        problems.append(f"gold value fields {g('gold_value_fields', 0)} are not partitioned by outcomes ({parts})")
    if not g("ev_joint", 0) <= g("ev_value_correct", 0) <= g("ev_predicted", 0) <= g("ev_gold_fields", 0):
        problems.append("evidence counts are not nested: joint <= correct <= predicted <= annotated")
    if not g("ev_span_hit", 0) <= g("ev_cited", 0) <= g("ev_predicted", 0):
        problems.append("evidence hits exceed citations or predictions")
    return problems


def bootstrap(per_group: dict[str, dict], statistic, *, draws: int = 2000, seed: int = 20260930) -> dict:
    """Percentile interval of `statistic(pooled counts)` resampling whole groups (documents of one source together)."""
    names = sorted(per_group)
    point = statistic(pool(list(per_group.values())))
    if len(names) < 2:
        return {"point": point, "interval": None, "groups": len(names), "note": "fewer than two groups"}
    rng = np.random.default_rng(seed)
    samples = []
    for _ in range(draws):
        chosen = rng.choice(len(names), size=len(names), replace=True)
        value = statistic(pool([per_group[names[k]] for k in chosen]))
        if value is not None:
            samples.append(value)
    low, high = np.percentile(samples, [2.5, 97.5]) if samples else (None, None)
    return {"point": point, "interval": None if low is None else [float(low), float(high)], "groups": len(names),
            "draws": draws, "used_draws": len(samples), "seed": seed, "unit": "group"}


def score_structured(case: Case, pred: dict, rules: Eval) -> tuple[dict, list[dict]]:
    """Score nested document fields and repeated object arrays through the same record scorer.

    Flatten only evaluation views, retaining original arrays/annotations on Case. Parent records
    are aligned first; their nested arrays are then scored within that parent, never across parents.
    A collection no gold record annotates is unscored under every parent, paired or not (`unscored_records`). An unpaired
    parent's collection is scored only where its annotation is known: a duplicate takes its gold record's, an extra one is
    known only when every gold parent at that place annotates it (else `unknown_availability_records`, also unscored); the
    parent itself stays duplicated or spurious. Explicit null or [] is an annotated empty collection, never unannotated.
    Every count is also kept per collection path (`path|<label>|<count>`), so one path's gain cannot hide another's loss.
    This custom, strict leaf comparator is deliberately not the official keyless benchmark metric.
    """
    from dataclasses import replace
    from kei_exp.kie.extract.schema import Node

    annotation = case.annotations
    field_rules = annotation["field_rules"]
    original_rows = {(r["record"], r["field"]): r for r in pred["fields"]}
    totals, outcomes = [], []
    source = case.inference()

    def leaf_nodes(nodes, prefix=""):
        result = []
        for node in nodes:
            name = prefix + node.name
            if node.type == "object":
                result.extend(leaf_nodes(node.children, name + "."))
            elif node.type != "array" or node.item_type:
                result.append(node.model_copy(update={"name": name}))
        return result

    missing = object()

    def get(value, path, default=None):
        for part in path.split("."):
            if value is None:
                return None
            if not isinstance(value, dict) or part not in value:
                return default
            value = value[part]
        return value

    def gold_field(value, path):
        if value is missing:
            return {}
        rule = field_rules.get(path, {})
        options = rule.get("evidence", [])
        # Parent array evidence contains record objects, not alternate whole-array values.
        alternatives = [e["value"] for e in options if e.get("value") is not None and not isinstance(e["value"], (dict, list))]
        if value is None:
            return {"absent": True, "accepted_values": alternatives, "accepted_evidence": options}
        return {"value": value, "accepted_values": alternatives, "accepted_evidence": options,
                "annotation_availability": {"value": True, "page": any(e.get("page") is not None for e in options),
                    "box": any(e.get("page") is not None and e.get("bbox") is not None for e in options)}}

    def arrays(fields, prefix=""):      # object arrays, including those nested in scalar objects
        for node in fields:
            path = prefix + node.name
            if node.type == "array" and node.children:
                yield path, node.children
            elif node.type == "object":
                yield from arrays(node.children, path + ".")

    def items(value, path):
        values = get(value, path) or []
        return [v for v in values if isinstance(v, dict)] if isinstance(values, list) else []

    annotated_collections = set()       # collection paths some gold record annotates; the rest are unscored everywhere
    partly_annotated = set()            # ... and those some other gold record at the same place leaves unannotated
    by_path = defaultdict(lambda: defaultdict(int))     # the same counts per collection path, so paths never offset

    def annotated(nodes, records, label):
        for path, children in arrays(nodes):
            found = [v for r in records if (v := get(r, path, missing)) is not missing]
            if found:
                annotated_collections.add(f"{label}.{path}")
                if len(found) < len(records):
                    partly_annotated.add(f"{label}.{path}")
                annotated(children, [x for v in found if isinstance(v, list) for x in v if isinstance(x, dict)], f"{label}.{path}")

    def unit(nodes, gold_records, predicted, paths, evidence_rows, label, exhaustive=True):
        leaves = leaf_nodes(nodes)
        if not leaves:
            # A structure-only parent has no scalar annotations; its arrays are still evaluated below.
            leaves = [Node(id="structure", name="__structure__", type="boolean")]
        schema = Schema(recordDescription="Evaluator-only flattened record", schemaNodes=leaves)
        gold = []
        for i, record in enumerate(gold_records):
            fields = {n.name: gold_field(get(record, n.name, missing), paths[i] + n.name) for n in leaves}
            pages = {e["page"] for f in fields.values() for e in f.get("accepted_evidence", []) if e.get("page") is not None}
            gold.append({"fields": fields, "cross_page": len(pages) > 1})
        rows = []
        for i, value in enumerate(predicted):
            for n in leaves:
                parent = evidence_rows[i].get(n.name.split(".")[0], {})
                v = get(value, n.name)
                raw_parent = parent.get("raw", parent.get("value"))
                suffix = n.name.split(".", 1)
                raw = get(raw_parent, suffix[1]) if len(suffix) > 1 else raw_parent
                rows.append({**parent, "record": i, "field": n.name, "value": v, "raw": raw,
                             "status": "value" if v is not None else parent.get("status", "absent") if parent.get("status") in
                             ("omitted", "unresolved", "unsupported") else "absent"})
        virtual = Case(case.id, case.group, case.split, source.evidence, schema, tuple(gold),
                       exhaustive=exhaustive, annotations={"fixed_document_root": label == "document"})
        prediction = {"records": predicted, "fields": rows}
        policy = dict(rules.comparators)
        for n in leaves:
            # Date conversion is enabled by the dataset's documented field rule, never by observed model errors.
            comparators = {field_rules.get(p + n.name, {}).get("comparator") for p in paths}
            if comparators == {"date"}:
                policy[n.name] = "date"
        local_rules = replace(rules, comparators=policy)
        count, result = score_case(virtual, prediction, local_rules)
        if label != "document":
            count.update({"repeated_" + key: count.get(key, 0) for key in ("gold_records", "pred_records", "matched_records", "missing_records", "duplicated_records", "hallucinated_records", "strict_records", "cross_page_gold", "cross_page_strict")})
        totals.append(count)
        for key, value in [*count.items(), ("units", 1)]:
            by_path[label][key] += value
        outcomes.extend({**o, "collection": label} for o in result)
        pairs, duplicates, extra = _match(virtual, gold, _Records(prediction, local_rules), kinds_for(schema, local_rules), local_rules)
        paired = {j: i for i, j in pairs.items()}

        def unscored(path, n, key="unscored_records"):
            for counter in (count, by_path[path]):
                counter[key] = counter.get(key, 0) + n
        for array_path, children in arrays(nodes):
            path = f"{label}.{array_path}"
            for j, record in enumerate(gold_records):
                i = paired.get(j)
                annotated = get(record, array_path, missing)
                if annotated is missing:
                    count["unannotated_collections"] = count.get("unannotated_collections", 0) + 1
                    unscored(path, len(items(predicted[i], array_path)) if i is not None else 0)
                    continue
                gold_array = annotated or []
                values = (get(predicted[i], array_path) or []) if i is not None else []
                if not isinstance(values, list):
                    values = []
                owner = evidence_rows[i].get(array_path.split(".")[0], {}) if i is not None else {}
                raw_array = owner.get("raw")
                if "." in array_path:
                    raw_array = get(raw_array, array_path.split(".", 1)[1])
                raw_array = raw_array if isinstance(raw_array, list) else []
                nested_rows = [{n.name: {**owner, "raw": (raw_array[k].get(n.name) if k < len(raw_array) and isinstance(raw_array[k], dict) else None),
                                         "value": v.get(n.name)} for n in children}
                               for k, v in enumerate(values) if isinstance(v, dict)]
                values = [v for v in values if isinstance(v, dict)]
                unit(children, gold_array, values, [f"{paths[j]}{array_path}[{k}]." for k in range(len(gold_array))],
                     nested_rows, f"{label}.{array_path}", field_rules.get(paths[j] + array_path, {}).get("exhaustive", True))
            for i in [*extra, *duplicates]:     # an unpaired parent: its own spuriousness is already counted above
                values = items(predicted[i], array_path)
                if i in duplicates:             # a copy of a gold record has that record's annotation availability
                    known = get(gold_records[duplicates[i]], array_path, missing) is not missing
                else:                           # an extra one has no gold record: known only if every gold parent agrees
                    known = path in annotated_collections and path not in partly_annotated
                if values and not known:
                    unscored(path, len(values))
                    if path in partly_annotated and i not in duplicates:
                        unscored(path, len(values), "unknown_availability_records")
                elif values:
                    owner = evidence_rows[i].get(array_path.split(".")[0], {})
                    unit(children, [], values, [], [{n.name: {**owner, "raw": v.get(n.name), "value": v.get(n.name)} for n in children} for v in values], label + "." + array_path)
    annotated(case.schema.record_nodes, [annotation["expected_output"]], "document")
    unit(case.schema.record_nodes, [annotation["expected_output"]], pred["records"], [""],
         [{n.name: original_rows.get((i, n.name), {}) for n in case.schema.record_nodes} for i in range(len(pred["records"]))], "document")
    total = pool(totals)
    total |= {f"path|{path}|{key}": value for path, counts in by_path.items() for key, value in counts.items()}
    total["documents"] = total["raw_documents"] = 1
    total["strict_documents"] = int(all(c.get("strict_documents") for c in totals))
    total["raw_strict_documents"] = int(all(c.get("raw_strict_documents") for c in totals))
    for key, value in (pred.get("validity") or {}).items():
        total[f"replies_{key}"] = value
    for side in ("fresh", "replayed"):
        for key, value in ((pred.get("cost") or {}).get(side) or {}).items():
            total[f"{side}_{key}"] = value
    return total, outcomes
