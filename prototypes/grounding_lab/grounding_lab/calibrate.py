"""Dev/held-out calibration of the lexical+ce-bare policy constants.

Splits the dataset by document, sweeps (shortlist K, abstain gate,
containment cap, auto-accept threshold) on the dev docs only, and reports
held-out numbers at both the chosen and the incumbent constants.

Usage: uv run python -m grounding_lab.calibrate dataset/
       (--heldout doc1,doc2 to override the default held-out doc list)

The cross-encoder scores each claim's top-50 shortlist once; every param
combo is then evaluated from those cached scores (a K-shortlist is a prefix
of the top-50 bi-encoder ordering).
"""

from __future__ import annotations

import argparse
import itertools
import sys
from datetime import date
from pathlib import Path

from .harness import load_dataset
from .pipeline import (
    _cross_encoder,
    bounded_contains,
    lexical_match,
)

K_MAX = 50
K_GRID = [5, 10, 20, 30, 50]
ABSTAIN_GRID = [0.3, 0.4, 0.5, 0.6, 0.7]
CAP_GRID = [0.1, 0.25, 0.4]
ACCEPT_GRID = [0.3, 0.4, 0.5, 0.6, 0.7]
INCUMBENT = (10, 0.5, 0.25, 0.5)  # (K, abstain, cap, accept)

# Held-out docs were added AFTER the incumbent constants were frozen; the five
# original docs (everything else) are dev, because the constants were chosen
# while watching them.
DEFAULT_HELDOUT = [
    "herredsvejen",
    "hvissinge",
    "katrinesminde",
    "age-related-disease",
    "catfish-collagen",
]


def score_claims(documents):
    """Per claim: lexical link or (gold rank, CE scores, containment) @ top-50."""
    ce = _cross_encoder()
    scored = []
    for doc_name, index, claims in documents:
        for claim in claims:
            lex = lexical_match(claim, index.anchors)
            if lex is not None:
                scored.append((doc_name, claim, "lexical", lex.anchor_id))
                continue
            shortlist = index.shortlist(str(claim.value), k=K_MAX)
            scores = ce.predict(
                [(str(claim.value), a.scoring_text) for a in shortlist]
            )
            # Raw text, not scoring_text — mirrors verbatim_downgrade: row
            # context must not let a wrong sibling cell pass containment.
            # Booleans are exempt from the post-check in both paths.
            contained = [
                isinstance(claim.value, bool)
                or bounded_contains(claim.value, a.text)
                for a in shortlist
            ]
            scored.append(
                (doc_name, claim, "neural", (shortlist, scores, contained))
            )
    return scored


def decide(entry, k, abstain, cap):
    """Return (picked_anchor_id | None, confidence, correct: bool)."""
    _, claim, tier, neural = entry
    golds = claim.gold_anchor_ids
    assert tier == "neural", "lexical entries are handled by the caller"
    shortlist, scores, contained = neural
    prefix = scores[:k]
    order = prefix.argsort()[::-1]
    best = float(prefix[order[0]])
    runner_up = float(prefix[order[1]]) if len(order) > 1 else 0.0
    confidence = min(1.0, max(0.0, best - runner_up))
    if best < abstain:
        return None, confidence, not golds
    i = int(order[0])
    if not contained[i]:
        confidence = min(confidence, cap)
    picked = shortlist[i].anchor_id
    return picked, confidence, picked in golds


def evaluate(entries, k, abstain, cap, accept):
    linkable = correct_links = abstains_due = correct_abstains = wrong = 0
    auto_total = auto_correct = 0
    for entry in entries:
        _, claim, tier, payload = entry
        golds = claim.gold_anchor_ids
        if golds:
            linkable += 1
        else:
            abstains_due += 1
        if tier == "lexical":
            confidence, correct = 1.0, payload in golds
            if correct:
                correct_links += 1
            else:
                wrong += 1
        else:
            picked, confidence, correct = decide(entry, k, abstain, cap)
            if picked is None:
                correct_abstains += correct
                continue
            if correct:
                correct_links += 1
            else:
                wrong += 1
        if confidence >= accept:
            auto_total += 1
            auto_correct += correct
    return {
        "correct_links": correct_links,
        "linkable": linkable,
        "correct_abstains": correct_abstains,
        "abstains_due": abstains_due,
        "wrong": wrong,
        "auto": auto_total,
        "auto_correct": auto_correct,
        "total_correct": correct_links + correct_abstains,
    }


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for a binomial proportion."""
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def ci(successes: int, n: int) -> str:
    lo, hi = wilson(successes, n)
    return f"{lo:.0%}–{hi:.0%}"


def recall_table(entries):
    rows = []
    for k in K_GRID:
        hits = total = 0
        for _, claim, tier, neural in entries:
            if tier != "neural" or not claim.gold_anchor_ids:
                continue
            total += 1
            shortlist = neural[0]
            hits += any(
                a.anchor_id in claim.gold_anchor_ids for a in shortlist[:k]
            )
        rows.append((k, hits, total))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default="dataset", type=Path)
    parser.add_argument("--heldout", default=",".join(DEFAULT_HELDOUT))
    args = parser.parse_args()

    heldout_names = {n.strip() for n in args.heldout.split(",") if n.strip()}
    documents = load_dataset(args.root)
    names = {d[0] for d in documents}
    missing = heldout_names - names
    if missing:
        print(f"held-out docs not in dataset: {sorted(missing)}", file=sys.stderr)
        return 1

    entries = score_claims(documents)
    dev = [e for e in entries if e[0] not in heldout_names]
    held = [e for e in entries if e[0] in heldout_names]

    print("# Calibration report (config: lexical+ce-bare)\n")
    print(f"Generated {date.today().isoformat()} by `pnpm --filter grounding-lab calibrate` — do not hand-edit.\n")
    print(
        f"dev: {len(names - heldout_names)} docs, {len(dev)} claims — "
        f"held-out: {len(heldout_names)} docs, {len(held)} claims\n"
    )

    print("## Bi-encoder shortlist recall@K (neural-fallback linkable claims)\n")
    print("| K | dev | held-out |")
    print("|---|---|---|")
    held_recall = dict()
    for (k, dh, dt), (_, hh, ht) in zip(recall_table(dev), recall_table(held)):
        held_recall[k] = (hh, ht)
        print(f"| {k} | {dh}/{dt} | {hh}/{ht} |")

    # Sweep K/abstain/cap on dev; accept chosen after (largest auto coverage
    # with perfect dev auto precision).
    combos = []
    for k, abstain, cap in itertools.product(K_GRID, ABSTAIN_GRID, CAP_GRID):
        best_accept = None
        for accept in ACCEPT_GRID:
            m = evaluate(dev, k, abstain, cap, accept)
            if m["auto_correct"] == m["auto"]:
                best_accept = (accept, m)
                break  # lowest perfect-precision threshold = max coverage
        if best_accept is None:
            accept, m = ACCEPT_GRID[-1], evaluate(dev, k, abstain, cap, ACCEPT_GRID[-1])
        else:
            accept, m = best_accept
        combos.append(((m["total_correct"], -m["wrong"], m["auto"], -k), (k, abstain, cap, accept), m))
    combos.sort(key=lambda c: c[0], reverse=True)

    print("\n## Dev sweep (top 5 by correct decisions, then fewest wrong links)\n")
    print("| K | abstain | cap | accept | links | abstains | wrong | auto |")
    print("|---|---|---|---|---|---|---|---|")
    for _, (k, abstain, cap, accept), m in combos[:5]:
        print(
            f"| {k} | {abstain} | {cap} | {accept} | "
            f"{m['correct_links']}/{m['linkable']} | "
            f"{m['correct_abstains']}/{m['abstains_due']} | {m['wrong']} | "
            f"{m['auto_correct']}/{m['auto']} |"
        )

    chosen = combos[0][1]
    print(f"\nChosen on dev: K={chosen[0]}, abstain={chosen[1]}, "
          f"cap={chosen[2]}, auto-accept={chosen[3]}")
    print(f"Incumbent:     K={INCUMBENT[0]}, abstain={INCUMBENT[1]}, "
          f"cap={INCUMBENT[2]}, auto-accept={INCUMBENT[3]}\n")

    print("## Held-out results\n")
    print("| constants | links | abstains | wrong | auto precision | links 95% CI | auto 95% CI |")
    print("|---|---|---|---|---|---|---|")
    for label, (k, abstain, cap, accept) in (
        ("chosen", chosen),
        ("incumbent", INCUMBENT),
    ):
        m = evaluate(held, k, abstain, cap, accept)
        print(
            f"| {label} | {m['correct_links']}/{m['linkable']} | "
            f"{m['correct_abstains']}/{m['abstains_due']} | {m['wrong']} | "
            f"{m['auto_correct']}/{m['auto']} | "
            f"{ci(m['correct_links'], m['linkable'])} | "
            f"{ci(m['auto_correct'], m['auto'])} |"
        )
    print("\nDev numbers for the same constants:\n")
    print("| constants | links | abstains | wrong | auto precision |")
    print("|---|---|---|---|---|")
    for label, (k, abstain, cap, accept) in (
        ("chosen", chosen),
        ("incumbent", INCUMBENT),
    ):
        m = evaluate(dev, k, abstain, cap, accept)
        print(
            f"| {label} | {m['correct_links']}/{m['linkable']} | "
            f"{m['correct_abstains']}/{m['abstains_due']} | {m['wrong']} | "
            f"{m['auto_correct']}/{m['auto']} |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
