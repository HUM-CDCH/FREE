"""Descriptive paired contrasts. Repeats are retained measurements, not additional documents."""
from pathlib import Path

from experiments.extraction.manifest import digest, read, write_new

from .evaluate import canonical
from .run import verify_run

OUTCOMES = {
    "field_precision": ("fields", "precision"), "field_recall": ("fields", "recall"),
    "exact_record_recall": ("records", "exact_recall"), "exact_unique_recall": ("records", "exact_unique_recall"),
    "duplicate_records": ("merge", "duplicate_records"),
    "object_evidence_recall": ("evidence", "objects", "recall"),
    "conditional_grounding_precision": ("evidence", "conditional_grounding", "precision"),
    "unique_evidence_recall": ("evidence", "unique_claims", "recall"),
    "value_contexts": ("cost", "value_contexts"), "calls": ("cost", "calls"),
    "input_tokens": ("cost", "input_tokens"), "output_tokens": ("cost", "output_tokens"),
}


def outcome(metrics, path):
    for part in path:
        metrics = metrics.get(part) if isinstance(metrics, dict) else None
    return metrics


def compare(dataset: Path, output: Path, baseline: str, variant: str, report: Path):
    manifest = verify_run(dataset, output)
    methods = {m["id"]: m for m in manifest["config"]["methods"]}
    if baseline == variant or baseline not in methods or variant not in methods:
        raise ValueError("choose two distinct registered methods")
    index = {(c["document"], c["provider"], c["repeat"], c["method"]): c for c in manifest["cells"]}
    pairs = []
    hashes = {}
    for document, provider, repeat in sorted({key[:3] for key in index}):
        measurements = {}
        for method in (baseline, variant):
            cell = index[document, provider, repeat, method]
            directory = output / "cells" / cell["id"]
            status = read(directory / "finished.json")["status"]
            metrics = read(directory / "metrics.json") if (directory / "metrics.json").exists() else {}
            if (directory / "cost.json").exists():
                metrics = {**metrics, "cost": read(directory / "cost.json")}
            measurements[method] = {"cell": cell["id"], "status": status,
                                    "outcomes": {name: outcome(metrics, path) for name, path in OUTCOMES.items()},
                                    "reprint_value_contexts": metrics.get("merge", {}).get("reprint_value_contexts", {})}
            if (directory / "artifact.json").exists():
                artifact = read(directory / "artifact.json")
                prediction = {key: artifact.get(key) for key in ("records", "evidence", "disagreements", "quoted_support")}
                hashes.setdefault((document, provider, method), {})[repeat] = digest(canonical(prediction).encode())
        left, right = (measurements[m]["outcomes"] for m in (baseline, variant))
        delta = {name: right[name] - left[name] if right[name] is not None and left[name] is not None else None
                 for name in OUTCOMES}
        bounded = [m for m in (baseline, variant) if methods[m]["options"].get("article", {}).get("context") == "bounded"]
        active = {m: (measurements[m]["outcomes"]["value_contexts"] >= 2
                      if measurements[m]["outcomes"]["value_contexts"] is not None else None) for m in bounded}
        pairs.append({"document": document, "provider": provider, "repeat": repeat, "measurements": measurements,
                      "variant_minus_baseline": delta, "bounded_multi_context": active})
    agreement = []
    for document, provider, method in sorted(hashes):
        observed = hashes[document, provider, method]
        agreement.append({"document": document, "provider": provider, "method": method,
                          "prediction_sha256_by_repeat": observed,
                          "all_registered_repeats_present": len(observed) == manifest["config"].get("repeats", 1),
                          "identical": len(set(observed.values())) == 1 if len(observed) > 1 else None})
    write_new(report, {"kind": "descriptive paired comparison, not independent repeat samples",
                       "baseline": methods[baseline], "variant": methods[variant],
                       "registered_documents": len(manifest["config"]["documents"]), "pairs": pairs,
                       "prediction_agreement": agreement,
                       "result_seal_sha256": digest((output / "seal.json").read_bytes())})
