"""Describe disagreement between identical captured grounding requests; never call a model.

Usage: python extraction_grounding_variation.py STUDY_DIR SOURCE OUTPUT_JSON
Comparisons include every requested claim, including derived fields. Pairs sharing
a response are dependent; their disagreement fraction is not an accuracy estimate.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
from itertools import combinations
import json
from pathlib import Path


def pin(path):
    return {"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def compare(captures):
    groups = defaultdict(list)
    for capture in captures:
        # Preserve schema property order: constrained decoding may depend on it.
        key = json.dumps(capture["request"], ensure_ascii=False)
        groups[key].append(capture)
    shared = []
    for key, members in sorted(groups.items()):
        if len(members) < 2:
            continue
        valid = []
        unreadable = []
        for member in members:
            reply = member["reply"]
            try:
                answer = json.loads(reply["text"], strict=False)
            except json.JSONDecodeError:
                answer = None
            if reply["finish"] != "stop" or not isinstance(answer, dict):
                unreadable.append(member["id"])
            else:
                valid.append((member, answer))
        differences = []
        comparisons = 0
        missing = {"missing_response_key": True}
        for (a, left), (b, right) in combinations(valid, 2):
            for claim in a["request"]["schema"]["required"]:
                comparisons += 1
                if left.get(claim, missing) != right.get(claim, missing):
                    differences.append({"left": a["id"], "right": b["id"], "claim": claim,
                        "left_decision": left.get(claim, missing), "right_decision": right.get(claim, missing)})
        shared.append({"request_sha256": hashlib.sha256(key.encode()).hexdigest(),
            "members": [m["id"] for m in members], "unreadable_or_truncated": unreadable,
            "claim_pair_comparisons": comparisons, "differences": differences})
    return {"captured_requests": len(captures), "unique_requests": len(groups),
        "shared_request_groups": len(shared),
        "divergent_groups": sum(bool(g["differences"]) for g in shared),
        "claim_pair_comparisons": sum(g["claim_pair_comparisons"] for g in shared),
        "different_decisions": sum(len(g["differences"]) for g in shared), "groups": shared,
        "limits": "All requested claims; no semantic scoring. All unordered pairs, not comparisons against one reference. Pairs are dependent. Equality covers captured system/user/schema/max_tokens within the pinned study provider; unavailable server/model revisions remain unverified."}


def report(study, source):
    manifest_path = study / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    entry = next(s for s in manifest["sources"] if s["id"] == source)
    captures, pins = [], [pin(manifest_path)]
    for method in entry["methods"]:
        for repeat in range(manifest["repeats"]):
            directory = study / "cells" / f"{source}--{method}--{repeat}" / "calls"
            for path in sorted(directory.glob("reasoning-*.request.json")):
                request = json.loads(path.read_text())
                if "### Claims\n" not in request["user"]:
                    continue
                reply_path = path.with_name(path.name.replace(".request.json", ".reply.json"))
                # A missing reply is incomplete evidence, never a matching NONE decision.
                reply = json.loads(reply_path.read_text()) if reply_path.exists() else {
                    "text": "", "finish": None}
                pins.append(pin(path))
                if reply_path.exists():
                    pins.append(pin(reply_path))
                captures.append({"id": str(path.relative_to(study)), "request": request, "reply": reply})
    return {"source": source, "provider": manifest["providers"]["reasoning"],
        "inputs": pins, **compare(captures)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study", type=Path)
    parser.add_argument("source")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = {"script": pin(Path(__file__)), **report(args.study, args.source)}
    with args.output.open("x") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")
