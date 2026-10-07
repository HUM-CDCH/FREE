"""Run registered cells with exact captures and resumable, immutable attempt records.

python -m experiments.extraction.study validate|preflight|run MANIFEST OUTPUT [--cell CELL_ID]
Uses existing model endpoints; never starts services or changes canonical inputs.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import random
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import requests

from kei_exp.kie.extract.llm import OpenAIChat, Reply
from kei_exp.kie.extract.article import inventory_request, source_contexts
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.method import LimitedCounter
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import extract
from kei_exp.kie.extract.tokens import counter_for
from kei_exp.kie.passages import load

from .manifest import digest, read, validate, write_new


def preflight(study: dict, cells: list[dict], *, output: Path | None = None) -> list[dict]:
    """Count the real inventory prompts, without generating answers or looking at gold."""
    provider = study["providers"]["reasoning"]
    counter = counter_for(OpenAIChat(url=provider["base_url"] + "/v1/chat/completions", model=provider["model"]))
    if "grounding_study" in study:
        from .grounding_study import preflight_fixed
        if output is None:
            raise ValueError("fixed grounding preflight needs an output directory for tokenizer probes")
        return preflight_fixed(study, cells, output, counter)
    report = []
    for cell in cells:
        method = cell["request"].options.article
        if method is None:
            continue  # Catalog counts each actual entry request during execution.
        source = next(s for s in study["sources"] if s["id"] == cell["source"])
        evidence = load(Path(source["run"]))
        limited = LimitedCounter(counter, method.context_tokens) if method.context == "bounded" else counter
        contexts = (source_contexts(evidence.passages, cell["request"].schema_, method, limited, lambda: None)
                    if method.context == "bounded" else [Context(evidence.passages)])
        counts = []
        for context in contexts:
            system, user, schema, _ = inventory_request(context.passages, cell["request"].schema_, method)
            counts.append(limited.request_tokens(system, user, schema))
        report.append({"cell": cell["id"], "inventory_units": len(contexts), "inventory_input_counts": counts,
                       "context_tokens": limited.context_tokens,
                       "units_refused_with_minimum_output": sum(n + 4096 > limited.context_tokens for n in counts),
                       "note": "Inventory admission only; each document, record and grounding call is counted separately at execution."})
        print(f"preflight {cell['id']}: {len(contexts)} units, largest input {max(counts, default=0)}", flush=True)
    return report


class Capture:
    def __init__(self, chat, root: Path, role: str):
        self.chat, self.root, self.role, self.model = chat, root, role, chat.model
        self.index = self.fresh = self.reused = self.uncertain = 0

    def complete(self, **request):
        self.index += 1
        prefix = self.root / f"{self.role}-{self.index:04}"
        requested, replied = prefix.with_suffix(".request.json"), prefix.with_suffix(".reply.json")
        if requested.exists():
            if read(requested) != request:
                raise ValueError(f"resume diverged at {requested.name}; use a new study revision")
            if replied.exists():
                self.reused += 1
                return Reply(**read(replied))
            self.uncertain += 1  # a prior process may have sent the call without saving its reply
        else:
            write_new(requested, request)
        reply = self.chat.complete(**request)
        write_new(replied, asdict(reply))
        self.fresh += 1
        return reply


def execute(study: dict, study_hash: str, cell: dict, output: Path) -> str:
    directory = output / "cells" / cell["id"]
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pin = {"manifest_sha256": study_hash, "cell": cell["id"]}
        if (directory / "pin.json").exists():
            if read(directory / "pin.json") != pin:
                raise ValueError("cell belongs to a different manifest")
        else:
            write_new(directory / "pin.json", pin)
        if (directory / "result.json").exists():
            completed = read(directory / "result.json")
            if digest(json.dumps(completed["artifact"], sort_keys=True).encode()) != completed["execution"]["artifact_sha256"]:
                raise ValueError("completed artifact changed")
            return "retained_completed"
        attempt = len(list(directory.glob("attempt-*.started.json"))) + 1
        prefix = directory / f"attempt-{attempt:03}"
        write_new(prefix.with_suffix(".started.json"), {"at": datetime.now(UTC).isoformat(), **pin})
        clock = time.monotonic()
        captures = {}
        try:
            clients, counters, providers = {}, {}, {}
            for role, provider in study["providers"].items():
                response = requests.get(provider["base_url"] + "/v1/models", timeout=30)
                response.raise_for_status()
                models = response.json()["data"]
                served = next((model for model in models if model["id"] == provider["model"]), None)
                if served is None or served.get("max_model_len") != provider["context_tokens"]:
                    raise ValueError(f"provider drift for {role}: {models}")
                providers[role] = served
                clients[role] = OpenAIChat(url=provider["base_url"] + "/v1/chat/completions", model=provider["model"])
                counters[role] = counter_for(clients[role])
                captures[role] = Capture(clients[role], directory / "calls", role)
            if "grounding_study" in study:
                from .grounding_study import RecordedCounts
                counters["reasoning"] = RecordedCounts(counters["reasoning"], output / "token-counts" / cell["id"],
                                                       study["providers"]["reasoning"])
            write_new(prefix.with_suffix(".providers.json"), providers)
            source = next(s for s in study["sources"] if s["id"] == cell["source"])
            if "grounding_study" in study:
                from .grounding_study import fixed_grounding
                result = fixed_grounding(source, cell["request"], Router(**captures), counters,
                    model_seconds=study["grounding_study"]["model_seconds_per_cell"])
            else:
                result = extract(Path(source["run"]), cell["request"], Router(**captures),
                                 counter=counters, generation=source["generation"])
            for capture in captures.values():
                if len(list((directory / "calls").glob(f"{capture.role}-*.reply.json"))) != capture.index:
                    raise ValueError("resume left unconsumed captured calls")
            terminal = {"status": "completed", "artifact_sha256": digest(json.dumps(result, sort_keys=True).encode())}
        except Exception as error:
            terminal = {"status": "failed", "error_type": type(error).__name__, "error": str(error)}
        terminal.update({"wall_seconds_this_attempt": time.monotonic() - clock,
                         "attempt": attempt,
                         "fresh_calls": sum(c.fresh for c in captures.values()),
                         "reused_calls": sum(c.reused for c in captures.values()),
                         "unknown_prior_completions": sum(c.uncertain for c in captures.values())})
        if terminal["status"] == "completed":
            # Result and execution receipt commit together; a crash cannot leave an unsealed success.
            write_new(directory / "result.json", {"artifact": result, "execution": terminal})
        write_new(prefix.with_suffix(".finished.json"), terminal)
        return terminal["status"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate", "preflight", "run"])
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cell")
    args = parser.parse_args()
    service = Path(__file__).resolve().parents[2]
    study = read(args.manifest)
    cells = validate(study, service)
    if args.cell:
        cells = [cell for cell in cells if cell["id"] == args.cell]
        if not cells:
            raise ValueError("unknown cell")
    print(f"validated {len(cells)} cells; {len(study['sources'])} sources", flush=True)
    if args.command == "validate":
        return
    if args.command == "preflight":
        write_new(args.output / "preflight.json", preflight(study, cells, output=args.output))
        return
    study_hash = digest(args.manifest.read_bytes())
    if (args.output / "manifest.json").exists():
        if read(args.output / "manifest.json") != study:
            raise ValueError("output directory already belongs to another study")
    else:
        write_new(args.output / "manifest.json", study)
    random.Random(study["order_seed"]).shuffle(cells)
    failures = 0
    for index, cell in enumerate(cells, 1):
        print(f"{index}/{len(cells)} {cell['id']} starting", flush=True)
        status = execute(study, study_hash, cell, args.output)
        failures += status == "failed"
        print(f"{index}/{len(cells)} {cell['id']} {status}", flush=True)
    if failures:
        raise SystemExit(f"{failures} failed cells; captures retained for exact resumption")


if __name__ == "__main__":
    main()
