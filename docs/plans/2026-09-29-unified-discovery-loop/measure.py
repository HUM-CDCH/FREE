"""One unified Catalog extraction against the served models, written whole to /out/LABEL.json, summarised as one JSON
line: per-stage calls, tokens, model-seconds and cut-offs, discovery wall time, and a score against a generated
catalogue's truth. The summary is the loop's only yardstick; every row of log.md comes from it.

  run.sh LABEL /repo/docs/plans/2026-09-29-unified-discovery-loop/measure.py LABEL CASE [MODELS_JSON|-] [CHUNKS]
  run.sh LABEL /repo/docs/plans/2026-09-29-unified-discovery-loop/measure.py --rescore /out/RESULT.json CASE

CASE is a `tests/fixtures/catalogue` name (no truth), `big` (the rev-8 200-entry catalogue), or `FILE.py:FUNCTION`
(relative to /repo) returning {"case": <catalogue fixture dict>, "schema": <FREE schema>,
"truth": {label: {field: value}}} and optionally "label", a function from a printed label to its truth key. The scorer may know the truth; the method under test must not.
"""
import collections
import json
import runpy
import sys
from pathlib import Path

REV8 = "/repo/docs/plans/2026-09-24-unified-durable-execution-evidence/rev8-tests/make_catalogues.py"


def generated(name: str) -> dict | None:
    from tests.test_unified_catalog_live import SCHEMA
    if name == "big":
        make = runpy.run_path(REV8)
        sites, kinds = make["SITES"], make["KINDS"]
        return {"case": make["big"](), "schema": SCHEMA, "truth": {
            str(n): {"site_name": sites[n % len(sites)], "fundart": kinds[n % 4]} for n in range(40, 240)}}
    if ":" in name:
        path, function = name.rsplit(":", 1)
        return runpy.run_path(f"/repo/{path}")[function]()
    return None


def summary(result: dict, name: str, spec: dict | None, discovery_wall: float | None) -> dict:
    """Discovery wall time is measured, not summed: once windows run in parallel, model-seconds overstate it."""
    entries = result["discovery"]["entries"]
    stages: dict = collections.defaultdict(lambda: {"calls": 0, "in": 0, "out": 0, "model_s": 0.0, "cut_off": 0})
    for call in result["calls"]:
        each = stages[call["stage"]]
        each["calls"] += 1
        each["in"] += call["input_tokens"] or 0
        each["out"] += call["output_tokens"] or 0
        each["model_s"] = round(each["model_s"] + (call.get("seconds") or 0), 1)
        each["cut_off"] += call.get("finish") == "length"
    reasons = lambda items: collections.Counter(f"{item['path'][-1]}:{item['reason']}" for item in items)  # noqa: E731
    places = sum(window["places"] for window in result["discovery"]["windows"])
    succeeded = sum(call["output_tokens"] or 0 for call in result["discovery"]["calls"] if call["ok"])
    out = {"case": name, "models": result["models"], "seconds": result["seconds"],
           "discovery_wall_s": discovery_wall, "records": len(result["records"]),
           "entry_ends": collections.Counter(entry["end"] for entry in entries),
           "completeness": result["completeness"],
           "issues": collections.Counter(issue["code"] for issue in result["issues"]), "stages": stages,
           "discovery_places": places,
           "tokens_per_place": round(succeeded / places, 1) if places else None, "rejected": reasons(result["rejected"]), "proposed": reasons(result["proposed"])}
    if spec:
        truth = spec["truth"]
        key = spec.get("label") or (lambda label: label.rstrip("."))  # the truth's key for a printed label
        labels = [key(entry["label"] or "") for entry in entries]
        score: collections.Counter = collections.Counter()
        for entry_label, record in zip(labels, result["records"], strict=True):
            for field, want in truth.get(entry_label, {}).items():
                got = record.get(field)
                score[f"{field}:" + ("empty" if got is None else
                                     "right" if str(got).rstrip(".") == str(want).rstrip(".") else "WRONG")] += 1
        counts = collections.Counter(labels)
        out |= {"true_entries": len(truth), "found": sum(label in truth for label in counts),
                "false_entries": {label: n for label, n in counts.items() if label not in truth},
                "duplicated": [label for label, n in counts.items() if n > 1 and label in truth],
                "unresolved_ends": [label for label, entry in zip(labels, entries) if entry["end"] == "unresolved"],
                "score": dict(sorted(score.items()))}
    return out


def main(argv: list[str]) -> None:
    if argv[0] == "--rescore":
        result = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        print(json.dumps(summary(result, argv[2], generated(argv[2]), None), ensure_ascii=False))
        return
    from kei_exp.kie.extract import run
    from kei_exp.kie.extract.models import chats_for
    from tests.helpers import catalogue
    from tests.test_unified_catalog_live import SCHEMA
    label, name = argv[0], argv[1]
    models = json.loads(argv[2]) if len(argv) > 2 and argv[2] != "-" else None
    chunks = int(argv[3]) if len(argv) > 3 else 1
    spec = generated(name)
    run_dir = catalogue.write(spec["case"] if spec else name, Path("/tmp") / label)
    request = run.ExtractRequest.model_validate({"schema": spec["schema"] if spec else SCHEMA, "options": {
        "strategy": "catalog", "unified": {"defaults": 1}, **({"models": models} if models else {})}})
    result = run.extract(run_dir, request, chats_for(request.options), extraction_id=label, chunks=chunks)
    Path(f"/out/{label}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1))
    records = run_dir / "extractions" / label
    wall = round((records / "catalog-discovery.json").stat().st_mtime
                 - (records / "catalog-execution.json").stat().st_mtime, 1)
    print(json.dumps({"label": label, "chunks": chunks, **summary(result, name, spec, wall)}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
