"""Small, discovery-only prompt experiment; never writes product state.

Capture one Phoenix discovery span as JSON (the REST API's {data: [span]} shape), then:

  python -m experiments.extraction.table_discovery TRACE.json OUTPUT --reference REFERENCE.json --ssh-host HOST

The worker runs in an existing Parsing Service container with its configured reasoning model.
Only this script and the captured request are sent over SSH; no checkout or environment is copied.
OUTPUT must not exist. It retains the declared protocol, exact requests/replies and boundary scores.
Keep captures and results outside tracked files: the public experiment contains synthetic sources only.
Three greedy repetitions measure repeatability on this sample, not generalization or independent trials.
REFERENCE supplies independently annotated entries (id, exact ranges, resolved end and optional parent).
Use --replay PREVIOUS/report.json to re-score saved replies against a corrected reference without inference;
the report records the amendment and original digest, and refuses changed model requests.
Use --cases to select controls. Nested-record controls also run the existing children discovery pass.
The default candidate uses version 9's refined scope and explicit shared-qualification reply kind;
--candidate original retains the first, summary-duplicating scope-only arm.
Field extraction and durable execution are outside this experiment.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path


ORIGINAL_SCOPE = (
    " The record definition determines the unit to separate, even inside a larger container. "
    "When the defined records are entries in a table, every matching data row starts its own record; "
    "the table title and column headers are shared context, not a record containing those entries. "
    "Keep a record's internal headings, tables, citations and numbered list items with that record "
    "only when they do not themselves match the requested record definition. "
    "Use other only for text outside every record, not sections inside one."
)
LINE = re.compile(r"^\[(L\d+)(?: (heading|table row))?\] (.*)$", re.MULTILINE)
CASE_NAMES = ("captured-full-document", "synthetic-table", "internal-tables", "summary-before-prose",
              "parents-and-nested-finds", "primary-summary-table")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def cases(span, discovery_prompt, baseline_scope, reference):
    captured = json.loads(span["attributes"]["input.value"])
    if captured["system"].count(baseline_scope) != 1:
        raise ValueError("captured discovery scope differs from the worker: refusing an approximate replay")
    lines = list(LINE.finditer(captured["user"]))
    source = {m[1]: m[3] for m in lines}
    expected = reference["entries"]
    for entry in expected:
        for r in entry["ranges"]:
            if r["segment"] not in source or not 0 <= r["start"] < r["end"] <= len(source[r["segment"]]):
                raise ValueError("reference range is outside the captured source")
    score([], expected)  # validate reference identities and resolved ends before asking a model

    def synthetic(name, description, rows, starts):
        user = "### WINDOW\n" + "\n".join(f"[L{i} {kind}] {text}" if kind else f"[L{i}] {text}"
                                         for i, (kind, text) in enumerate(rows, 1))
        return {"name": name, "description": description,
                "system": discovery_prompt.format(description=description + baseline_scope),
                "user": user + "\n\nReturn the JSON object now.", "expected": [[f"L{i}", 0] for i in starts]}

    table = synthetic("synthetic-table", "One record is a port entry: its name, region and year.", [
        ("heading", "Survey of ports"), ("table row", "Table A. Port entries"),
        ("table row", "Port\tRegion\tYear"),
        *(("table row", f"Port {chr(65 + i)}\t{'West' if i % 2 else 'East'}\t{1700 + i}") for i in range(8)),
        ("", "End of port survey.")], range(4, 12))
    primary_summary = {**table, "name": "primary-summary-table", "user": table["user"].replace(
        "Survey of ports", "Summary of ports").replace("Table A. Port entries", "Summary table of port entries")}
    parents = synthetic("internal-tables", "One record is a grave, including all its finds and measurements.", [
        ("heading", "Excavation report"), ("heading", "Grave 1"), ("", "Orientation: north-south."),
        ("table row", "Find\tMaterial\tCount"), ("table row", "Bead\tGlass\t3"),
        ("table row", "Pin\tBronze\t1"), ("heading", "Measurements"), ("", "Length: 180 cm."),
        ("heading", "Grave 2"), ("", "Orientation: east-west."),
        ("table row", "Find\tMaterial\tCount"), ("table row", "Ring\tIron\t1"),
        ("table row", "Pot\tClay\t2"), ("", "Length: 170 cm."),
        ("heading", "Bibliography"), ("", "Synthetic report reference.")], [2, 9])
    parents["must_own"] = [[f"L{i}", "L2"] for i in range(2, 9)] + [[f"L{i}", "L9"] for i in range(9, 15)]
    summary = synthetic("summary-before-prose", "One record is a grave, including all its finds and measurements.", [
        ("heading", "Index of graves"), ("table row", "Grave\tOrientation\tLength"),
        ("table row", "Grave 1\tNorth-south\t180 cm"), ("table row", "Grave 2\tEast-west\t170 cm"),
        ("heading", "Detailed grave descriptions"), ("heading", "Grave 1"),
        ("", "Orientation: north-south. Finds: three glass beads and a bronze pin."), ("", "Length: 180 cm."),
        ("heading", "Grave 2"), ("", "Orientation: east-west. Finds: one iron ring and two clay pots."),
        ("", "Length: 170 cm."), ("heading", "Bibliography")], [6, 9])
    summary["must_own"] = [[f"L{i}", "L6"] for i in range(6, 9)] + [[f"L{i}", "L9"] for i in range(9, 12)]
    nested = synthetic("parents-and-nested-finds",
        "One record is a grave or an individually identified find within a grave. Keep the grave's own "
        "description and measurements distinct from the finds it contains.", [
        ("heading", "Excavation report"), ("heading", "Grave 1"), ("", "Orientation: north-south."),
        ("table row", "Find\tMaterial\tCount"), ("table row", "Find A1\tGlass\t3"),
        ("table row", "Find A2\tBronze\t1"), ("", "Grave 1 length: 180 cm. Depth: 60 cm."),
        ("heading", "Grave 2"), ("", "Orientation: east-west."),
        ("table row", "Find\tMaterial\tCount"), ("table row", "Find B1\tIron\t1"),
        ("table row", "Find B2\tClay\t2"), ("", "Grave 2 length: 170 cm. Depth: 50 cm."),
        ("heading", "Bibliography")], [2, 5, 6, 8, 11, 12])
    nested["children"] = True
    nested["parents"] = {"L5@0": "L2@0", "L6@0": "L2@0", "L11@0": "L8@0", "L12@0": "L8@0"}
    nested["must_own"] = [[f"L{i}", "L2"] for i in (2, 3, 4, 7)] + [
        [f"L{i}", "L8"] for i in (8, 9, 10, 13)] + [[f"L{i}", f"L{i}"] for i in (5, 6, 11, 12)]
    captured_case = {"name": "captured-full-document", **captured, "expected_entries": expected}
    table["must_own"] = [[f"L{i}", f"L{i}"] for i in range(4, 12)]
    primary_summary["must_own"] = table["must_own"]
    for case in (table, parents, summary, nested, primary_summary):
        texts = {m[1]: m[3] for m in LINE.finditer(case["user"])}
        ranges = {}
        for label, owner in case["must_own"]:
            ranges.setdefault(f"{owner}@0", []).append({"segment": label, "start": 0, "end": len(texts[label])})
        case["expected_entries"] = [{"id": f"{label}@{offset}", "ranges": ranges[f"{label}@{offset}"],
                                     "end": "validated", **({"parent": case["parents"][f"{label}@{offset}"]}
                                     if f"{label}@{offset}" in case.get("parents", {}) else {})}
                                    for label, offset in case.pop("expected")]
        del case["must_own"]
    return [captured_case, table, parents, summary, nested, primary_summary]


def score(actual, expected, issues=(), ledger=()):
    """One structural contract for synthetic discovery and full canonical extraction: complete record ownership."""
    def identity(entry):
        first = entry["ranges"][0]
        return f"{first['segment']}@{first['start']}"

    expected_ids = [e["id"] for e in expected]
    if len(set(expected_ids)) != len(expected_ids) or any(
            not e["ranges"] or e["id"] != identity(e) or e["end"] not in ("validated", "source_end") for e in expected):
        raise ValueError("reference entries require unique source identities, nonempty ranges and resolved ends")
    want, got = Counter(expected_ids), Counter(e["id"] for e in actual)
    missing, extra = list((want - got).elements()), list((got - want).elements())
    by_id = {e["id"]: e for e in expected}
    ownership_errors = []
    for entry in actual:
        target = by_id.get(entry["id"])
        if target is not None and (not entry["ranges"] or identity(entry) != entry["id"] or any(
                entry.get(key) != target.get(key) for key in ("ranges", "end", "parent"))):
            ownership_errors.append(entry["id"])
    unresolved = any(row["disposition"] in ("unresolved", "withheld") for row in ledger) or any(
        entry["end"] not in ("validated", "source_end") for entry in actual)
    ordered = [e["id"] for e in actual] == expected_ids
    return {"expected": len(expected), "records": len(actual), "matched": sum((want & got).values()),
            "missing": missing, "extra": extra, "issues": list(issues), "unresolved": unresolved,
            "ownership_errors": list(ownership_errors),
            "pass": ordered and not missing and not extra and not issues and not unresolved and not ownership_errors}


def assemble(case, answer, child_ask=None, child_fits=None, *, shared_context=False):
    """Run the real discovery observer and assembler, retaining their diagnostics, with stable line identities."""
    from kei_exp.kie.extract import discovery
    from kei_exp.kie.passages import Evidence, Passage

    matches = list(LINE.finditer(case["user"]))
    passages = tuple(Passage(m[1], 1, i, m[3], "Table" if m[2] == "table row" else
                             "SectionHeader" if m[2] == "heading" else "Text", (0, 0, 1, 1), "block")
                     for i, m in enumerate(matches))
    evidence = Evidence("experiment", "fixed", "synthetic-line-identities", case["name"], 1, passages)
    texts = {p.id: p.text for p in passages}
    window = discovery.Window(tuple(discovery.Unit(p.id, 0, len(p.text)) for p in passages))
    issues = []
    observed = discovery._observe(answer, window, texts, [m[1] for m in matches], issues,
                                 shared_context=shared_context)
    if observed is None:
        raise ValueError("discovery observer rejected the reply")
    body = discovery._assemble([observed], evidence, texts)
    if case.get("children"):
        if child_ask is None or child_fits is None:
            raise ValueError("nested control requires the children discovery pass")
        body = discovery.children({**body, "calls": [], "issues": issues}, evidence, case["description"],
                                  child_fits, child_ask)
        issues = body["issues"]
    return {**body, "issues": [issue.code for issue in issues]}


def worker(payload):
    from kei_exp.kie.extract import discovery, llm, unified

    span = payload["span"]
    candidate_scope = ORIGINAL_SCOPE if payload["candidate"] == "original" else unified.DISCOVERY_SCOPE_V9
    prepared = cases(span, discovery.DISCOVERY, unified.DISCOVERY_SCOPE, payload["reference"])
    prepared = [case for case in prepared if not payload.get("cases") or case["name"] in payload["cases"]]
    if not prepared or payload.get("cases") and {c["name"] for c in prepared} != set(payload["cases"]):
        raise ValueError("unknown or empty case selection")
    chat = llm.OpenAIChat()
    if chat.model != span["attributes"]["llm.model_name"]:
        raise ValueError("worker's configured model differs from the captured discovery model")
    pins = {name: hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
            for name, module in (("discovery", discovery), ("llm", llm), ("unified", unified))}
    print(json.dumps({"protocol": {"repeats": payload["repeats"], "temperature": 0, "max_tokens": 4096,
          "model": chat.model, "implementation": pins, "baseline_scope": unified.DISCOVERY_SCOPE,
          "candidate_scope": candidate_scope,
          "candidate_shared_context": payload["candidate"] == "refined", "cases": prepared,
          "reference": payload["reference"], "replay_sha256": digest(payload["replay"]) if payload["replay"] else None,
          "recorded_baseline": span["attributes"]["llm.output_messages.0.message.content"],
          "trace_id": span["context"]["trace_id"], "span_id": span["context"]["span_id"]}}), flush=True)
    child_counter = None
    if any(c.get("children") for c in prepared):
        from kei_exp.kie.extract.tokens import counter_for
        child_counter = counter_for(chat)
    for repeat in range(payload["repeats"]):
        for case in prepared:
            # Alternate order between repetitions, preserving the exact source and reply budget in both arms.
            arms = ["baseline", "candidate"] if repeat % 2 == 0 else ["candidate", "baseline"]
            for arm in arms:
                system = case["system"] if arm == "baseline" else case["system"].replace(
                    unified.DISCOVERY_SCOPE, candidate_scope, 1)
                shared_context = arm == "candidate" and payload["candidate"] == "refined"
                if shared_context:
                    system += discovery.SHARED_CONTEXT
                schema = discovery._reply([m[1] for m in LINE.finditer(case["user"])], shared_context=shared_context)
                request = chat.request_body(system=system, user=case["user"], schema=schema, max_tokens=4096)
                row = {"case": case["name"], "arm": arm, "repeat": repeat + 1,
                       "request": request, "request_sha256": digest(request)}
                started = time.monotonic()
                try:
                    if payload["replay"]:
                        saved = next(r for r in payload["replay"]["rows"] if
                                     (r["case"], r["arm"], r["repeat"]) == (case["name"], arm, repeat + 1))
                        if request != saved["request"]:
                            raise ValueError("changed request: cannot replay")
                        row.update({k: saved[k] for k in ("raw", "finish", "input_tokens", "output_tokens", "attempts")})
                        row["original_seconds"] = saved["seconds"]
                    else:
                        reply = chat.complete(system=system, user=case["user"], schema=schema, max_tokens=4096)
                        row.update(raw=reply.text, finish=reply.finish, input_tokens=reply.input_tokens,
                                   output_tokens=reply.output_tokens, attempts=list(reply.attempts))
                    if row["finish"] != "stop":
                        raise ValueError(f"incomplete completion: {row['finish']}")
                    answer = llm.parse_json(row["raw"])
                    row["children_calls"] = []
                    def child_ask(record, system, user, schema, calls, issues):
                        child_request = chat.request_body(system=system, user=user, schema=schema, max_tokens=4096)
                        if payload["replay"]:
                            call = saved["children_calls"][len(row["children_calls"])]
                            if call["request"] != child_request:
                                raise ValueError("changed children request: cannot replay")
                            raw = call["raw"]
                        else:
                            reply = chat.complete(system=system, user=user, schema=schema, max_tokens=4096)
                            if reply.finish != "stop":
                                raise ValueError("incomplete children completion")
                            raw = reply.text
                        row["children_calls"].append({"request": child_request, "raw": raw})
                        return llm.parse_json(raw)
                    def child_fits(system, user, schema):
                        return child_counter.request_tokens(system, user, schema) <= child_counter.context_tokens - 4096
                    body = assemble(case, answer, child_ask, child_fits, shared_context=shared_context)
                    row.update(actual=body["entries"], score=score(body["entries"], case["expected_entries"],
                               body["issues"], body["ledger"]))
                except Exception as error:
                    row.update(error=type(error).__name__, error_detail=str(error) if isinstance(error, ValueError)
                               else "experiment failed; inspect the saved request and response", score={"pass": False})
                row["seconds"] = round(time.monotonic() - started, 3)
                print(json.dumps({"result": row}, ensure_ascii=False), flush=True)


def main():
    if sys.argv[1:] == ["--worker"]:
        worker(json.load(sys.stdin))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--container", default="free-parsing_worker-1")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--candidate", choices=["original", "refined"], default="refined")
    parser.add_argument("--cases", nargs="+", choices=CASE_NAMES)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    spans = json.loads(args.trace.read_text())["data"]
    if len(spans) != 1 or spans[0]["name"] != "discovery":
        parser.error("TRACE must contain exactly one discovery span")
    args.output.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).read_text()
    (args.output / "runner.py").write_text(source)
    replay = json.loads(args.replay.read_text()) if args.replay else None
    case_count = len(args.cases) if args.cases else len(CASE_NAMES)
    command = shlex.join(["docker", "exec", "-i", args.container, "python", "-c", source, "--worker"])
    rows = []
    with subprocess.Popen(["ssh", "-o", "BatchMode=yes", args.ssh_host, command], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True) as process:
        process.stdin.write(json.dumps({"span": spans[0], "repeats": args.repeats,
                                       "reference": json.loads(args.reference.read_text()),
                                       "replay": replay, "cases": args.cases,
                                       "candidate": args.candidate}))
        process.stdin.close()
        for line in process.stdout:
            item = json.loads(line)
            if "protocol" in item:
                protocol = {**item["protocol"], "runner_sha256": hashlib.sha256(source.encode()).hexdigest()}
                (args.output / "protocol.json").write_text(json.dumps(protocol, ensure_ascii=False, indent=2))
            else:
                row = item["result"]
                rows.append(row)
                name = f"{row['case']}-{row['arm']}-{row['repeat']}.json"
                (args.output / name).write_text(json.dumps(row, ensure_ascii=False, indent=2))
                print(json.dumps({k: row.get(k) for k in ("case", "arm", "repeat", "seconds", "error")} |
                                 {"score": {k: row["score"].get(k) for k in
                                            ("records", "expected", "matched", "pass")} |
                                  {"ownership_errors": len(row["score"].get("ownership_errors", []))}}), flush=True)
        if process.wait() != 0:
            raise RuntimeError("experiment worker failed; partial evidence retained")
    if len(rows) != args.repeats * case_count * 2 or len({(r["case"], r["arm"], r["repeat"]) for r in rows}) != len(rows):
        raise RuntimeError("experiment did not return every distinct planned comparison")
    report = {"rows": rows, "candidate_passes": sum(r["score"]["pass"] for r in rows if r["arm"] == "candidate"),
              "candidate_runs": sum(r["arm"] == "candidate" for r in rows)}
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if any(r.get("error") for r in rows) or report["candidate_passes"] != report["candidate_runs"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
