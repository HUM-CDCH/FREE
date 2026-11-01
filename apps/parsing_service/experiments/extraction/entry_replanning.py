"""Replay a constructed unified Catalog workload through durable planning, one planning round per completed call.

Not the original Spark workload (its private fixtures were removed after collection): `N` scripted records spread over
a fixed number of pages, so discovery's windows stay fixed while the completed entries grow. `record` answers every
captured request once with the repository's scripted test model and writes the saved replies; `replay` plans the
same attempt again from those replies alone (an unknown request fails, no model is reachable) under a fixed
first-completion schedule, and writes each round's planned captures, entry computations, coordination calls and CPU.
`compare` checks two replay reports of the same replies and schedule for equivalence (permitted difference: fewer
repeated lookups and publications of unchanged rows).

  uv run --no-sync python -m experiments.extraction.entry_replanning record OUT.json --records 40
  uv run --no-sync python -m experiments.extraction.entry_replanning replay REPLIES.json REPORT.json [--timing]
  uv run --no-sync python -m experiments.extraction.entry_replanning compare BASELINE.json CANDIDATE.json
  uv run --no-sync python -m experiments.extraction.entry_replanning trace REPORT.json --entry 0
"""
from __future__ import annotations

import argparse
import hashlib
import json
import resource
import time
from collections import Counter
from pathlib import Path
from dataclasses import asdict
from unittest.mock import patch

from kei_exp.kie.extract import calls, run, tokens, unified
from kei_exp.kie.extract.durable import CapturePlanner, NeedsCall, digest
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.retained import publish_final
from tests.test_durable_extraction import Counter as WordCounter, MemoryLease
from tests.test_extract_grounded import CountingChat
from tests.test_unified_catalog import Model, evidence, request as unified_request
from tests.test_unified_catalog import untimed

PAGES = 4


class Unexpected(RuntimeError):
    """A request absent from the saved replies: never answered approximately."""


class Kept(WordCounter):
    """The scripted word counter, kept per attempt as a served tokenizer's counts are (`tokens.counting`)."""
    _serving = b"constructed-word-counter"


class NoModel:
    """Planning never calls a model; a call reaching here is a defect of the replay."""

    def __call__(self, *_):
        raise Unexpected("a model call was attempted during replay")


def source(records: int):
    per_page = -(-records // PAGES)
    pages = []
    for page in range(PAGES):
        numbers = range(page * per_page + 1, min(records, (page + 1) * per_page) + 1)
        pages.append("\n".join(f"{n}. Site{n}. Material: m{n}. Find: f{n} ({n % 9 + 1}). The object was recorded "
                               f"in the register with its condition, dimensions and provenance." for n in numbers))
    return evidence(*pages)


def lease_for(request, label: str) -> MemoryLease:
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    fixed = hashlib.sha256(label.encode()).hexdigest()
    lease.attempt = f"{fixed[:8]}-{fixed[8:12]}-4{fixed[13:16]}-8{fixed[17:20]}-{fixed[20:32]}"
    lease.state["selection"]["id"] = "00000000-0000-4000-8000-000000000001"
    lease.state["selection"]["schemaRevisionId"] = "00000000-0000-4000-8000-000000000002"
    lease.state["source"]["sourceRevisionId"] = "00000000-0000-4000-8000-000000000003"
    return lease


def duration(key: str) -> float:
    """A fixed pseudo-duration per request, so every variant completes calls in the same order."""
    return 1 + int(key[:4], 16) % 5


def record(args):
    request = unified_request(defaults=args.defaults)
    text = source(args.records)
    lease = lease_for(request, "record")
    chat = CountingChat(Model(text))
    for _ in range(100_000):
        counter = WordCounter()
        planner = CapturePlanner(lease, {"fields": counter, "reasoning": counter})
        try:
            run.dispatch(None, text, request, Router(chat, chat, planner), counter=counter, chunks=args.chunks)
        except NeedsCall:
            for unit in lease.units.values():
                if unit["id"] in planner.pending:
                    body = dict(unit["input"]["request"]["body"])
                    body.pop("max_whitespace")
                    parsed, attempts = calls.complete(chat, **body, counter=counter)
                    unit["checkpoint"] = {"output": {"parsed": parsed, "calls": [asdict(call) for call in attempts]}}
            continue
        break
    replies = {key: unit["checkpoint"] for key, unit in lease.units.items()}
    args.out.write_text(json.dumps({"records": args.records, "defaults": args.defaults, "chunks": args.chunks,
                                    "replies": replies}))
    print(json.dumps({"saved_replies": len(replies)}))


def replay(args):
    saved = json.loads(args.replies.read_text())
    request = unified_request(defaults=saved["defaults"])
    text = source(saved["records"])
    chunks = args.chunks or saved["chunks"]
    lease = lease_for(request, "replay")
    model = NoModel()
    chat = CountingChat(model)
    scope = f"constructed/{lease.attempt}"
    calls_by_routine = Counter()
    seen_snapshots: dict[str, int] = {}
    rows, running, done, clock = [], {}, set(), 0.0
    entries_computed: list = []
    looked_up: list = []
    original_call, original_entry = lease.call, unified._Run.entry

    def call(name, *a):
        calls_by_routine[name] += 1
        looked_up.append([name, a[1] if name in ("capture_unit", "publish_plan") else a[0] if name == "publish_snapshot"
                          else None])
        if name == "capture_unit" and a[1] not in lease.units and a[1] not in saved["replies"]:
            raise Unexpected("request absent from the saved replies: " + a[2]["stage"])
        result = original_call(name, *a)
        if name == "publish_snapshot":
            seen_snapshots[a[0]] = seen_snapshots.get(a[0], 0) + 1
        return result

    def entry(self, number, body, *a, **kw):
        entries_computed.append([number, kw.get("verify", True)])
        return original_entry(self, number, body, *a, **kw)

    if not args.timing:  # timing runs keep the lease uninstrumented; an unknown request still fails when answered
        lease.call = call
    tokens.forget(scope)
    rusage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    started = time.perf_counter()
    with patch.object(unified._Run, "entry", entry if not args.timing else original_entry):
        for round_number in range(100_000):
            calls_by_routine.clear()
            entries_computed.clear()
            looked_up.clear()
            before_snapshots = dict(seen_snapshots)
            counter = Kept()
            planner = CapturePlanner(lease, {"fields": counter, "reasoning": counter})
            cpu, wall = time.process_time(), time.perf_counter()
            try:
                with tokens.counting(scope):
                    result = run.dispatch(None, text, request, Router(chat, chat, planner), counter=counter,
                                          chunks=chunks)
            except NeedsCall:
                result = None
            cpu, wall = time.process_time() - cpu, time.perf_counter() - wall
            stages = {unit["id"]: (key, unit["descriptor"]["stage"]) for key, unit in lease.units.items()}
            pending = sorted(planner.pending, key=planner.pending.get)
            row = {"round": round_number, "cpu": cpu, "wall": wall,
                   "pending": [[stages[capture][0], stages[capture][1], planner.roles[capture]] for capture in pending],
                   "completed_entries": len({tuple(each) for each in entries_computed}) if not args.timing else None,
                   "entry_computations": list(entries_computed) if not args.timing else None,
                   "coordination": dict(calls_by_routine),
                   "lookups": [list(each) for each in looked_up] if not args.timing else None,
                   "new_snapshots": sorted(k for k in seen_snapshots if k not in before_snapshots),
                   "repeated_snapshots": sum(seen_snapshots[k] - before_snapshots.get(k, 0)
                                             for k in seen_snapshots if k in before_snapshots),
                   "saved_entries": len({value["path"][1] for publication in lease.publications.values()
                                         for value in publication["values"] if value["modelValue"] is not None})}
            if result is not None:
                rows.append(row)
                break
            for capture in pending:
                role = planner.roles[capture]
                if capture not in running and capture not in done and \
                        sum(each[1] == role for each in running.values()) < chunks:
                    running[capture] = (clock + duration(stages[capture][0]), role)
            if not running:
                raise RuntimeError("planning yielded without a runnable call")
            clock = min(end for end, _ in running.values())
            finished = sorted((capture for capture, (end, _) in running.items() if end <= clock),
                              key=lambda capture: stages[capture][0])
            row["answered"] = []
            for capture in finished:
                key, stage = stages[capture]
                if key not in saved["replies"]:
                    raise Unexpected("no saved reply for a planned " + stage)
                lease.units[key]["checkpoint"] = json.loads(json.dumps(saved["replies"][key]))
                body = lease.units[key]["input"]["request"]["body"]
                row["answered"].append([stage, body.get("record")])
                done.add(capture)
                del running[capture]
            rows.append(row)
    total = time.perf_counter() - started
    lease.state["recordScopes"] = planner.scopes
    planned = dict(lease.publications)
    publish_final(lease, result)
    # The final publication's diagnostics carry the run's own clock: compared without them, by content.
    final = sorted(digest([each["values"], {k: v for k, v in each["coverage"].items() if k != "diagnostics"}])
                   for identity, each in lease.publications.items() if identity not in planned)
    tokens.forget(scope)
    report = {
        "records": saved["records"], "defaults": saved["defaults"], "chunks": chunks, "timing_only": args.timing,
        "rounds": len(rows), "seconds": total, "cpu": sum(row["cpu"] for row in rows),
        "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "rss_before_kib": rusage,
        "artifact": digest(untimed(result)),
        "scopes": {str(k): v for k, v in planner.scopes.items()},
        "plans": {stage: plan["digest"] for stage, plan in lease.plans.items()},
        "inputs": {key: digest(unit["input"]) for key, unit in lease.units.items()},
        "descriptors": {key: unit["descriptor"] | {"planDigest": None} for key, unit in lease.units.items()},
        "publications": {identity: digest(each) for identity, each in planned.items()},
        "final_publications": final,
        "key_records": {key: [unit["descriptor"]["stage"], unit["input"]["request"]["body"].get("record")]
                        for key, unit in lease.units.items()},
        "snapshot_records": {identity: sorted({value["path"][1] for value in each["values"]})
                             for identity, each in planned.items()},
        "records_out": [[record_.get("material"), record_.get("label")] for record_ in result["records"]],
        "per_round": rows}
    args.report.write_text(json.dumps(report))
    print(json.dumps({key: report[key] for key in ("records", "rounds", "seconds", "cpu", "peak_rss_kib",
                                                    "artifact")}))


def compare(args):
    """The two replays are the same attempt: only repeated lookups and publications of unchanged rows may differ."""
    base, cand = (json.loads(path.read_text()) for path in (args.baseline, args.candidate))
    problems = []
    for name in ("records", "defaults", "chunks", "rounds", "artifact", "scopes", "plans", "inputs", "descriptors",
                 "publications", "final_publications", "records_out"):
        if base[name] != cand[name]:
            problems.append(name)
    for b, c in zip(base["per_round"], cand["per_round"], strict=True):
        for name in ("pending", "answered", "new_snapshots", "saved_entries"):
            if b.get(name) != c.get(name):
                problems.append(f"round {b['round']}: {name}")
        for routine, count in c["coordination"].items():
            if count > b["coordination"].get(routine, 0):
                problems.append(f"round {b['round']}: more {routine}")
        if c["coordination"].get("finalize_input", 0) != b["coordination"].get("finalize_input", 0):
            problems.append(f"round {b['round']}: finalize_input differs")
    print(json.dumps({"equivalent": not problems, "problems": problems[:20]}))
    return 0 if not problems else 1


def trace(args):
    """One entry's events, round by round: what completed, whether the entry was computed, its capture lookups and
    its publications (new or repeated)."""
    report = json.loads(args.report.read_text())
    keys = {key for key, (stage, number) in report["key_records"].items()
            if number == args.entry and stage in ("entry", "verification", "arbitration")}
    published = set()
    for row in report["per_round"]:
        own = [identity for name, identity in row["lookups"] if name == "publish_snapshot"
               and report["snapshot_records"].get(identity) == [args.entry]]
        print(json.dumps({"round": row["round"], "answered": row.get("answered"),
                          "computed": [verify for number, verify in row["entry_computations"] if number == args.entry],
                          "lookups": sum(name in ("capture_unit", "publish_plan") and key in keys
                                         for name, key in row["lookups"]),
                          "published": ["repeat" if identity in published else "new" for identity in own],
                          "round_lookups": sum(name in ("capture_unit", "publish_plan") for name, _ in row["lookups"])}))
        published.update(own)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("record")
    one.add_argument("out", type=Path)
    one.add_argument("--records", type=int, default=40)
    one.add_argument("--defaults", type=int, default=3, choices=(3, 4, 7))
    one.add_argument("--chunks", type=int, default=4)
    two = sub.add_parser("replay")
    two.add_argument("replies", type=Path)
    two.add_argument("report", type=Path)
    two.add_argument("--chunks", type=int)
    two.add_argument("--timing", action="store_true", help="no per-entry instrumentation")
    three = sub.add_parser("compare")
    three.add_argument("baseline", type=Path)
    three.add_argument("candidate", type=Path)
    four = sub.add_parser("trace")
    four.add_argument("report", type=Path)
    four.add_argument("--entry", type=int, default=0)
    args = parser.parse_args()
    return {"record": record, "replay": replay, "compare": compare, "trace": trace}[args.command](args) or 0


if __name__ == "__main__":
    raise SystemExit(main())
