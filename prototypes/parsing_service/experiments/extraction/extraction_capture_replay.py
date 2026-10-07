"""Rebuild sealed fresh-call study outputs from exact replies; never generate responses.

From the study's pinned Parsing Service checkout:
PYTHONPATH=src:. .venv/bin/python /path/to/this.py STUDY_DIR REPORT_JSON TOKEN_CACHE
Missing partition/admission counts fail offline. --allow-tokenize permits only
new tokenizer probes, saved separately for subsequent offline verification.
Conditional R2a outputs use their own selection_replay command.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import kei_exp
from experiments.extraction.manifest import digest, pin, read, validate, write_new
from experiments.extraction.replay_reference import Captured, key, stable
from kei_exp.kie.extract.llm import OpenAIChat
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import extract
from kei_exp.kie.extract.tokens import SOURCE, TokenCounter, counter_for


class Counts(TokenCounter):
    def __init__(self, captured, provider, directory, allow_tokenize):
        super().__init__(SOURCE, provider["model"], provider["context_tokens"])
        self.captured, self.provider, self.directory = captured, provider, directory
        self.allow_tokenize, self.live = allow_tokenize, None
        self.fresh = 0
        self.used = {}

    def request_tokens(self, system, user, schema=None):
        request = dict(system=system, user=user, schema=schema)
        recorded = self.captured.counts.get(key(request))
        if recorded is not None:
            return recorded
        path = self.directory / (digest(json.dumps(request, sort_keys=True).encode()) + ".json")
        if path.exists():
            item = read(path)
            if item["request"] != json.loads(json.dumps(request)) or item["provider"] != self.provider:
                raise ValueError("tokenizer cache request/provider mismatch")
            count = item["count"]
        else:
            if not self.allow_tokenize:
                raise ValueError("missing token probe; offline replay cannot establish this boundary")
            if self.live is None:
                self.live = counter_for(OpenAIChat(url=self.provider["base_url"] + "/v1/chat/completions",
                                                  model=self.provider["model"]))
                if self.live.context_tokens != self.context_tokens:
                    raise ValueError("tokenizer serving context changed")
            count = self.live.request_tokens(system, user, schema)
            write_new(path, {"request": request, "provider": self.provider, "count": count})
            self.fresh += 1
        self.used[str(path)] = pin(path)
        return count


def replay(study, cell, directory, token_cache, allow_tokenize):
    completed = read(directory / "result.json")
    expected, execution = completed["artifact"], completed["execution"]
    if execution["status"] != "completed":
        raise ValueError("result has no completed execution receipt")
    if digest(json.dumps(expected, sort_keys=True).encode()) != execution["artifact_sha256"]:
        raise ValueError("changed artifact seal")
    if read(directory / f"attempt-{execution['attempt']:03}.finished.json") != execution:
        raise ValueError("execution receipt mismatch")
    capture_pins = [pin(path) for path in sorted((directory / "calls").glob("*.json"))]
    chats = {role: Captured(directory / "calls", role, provider["model"], provider["context_tokens"])
             for role, provider in study["providers"].items()}
    counters = {role: Counts(chats[role], provider, token_cache / role, allow_tokenize)
                for role, provider in study["providers"].items()}
    source = next(source for source in study["sources"] if source["id"] == cell["source"])
    result = extract(Path(source["run"]), cell["request"], Router(**chats), counter=counters,
                     generation=source["generation"])
    actual = json.loads(json.dumps(stable(result)))
    wanted = stable(expected)
    if actual != wanted:
        changed = sorted(k for k in actual.keys() | wanted.keys() if actual.get(k) != wanted.get(k))
        raise ValueError(f"replay artifact differs: {changed}")
    if any(chat.index != len(chat.calls) for chat in chats.values()):
        raise ValueError("unconsumed captured replies")
    if capture_pins != [pin(Path(item["path"])) for item in capture_pins]:
        raise ValueError("captures changed during replay")
    return {"cell": cell["id"], "equal_except_top_level_clocks": True,
            "calls": sum(chat.index for chat in chats.values()), "result": pin(directory / "result.json"),
            "captures": capture_pins, "fresh_model_calls": 0,
            "fresh_tokenizer_probes": sum(counter.fresh for counter in counters.values()),
            "tokenizer_probes": [item for counter in counters.values() for item in counter.used.values()]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study", type=Path)
    parser.add_argument("report", type=Path)
    parser.add_argument("token_cache", type=Path)
    parser.add_argument("--allow-tokenize", action="store_true")
    parser.add_argument("--cell", action="append")
    args = parser.parse_args()
    if args.report.exists():
        raise FileExistsError(args.report)
    study = read(args.study / "manifest.json")
    cells = validate(study, Path(kei_exp.__file__).resolve().parents[2])
    if args.cell:
        if set(args.cell) - {cell["id"] for cell in cells}:
            raise ValueError("unknown requested cell")
        cells = [cell for cell in cells if cell["id"] in args.cell]
    results, pending = [], []
    manifest_hash = digest((args.study / "manifest.json").read_bytes())
    for cell in cells:
        directory = args.study / "cells" / cell["id"]
        if not (directory / "result.json").exists():
            pending.append(cell["id"])
            continue
        if read(directory / "pin.json") != {"cell": cell["id"], "manifest_sha256": manifest_hash}:
            raise ValueError("cell manifest mismatch")
        results.append(replay(study, cell, directory, args.token_cache, args.allow_tokenize))
        print(f"verified {cell['id']}", flush=True)
    write_new(args.report, {"kind": "exact response replay; not fresh inference",
        "script": pin(Path(__file__)), "manifest": pin(args.study / "manifest.json"),
        "verified": results, "pending": pending,
        "limits": "Only top-level started/seconds are excluded. Tokenizer probes may be later observations, not original R1 captures. Provider identity is configured/observed, not a loaded-weights attestation."})


if __name__ == "__main__":
    main()
