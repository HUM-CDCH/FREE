"""Audit fixed-upstream grounding after exact replay, without new model work.

Run from the frozen Parsing Service source:
PYTHONPATH=src:. python /path/to/this.py STUDY_DIR REPLAY_JSON OUTPUT_JSON
The report retains failed/pending cells and emits unadjudicated link differences.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path

import kei_exp
import requests

from experiments.extraction.analyze import diagnostic, paired_interval
from experiments.extraction.manifest import checked, pin, read, validate, write_new
from kei_exp.kie.extract.evidence import load
from kei_exp.kie.extract.schema import Schema, evidence_policy
from kei_exp.kie.extract.stages import leaves


EFFECT_METRICS = ("linked_claims", "refused_claim_unit_pairs", "captured_requests",
                  "input_tokens_total", "output_tokens_total", "recorded_call_seconds")


def capture_cost(directory: Path, terminal: dict) -> dict:
    """Missing replies and unreported usage remain unknown, including failed cells."""
    requested = sorted((directory / "calls").glob("*.request.json"))
    replied = sorted((directory / "calls").glob("*.reply.json"))
    expected = {p.with_name(p.name.replace(".request.json", ".reply.json")) for p in requested}
    if set(replied) - expected or any(not p.name.startswith("reasoning-") for p in requested):
        raise ValueError("grounding captures contain an orphan reply or upstream call")
    replies = [read(p) for p in replied]
    missing = len(requested) - len(replies)
    uncertain = terminal["unknown_prior_completions"]
    result = {"captured_requests": len(requested), "saved_replies": len(replies),
        "requests_without_reply": missing, "recorded_call_seconds": sum(r["seconds"] for r in replies),
        "call_seconds_complete": missing == 0 and uncertain == 0,
        "fresh_calls_this_attempt": terminal["fresh_calls"],
        "reused_calls_this_attempt": terminal["reused_calls"],
        "unknown_prior_completions": terminal["unknown_prior_completions"],
        "wall_seconds_this_attempt": terminal["wall_seconds_this_attempt"],
        "claim_decisions_requested": sum(len(read(p)["schema"]["required"]) for p in requested)}
    for kind in ("input", "output"):
        values = [r[f"{kind}_tokens"] for r in replies]
        unknown = missing + uncertain + sum(value is None for value in values)
        result[f"{kind}_tokens_reported"] = sum(value for value in values if value is not None)
        result[f"{kind}_tokens_unknown_requests"] = unknown
        result[f"{kind}_tokens_total"] = None if unknown else sum(values)
    return result


def source_validity(artifact: dict, canonical, claims: dict) -> tuple[dict, dict]:
    """Check literal source ranges/geometry independently of the span constructor."""
    passages = {p.id: p for p in canonical.passages}
    proofs = defaultdict(list)
    kinds = Counter()
    for proof in artifact["quoted_support"]:
        path = tuple(proof["path"])
        passage = passages.get(proof["segment"])
        if path not in claims or passage is None or proof.get("attribution") != "model_attested":
            raise ValueError("proof names a foreign claim/source or lacks attestation")
        cells = {cell.cell_id: cell for cell in passage.table.cells} if passage.table else {}
        cell = cells.get(proof["cell"])
        if proof["cell"] is not None and cell is None:
            raise ValueError("proof names a noncanonical table cell")
        text = cell.text if cell else passage.text
        quote = proof["quote"]
        if not isinstance(quote, str) or not quote.strip() or quote not in text:
            raise ValueError("quote is not an exact canonical substring")
        if "span" in proof:
            start, end = proof["start"], proof["end"]
            if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(passage.text)
                    or passage.text[start:end] != quote
                    or (cell and (start, end, quote) != (cell.start, cell.end, cell.text))):
                raise ValueError("span offsets do not reconstruct the exact canonical occurrence")
            identity = passage.id + (f"/{cell.cell_id}" if cell else f"@{start}:{end}")
            if proof["span"] != identity:
                raise ValueError("span identity and occurrence disagree")
        elif len(quote) > 500:
            raise ValueError("generated quote exceeds its registered limit")
        kind = "table_cell" if cell else "table_passage" if passage.table or "table" in passage.label.lower() else "prose"
        proofs[path].append({**proof, "source_kind": kind, "page": passage.page})
        kinds[kind] += 1
    linked = set()
    for link in artifact["evidence"]:
        path = tuple(link["path"])
        passage = passages.get(link["segment"])
        if path in linked or passage is None:
            raise ValueError("duplicate claim link or noncanonical source")
        matching = [p for p in proofs[path] if p["segment"] == link["segment"]]
        if not matching:
            raise ValueError("retained link has no literal proof")
        cell = next((cell for cell in passage.table.cells if cell.cell_id == link["cell"]), None) if passage.table else None
        if link["cell"] is not None and (cell is None or cell.bbox_pt is None or not any(p["cell"] == cell.cell_id for p in matching)):
            raise ValueError("link claims unmeasured or unrelated cell geometry")
        box, precision = (cell.bbox_pt, "cell") if cell else (passage.bbox_pt, passage.precision)
        if link["page"] != passage.page or tuple(link["bbox_pt"]) != tuple(box) or link["precision"] != precision:
            raise ValueError("link geometry differs from canonical precision")
        linked.add(path)
    if linked != set(proofs):
        raise ValueError("proofs and retained claim links disagree")
    return {"status": "checked" if linked else "no_proofs", "proofs_checked": sum(kinds.values()), "by_source_kind": dict(kinds),
        "span_offsets_checked": sum("span" in p for p in artifact["quoted_support"]),
        "retained_links_checked": len(linked), "all_literal_locations_valid": True if linked else None,
        "semantic_precision": None, "evidence_recall": None,
        "semantic_status": "unavailable: no independent claim-source labels"}, dict(proofs)


def boolean_count(value) -> int:
    if isinstance(value, dict):
        return sum(boolean_count(child) for child in value.values())
    if isinstance(value, list):
        return sum(boolean_count(child) for child in value)
    return int(isinstance(value, bool))


def route_coverage(artifact: dict, claims: dict, contexts: int) -> dict | None:
    if "grounding_routes" not in artifact:
        return None
    skipped = {tuple(p["path"]) for p in artifact.get("grounding_eligibility", {}).get("skipped", [])}
    linked = {tuple(p["path"]) for p in artifact["evidence"]}
    routes = artifact["grounding_routes"]
    if len(routes) != len(claims) - len(skipped) or {tuple(r["path"]) for r in routes} != claims.keys() - skipped:
        raise ValueError("routes do not cover every policy-eligible claim")
    counts = Counter()
    for route in routes:
        units = route["attempted"] + route["refused"] + route["remaining"]
        supported = tuple(route["path"]) in linked
        expected = "stopped_after_support" if supported else "partial" if route["refused"] else "attempted_all"
        if (sorted(units) != list(range(contexts)) or sorted(route["order"]) != list(range(contexts))
                or route["supported"] != supported or route["coverage"] != expected
                or (not supported and route["remaining"])):
            raise ValueError("route attempts/refusals/remaining units do not reconcile")
        counts[expected] += 1
        for name in ("attempted", "refused", "remaining"):
            counts[f"{name}_claim_unit_pairs"] += len(route[name])
        counts["origin_attempts"] += sum(unit in route["origin_units"] for unit in route["attempted"])
        counts["non_origin_attempts"] += sum(unit not in route["origin_units"] for unit in route["attempted"])
        counts["supported_after_first_attempt"] += supported and len(route["attempted"]) > 1
    return dict(counts)


def completed_metrics(row: dict) -> dict:
    return {"linked_claims": row["diagnostics"]["linked_record_leaves"],
        "refused_claim_unit_pairs": row["refused_claim_unit_pairs"],
        **{name: row["cost"][name] for name in ("captured_requests", "input_tokens_total", "output_tokens_total")},
        "recorded_call_seconds": row["cost"]["recorded_call_seconds"] if row["cost"]["call_seconds_complete"] else None}


def document_effects(documents: list[dict], value_key: str) -> dict:
    """Resample paired documents, retaining metric-specific missingness explicitly."""
    effects = {}
    for metric in EFFECT_METRICS:
        included, excluded, values = [], [], []
        for document in documents:
            value = document.get(value_key, {}).get(metric)
            if value is None:
                excluded.append({"source": document["source"], "reason":
                    "incomplete_pair" if value_key not in document else "unknown_metric"})
            else:
                included.append(document["source"])
                values.append(value)
        interval = paired_interval(values) if len(values) > 1 else {
            "documents": len(values), "mean": values[0] if values else None,
            "percentile_95": None, "unit": "document"}
        effects[metric] = {**interval, "included_sources": included, "excluded_documents": excluded,
            "status": "available" if len(values) > 1 else "insufficient_documents" if values else "unavailable"}
    return {"registered_documents": len(documents), "metrics": effects,
        "scope": "Unweighted paired-document means, conditional on completed artifacts and known metrics; "
                 "not a full-cohort success or efficiency estimate. Read coverage and failures alongside costs."}


def comparison_rows(study: dict, rows: dict, proof_sets: dict, bundles: dict) -> tuple[list, list]:
    comparisons, queue = [], []
    for comparison in study["comparisons"]:
        pairs = []
        for source in study["sources"]:
            ids = [f"{source['id']}--{comparison[role]}--0" for role in ("control", "treatment")]
            control, treatment = (rows[cell] for cell in ids)
            pair = {"source": source["id"], "control": ids[0], "treatment": ids[1],
                    "statuses": [control["status"], treatment["status"]]}
            if not all(row["status"] == "completed" for row in (control, treatment)):
                pair["comparison"] = "unavailable: one or both cells have no verified completed artifact"
                pairs.append(pair)
                continue
            pair["comparison"] = "completed pair; cost must be interpreted with coverage"
            before_metrics, after_metrics = completed_metrics(control), completed_metrics(treatment)
            pair["deltas_treatment_minus_control"] = {key: after_metrics[key] - value
                if value is not None and after_metrics[key] is not None else None for key, value in before_metrics.items()}
            a, b = (proof_sets[cell] for cell in ids)
            changes = Counter()
            claims = {("records", n, *path): value for n, fields in enumerate(bundles[source["id"]]["fields"])
                      for path, value in leaves(fields)}
            for path in claims:
                before, after = a.get(path, []), b.get(path, [])
                if before == after:
                    continue
                change = "added" if not before else "dropped" if not after else "changed"
                changes[change] += 1
                queue.append({"source": source["id"], "control": ids[0], "treatment": ids[1],
                    "path": list(path), "value": claims[path], "change": change,
                    "before": before, "after": after, "status": "unadjudicated",
                    "review_axes": ["entailment", "subject", "table row/header", "unit", "qualifier"]})
            pair["link_changes"] = dict(changes)
            pairs.append(pair)
        comparisons.append({**comparison, "documents": pairs,
            "document_effects": document_effects(pairs, "deltas_treatment_minus_control")})
    return comparisons, queue


def interaction_rows(study: dict, rows: dict) -> list:
    results = []
    for interaction in study.get("interactions", []):
        documents = []
        for source in study["sources"]:
            selected = {role: rows[f"{source['id']}--{interaction[role]}--0"] for role in ("baseline", "a", "b", "ab")}
            item = {"source": source["id"], "statuses": {role: row["status"] for role, row in selected.items()}}
            if all(row["status"] == "completed" for row in selected.values()):
                metrics = {role: completed_metrics(row) for role, row in selected.items()}
                item["difference_of_differences"] = {key: metrics["ab"][key] - metrics["a"][key] - metrics["b"][key] + value
                    if all(metric[key] is not None for metric in metrics.values()) else None
                    for key, value in metrics["baseline"].items()}
            else:
                item["comparison"] = "unavailable: interaction needs four verified completed artifacts"
            documents.append(item)
        results.append({**interaction, "documents": documents,
            "document_effects": document_effects(documents, "difference_of_differences")})
    return results


def report(study: dict, cells: list[dict], output: Path, verification_path: Path) -> dict:
    verification = read(verification_path)
    if verification["manifest"] != pin(output / "manifest.json"):
        raise ValueError("grounding replay belongs to another manifest")
    verified = {item["cell"]: item for item in verification["cells"]}
    if len(verified) != len(verification["cells"]) or set(verified) != {cell["id"] for cell in cells}:
        raise ValueError("replay receipt must name every registered cell exactly once")
    rows, proof_sets, bundles = {}, {}, {}
    for source in study["sources"]:
        bundles[source["id"]] = read(checked(source["fixed_upstream"]))
    for cell in cells:
        item, directory = verified[cell["id"]], output / "cells" / cell["id"]
        row = {key: cell[key] for key in ("id", "source", "method", "repeat")}
        row["status"] = item["status"]
        bundle = bundles[cell["source"]]
        claims = {("records", n, *path): value for n, fields in enumerate(bundle["fields"]) for path, value in leaves(fields)}
        schema = Schema.model_validate(bundle["schema"])
        policy = cell["request"].options.article.evidence_policy == "schema"
        row["claim_denominators"] = {"all_enumerated": len(claims),
            "policy_eligible": sum(not policy or evidence_policy(schema.record_nodes, path[2:]) == "quoted" for path in claims),
            "excluded_booleans": boolean_count(bundle["fields"])}
        if item["status"] == "pending":
            if list(directory.glob("attempt-*.finished.json")) or (directory / "result.json").exists():
                raise ValueError("pending replay receipt is stale")
            rows[cell["id"]] = row
            continue
        terminal = read(checked(item["terminal"]))
        row["terminal"] = item["terminal"]
        if read(directory / "pin.json") != {"cell": cell["id"], "manifest_sha256": verification["manifest"]["sha256"]}:
            raise ValueError("grounding cell pin changed")
        if terminal != read(sorted(directory.glob("attempt-*.finished.json"))[-1]):
            raise ValueError("replay receipt precedes a later attempt")
        row["cost"] = capture_cost(directory, terminal)
        row["recorded_seconds_above_admission_limit"] = max(0, row["cost"]["recorded_call_seconds"]
            - study["grounding_study"]["model_seconds_per_cell"])
        row["captures"] = [pin(path) for path in sorted((directory / "calls").glob("*.json"))]
        if item["status"] in {"completed", "failed"}:
            if not item["exact_replay"] or row["captures"] != item["captures"]:
                raise ValueError("cell lacks exact replay or its captures changed")
            for probe in item["tokenizer_probes"]:
                checked(probe)
        if item["status"] == "completed":
            artifact = read(checked(item["result"]))["artifact"]
            source = next(source for source in study["sources"] if source["id"] == cell["source"])
            if (artifact["execution_scope"] != "grounding_on_fixed_upstream" or artifact["upstream"] != source["fixed_upstream"]
                    or any(artifact[key] != bundle[key] for key in ("records", "inventory", "contexts", "value_contexts", "conflicts"))):
                raise ValueError("grounding result changed frozen upstream content")
            canonical = load(Path(source["run"]))
            if (artifact["generation"], artifact["digest"]) != (canonical.generation, canonical.digest):
                raise ValueError("grounding result names a different canonical generation")
            row["diagnostics"] = diagnostic(artifact)
            if row["diagnostics"]["populated_record_leaves"] != len(claims):
                raise ValueError("claim denominator differs from fixed upstream")
            row["literal_validity"], proof_sets[cell["id"]] = source_validity(artifact, canonical, claims)
            row["route_coverage"] = route_coverage(artifact, claims, len(bundle["contexts"]))
            row["refused_claim_unit_pairs"] = sum(i["code"] == "grounding_exceeds_budget" for i in artifact["issues"])
            row["upstream_records_unchanged"] = True
        rows[cell["id"]] = row
    comparisons, queue = comparison_rows(study, rows, proof_sets, bundles)
    return {"study": study["id"], "manifest": pin(output / "manifest.json"), "verification": pin(verification_path),
        "reporter": pin(Path(__file__)), "expected_cells": len(cells),
        "cell_statuses": dict(Counter(row["status"] for row in rows.values())),
        "cells": list(rows.values()), "comparisons": comparisons,
        "interactions": interaction_rows(study, rows), "link_review_queue": queue,
        "limits": ["Fixed-upstream development comparison; no held-out documents or fresh upstream extraction.",
            "Pending cells have unavailable cost/coverage, never zero. Budget/infrastructure failures remain in the cohort.",
            "Capture totals include failed cells. Missing replies or unreported usage prevent a total-token claim.",
            "Recorded request durations include contention and network time; reused replies are not fresh speed measurements.",
            "Claim denominators exclude booleans and blank/null values; policy-eligible denominators remain separate.",
            "Literal source validity and changed links do not establish entailment, evidence recall or unsupported-link rate.",
            "Comparison deltas require two completed artifacts; failed/pending pairs remain explicitly unavailable.",
            "Percentile intervals resample paired documents with equal weight; exclusions are metric-specific. "
            "Fewer than two observed documents yield no interval. Small development-corpus intervals do not "
            "measure generalization, serving variability or uncertainty from missing/failed cells.",
            "Single greedy execution per cell; no estimate of serving variability. No production-default recommendation."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study", type=Path)
    parser.add_argument("verification", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    def forbidden(*_args, **_kwargs):
        raise AssertionError("HTTP disabled during grounding reporting")
    requests.Session.request = forbidden
    study = read(args.study / "manifest.json")
    cells = validate(study, Path(kei_exp.__file__).resolve().parents[2])
    write_new(args.output, report(study, cells, args.study, args.verification))


if __name__ == "__main__":
    main()
