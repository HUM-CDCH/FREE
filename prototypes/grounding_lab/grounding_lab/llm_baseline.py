"""LLM grounding baseline over the same dataset the harness scores.

Mirrors the production shape (groundingModelFor in
prototypes/studio/api/_extraction_runtime.ts + claimBatches in
packages/extraction/src/grounding.ts):

- claims are batched per record (one call per `records[i]` group plus one root
  batch), not one call per document;
- the model sees ONLY bare claim values under opaque labels, per the real
  GroundingModelRequest — no field names, no sibling context;
- anchors are rendered as a bracketed evidence listing `[E1] text`, the reply
  is `{"links": {"C1": "E4" | "NONE"}}`.

Deviations from the incumbent, stated: anchors use scoring_text (row context)
rather than grounding.ts's anchorText() whose table cells lose text after the
first ` | ` — the same anchor quality the neural tiers get; and the model is
whatever local Ollama serves, a capability floor rather than the strongest
routable incumbent.

Protocol failures (unparseable JSON, missing claim label, unknown anchor
label) are counted separately — never as abstentions.

Usage: uv run python -m grounding_lab.llm_baseline dataset [model]
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

from .harness import load_dataset

import os

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/") + "/api/chat"

PROMPT = """You link extracted values to the evidence passage that supports them.

Claims (label: value):
{claims}

Evidence passages:
{anchors}

For every claim label, answer with the ONE evidence label whose passage states
or directly supports the claim value, or "NONE" if no passage does. Reply with
JSON of the shape {{"links": {{"C1": "E4", "C2": "NONE"}}}} covering every
claim label. No other keys, no explanations."""


def claim_batches(claims: list) -> list[list[tuple[int, object]]]:
    """Group claims per record, mirroring claimBatches in grounding.ts."""
    batches: dict[object, list[tuple[int, object]]] = defaultdict(list)
    for i, claim in enumerate(claims):
        path = claim.result_path
        key = (
            f"records[{path[1]}]"
            if len(path) > 1 and path[0] == "records" and isinstance(path[1], int)
            else "$"
        )
        batches[key].append((i, claim))
    return list(batches.values())


def ground_batch(model: str, batch: list, anchors: list, think: bool = False) -> tuple[dict, float]:
    claim_lines = "\n".join(f"C{i + 1}: {c.value}" for i, c in batch)
    anchor_lines = "\n".join(
        f"[E{i + 1}] {a.scoring_text}" for i, a in enumerate(anchors)
    )
    content = PROMPT.format(claims=claim_lines, anchors=anchor_lines)
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "think": think,
        "format": "json",
        # Ollama truncates a prompt longer than num_ctx (garbage with
        # valid-looking labels, or "no user query found"), so size the window
        # from the prompt. Statistical tables tokenize at ~1.9 chars/token
        # (España en cifras: 355k chars -> 190k tokens); 1.5 leaves margin.
        "options": {"temperature": 0, "num_ctx": max(45056, int(len(content) / 1.5) + 8192)},
    }).encode()
    started = time.perf_counter()
    request = urllib.request.Request(
        OLLAMA, body, {"Content-Type": "application/json"}
    )
    # Thinking mode emits long chain-of-thought per batch; a big-document
    # batch can exceed 10 minutes of generation.
    try:
        with urllib.request.urlopen(request, timeout=3600 if think else 600) as response:
            content = json.load(response)["message"]["content"]
    except urllib.error.HTTPError as error:
        print(f"ollama {error.code}: {error.read().decode(errors='replace')[:500]}", file=sys.stderr)
        raise
    return parse_links(content), time.perf_counter() - started


def parse_links(content: str) -> dict:
    """Extract the {"links": {...}} object from a model reply.

    Shape validation mirrors groundingSelections in the production runtime
    (prototypes/studio/api/_extraction_runtime.ts): exactly one top-level
    "links" key holding an object whose values are non-empty strings.
    Anything else — including one malformed value — returns {}, which scores
    every claim in the batch as a protocol failure. The regex fallback only
    digs the JSON out of surrounding prose (a transport concern); it never
    relaxes the shape check.
    """
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            return {}
        try:
            parsed = json.loads(match.group())
        except json.JSONDecodeError:
            return {}
    if not (
        isinstance(parsed, dict)
        and set(parsed) == {"links"}
        and isinstance(parsed["links"], dict)
    ):
        return {}
    links = parsed["links"]
    return (
        links
        if all(isinstance(value, str) and value for value in links.values())
        else {}
    )


def main(root: Path, model: str, think: bool = False, ground=ground_batch) -> int:
    documents = load_dataset(root)
    correct = linkable = abstained = unlinkable = wrong = failures = 0
    total_seconds = 0.0
    total_claims = calls = 0
    audit: list[str] = []
    for doc_name, index, claims in documents:
        anchor_id_by_label = {
            f"E{i + 1}": anchor.anchor_id
            for i, anchor in enumerate(index.anchors)
        }
        for batch in claim_batches(claims):
            links, elapsed = ground(model, batch, index.anchors, think)
            total_seconds += elapsed
            total_claims += len(batch)
            calls += 1
            for i, claim in batch:
                picked = links.get(f"C{i + 1}")
                anchor_id, failed = None, False
                if picked is None or not isinstance(picked, str):
                    failed = True  # missing claim label / malformed value
                elif picked == "NONE":
                    pass
                elif picked in anchor_id_by_label:
                    anchor_id = anchor_id_by_label[picked]
                else:
                    failed = True  # unknown/non-canonical anchor label
                if claim.gold_anchor_ids:
                    linkable += 1
                    outcome = "✗"
                    if anchor_id in claim.gold_anchor_ids:
                        correct += 1
                        outcome = "✓"
                    elif anchor_id is not None:
                        wrong += 1
                else:
                    unlinkable += 1
                    outcome = "✓" if anchor_id is None and not failed else "✗"
                    if anchor_id is None and not failed:
                        abstained += 1
                    elif anchor_id is not None:
                        wrong += 1
                failures += failed
                value = str(claim.value)
                value = value if len(value) <= 40 else value[:37] + "…"
                audit.append(
                    f"| {doc_name} | {value} | {outcome} "
                    f"{(anchor_id or '—')[:18]}{' (protocol failure)' if failed else ''} |"
                )
        print(f"{doc_name}: done", file=sys.stderr)
    print(f"\n## LLM baseline ({model}, {calls} per-record calls)\n")
    print("| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |")
    print("|---|---|---|---|---|---|")
    print(
        f"| {model} | {correct}/{linkable} | {abstained}/{unlinkable} | "
        f"{wrong} | {failures} | {1000 * total_seconds / total_claims:.0f} |"
    )
    print("\n### Per-claim audit\n")
    print("| doc | claim | LLM pick |")
    print("|---|---|---|")
    print("\n".join(audit))
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--think"]
    raise SystemExit(main(
        Path(args[0] if args else "dataset"),
        args[1] if len(args) > 1 else "qwen3.8:latest",
        think="--think" in sys.argv,
    ))
