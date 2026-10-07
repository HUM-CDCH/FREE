"""Conditional selector comparison: exact R1 reply subsequences, never fresh generation.

See selection-protocol.md. Commands: register R1_DIR OUTPUT; run OUTPUT SOURCE.
The original bounded replay must match before either paired artifact is published.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from kei_exp.kie.extract.llm import OpenAIChat, Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import extract
from kei_exp.kie.extract.tokens import counter_for

from .manifest import checked, code_pin, digest, pin, read, request, validate, write_new
from .replay_reference import stable


def normalized(value):
    return json.loads(json.dumps(value))


class Subsequence:
    def __init__(self, directory, role, model):
        self.model, self.cursor, self.used = model, 0, []
        self.calls = [(p, read(p), read(p.with_name(p.name.replace(".request.", ".reply."))))
                      for p in sorted(directory.glob(f"{role}-*.request.json"))]
        responses = {}
        for _, requested, reply in self.calls:
            key = json.dumps(requested, sort_keys=True)
            if key in responses and responses[key] != reply:
                raise ValueError("ambiguous repeated request has different replies; conditional replay refused")
            responses[key] = reply

    def complete(self, **value):
        for index in range(self.cursor, len(self.calls)):
            path, expected, reply = self.calls[index]
            if expected == normalized(value):
                self.cursor = index + 1
                self.used.append(pin(path))
                return Reply(**reply)
        raise ValueError("request absent from remaining captured subsequence; no live generation allowed")


class Counts:
    """Persist actual tokenizer answers, including partition probes not saved in R1."""
    def __init__(self, provider, directory):
        self.provider, self.directory, self.live = provider, directory, None
        self.context_tokens = provider["context_tokens"]

    def request_tokens(self, system, user, schema=None):
        value = dict(system=system, user=user, schema=schema)
        key = digest(json.dumps(value, sort_keys=True).encode())
        path = self.directory / f"{key}.json"
        if path.exists():
            item = read(path)
            if item["request"] != normalized(value):
                raise ValueError("tokenizer cache request differs")
            return item["count"]
        if self.live is None:
            self.live = counter_for(OpenAIChat(url=self.provider["base_url"] + "/v1/chat/completions",
                                              model=self.provider["model"]))
            if self.live.context_tokens != self.context_tokens:
                raise ValueError("served context changed")
        count = self.live.request_tokens(system, user, schema)
        write_new(path, {"request": value, "count": count})
        return count


def register(parent: Path, output: Path):
    study = read(parent / "manifest.json")
    study["id"] = "extraction-selection-replay-20260927-r2a"
    method = normalized(study["methods"]["bounded"])
    method["article"]["grounding"] = "off"
    selected = normalized(method)
    selected["article"]["selection"] = "supported"
    study["methods"] = {"all_units": method, "selected": selected}
    study["sources"] = [s for s in study["sources"] if "bounded" in s["methods"]]
    for source in study["sources"]:
        source["methods"] = ["all_units", "selected"]
    study["comparisons"] = [{"control": "all_units", "treatment": "selected", "factor": "article.selection"}]
    study["interactions"] = []
    study["code_files"] = code_pin(Path(__file__).resolve().parents[2])
    study["replay"] = {"parent": pin(parent / "manifest.json"),
                       "protocol": pin(Path(__file__).with_name("selection-protocol.md")),
                       "interpretation": "fixed captured responses; no independent repetition or fresh inference latency"}
    validate(study, Path(__file__).resolve().parents[2])
    write_new(output / "manifest.json", study)


def execute(output: Path, source_id: str):
    study = read(output / "manifest.json")
    validate(study, Path(__file__).resolve().parents[2])
    checked(study["replay"]["protocol"])
    parent = checked(study["replay"]["parent"]).parent
    original = read(parent / "manifest.json")
    source = next(s for s in study["sources"] if s["id"] == source_id)
    prior = parent / "cells" / f"{source_id}--bounded--0"
    envelope = read(prior / "result.json")  # missing parent is an explicit unavailable cell
    expected = envelope["artifact"]
    if digest(json.dumps(expected, sort_keys=True).encode()) != envelope["execution"]["artifact_sha256"]:
        raise ValueError("parent artifact differs from its receipt")
    if read(prior / "pin.json")["manifest_sha256"] != study["replay"]["parent"]["sha256"]:
        raise ValueError("parent cell manifest mismatch")
    captures = [pin(p) for p in sorted((prior / "calls").glob("*.json"))]
    provenance = {"result": pin(prior / "result.json"), "captures": captures}
    source_pin = output / "parents" / f"{source_id}.json"
    if source_pin.exists():
        if read(source_pin) != provenance:
            raise ValueError("parent captures changed")
    else:
        write_new(source_pin, provenance)
    counters = {role: Counts(provider, output / "token-counts" / role)
                for role, provider in study["providers"].items()}
    results = []
    for name, configured in [("original", request(source, original["methods"]["bounded"])),
                             *[(name, request(source, method)) for name, method in study["methods"].items()]]:
        chats = {role: Subsequence(prior / "calls", role, provider["model"])
                 for role, provider in study["providers"].items()}
        artifact = extract(Path(source["run"]), configured, Router(**chats), counter=counters,
                           generation=source["generation"])
        if name == "original":
            if normalized(stable(artifact)) != normalized(stable(expected)):
                raise ValueError("original bounded artifact differs; control replay failed")
            if any(len(chat.used) != len(chat.calls) for chat in chats.values()):
                raise ValueError("original replay did not consume all captures")
            continue
        results.append((name, artifact, [item for chat in chats.values() for item in chat.used]))
    for name, artifact, used in results:
        cell = f"{source_id}--{name}--0"
        directory = output / "cells" / cell
        receipt = {"status": "completed", "attempt": 1, "fresh_calls": 0, "reused_calls": len(used),
                   "artifact_sha256": digest(json.dumps(artifact, sort_keys=True).encode()),
                   "kind": "conditional fixed-response replay", "used_requests": used,
                   "wall_seconds_this_attempt": None, "original_control_equal": True}
        cell_pin = {"cell": cell, "manifest_sha256": digest((output / "manifest.json").read_bytes())}
        if (directory / "pin.json").exists():
            if read(directory / "pin.json") != cell_pin:
                raise ValueError("replay cell belongs to another manifest")
        else:
            write_new(directory / "pin.json", cell_pin)
        if (directory / "result.json").exists():
            saved = read(directory / "result.json")
            if (normalized(stable(saved["artifact"])) != normalized(stable(artifact))
                    or digest(json.dumps(saved["artifact"], sort_keys=True).encode())
                    != saved["execution"]["artifact_sha256"]):
                raise ValueError("existing replay result differs")
        else:
            write_new(directory / "result.json", {"artifact": artifact, "execution": receipt})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["register", "run"])
    parser.add_argument("path", type=Path)
    parser.add_argument("target")
    args = parser.parse_args()
    if args.command == "register":
        register(args.path, Path(args.target))
    else:
        execute(args.path, args.target)


if __name__ == "__main__":
    main()
