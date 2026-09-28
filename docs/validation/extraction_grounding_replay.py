"""Replay completed/budget-ended fixed-upstream grounding cells with HTTP disabled.

Run from the registered frozen Parsing Service source:
PYTHONPATH=src:. python /path/to/this.py R5_OUTPUT REPORT_JSON
Missing replies/probes are explicit gaps, never a reason to generate replacements.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import kei_exp
import requests

from experiments.extraction.fixed_upstream import normalized
from experiments.extraction.grounding_study import RecordedCounts, fixed_grounding
from experiments.extraction.manifest import digest, pin, read, validate, write_new
from experiments.extraction.replay_reference import Captured, stable
from kei_exp.kie.extract.models import Router


class OfflineCounter:
    def __init__(self, context):
        self.context_tokens = context

    def request_tokens(self, *_args, **_kwargs):
        raise AssertionError("missing saved grounding token probe; offline replay cannot continue")


def replay_cell(study: dict, cell: dict, output: Path) -> dict:
    directory = output / "cells" / cell["id"]
    terminals = sorted(directory.glob("attempt-*.finished.json"))
    if not terminals:
        return {"cell": cell["id"], "status": "pending", "exact_replay": False}
    terminal_path = terminals[-1]
    terminal = read(terminal_path)
    if read(directory / "pin.json") != {"cell": cell["id"], "manifest_sha256": pin(output / "manifest.json")["sha256"]}:
        raise ValueError("cell belongs to another grounding manifest")
    result_path = directory / "result.json"
    if terminal["status"] == "completed":
        saved = read(result_path)
        if (saved["execution"] != terminal
                or digest(json.dumps(saved["artifact"], sort_keys=True).encode()) != terminal["artifact_sha256"]):
            raise ValueError("completed grounding result seal/receipt mismatch")
    elif terminal.get("error_type") != "TimeoutError" or terminal.get("error") != "registered cumulative grounding model-time budget exhausted":
        return {"cell": cell["id"], "status": "infrastructure_failure_requires_review", "exact_replay": False,
                "terminal": pin(terminal_path), "reason": "cannot recreate an uncaptured external failure"}
    elif result_path.exists():
        raise ValueError("budget-ended cell also has a completed result")
    capture_pins = [pin(path) for path in sorted((directory / "calls").glob("*.json"))]
    probe_pins = [pin(path) for path in sorted((output / "token-counts" / cell["id"]).glob("*.json"))]
    chats = {role: Captured(directory / "calls", role, provider["model"], provider["context_tokens"])
             for role, provider in study["providers"].items()}
    provider = study["providers"]["reasoning"]
    counter = RecordedCounts(OfflineCounter(provider["context_tokens"]), output / "token-counts" / cell["id"], provider)
    source = next(item for item in study["sources"] if item["id"] == cell["source"])
    try:
        actual = fixed_grounding(source, cell["request"], Router(**chats), {"reasoning": counter},
            model_seconds=study["grounding_study"]["model_seconds_per_cell"])
    except TimeoutError as error:
        if terminal["status"] != "failed" or str(error) != terminal["error"]:
            raise ValueError("replayed grounding budget outcome differs") from error
    else:
        if terminal["status"] != "completed" or normalized(stable(actual)) != stable(saved["artifact"]):
            raise ValueError("replayed grounding artifact differs beyond top-level clocks")
    if any(chat.index != len(chat.calls) for chat in chats.values()):
        raise ValueError("grounding replay left unconsumed captures")
    if chats["fields"].index:
        raise ValueError("grounding-only study has upstream field calls")
    if capture_pins != [pin(Path(item["path"])) for item in capture_pins] or probe_pins != [
            pin(Path(item["path"])) for item in probe_pins]:
        raise ValueError("grounding captures/probes changed during replay")
    return {"cell": cell["id"], "status": terminal["status"], "exact_replay": True,
        "terminal": pin(terminal_path), "result": pin(result_path) if result_path.exists() else None,
        "captures": capture_pins, "tokenizer_probes": probe_pins, "calls": chats["reasoning"].index,
        "fresh_model_calls": 0, "fresh_tokenizer_probes": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    def forbidden(*_args, **_kwargs):
        raise AssertionError("HTTP disabled during fixed-grounding replay")
    requests.Session.request = forbidden
    study = read(args.study / "manifest.json")
    cells = validate(study, Path(kei_exp.__file__).resolve().parents[2])
    results = []
    for cell in cells:
        result = replay_cell(study, cell, args.study)
        results.append(result)
        print(f"{cell['id']}: {result['status']}", flush=True)
    write_new(args.report, {"kind": "exact HTTP-disabled fixed-grounding replay", "script": pin(Path(__file__)),
        "manifest": pin(args.study / "manifest.json"), "cells": results,
        "limits": "Saved model replies and exact location reconstruction are not independent semantic labels."})


if __name__ == "__main__":
    main()
