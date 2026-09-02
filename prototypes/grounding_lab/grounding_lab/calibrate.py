"""Dev/held-out calibration of the lexical+ce policy constants.

Splits the dataset by document, sweeps (abstain gate, containment cap,
auto-accept threshold) on the dev docs only, and reports held-out numbers at
both the chosen and the incumbent constants.

Usage: uv run python -m grounding_lab.calibrate dataset/
       (--heldout doc1,doc2 to override the default held-out doc list)

Mirrors ground(): one lexical hit links, zero hits abstain, several hits are
scored once by the cross-encoder inside that hit set (field name + siblings
query); every
constant combination is then evaluated from those cached scores. The hit set
is the complete candidate list and always contains the gold.
"""

from __future__ import annotations

import argparse
import itertools
import sys
from datetime import date
from pathlib import Path

from .harness import load_dataset
from .pipeline import (
    CROSS_ENCODER_BATCH_SIZE,
    _cross_encoder,
    bounded_contains,
    lexical_tier,
    render_claim,
)

ABSTAIN_GRID = [float("-inf"), 0.3, 0.4, 0.5, 0.6, 0.7]
CAP_GRID = [0.1, 0.25, 0.4]
ACCEPT_GRID = [0.3, 0.4, 0.5, 0.6, 0.7]
INCUMBENT = (0.5, 0.25, 0.5)  # (abstain, cap, accept)

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
    """Per claim: lexical link / abstain, or (hit set, CE scores, containment)."""
    ce = _cross_encoder()
    scored = []
    for doc_name, index, claims in documents:
        for claim in claims:
            decided, shortlist = lexical_tier(claim, index.anchors)
            if decided is not None:
                tier = "lexical" if decided.anchor_id else "abstain"
                scored.append((doc_name, claim, tier, decided.anchor_id))
                continue
            scores = ce.predict(
                [
                    (render_claim(claim), a.scoring_text)
                    for a in shortlist
                ],
                batch_size=CROSS_ENCODER_BATCH_SIZE,
                show_progress_bar=False,
            )
            # Raw text, not scoring_text — mirrors verbatim_downgrade: row
            # context must not let a wrong sibling cell pass containment.
            contained = [
                bounded_contains(claim.value, a.text)
                for a in shortlist
            ]
            scored.append(
                (doc_name, claim, "neural", (shortlist, scores, contained))
            )
    return scored


def decide(entry, abstain, cap):
    """Return (picked_anchor_id | None, confidence, correct: bool)."""
    _, claim, tier, neural = entry
    golds = claim.gold_anchor_ids
    assert tier in {"neural", "verifier"}, "lexical entries are handled by the caller"
    shortlist, scores, contained = neural
    order = scores.argsort()[::-1]
    best = float(scores[order[0]])
    runner_up = float(scores[order[1]]) if len(order) > 1 else 0.0
    confidence = min(1.0, max(0.0, best if tier == "verifier" else best - runner_up))
    if tier == "verifier" and sum(float(score) >= abstain for score in scores) != 1:
        return None, confidence, not golds
    if best < abstain:
        return None, confidence, not golds
    i = int(order[0])
    if not contained[i]:
        confidence = min(confidence, cap)
    picked = shortlist[i].anchor_id
    return picked, confidence, picked in golds


def evaluate(entries, abstain, cap, accept):
    linkable = correct_links = abstains_due = correct_abstains = review = wrong = 0
    auto_total = auto_correct = 0
    for entry in entries:
        _, claim, tier, payload = entry
        golds = claim.gold_anchor_ids
        if golds:
            linkable += 1
        else:
            abstains_due += 1
        if tier == "abstain":
            correct_abstains += not golds  # zero lexical hits: no neural stage ran
            continue
        if tier == "lexical":
            confidence, correct = 1.0, payload in golds
        else:
            picked, confidence, correct = decide(entry, abstain, cap)
            if picked is None:
                correct_abstains += correct
                continue
        if confidence < accept:
            review += 1
            continue
        auto_total += 1
        auto_correct += correct
        if correct:
            correct_links += 1
        else:
            wrong += 1
    return {
        "correct_links": correct_links,
        "linkable": linkable,
        "correct_abstains": correct_abstains,
        "abstains_due": abstains_due,
        "review": review,
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


def hitset_summary(entries) -> str:
    sizes = [len(neural[0]) for _, _, tier, neural in entries if tier == "neural"]
    linkable = [
        any(a.anchor_id in claim.gold_anchor_ids for a in neural[0])
        for _, claim, tier, neural in entries
        if tier == "neural" and claim.gold_anchor_ids
    ]
    zero_hit_linkable = sum(
        1 for _, claim, tier, _ in entries if tier == "abstain" and claim.gold_anchor_ids
    )
    return (
        f"{len(sizes)} multi-hit claims (hit set 2–{max(sizes) if sizes else 0} anchors), "
        f"gold inside the hit set {sum(linkable)}/{len(linkable)}; "
        f"{zero_hit_linkable} zero-hit linkable claims abstained (PDF text artifacts)"
    )


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

    print("# Calibration report (config: lexical+ce)\n")
    print(f"Generated {date.today().isoformat()} by `pnpm --filter grounding-lab calibrate` — do not hand-edit.\n")
    print(
        f"dev: {len(names - heldout_names)} docs, {len(dev)} claims — "
        f"held-out: {len(heldout_names)} docs, {len(held)} claims\n"
    )

    print("## Lexical hit-set candidates (no shortlist K)\n")
    print(f"- dev: {hitset_summary(dev)}")
    print(f"- held-out: {hitset_summary(held)}")

    # Sweep abstain/cap on dev; accept chosen after (largest auto coverage
    # with perfect dev auto precision).
    combos = []
    for abstain, cap in itertools.product(ABSTAIN_GRID, CAP_GRID):
        best_accept = None
        for accept in ACCEPT_GRID:
            m = evaluate(dev, abstain, cap, accept)
            if m["auto_correct"] == m["auto"]:
                best_accept = (accept, m)
                break  # lowest perfect-precision threshold = max coverage
        if best_accept is None:
            accept, m = ACCEPT_GRID[-1], evaluate(dev, abstain, cap, ACCEPT_GRID[-1])
        else:
            accept, m = best_accept
        combos.append(((m["total_correct"], -m["wrong"], m["auto"]), (abstain, cap, accept), m))
    combos.sort(key=lambda c: c[0], reverse=True)

    print("\n## Dev sweep (top 5 by correct decisions, then fewest wrong links)\n")
    print("| abstain | cap | accept | links | abstains | review | wrong | auto |")
    print("|---|---|---|---|---|---|---|---|")
    for _, (abstain, cap, accept), m in combos[:5]:
        print(
            f"| {abstain} | {cap} | {accept} | "
            f"{m['correct_links']}/{m['linkable']} | "
            f"{m['correct_abstains']}/{m['abstains_due']} | {m['review']} | "
            f"{m['wrong']} | "
            f"{m['auto_correct']}/{m['auto']} |"
        )

    chosen = combos[0][1]
    print(f"\nChosen on dev: abstain={chosen[0]}, cap={chosen[1]}, auto-accept={chosen[2]}")
    print(f"Incumbent:     abstain={INCUMBENT[0]}, cap={INCUMBENT[1]}, auto-accept={INCUMBENT[2]}\n")

    print("## Held-out results\n")
    print("| constants | links | abstains | review | wrong | auto precision | links 95% CI | auto 95% CI |")
    print("|---|---|---|---|---|---|---|---|")
    for label, (abstain, cap, accept) in (
        ("chosen", chosen),
        ("incumbent", INCUMBENT),
    ):
        m = evaluate(held, abstain, cap, accept)
        print(
            f"| {label} | {m['correct_links']}/{m['linkable']} | "
            f"{m['correct_abstains']}/{m['abstains_due']} | {m['review']} | "
            f"{m['wrong']} | "
            f"{m['auto_correct']}/{m['auto']} | "
            f"{ci(m['correct_links'], m['linkable'])} | "
            f"{ci(m['auto_correct'], m['auto'])} |"
        )
    print("\nDev numbers for the same constants:\n")
    print("| constants | links | abstains | review | wrong | auto precision |")
    print("|---|---|---|---|---|---|")
    for label, (abstain, cap, accept) in (
        ("chosen", chosen),
        ("incumbent", INCUMBENT),
    ):
        m = evaluate(dev, abstain, cap, accept)
        print(
            f"| {label} | {m['correct_links']}/{m['linkable']} | "
            f"{m['correct_abstains']}/{m['abstains_due']} | {m['review']} | "
            f"{m['wrong']} | "
            f"{m['auto_correct']}/{m['auto']} |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
