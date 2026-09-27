"""Verify a refactor against exact captured requests/replies; no network or model calls.

Usage: python experiments/extraction/replay_reference.py CAPTURE_ROOT OUTPUT_JSON
Each source directory supplies pins.json, artifact.json and role-NNN.request/reply.json.
Only wall-clock fields are excluded from artifact equality. Captures are never rewritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import ExtractRequest, extract


def key(request: dict) -> str:
    return json.dumps({k: request[k] for k in ("system", "user", "schema")}, sort_keys=True, ensure_ascii=False)


class Captured:
    def __init__(self, root: Path, role: str, model: str, context: int):
        self.model, self.context_tokens, self.index = model, context, 0
        self.calls = [(json.loads(p.read_text()), json.loads(p.with_name(
            p.name.replace(".request.", ".reply.")).read_text()))
            for p in sorted(root.glob(f"{role}-*.request.json"))]
        self.counts = {}
        for request, reply in self.calls:
            identifier = key(request)
            if identifier in self.counts and self.counts[identifier] != reply["input_tokens"]:
                raise ValueError("equal captured requests disagree on input tokens")
            self.counts[identifier] = reply["input_tokens"]

    def request_tokens(self, system, user, schema=None):
        return self.counts[key(dict(system=system, user=user, schema=schema))]

    def complete(self, **request):
        expected, reply = self.calls[self.index]
        if request != expected:
            raise AssertionError(f"model request {self.index + 1} changed")
        self.index += 1
        return Reply(**reply)


def stable(artifact: dict) -> dict:
    return {k: v for k, v in artifact.items() if k not in ("started", "seconds")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("captures", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    report = []
    for directory in sorted(args.captures.iterdir()):
        if not (directory / "artifact.json").is_file():
            continue
        expected = json.loads((directory / "artifact.json").read_text())
        pins = json.loads((directory / "pins.json").read_text())
        contexts = {call["context_tokens"] for call in expected["calls"] if call.get("context_tokens")}
        if len(contexts) != 1:
            raise ValueError("reference needs one recorded serving context")
        chats = {role: Captured(directory, role, model, next(iter(contexts)))
                 for role, model in expected["models"].items()}
        result = extract(Path(pins["canonical_run"]), ExtractRequest.model_validate({
            "schema": expected["schema"], "options": expected["options"]}),
            Router(**chats), counter=chats, generation=expected["generation"])
        left, right = stable(expected), stable(result)
        if left != right:
            raise AssertionError(f"{directory.name}: changed artifact keys: "
                                 f"{[k for k in left.keys() | right.keys() if left.get(k) != right.get(k)]}")
        assert all(chat.index == len(chat.calls) for chat in chats.values())
        report.append({"source": directory.name, "calls": sum(c.index for c in chats.values()),
                       "records": len(result["records"]), "equal": True,
                       "artifact_sha256": hashlib.sha256(json.dumps(right, sort_keys=True).encode()).hexdigest()})
    if not report:
        raise ValueError("no captured reference artifacts")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        json.dump({"kind": "offline replay; not fresh inference", "sources": report}, output, indent=2)
    print(f"{len(report)} sources, {sum(r['calls'] for r in report)} identical requests and replies")


if __name__ == "__main__":
    main()
