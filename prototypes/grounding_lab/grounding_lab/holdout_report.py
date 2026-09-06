"""Report frozen paired predictions against adjudicated labels; never fit a model."""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean

from .evaluation_labels import evidence_correct, evidence_sets
from .holdout_evaluation import output_files, read, verify_freeze, write

QUOTE_REVIEW_PRIORITY = {"missing": 0, "not_found": 0, "mapping_failure": 0, "ambiguous": 1, "mapped": 2}


def quote_order(row, *, retained=False):
    path = tuple((0, part) if isinstance(part, int) else (1, part) for part in row["path"])
    priority = row["quoteReviewPriority"]
    return (-priority if retained else priority), path, row.get("family", "")


def quantiles(values):
    ordered = sorted(values)
    return {"n": len(ordered), **{f"p{p}": ordered[math.ceil(p/100*len(ordered))-1] if ordered else None for p in (50, 95, 99)}}


def metrics(rows):
    resolved = [r for r in rows if r["resolved"]]
    return {
        "claims": len(rows), "resolved": len(resolved), "unresolved": len(rows)-len(resolved),
        "diagnosticClaims": sum(r.get("diagnosticOnly", False) for r in rows),
        "supported": sum(r["supported"] for r in resolved),
        "supportedWithoutCanonicalEvidence": sum(r.get("supportedWithoutCanonicalEvidence", False) for r in resolved),
        "correctEvidence": sum(r["correctEvidence"] for r in resolved),
        "unsupportedProposals": sum(not r["supported"] and bool(r["proposed"]) for r in resolved),
        "wrongEvidenceSupported": sum(r["supported"] and bool(r["proposed"]) and not r["correctEvidence"] for r in resolved),
        "missingEvidenceSupported": sum(r["supported"] and not r["proposed"] for r in resolved),
        "ambiguous": sum(r.get("ambiguous", False) for r in resolved),
    }


def routing_metrics(rows):
    routed = [r for r in rows if "routingDecision" in r]
    if not routed:
        return {}
    resolved = [r for r in routed if r["resolved"]]
    linked = [r for r in resolved if r["routingDecision"] == "linked"]
    return {**{route: sum(r["routingDecision"] == route for r in routed) for route in ("linked", "review", "abstain")},
            "resolvedLinked": len(linked), "unresolved": len(routed)-len(resolved),
            "correctLinkedEvidence": sum(r["linkedEvidenceCorrect"] for r in linked),
            "unsupportedLinked": sum(not r["supported"] for r in linked),
            "wrongLinkedEvidenceSupported": sum(r["supported"] and not r["linkedEvidenceCorrect"] for r in linked),
            "linkPrecision": mean(r["linkedEvidenceCorrect"] for r in linked) if linked else None,
            "unsupportedReviewedOrAbstained": sum(not r["supported"] and r["routingDecision"] != "linked" for r in resolved),
            "supportedReviewedOrAbstained": sum(r["supported"] and r["routingDecision"] != "linked" for r in resolved)}


def queue_metrics(rows):
    result = {}
    for name, risk, error in (
        ("joint", "reviewRiskScore", lambda r: not r["correctEvidence"]),
        ("value", "valueRiskScore", lambda r: not r["supported"]),
    ):
        eligible = [r for r in rows if r["resolved"] and (r.get(risk) is not None or "quoteReviewPriority" in r)]
        if not eligible:
            continue
        ordinal = all("quoteReviewPriority" in r for r in eligible)
        ranked = sorted(eligible, key=quote_order if ordinal else lambda r: (-r[risk], json.dumps(r["path"])))
        errors = sum(error(r) for r in eligible)
        result[name] = {"ranking": "frozen quote status order" if ordinal else risk, **{f"at{k}": {"precision": mean(error(r) for r in ranked[:k]),
                                     "recall": sum(error(r) for r in ranked[:k])/errors if errors else None}
                        for k in (1, 3, 5)}}
    return result


def diagnostics(rows):
    output = {}
    for name, risk, target, eligible in (
        ("value", "valueRiskScore", lambda r: r["supported"], lambda r: True),
        ("evidence", "evidenceRiskScore", lambda r: r["correctEvidence"], lambda r: r["supported"] and bool(r["proposed"])),
        ("joint", "reviewRiskScore", lambda r: r["correctEvidence"], lambda r: True),
    ):
        selected = [r for r in rows if r["resolved"] and eligible(r) and r.get(risk) is not None]
        if not selected:
            continue
        bins = []
        for index, lower in enumerate((0, .2, .4, .6, .8)):
            members = [r for r in selected if min(4, int((1-r[risk])*5)) == index]
            bins.append({"lower": lower, "n": len(members), "predicted": mean(1-r[risk] for r in members) if members else None,
                         "observed": mean(target(r) for r in members) if members else None})
        output[name] = {"n": len(selected), "brier": mean(((1-r[risk])-target(r))**2 for r in selected), "reliability": bins}
    return output


def record_scope(result, expected):
    records = result.get("records", [])
    expected_count = expected.get("expected_record_count") if expected else None
    expected_ids = [r.get("catalogue_id") for r in expected.get("records", [])] if expected else None
    emitted_ids = [r.get("catalogue_id") for r in records]
    return {"emittedRecords": len(records), "expectedRecords": expected_count,
            "recordCountMatches": len(records) == expected_count if expected_count is not None else None,
            "emittedCatalogueIds": emitted_ids, "expectedCatalogueIds": expected_ids,
            "catalogueIdSequenceMatches": emitted_ids == expected_ids if expected_ids is not None else None,
            "interpretation": "Count and literal catalogue-ID order only; matching does not prove eligibility or disambiguate subrecords."}


def attempt_metrics(attempts):
    output = {"plannedExtractions": len(attempts),
              "diagnosticOutputs": sum(a.get("diagnosticOnly", False) for a in attempts),
              "literalScopeMismatches": sum(a.get("recordScope", {}).get("recordCountMatches") is False or a.get("recordScope", {}).get("catalogueIdSequenceMatches") is False for a in attempts),
              "scopeUnassessed": sum(a.get("recordScope", {}).get("recordCountMatches") is None or a.get("recordScope", {}).get("catalogueIdSequenceMatches") is None for a in attempts),
              **{status: sum(a["status"] == status for a in attempts) for status in ("complete", "failed", "incomplete", "notExecuted")},
              "elapsedSeconds": quantiles([a["elapsedSeconds"] for a in attempts if a.get("elapsedSeconds") is not None])}
    for key in ("extractionModelCalls", "rerankerCalls", "promptTokens", "outputTokens"):
        known = [a[key] for a in attempts if a.get(key) is not None]
        output[key] = {"reportedTotal": sum(known), "attemptsWithUnknownUsage": len(attempts)-len(known)}
    return output


def summarize(all_rows, latency):
    grouped = defaultdict(list)
    for row in all_rows:
        grouped[(row["arm"], row["family"])].append(row)
    per_family = [{"arm": arm, "family": family, **metrics(rows), "review": queue_metrics(rows), "routing": routing_metrics(rows)} for (arm, family), rows in grouped.items()]
    pooled, macros = [], []
    for arm in sorted({r["arm"] for r in all_rows}):
        rows = [r for r in all_rows if r["arm"] == arm]
        groups = [r for r in per_family if r["arm"] == arm]
        curves = []
        ranked = sorted((r for r in rows if r["resolved"] and r.get("reviewRiskScore") is not None), key=lambda r: r["reviewRiskScore"])
        ordinal = any("quoteReviewPriority" in r for r in rows)
        if ordinal:
            ranked = sorted((r for r in rows if r["resolved"] and "quoteReviewPriority" in r), key=lambda r: quote_order(r, retained=True))
        for coverage in (.1, .25, .5, .75, 1):
            selected = ranked[:max(1, math.ceil(coverage*len(ranked)))]
            if selected:
                curves.append({"coverage": len(selected)/len(ranked), "n": len(selected), "observedJointRisk": mean(not r["correctEvidence"] for r in selected)})
        pooled.append({"arm": arm, **metrics(rows), "routing": routing_metrics(rows), "diagnostics": diagnostics(rows), "riskCoverage": curves,
                       "riskCoverageOrdering": "reversed frozen quote status order" if ordinal else "reviewRiskScore ascending",
                       "latencySeconds": quantiles([r["seconds"] for r in latency if r["arm"] == arm])})
        macros.append({"arm": arm, "families": len(groups),
                       "valueSupportRate": mean(g["supported"]/g["resolved"] for g in groups if g["resolved"]) if any(g["resolved"] for g in groups) else None,
                       "correctEvidenceRate": mean(g["correctEvidence"]/g["resolved"] for g in groups if g["resolved"]) if any(g["resolved"] for g in groups) else None,
                       "review": {queue: {f"at{k}": {stat: mean(values) if (values := [g["review"][queue][f"at{k}"][stat] for g in groups if queue in g["review"] and g["review"][queue][f"at{k}"][stat] is not None]) else None for stat in ("precision", "recall")} for k in (1,3,5)} for queue in ("joint", "value")}})
    return {"perFamily": per_family, "pooled": pooled, "macro": macros, "latency": latency}


def build(root: Path) -> dict:
    verify_freeze(root)
    review_order = read(root / "review-order.json")
    if review_order["priorityByStatus"] != QUOTE_REVIEW_PRIORITY:
        raise ValueError("quote review-order addendum does not match reporting implementation")
    sources = read(root / "holdout/sources.json")
    statuses = {s["family"]: s.get("untouchedStatus", "unknown") for s in sources}
    all_rows, latency, attempts = [], [], []
    for extraction_arm in ("baseline", "quote"):
        for family in sorted(statuses):
            run = root / "runs" / extraction_arm / family
            meta = read(run / "extracted_meta.json") if (run / "extracted_meta.json").exists() else {}
            complete = bool(meta.get("complete")) and not meta.get("error")
            status = "complete" if complete else "failed" if meta.get("error") else "incomplete" if meta or (run / "prepared.json").exists() else "notExecuted"
            usage = meta.get("metadata") or {}
            grounding = read(run / "grounding_meta.json") if (run / "grounding_meta.json").exists() else {}
            output = output_files(run)
            diagnostic_only = bool(output and output[2])
            attempt = {"family": family, "arm": extraction_arm, "untouchedStatus": statuses[family], "status": status,
                       "diagnosticOnly": diagnostic_only,
                       "error": meta.get("error"), "elapsedSeconds": meta.get("elapsedSeconds"),
                       "extractionModelCalls": meta.get("modelCalls", 0 if status == "notExecuted" else None),
                       "rerankerCalls": grounding.get("calls", 0 if not complete else None),
                       "promptTokens": usage.get("promptTokens", 0 if status == "notExecuted" else None),
                       "outputTokens": usage.get("outputTokens", 0 if status == "notExecuted" else None)}
            attempts.append(attempt)
            if output is None:
                continue
            expected_path = root / "holdout" / family / "expected_records.json"
            attempt["recordScope"] = record_scope(read(output[0]), read(expected_path) if expected_path.exists() else None)
            labels = read(run / "claims_extracted.json")
            proposals = {tuple(r["path"]): r for r in (json.loads(s) for s in (run / "e-proposals.jsonl").read_text(encoding="utf-8").splitlines())}
            quotes = {tuple(r["resultPath"]): r for r in read(output[1])} if extraction_arm == "quote" else {}
            for policy in ("E", "quote-only") if extraction_arm == "quote" else ("E",):
                arm = f"{extraction_arm}/{policy}"
                latency.append({"family": run.name, "arm": arm,
                                "seconds": meta["elapsedSeconds"] + (grounding["durationSeconds"] if policy == "E" else 0),
                                "extractionModelCalls": meta["modelCalls"], "rerankerCalls": grounding["calls"] if policy == "E" else 0,
                                "usage": meta.get("metadata"), "complete": complete, "attemptStatus": status, "diagnosticOnly": diagnostic_only})
                for label in labels:
                    path = tuple(label["resultPath"])
                    raw = proposals[path]
                    if policy == "E":
                        proposed = [raw["bestCandidateAnchorId"]] if raw["bestCandidateAnchorId"] else []
                        ambiguous = False
                    else:
                        quote = quotes[path]
                        ambiguous = quote["status"] == "ambiguous"
                        proposed = quote["proposedAnchorSets"][0] if quote["status"] == "mapped" else []
                    gold = evidence_sets(label)
                    supported = label.get("supported", bool(gold))
                    routing = {}
                    if policy == "E":
                        decision, linked = raw["routingDecision"], raw["linkedAnchorId"]
                        if decision not in {"linked", "review", "abstain"} or (decision == "linked") != bool(linked):
                            raise ValueError(f"inconsistent frozen routing: {run}/{path}")
                        routing = {"routingDecision": decision, "linkedAnchorId": linked,
                                   "linkedEvidenceCorrect": evidence_correct([linked] if linked else [], gold)}
                    all_rows.append({"family": run.name, "arm": arm, "path": list(path), "value": label["value"],
                                     "diagnosticOnly": diagnostic_only, "attemptStatus": status,
                                     "supported": supported, "supportedWithoutCanonicalEvidence": supported and not gold,
                                     "goldAnchorSets": gold, "proposed": proposed,
                                     "correctEvidence": evidence_correct(proposed, gold),
                                     "resolved": label.get("labelStatus", "resolved") == "resolved", "ambiguous": ambiguous, **routing,
                                     **({k: raw[k] for k in ("valueRiskScore", "evidenceRiskScore", "reviewRiskScore")} if policy == "E" else
                                        {"quoteMappingStatus": quote["status"], "quoteReviewPriority": QUOTE_REVIEW_PRIORITY[quote["status"]]})})
    full = summarize(all_rows, latency)
    for row in full["perFamily"]:
        row["untouchedStatus"] = statuses[row["family"]]
    untouched = {family for family, status in statuses.items() if status == "untouched"}
    strict = summarize([r for r in all_rows if r["family"] in untouched], [r for r in latency if r["family"] in untouched])
    conforming_rows = [r for r in all_rows if not r["diagnosticOnly"]]
    conforming_latency = [r for r in latency if not r["diagnosticOnly"]]
    conforming = summarize(conforming_rows, conforming_latency)
    strict["conforming"] = summarize([r for r in conforming_rows if r["family"] in untouched], [r for r in conforming_latency if r["family"] in untouched])
    strict.update({"families": sorted(untouched), "excludedFamilies": {f: s for f, s in statuses.items() if f not in untouched},
                   "attemptTotals": attempt_metrics([a for a in attempts if a["family"] in untouched])})
    paired = sorted({a["family"] for a in attempts if a["arm"] == "baseline" and a["status"] == "complete"}
                    & {a["family"] for a in attempts if a["arm"] == "quote" and a["status"] == "complete"})
    return {**full, "conforming": conforming, "untouched": strict, "pairedConformingFamilies": paired, "attempts": attempts, "attemptTotals": attempt_metrics(attempts), "quoteReviewOrder": review_order,
            "failures": read(root / "failures.json"), "outcomes": all_rows,
            "limitations": ["Four source families; empirical tails are not production latency estimates.",
                            "Value-support rates evaluate emitted populated scalars; they do not measure recall of source attributes omitted or returned null.",
                            "Strictly untouched summaries include only families marked untouched by the source-only overlap audit; transfer and pending families remain in all-family results.",
                            "Attempt totals count each physical extraction once; quote/E and quote-only reuse the same extraction. Unknown failed-run token usage remains unknown.",
                            "All-output summaries retain every labeled value recovered from a typed over-record-limit failure as diagnosticOnly. Conforming summaries exclude those outputs; original attempts and failure counts remain failed.",
                            "Extraction latency excludes one-time PDF parsing and warmed reranker model loading; E includes its measured per-Extraction grounding time.",
                            "A supported value without canonical gold anchors is reported as evidence loss, not a semantic extraction error.",
                            "First-20 scope diagnostics compare source-manifest counts and literal catalogue IDs; matching is not proof of record eligibility or subrecord identity.",
                            "Conforming summaries mean runner-valid completion, types and record limit; they do not certify correct first-20 record selection.",
                            "Labels are independent model judgments with adjudication, not human ground truth.",
                            "Correct evidence requires exact equality with an acceptable anchor set; partial or broader sets do not count.",
                            "Core phase latency sums generation/mapping and E scoring; it excludes risk-sidecar computation and outcome serialization. WORKFLOW_TIMINGS.md reports broader observed file-boundary spans with archived timestamps and hashes; neither is a single integrated production request.",
                            "E reports proposed best candidates, including candidates below legacy acceptance thresholds; none are auto-accepted.",
                            "Separate routing summaries report the frozen linked/review/abstain decisions and correctness of linkedAnchorId; best-candidate proposal metrics do not replace them.",
                            "Quote-only review@1/3/5 uses the pre-label frozen ordinal status order; coverage reverses that priority. Quote-only Brier and reliability are unavailable because no probability is assigned."]}


def diagnostic_tables(report):
    """Render existing metric structures; do not alter ranking or recompute metrics."""
    cohorts = [("all outputs", report), ("conforming", report["conforming"]),
               ("untouched, all outputs", report["untouched"]),
               ("untouched, conforming", report["untouched"]["conforming"])]
    number = lambda value: "—" if value is None else f"{value:.3f}"
    percent = lambda value: "—" if value is None else f"{100*value:.1f}%"
    lines = ["", "## Family macro averages", "",
             "Conforming means runner-valid completion, types and record limit; it does not certify first-20 scope. All-output cohorts include flagged diagnostic failures.", "",
             "| cohort | arm | families | value support | correct evidence |",
             "|---|---|---:|---:|---:|"]
    for cohort, summary in cohorts:
        for row in summary["macro"]:
            lines.append(f"| {cohort} | {row['arm']} | {row['families']} | {percent(row['valueSupportRate'])} | {percent(row['correctEvidenceRate'])} |")
    lines += ["", "## Review workload", "",
              "Cells show precision / recall. Family rows rank within one Extraction; macro rows average those family results. Unresolved judgments are excluded. Joint error includes missing or incorrect evidence; value error means an unsupported value.", "",
              "| cohort / family | arm | target | review 1 | review 3 | review 5 |",
              "|---|---|---|---:|---:|---:|"]
    reviews = [(f"family {row['family']} (all outputs)", row) for row in report["perFamily"]]
    reviews += [(f"{cohort} macro", row) for cohort, summary in cohorts for row in summary["macro"]]
    for cohort, row in reviews:
        for target, queue in row["review"].items():
            cells = [f"{percent(queue[f'at{k}']['precision'])} / {percent(queue[f'at{k}']['recall'])}" for k in (1, 3, 5)]
            lines.append(f"| {cohort} | {row['arm']} | {target} | " + " | ".join(cells) + " |")
    lines += ["", "## Risk versus retained coverage", "",
              "Each cell shows observed joint-error rate (retained n; actual coverage). Columns are requested coverage levels; small samples may round upward. E retains low frozen risk scores first; quote-only retains mapped quotes first using the reversed frozen ordinal queue, without probabilities.", "",
              "| cohort | arm | 10% | 25% | 50% | 75% | 100% |",
              "|---|---|---|---|---|---|---|"]
    for cohort, summary in cohorts:
        for row in summary["pooled"]:
            cells = [f"{percent(point['observedJointRisk'])} (n={point['n']}; {percent(point['coverage'])})" for point in row["riskCoverage"]]
            lines.append(f"| {cohort} | {row['arm']} | " + " | ".join(cells if cells else ["—"]*5) + " |")
    lines += ["", "## Calibration diagnostics", "",
              "Brier scores and reliability treat one minus frozen E risk scores as predicted correctness, with no holdout fitting. Quote-only has no probability model, so its Brier and reliability are unavailable.", "",
              "| cohort | arm | target | n | Brier |",
              "|---|---|---|---:|---:|"]
    reliability = []
    for cohort, summary in cohorts:
        for row in summary["pooled"]:
            if not row["diagnostics"]:
                lines.append(f"| {cohort} | {row['arm']} | unavailable | — | — |")
            for target, values in row["diagnostics"].items():
                lines.append(f"| {cohort} | {row['arm']} | {target} | {values['n']} | {number(values['brier'])} |")
                cells = [f"{percent(bin['predicted'])} / {percent(bin['observed'])} (n={bin['n']})" for bin in values["reliability"]]
                reliability.append(f"| {cohort} | {row['arm']} | {target} | " + " | ".join(cells) + " |")
    lines += ["", "Reliability cells show mean predicted / observed correctness and sample count; empty bins remain unavailable.", "",
              "| cohort | arm | target | 0–20% | 20–40% | 40–60% | 60–80% | 80–100% |",
              "|---|---|---|---|---|---|---|---|", *reliability,
              "", "## Observed generation plus core-scoring latency", "",
              "Seconds; empirical nearest-rank quantiles, with one observation per source/arm. All-output cohorts include recovered diagnostic failures. One-time PDF parsing, warmed reranker loading, risk-sidecar computation and outcome serialization are excluded. E sums measured extraction/mapping and core scoring; quote-only adds no reranker call. Broader workflow spans, including risk and audit-file work, are reported in [WORKFLOW_TIMINGS.md](WORKFLOW_TIMINGS.md) with timestamp provenance.", "",
              "| cohort | arm | n | p50 | p95 | p99 |",
              "|---|---|---:|---:|---:|---:|"]
    for cohort, summary in cohorts:
        for row in summary["pooled"]:
            timing = row["latencySeconds"]
            lines.append(f"| {cohort} | {row['arm']} | {timing['n']} | " + " | ".join(number(timing[f"p{p}"]) for p in (50, 95, 99)) + " |")
    return lines


def labeling_summary(root, families):
    summaries = []
    for family in sorted(families):
        blind = root / "blind" / family
        rows = {}
        for name in ("labels-a", "labels-b", "disagreements", "adjudicated", "final-labels"):
            path = blind / f"{name}.json"
            rows[name] = read(path) if path.exists() else None
        final = rows["final-labels"]
        summaries.append({"family": family, **{name: len(values) if values is not None else None for name, values in rows.items()},
                          "unresolved": sum(row.get("status", "resolved") == "unresolved" for row in final) if final is not None else None,
                          "provenance": f"blind/{family}/"})
    return summaries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    report = build(args.root)
    report["labeling"] = labeling_summary(args.root, {a["family"] for a in report["attempts"]})
    write(args.root / "evaluation.json", report)
    lines = ["# Frozen four-family grounding comparison", "", "All labeled populated values are reported, including flagged recovered outputs from failed attempts. Original failures remain failed. No auto-accept.", "",
             "| arm | family | claims | diagnostic claims | supported | supported without canonical evidence | correct evidence | unsupported proposals | wrong evidence | missing evidence | unresolved |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in report["perFamily"] + [{**r, "family": "all-output pooled"} for r in report["pooled"]] + [{**r, "family": "untouched all-output pooled"} for r in report["untouched"]["pooled"]] + [{**r, "family": "conforming pooled"} for r in report["conforming"]["pooled"]] + [{**r, "family": "untouched conforming pooled"} for r in report["untouched"]["conforming"]["pooled"]]:
        lines.append(f"| {r['arm']} | {r['family']} | {r['claims']} | {r['diagnosticClaims']} | {r['supported']} | {r['supportedWithoutCanonicalEvidence']} | {r['correctEvidence']} | {r['unsupportedProposals']} | {r['wrongEvidenceSupported']} | {r['missingEvidenceSupported']} | {r['unresolved']} |")
    lines += ["", "Frozen E routing (distinct from best-candidate proposals above; links still require review):", "",
              "| arm | family | linked | review | abstain | correct linked evidence | unsupported linked | wrong linked evidence |",
              "|---|---|---:|---:|---:|---:|---:|---:|"]
    for row in report["perFamily"] + [{**r, "family": "all-family pooled"} for r in report["pooled"]] + [{**r, "family": "untouched pooled"} for r in report["untouched"]["pooled"]]:
        routing = row["routing"]
        if routing:
            lines.append(f"| {row['arm']} | {row['family']} | " + " | ".join(str(routing[key]) for key in ("linked", "review", "abstain", "correctLinkedEvidence", "unsupportedLinked", "wrongLinkedEvidenceSupported")) + " |")
    lines += ["", f"Strictly untouched families: {', '.join(report['untouched']['families']) or 'none confirmed'}.",
              f"Families with two runner-valid arms: {', '.join(report['pairedConformingFamilies']) or 'none'}. Pooled arm results can contain different families; use the per-family comparisons to distinguish grounding from extraction and failure effects.",
              "Excluded from strictly untouched summaries: " + "; ".join(f"{family}: {status}" for family, status in report["untouched"]["excludedFamilies"].items()) + ".", "",
              "| extraction arm | family | status | diagnostic output | records / expected | extraction seconds | model calls | reranker calls | input tokens | output tokens |",
              "|---|---|---|---|---|---:|---:|---:|---:|---:|"]
    display = lambda value: "unknown" if value is None else str(value)
    for attempt in report["attempts"]:
        scope = attempt.get("recordScope", {})
        lines.append(f"| {attempt['arm']} | {attempt['family']} | {attempt['status']} | {attempt['diagnosticOnly']} | {display(scope.get('emittedRecords'))} / {display(scope.get('expectedRecords'))} | {display(attempt['elapsedSeconds'])} | "
                     + " | ".join(display(attempt[key]) for key in ("extractionModelCalls", "rerankerCalls", "promptTokens", "outputTokens")) + " |")
    total = report["attemptTotals"]
    lines += ["", f"Planned holdout extractions: {total['plannedExtractions']}; complete: {total['complete']}; failed: {total['failed']}; incomplete: {total['incomplete']}; not executed: {total['notExecuted']}."]
    lines += [f"Literal first-20 scope mismatches: {total['literalScopeMismatches']}; unassessed: {total['scopeUnassessed']}. Scope mismatches can overlap generation failures and are not added to the failure count."]
    lines += ["", "Physical holdout usage totals count each extraction once, even when both E and quote-only are evaluated.", "",
              "| usage | reported total | attempts with unknown usage |", "|---|---:|---:|"]
    for key in ("extractionModelCalls", "rerankerCalls", "promptTokens", "outputTokens"):
        lines.append(f"| {key} | {total[key]['reportedTotal']} | {total[key]['attemptsWithUnknownUsage']} |")
    lines += ["", "## First-20 scope checks", "",
              "Literal catalogue-ID comparison is a diagnostic, not semantic matching. A runner-valid output can still choose the wrong records.", "",
              "| family | extraction arm | record count matches | catalogue-ID sequence matches | emitted IDs | expected IDs |",
              "|---|---|---|---|---|---|"]
    for attempt in report["attempts"]:
        scope = attempt.get("recordScope", {})
        ids = lambda values: "—" if values is None else ", ".join(str(v).replace("|", "\\|") for v in values)
        lines.append(f"| {attempt['family']} | {attempt['arm']} | {display(scope.get('recordCountMatches'))} | {display(scope.get('catalogueIdSequenceMatches'))} | {ids(scope.get('emittedCatalogueIds'))} | {ids(scope.get('expectedCatalogueIds'))} |")
    lines += diagnostic_tables(report)
    lines += ["", "## Labeling and adjudication", "",
              "Counts refer to anonymized distinct claims shared across extraction arms, so they need not equal summed arm counts. These are model judgments, not human ground truth; missing artifacts are shown as unknown.", "",
              "| family | labeler A | labeler B | disagreements | adjudicated | final | unresolved | provenance |",
              "|---|---:|---:|---:|---:|---:|---:|---|"]
    for row in report["labeling"]:
        lines.append(f"| {row['family']} | " + " | ".join(display(row[key]) for key in ("labels-a", "labels-b", "disagreements", "adjudicated", "final-labels", "unresolved")) + f" | [{row['provenance']}]({row['provenance']}) |")
    lines += ["", "Full family/macro/pooled diagnostics, review@1/3/5, reliability bins, risk/coverage and observed latency quantiles: `evaluation.json`.",
              "Quote-only review order was frozen before holdout labels in `review-order.json`; ordinal priorities are not probabilities.", ""]
    lines += [f"- {note}" for note in report["limitations"]]
    lines += [f"- Failed extraction: {f['family']}/{f['arm']}: {f['metadata'].get('error')}" for f in report["failures"]]
    (args.root / "EVALUATION.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
