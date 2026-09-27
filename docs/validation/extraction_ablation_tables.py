"""Render a sealed analysis snapshot as reviewable tables; no inference or rescoring.

Usage: python extraction_ablation_tables.py STUDY_DIR ANALYSIS ACCOUNTING OUTPUT.md
The accounting must name the exact analysis hash. Existing outputs are never replaced.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path


def table(headers, rows):
    def line(values):
        return "| " + " | ".join(str(v).replace("|", "\\|").replace("\n", " ") for v in values) + " |"
    return "\n".join([line(headers), line(["---"] * len(headers)), *[line(row) for row in rows]])


def render(manifest: dict, analysis: dict, accounting: dict, gold_sources: set[str]) -> str:
    expected = {f"{s['id']}--{method}--{repeat}" for s in manifest["sources"]
                for method in s["methods"] for repeat in range(manifest["repeats"])}
    rows = analysis["cells"]
    completed = {row["id"] for row in rows}
    missing = {row["cell"] for row in analysis["missing"]}
    if (analysis["study"] != manifest["id"] or accounting["study"] != manifest["id"]
            or completed & missing or completed | missing != expected
            or len(completed) != len(rows) or len(missing) != len(analysis["missing"])
            or analysis["expected_cells"] != len(expected) or analysis["completed_cells"] != len(rows)
            or set(accounting["cells"]) != completed or set(accounting["stage_costs"]) != completed):
        raise ValueError("snapshot coverage or study identities disagree")
    source_methods = {s["id"]: set(s["methods"]) for s in manifest["sources"]}
    for row in rows:
        if row["id"] != f"{row['source']}--{row['method']}--{row['repeat']}":
            raise ValueError("cell identity disagrees with its metadata")
        if (row["source"] in gold_sources) != ("accuracy" in row):
            raise ValueError("gold coverage disagrees with scored cells")
    text = [f"# {manifest['id']} — result tables", "",
            f"Snapshot: **{len(rows)}/{len(expected)} sealed cells**; **{len(missing)} missing**.", "",
            "A sealed cell can contain failed calls, refused input or incomplete grounding. "
            "This is a development-corpus comparison; gold is non-exhaustive and no held-out accuracy is estimated.", "",
            "## Registered coverage", "",
            table(["Method", "Sealed / registered", "Processing incomplete", "Processing status unreported"], [
                [method, f"{sum(r['method'] == method for r in rows)}/{sum(method in s['methods'] for s in manifest['sources']) * manifest['repeats']}",
                 sum(r["method"] == method and (r["completion"] or {}).get("processing") is False for r in rows),
                 sum(r["method"] == method and "processing" not in (r["completion"] or {}) for r in rows)]
                for method in manifest["methods"]]), "",
            "## Scored development cells", "",
            "Correct/total counts use the frozen gold projection. Populated-field accuracy is a lower bound: "
            "unresolved review items stay in its denominator. Empty-field correctness is shown separately. "
            "Unscored extra records are not assumed false positives.", "",
            table(["Cell", "Populated correct/total", "Needs review", "Empty correct/total", "Gold identities matched/total", "Duplicate identity groups", "Unscored extra records"], [
                [r["id"], f"{r['accuracy']['populated']['correct']}/{r['accuracy']['populated']['total']}",
                 r["accuracy"]["populated"]["needs_review"],
                 f"{r['accuracy']['empty']['correct']}/{r['accuracy']['empty']['total']}",
                 f"{r['identity_alignment'].get('matched', 0)}/{sum(r['identity_alignment'].values())}",
                 r["identity_alignment"].get("duplicate_identity", 0),
                 len(r["extra_prediction_indices_unscored"])] for r in rows if "accuracy" in r]), "",
            "## Paired effects", "",
            "Effects are treatment minus control. Accuracy uses annotated document pairs; call/token effects "
            "use all available registered document pairs. These denominators can differ. Intervals resample "
            "documents and are descriptive with this small corpus; a zero-width interval does not establish equivalence. "
            "No interval is displayed with fewer than two documents.", ""]
    effects = []
    if len(analysis["comparisons"]) != len(manifest["comparisons"]):
        raise ValueError("comparison coverage disagrees")
    for declared, observed in zip(manifest["comparisons"], analysis["comparisons"], strict=True):
        if any(observed[k] != declared[k] for k in ("control", "treatment", "factor")):
            raise ValueError("comparison identity disagrees")
        eligible = {source for source, methods in source_methods.items()
                    if {declared["control"], declared["treatment"]} <= methods}
        paired = {source for source in eligible if all(
            f"{source}--{method}--{repeat}" in completed
            for method in (declared["control"], declared["treatment"]) for repeat in range(manifest["repeats"]))}
        observed_pairs = observed["paired"]
        if {p["source"] for p in observed_pairs} != paired or len(observed_pairs) != len(paired):
            raise ValueError("paired document coverage disagrees")
        effect = observed["accuracy_effect"]
        if effect["documents"] != len(paired & gold_sources):
            raise ValueError("accuracy denominator disagrees")
        interval = effect["percentile_95"]
        effects.append([f"{declared['control']} → {declared['treatment']}", declared["factor"],
                        f"{effect['documents']}/{len(eligible & gold_sources)}",
                        f"{100 * effect['mean']:+.2f}" if effect["documents"] else "—",
                        f"[{100 * interval[0]:+.2f}, {100 * interval[1]:+.2f}]" if effect["documents"] >= 2 else "—",
                        f"{len(paired)}/{len(eligible)}",
                        f"{statistics.mean(p['calls'] for p in observed_pairs):+.2f}" if paired else "—",
                        f"{statistics.mean(p['input_tokens'] for p in observed_pairs):+,.0f}" if paired else "—"])
    text += [table(["Comparison", "Factor", "Gold pairs / expected", "Accuracy Δ pp", "95% interval pp",
                    "All pairs / expected", "Mean calls Δ", "Mean input tokens Δ"], effects), "",
             "## Cell diagnostics and costs", "",
             "Linked/populated leaves measure source-link coverage, not semantic correctness. "
             "The denominator includes status/diagnostic fields requested by the schema. "
             "Inspect per-field accounting before interpreting a change as lost measurements. "
             "Call totals are artifact call records, including pre-inference refusals.", "",
             table(["Cell", "Records", "Linked/populated", "Calls", "Failed calls", "Input tokens", "Output tokens"], [
                 [r["id"], r["records"], f"{r['linked_record_leaves']}/{r['populated_record_leaves']}",
                  r["calls"], r["failed_calls"], f"{r['input_tokens']:,}", f"{r['output_tokens']:,}"] for r in rows]), ""]
    stages = {}
    for cell in accounting["stage_costs"].values():
        for stage, values in cell["stages"].items():
            stages.setdefault(stage, Counter()).update(values)
    text += ["## Recorded stage totals", "",
             f"Saved fresh/reused response counts: {sum(c['fresh_calls'] for c in accounting['stage_costs'].values())}/"
             f"{sum(c['reused_calls'] for c in accounting['stage_costs'].values())}.", "",
             "Totals cover this snapshot across methods. Recorded durations include shared-provider contention "
             "and historical durations of reused replies; they are not fresh replay latency or DBOS/HTTP end-to-end time. "
             "Unknown token counts are listed rather than treated as measured zeroes.", "",
             table(["Stage", "Calls", "Failed", "Input tokens", "Output tokens", "Unknown input/output calls", "Recorded seconds"], [
                 [stage, s["calls"], s["failed_calls"], f"{s['input_tokens_reported']:,}", f"{s['output_tokens_reported']:,}",
                  f"{s['input_tokens_unknown_calls']}/{s['output_tokens_unknown_calls']}", f"{s['recorded_call_seconds']:,.1f}"]
                 for stage, s in sorted(stages.items())]), "",
             "## Issue ledger", "",
             table(["Cell", "Issue counts"], [[r["id"], "; ".join(f"{k}: {v}" for k, v in sorted(r["issues"].items()))]
                                               for r in rows if r["issues"]]), "",
             "## Missing cells", "",
             table(["Cell", "Last recorded status"], [[r["cell"], json.dumps(r["status"], sort_keys=True)]
                                                        for r in analysis["missing"]]), "",
             "## Interpretation boundaries", "",
             *[f"- {item}" for item in analysis["limits"]], "",
             "Interaction estimates, observation-level review queues, localization diagnostics and "
             "grounding comparability remain in the pinned analysis/accounting JSON. These tables do not replace adjudication.", ""]
    return "\n".join(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("study", "analysis", "accounting", "output"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    inputs = {"manifest": args.study / "manifest.json", "analysis": args.analysis, "accounting": args.accounting}
    raw = {name: path.read_bytes() for name, path in inputs.items()}
    manifest, analysis, accounting = (json.loads(raw[name]) for name in ("manifest", "analysis", "accounting"))
    if accounting["analysis_sha256"] != hashlib.sha256(raw["analysis"]).hexdigest():
        raise ValueError("accounting belongs to another analysis snapshot")
    for cell in analysis["cells"]:
        pin = json.loads((args.study / "cells" / cell["id"] / "pin.json").read_bytes())
        if pin != {"cell": cell["id"], "manifest_sha256": hashlib.sha256(raw["manifest"]).hexdigest()}:
            raise ValueError("cell belongs to another manifest")
    gold = Path(manifest["evaluation"]["gold"]["path"]).read_bytes()
    if hashlib.sha256(gold).hexdigest() != manifest["evaluation"]["gold"]["sha256"]:
        raise ValueError("gold pin changed")
    result = render(manifest, analysis, accounting, set(json.loads(gold)["sources"]))
    result += "\n## Reproduction pins\n\n" + table(["Input", "Path", "SHA-256"], [
        [name, path, hashlib.sha256(raw[name]).hexdigest()] for name, path in inputs.items()])
    result += f"\n\nRenderer SHA-256: `{hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}`.\n"
    with args.output.open("x") as output:
        output.write(result)


if __name__ == "__main__":
    main()
