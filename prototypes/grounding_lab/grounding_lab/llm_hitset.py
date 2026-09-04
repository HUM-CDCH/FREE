"""Policy E with the LLM as the hit-set scorer — the missing ablation.

Same shape as E (`lexical+ce` in pipeline.py), one substitution: where E hands
the multi-hit set to a cross-encoder, this hands it to the same local Ollama
model `llm_baseline` uses.

- exactly one lexical hit -> link it, no model call (as E);
- zero strict hits -> abstain, no model call (as E). Whitespace-tolerant
  (loose) hits also abstain here: E routes them to the scorer with a
  confidence cap, which has no counterpart in a link/NONE protocol;
- two or more hits -> ONE call carrying exactly what E's reranker gets: the
  rich claim (`render_claim`: field name, value, siblings) and only the hit
  set, rendered `[E1] scoring_text`.

The request, prompt and reply validation are `llm_baseline.ground_batch` /
`parse_links` verbatim; the rich claim rides in as the batch's single claim
value. Scoring matches `llm_baseline.main` line for line, so the two runs are
comparable: correct links, correct abstains, wrong links, protocol failures.

Usage: uv run python -m grounding_lab.llm_hitset dataset final_dataset ...
"""

from __future__ import annotations

import sys
import time
from dataclasses import replace
from pathlib import Path

from .harness import load_dataset
from .llm_baseline import ground_batch
from .pipeline import bounded_contains, lexical_tier, render_claim


def run(
    root: Path, model: str, think: bool = False, ground=ground_batch
) -> tuple[dict, list[str]]:
    """Ground every claim under `root`; returns (counters, audit rows)."""
    stats = dict(
        claims=0, correct=0, linkable=0, abstained=0, unlinkable=0,
        wrong=0, failures=0, calls=0, seconds=0.0,
    )
    audit: list[str] = []
    for doc_name, index, claims in load_dataset(root):
        for claim in claims:
            started = time.perf_counter()
            decided, hits = lexical_tier(claim, index.anchors)
            anchor_id, failed, tier = None, False, "lexical"
            if decided is not None:
                anchor_id = decided.anchor_id  # one hit links, no hits abstain
            elif not bounded_contains(claim.value, hits[0].text):
                tier = "loose"  # non-verbatim hits: abstain, no model call
            else:
                tier = "llm"
                by_label = {f"E{i + 1}": a.anchor_id for i, a in enumerate(hits)}
                rich = replace(claim, value=render_claim(claim))
                # ponytail: the Ollama box is shared, so a queued call can
                # blow ground_batch's fixed timeout. Retry twice; a claim
                # that still times out raises rather than scoring silently.
                for attempt in range(3):
                    try:
                        links, _ = ground(model, [(0, rich)], hits, think)
                        break
                    except TimeoutError:
                        print(f"timeout, retry {attempt + 1}", file=sys.stderr)
                else:
                    raise TimeoutError(f"{doc_name}: {claim.value!r}")
                stats["calls"] += 1
                picked = links.get("C1")
                if picked is None or not isinstance(picked, str):
                    failed = True  # missing claim label / malformed value
                elif picked == "NONE":
                    pass
                elif picked in by_label:
                    anchor_id = by_label[picked]
                else:
                    failed = True  # unknown/non-canonical anchor label
            stats["seconds"] += time.perf_counter() - started
            stats["claims"] += 1
            if claim.gold_anchor_ids:
                stats["linkable"] += 1
                outcome = "✗"
                if anchor_id in claim.gold_anchor_ids:
                    stats["correct"] += 1
                    outcome = "✓"
                elif anchor_id is not None:
                    stats["wrong"] += 1
            else:
                stats["unlinkable"] += 1
                outcome = "✓" if anchor_id is None and not failed else "✗"
                if anchor_id is None and not failed:
                    stats["abstained"] += 1
                elif anchor_id is not None:
                    stats["wrong"] += 1
            stats["failures"] += failed
            value = str(claim.value)
            value = value if len(value) <= 40 else value[:37] + "…"
            audit.append(
                f"| {doc_name} | {value} | {len(hits)} | {tier} | {outcome} "
                f"{(anchor_id or '—')[:18]}"
                f"{' (protocol failure)' if failed else ''} |"
            )
        print(f"{doc_name}: done", file=sys.stderr)
    return stats, audit


def _row(name: str, s: dict) -> str:
    return (
        f"| {name} | {s['claims']} | {s['correct']}/{s['linkable']} | "
        f"{s['abstained']}/{s['unlinkable']} | {s['wrong']} | {s['failures']} | "
        f"{s['calls']} | {1000 * s['seconds'] / max(s['claims'], 1):.0f} |"
    )


def main(roots: list[Path], model: str, think: bool = False, ground=ground_batch) -> int:
    pooled = dict(
        claims=0, correct=0, linkable=0, abstained=0, unlinkable=0,
        wrong=0, failures=0, calls=0, seconds=0.0,
    )
    rows, audit = [], []
    for root in roots:
        stats, doc_audit = run(root, model, think, ground)
        rows.append(_row(root.name, stats))
        audit += doc_audit
        for key in pooled:
            pooled[key] += stats[key]
    print(f"\n## Policy E with {model} as the hit-set scorer\n")
    print(
        "| set | claims | correct links | correct abstains | wrong links | "
        "protocol failures | model calls | avg ms/claim |"
    )
    print("|---|---:|---:|---:|---:|---:|---:|---:|")
    print("\n".join(rows))
    print(_row("**pooled**", pooled))
    print("\n### Per-claim audit\n")
    print("| doc | claim | hits | tier | pick |")
    print("|---|---|---:|---|---|")
    print("\n".join(audit))
    return 0


def _selfcheck() -> int:
    """No Ollama: a stub scorer proves the routing and the scoring branches."""
    from unittest.mock import patch

    from .pipeline import Anchor, AnchorIndex, Claim

    anchors = [
        Anchor("a1", "born 1790 in Livorno", 1),
        Anchor("a2", "1790 was the free port year", 1),
        Anchor("a3", "unrelated", 1),
    ]
    claims = [
        Claim("1790", ("records", 0, "year"), ("a2",)),   # 2 hits -> model
        Claim("Livorno", ("records", 0, "port"), ("a1",)),  # 1 hit -> lexical
        Claim("absent", ("records", 0, "x"), ()),          # 0 hits -> abstain
    ]
    calls = []

    def stub(model, batch, hits, think):
        calls.append((batch[0][1].value, [a.anchor_id for a in hits]))
        return {"C1": "E2"}, 0.0

    # patch.object on this module object, not by dotted name: under `python -m`
    # the running module is __main__ and a dotted patch would hit a second copy.
    with patch.object(
        sys.modules[__name__],
        "load_dataset",
        return_value=[("doc", AnchorIndex(anchors), claims)],
    ):
        stats, audit = run(Path("."), "stub", ground=stub)
    assert len(calls) == 1, calls
    # The model sees the rich claim and only the hit set — not every anchor.
    assert calls[0] == ("year: 1790", ["a1", "a2"]), calls
    assert (stats["correct"], stats["linkable"]) == (2, 2), stats
    assert (stats["abstained"], stats["wrong"], stats["failures"]) == (1, 0, 0), stats
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        raise SystemExit(_selfcheck())
    # Positional args are dataset roots; the one carrying a tag ("model:tag")
    # is the Ollama model.
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    models = [a for a in args if ":" in a]
    raise SystemExit(main(
        [Path(a) for a in args if ":" not in a] or [Path("dataset")],
        models[0] if models else "qwen3.8:latest",
        think="--think" in sys.argv,
    ))
