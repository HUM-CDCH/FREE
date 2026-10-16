"""Replay a private, frozen completed Catalog attempt, never generate model replies.

The fixture uses collect_planning_fixture.sql's shape: state/effective/plans/captures,
including exact finalized inputs and checkpoints. Canonical result/pages are supplied
separately. Unknown requests, descriptors, plans and tokenizer observations fail.
Only --collect-tokenize permits network access, and only to /tokenize via explicitly
provided routes; replay itself uses saved observations. This is planning replay, not
end-to-end extraction, new-input composition, or a reproduction of a historical speedup.
Keep fixtures, tokenizer bodies and routes private and outside version control.

  PYTHONPATH=src:. python -m experiments.extraction.retained_entry_replanning replay \
    FIXTURE RUN COUNTS REPORT [--chunks 4] [--attempts 2] [--fingerprints 16] [--memory]
  PYTHONPATH=src:. python -m experiments.extraction.retained_entry_replanning compare BASE CAND

--attempts interleaves independent attempt planning rounds in one process, with a
separate fixed virtual completion clock per attempt. --fingerprints simulates probe
revision changes with identical request counts after completion, to measure retained
historical versions; it does not claim actual tokenizer redeployments were observed.
"""
from __future__ import annotations

import argparse
import copy
import gc
import hashlib
import inspect
import json
import resource
import subprocess
import sys
import time
import tracemalloc
from collections import Counter
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import requests

import kei_exp
from kei_exp.kie.extract import discovery, tokens, unified
from kei_exp.kie.extract.durable import CapturePlanner, NeedsCall, digest
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.retained import publish_final
from kei_exp.kie.extract.run import dispatch
from kei_exp.kie.passages import load
from kei_exp.workflows.durable_extract import effective


class ReplayMismatch(RuntimeError):
    pass


def stable(artifact):
    # No semantic field or saved call timing is removed.
    return {key: value for key, value in artifact.items() if key not in ("started", "seconds")}


def publication(values, coverage):
    coverage = copy.deepcopy(coverage)
    if "diagnostics" in coverage:
        coverage["diagnostics"] = stable(coverage["diagnostics"])
    return digest([values, coverage])


class FrozenLease:
    """Only a captured reply's visibility changes. Inputs and candidates are frozen."""

    def __init__(self, fixture, *, instrumented=True):
        self.instrumented = instrumented
        self.attempt = fixture["attempt"]
        self.state = copy.deepcopy(fixture["state"])
        self.configuration = fixture["effective"]
        self.captures = {capture["unitKey"]: capture for capture in fixture["captures"]}
        self.by_id = {capture["id"]: capture for capture in fixture["captures"]}
        if len(self.by_id) != len(fixture["captures"]) or len(self.captures) != len(self.by_id):
            raise ReplayMismatch("duplicate frozen capture")
        if any(not capture.get("input") or not capture.get("checkpoint") for capture in self.by_id.values()):
            raise ReplayMismatch("unfinished frozen capture")
        self.done, self.looked_up = set(), set()
        self.plans = copy.deepcopy(fixture["plans"])
        self.visited_plans, self.publications = {}, {}
        self.counts, self.round_counts, self.round_publications = Counter(), Counter(), []

    def call(self, name, *args):
        if self.instrumented:
            self.counts[name] += 1
            self.round_counts[name] += 1
        if name == "resolve_selection":
            return {"configuration": self.configuration}
        if name == "historical_coverage":
            return {}
        if name == "publish_plan":
            _, stage, manifest = args
            saved = self.plans.get(stage)
            if saved is None or saved["manifest"] != manifest:
                raise ReplayMismatch("unknown or changed frozen plan: " + stage)
            self.visited_plans[stage] = saved["digest"]
            return saved
        if name == "capture_unit":
            _, key, descriptor = args
            saved = self.captures.get(key)
            if saved is None or saved["descriptor"] != descriptor:
                raise ReplayMismatch("unknown or changed frozen request: " + descriptor["stage"])
            self.looked_up.add(key)
            return {**saved, "checkpoint": saved["checkpoint"] if saved["id"] in self.done else None}
        if name == "publish_snapshot":
            identity, selection, values, coverage = args
            if selection != self.state["selection"]["id"]:
                raise ReplayMismatch("changed selection")
            if not self.instrumented:
                return {"values": values, "coverage": coverage}
            body = publication(values, coverage)
            if identity in self.publications and self.publications[identity] != body:
                raise ReplayMismatch("changed publication")
            self.publications[identity] = body
            self.round_publications.append(body)
            return {"values": values, "coverage": coverage}
        # Frozen finalized inputs must never be silently replaced or recomposed.
        raise ReplayMismatch("unexpected coordination operation: " + name)


def retained_size(value, seen=None):
    """Gross reachable Python object bytes, counted once, not allocator/RSS bytes.

    Includes shared strings/objects reachable from the cache, so this is not an
    exclusive allocation attribution. Modules, functions and class globals are excluded.
    """
    seen = set() if seen is None else seen
    if id(value) in seen:
        return 0
    seen.add(id(value))
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        return size + sum(retained_size(key, seen) + retained_size(item, seen) for key, item in value.items())
    if isinstance(value, (tuple, list, set, frozenset)):
        return size + sum(retained_size(item, seen) for item in value)
    if hasattr(value, "__dict__") and not isinstance(value, type) and not callable(value):
        return size + retained_size(vars(value), seen)
    return size


def memory():
    compiled = getattr(tokens, "_compiled", {})
    return {"compiled_attempts": len(compiled), "compiled_works": sum(len(work) for work in compiled.values()),
            "compiled_reachable_bytes": retained_size(compiled), "counts": tokens.kept(),
            "counts_reachable_bytes": retained_size(tokens._attempts),
            "rss_kib": int(Path("/proc/self/statm").read_text().split()[1]) * resource.getpagesize() // 1024,
            "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "traced_current_peak_bytes": list(tracemalloc.get_traced_memory()) if tracemalloc.is_tracing() else None}


def pin(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replay(args):
    fixture = json.loads(args.fixture.read_text())
    observations = json.loads(args.counts.read_text()) if args.counts.exists() else {}
    routes = json.loads(args.routes.read_text()) if args.routes else {}
    if args.collect_tokenize and not routes:
        raise ReplayMismatch("tokenize collection requires explicit private base-URL routes")
    if not 1 <= args.attempts <= 9 or not 1 <= args.fingerprints <= 64:
        raise ValueError("attempts must be 1..9 and fingerprint versions 1..64")
    chunks = args.chunks or fixture["chunks"]
    if not 1 <= chunks <= 64:
        raise ValueError("chunks must be 1..64")
    sessions = []
    for index in range(args.attempts):
        lease = FrozenLease(fixture, instrumented=not args.timing)
        request, chat = effective(lease)
        evidence = load(args.run)
        if evidence.generation != lease.state["source"]["generation"]:
            raise ReplayMismatch("canonical source generation changed")
        sessions.append({"lease": lease, "request": request, "chat": chat, "evidence": evidence,
                         "scope": f"retained-replay/{index}/{lease.attempt}", "running": {}, "clock": 0.,
                         "rows": [], "result": None, "cpu": 0., "wall": 0., "revision": 0})
    # A fresh subprocess is used for each report; clear only this process's derived state.
    tokens._attempts.clear()
    tokens._kept = 0
    getattr(tokens, "_compiled", {}).clear()
    gc.collect()
    before = memory()
    if args.memory:
        tracemalloc.start()
    revision, fresh_counts = 0, 0
    metric = Counter()

    def post(counter, body):
        nonlocal fresh_counts
        key = tokens._digest([counter._base, counter.model, getattr(counter._chat, "headers", None), body]).hex()
        if key not in observations:
            if not args.collect_tokenize or counter._base not in routes:
                raise ReplayMismatch("unknown frozen tokenizer request")
            # Only the tokenize route is reachable, not an adapter's generation route.
            response = requests.post(routes[counter._base].rstrip("/") + "/tokenize", json=body, timeout=60)
            response.raise_for_status()
            observations[key] = response.json()
            args.counts.write_text(json.dumps(observations))
            args.counts.chmod(0o600)
            fresh_counts += 1
        answer = observations[key]
        metric["tokenizer_observations_read"] += 1
        if revision and body == counter._chat.tokenize_body(system=tokens.PROBE_SYSTEM, user=tokens.PROBE_USER,
                                                           schema=tokens.PROBE_SCHEMA):
            answer = copy.deepcopy(answer)
            if not isinstance(answer.get("tokens"), list) or not answer["tokens"]:
                raise ReplayMismatch("fingerprint stress requires saved probe token IDs")
            answer["tokens"][0] += revision * 1000000
        return answer

    def forbidden(*_, **__):
        raise ReplayMismatch("fresh model generation is forbidden")

    with ExitStack() as stack:
        stack.enter_context(patch.object(tokens.TokenCounter, "_post", post))
        for adapter in {type(session["chat"].fields) for session in sessions} | \
                       {type(session["chat"].reasoning) for session in sessions}:
            stack.enter_context(patch.object(adapter, "complete", forbidden))
        for _ in range(10000):
            unfinished = [session for session in sessions if session["result"] is None]
            if not unfinished:
                break
            for session in unfinished:
                lease, chat = session["lease"], session["chat"]
                lease.round_counts.clear()
                lease.round_publications.clear()
                previous = set(lease.publications.values())
                planner = CapturePlanner(lease)
                cpu, wall = time.process_time(), time.perf_counter()
                try:
                    with tokens.counting(session["scope"]):
                        result = dispatch(args.run, session["evidence"], session["request"],
                                          Router(chat.fields, chat.reasoning, planner), chunks=chunks)
                except NeedsCall:
                    result = None
                cpu, wall = time.process_time() - cpu, time.perf_counter() - wall
                session["cpu"] += cpu
                session["wall"] += wall
                pending = sorted(planner.pending, key=planner.pending.get)
                row = {"pending": [planner.pending[capture] for capture in pending],
                       "scopes": digest(planner.scopes), "coordination": dict(lease.round_counts),
                       "new_publications": sorted(set(lease.publications.values()) - previous),
                       "publication_visits": len(lease.round_publications), "started": [], "completed": []}
                if result is not None:
                    if len(lease.done) != len(lease.by_id):
                        raise ReplayMismatch("unconsumed frozen replies")
                    session["result"] = stable(result)
                    session["scopes"] = planner.scopes
                    planned = set(lease.publications.values())
                    lease.state["recordScopes"] = planner.scopes
                    publish_final(lease, {**result, "started": "fixed-replay-clock", "seconds": 0})
                    session["final_publications"] = sorted(set(lease.publications.values()) - planned)
                else:
                    for capture in pending:
                        running, role = session["running"], planner.roles[capture]
                        if capture not in running and capture not in lease.done and \
                                sum(each[1] == role for each in running.values()) < chunks:
                            saved_calls = lease.by_id[capture]["checkpoint"]["output"].get("calls", [])
                            duration = max(.001, sum(call.get("seconds", 0.) for call in saved_calls))
                            running[capture] = (session["clock"] + duration, role)
                            row["started"].append(planner.pending[capture])
                    if not session["running"]:
                        raise ReplayMismatch("no runnable frozen call")
                    session["clock"] = min(end for end, _ in session["running"].values())
                    finished = [capture for capture, (end, _) in session["running"].items()
                                if end <= session["clock"]]
                    row["completed"] = sorted(lease.by_id[capture]["unitKey"] for capture in finished)
                    lease.done.update(finished)
                    for capture in finished:
                        del session["running"][capture]
                session["rows"].append(row)
        else:
            raise ReplayMismatch("planning round limit exceeded")
        retained = [memory()]
        for revision in range(1, args.fingerprints):
            for session in sessions:
                lease, chat = session["lease"], session["chat"]
                planner = CapturePlanner(lease)
                with tokens.counting(session["scope"]):
                    result = dispatch(args.run, session["evidence"], session["request"],
                                      Router(chat.fields, chat.reasoning, planner), chunks=chunks)
                if digest(stable(result)) != digest(session["result"]) or planner.pending:
                    raise ReplayMismatch("fingerprint recomputation changed completed output")
            retained.append(memory())
    if args.collect_tokenize:
        args.counts.write_text(json.dumps(observations))
        args.counts.chmod(0o600)
    after = memory()
    for session in sessions:
        tokens.forget(session["scope"])
    gc.collect()
    forgotten = memory()
    if args.memory:
        tracemalloc.stop()
    reports = []
    for session in sessions:
        lease, result = session["lease"], session["result"]
        reports.append({"rounds": len(session["rows"]), "planning_cpu_seconds": session["cpu"],
                        "planning_wall_seconds": session["wall"], "artifact": digest(result),
                        "evidence": digest(result.get("evidence", [])), "records": len(result.get("records", [])),
                        "scopes": digest(session["scopes"]), "plans": lease.visited_plans,
                        "inputs": {key: digest(lease.captures[key]["input"]) for key in sorted(lease.looked_up)},
                        "publications": sorted(set(lease.publications.values())),
                        "final_publications": session["final_publications"],
                        "coordination": dict(lease.counts), "per_round": session["rows"]})
    root = Path(kei_exp.__file__).resolve().parents[4]
    sha = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    report = {"source_sha": sha, "fixture_sha256": pin(args.fixture), "counts_sha256": pin(args.counts),
              "source_manifest_sha256": pin(args.run / "result" / "result.json"), "chunks": chunks,
              "attempts": args.attempts, "fingerprints": args.fingerprints, "memory_instrumented": args.memory,
              "timing_only": args.timing,
              "fresh_model_calls": 0, "fresh_tokenizer_requests": fresh_counts,
              "sessions": reports, "memory_before": before, "memory_retained": retained,
              "memory_after": after, "memory_forgotten": forgotten, "tokenizer_metrics": dict(metric),
              "module_sha256": {module.__name__: pin(Path(inspect.getfile(module)))
                                for module in (tokens, unified, discovery)},
              "limits": ["Planning replay; no end-to-end extraction timing or recall claim",
                         "Finalized inputs/candidates frozen, not independently recomposed",
                         "Only artifact top-level started/seconds normalized; saved call clocks retained",
                         "Final publication wall clocks fixed identically before publication",
                         "In-memory coordination; database latency excluded",
                         "Fingerprint stress simulates probe revisions with unchanged payload counts",
                         "Gross cache reachable bytes include shared objects; RSS is whole process"]}
    args.report.write_text(json.dumps(report))
    print(json.dumps({"source_sha": sha, "chunks": chunks, "attempts": args.attempts,
                      "sessions": [{key: value for key, value in session.items()
                                    if key in ("rounds", "planning_cpu_seconds", "planning_wall_seconds", "records", "artifact")}
                                   for session in reports],
                      "retained": retained[-1], "forgotten": forgotten,
                      "fresh_tokenizer_requests": fresh_counts}))


def compare(args):
    base, candidate = (json.loads(path.read_text()) for path in (args.baseline, args.candidate))
    problems = []
    if base.get("timing_only") or candidate.get("timing_only"):
        problems.append("timing-only reports cannot establish full equivalence")
    for key in ("fixture_sha256", "counts_sha256", "source_manifest_sha256", "chunks", "attempts", "fingerprints"):
        if base[key] != candidate[key]:
            problems.append(key)
    if len(base["sessions"]) != len(candidate["sessions"]):
        problems.append("session count")
    def coordination(before, after, where):
        for routine in set(before) | set(after):
            old, new = before.get(routine, 0), after.get(routine, 0)
            if new > old or (routine not in ("publish_plan", "capture_unit", "publish_snapshot") and new != old):
                problems.append(f"{where}: {routine}")

    for index, (before, after) in enumerate(zip(base["sessions"], candidate["sessions"])):
        for key in ("rounds", "artifact", "evidence", "records", "scopes", "plans", "inputs", "publications",
                    "final_publications"):
            if before[key] != after[key]:
                problems.append(f"session {index}: {key}")
        coordination(before["coordination"], after["coordination"], f"session {index} total")
        if len(before["per_round"]) != len(after["per_round"]):
            problems.append(f"session {index}: per_round length")
        for number, (b, c) in enumerate(zip(before["per_round"], after["per_round"])):
            for key in ("pending", "scopes", "new_publications", "started", "completed"):
                if b[key] != c[key]:
                    problems.append(f"session {index} round {number}: {key}")
            coordination(b["coordination"], c["coordination"], f"session {index} round {number}")
    print(json.dumps({"equivalent": not problems, "problems": problems[:30]}))
    return int(bool(problems))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("replay")
    for name in ("fixture", "run", "counts", "report"):
        one.add_argument(name, type=Path)
    one.add_argument("--chunks", type=int)
    one.add_argument("--attempts", type=int, default=1)
    one.add_argument("--fingerprints", type=int, default=1)
    one.add_argument("--memory", action="store_true")
    one.add_argument("--timing", action="store_true", help="no coordination tallies or publication-hash instrumentation")
    one.add_argument("--collect-tokenize", action="store_true")
    one.add_argument("--routes", type=Path)
    two = commands.add_parser("compare")
    two.add_argument("baseline", type=Path)
    two.add_argument("candidate", type=Path)
    args = parser.parse_args()
    return replay(args) if args.command == "replay" else compare(args)


if __name__ == "__main__":
    raise SystemExit(main())
