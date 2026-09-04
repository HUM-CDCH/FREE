"""Run every pipeline config over the dataset and print a markdown report.

Usage: uv run python -m grounding_lab.harness dataset/
Each dataset/<doc>/ directory needs anchors.json and claims.json.
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

from statistics import median

from .pipeline import (
    CONFIGS,
    Anchor,
    AnchorIndex,
    Claim,
    Link,
    cross_encoder_match,
    ground,
    lexical_match,
    nli_match,
    render_claim,
)

BUCKETS = [(0.0, 0.1), (0.1, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.01)]
AUTO_ACCEPT = 0.5  # links with confidence >= this bypass human review


def load_dataset(
    root: Path, claims_files: tuple[str, ...] = ("claims.json",)
) -> list[tuple[str, AnchorIndex, list[Claim]]]:
    """claims_files: claim files merged per document, in order. The first one
    must exist for the document to be evaluated; later ones (e.g. traps.json)
    are optional so a partial trap set still loads."""
    documents = []
    for doc_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if doc_dir.name.startswith("_"):
            continue  # fixtures (_smoke) are not documents
        anchors_file = doc_dir / "anchors.json"
        claims_file = doc_dir / claims_files[0]
        if not anchors_file.exists() or not claims_file.exists():
            continue
        anchors = [
            Anchor(a["anchorId"], a["text"], a["page"], a.get("context"))
            for a in json.loads(anchors_file.read_text(encoding="utf-8"))
        ]
        raw = [
            c
            for name in claims_files
            if (doc_dir / name).exists()
            for c in json.loads((doc_dir / name).read_text(encoding="utf-8"))
        ]
        claims = []
        for c in raw:
            # Either a single goldAnchorId (possibly null) or a goldAnchorIds
            # list of all anchors a reviewer would accept as evidence.
            golds = c.get("goldAnchorIds")
            if golds is None:
                golds = [c["goldAnchorId"]] if c.get("goldAnchorId") else []
            claims.append(
                Claim(
                    value=c["value"],
                    result_path=tuple(c.get("resultPath", [])),
                    gold_anchor_ids=tuple(golds),
                    context=c.get("context"),
                )
            )
        documents.append((doc_dir.name, AnchorIndex(anchors), claims))
    return documents


def main(root: Path) -> int:
    documents = load_dataset(root)
    if not documents:
        print(f"No documents with anchors.json + claims.json under {root}", file=sys.stderr)
        return 1

    # Warm-up: load every model and embed every document BEFORE timing, so the
    # latency column measures the pipeline, not model downloads and warm-up.
    # This pass doubles as the shortlist recall@K measurement, taken over the
    # population that actually reaches the neural fallback (lexical misses) —
    # once with the rendered claim and once with the bare value, because the
    # "-bare" configs (the production-shaped ones) shortlist on the bare value.
    rendered_hits = bare_hits = shortlist_total = 0
    for _, index, claims in documents:
        for claim in claims:
            rendered = index.shortlist(render_claim(claim))
            bare = index.shortlist(str(claim.value))
            if claim.gold_anchor_ids and lexical_match(claim, index.anchors) is None:
                shortlist_total += 1
                rendered_hits += any(
                    a.anchor_id in claim.gold_anchor_ids for a in rendered
                )
                bare_hits += any(
                    a.anchor_id in claim.gold_anchor_ids for a in bare
                )
    first_shortlist = documents[0][1].shortlist("warm up")
    cross_encoder_match("warm up", first_shortlist)
    nli_match("warm up", first_shortlist)

    # results[config] = list of (doc, claim, link, seconds)
    results: dict[str, list[tuple[str, Claim, Link, float]]] = defaultdict(list)
    for config in CONFIGS:
        for doc_name, index, claims in documents:
            for claim in claims:
                started = time.perf_counter()
                link = ground(claim, index, config)
                results[config].append(
                    (doc_name, claim, link, time.perf_counter() - started)
                )

    total_claims = sum(len(claims) for _, _, claims in documents)
    print(f"# Grounding lab report\n")
    print(f"Generated {date.today().isoformat()} by `pnpm --filter grounding-lab harness` — do not hand-edit.\n")
    print(f"{len(documents)} document(s), {total_claims} claims\n")
    print(
        f"Bi-encoder shortlist recall@10 on the neural-fallback population "
        f"(gold-linkable claims the lexical tier does not resolve): "
        f"{rendered_hits}/{shortlist_total} with rendered claims, "
        f"{bare_hits}/{shortlist_total} with bare values (what the -bare "
        f"configs query). A gold outside the top-10 is unrecoverable by any "
        "reranker.\n"
    )

    print("## Configs\n")
    print("| config | accuracy@1 | correct abstain | wrong link | median ms/claim |")
    print("|---|---|---|---|---|")
    for config in CONFIGS:
        rows = results[config]
        linkable = [(c, l) for _, c, l, _ in rows if c.gold_anchor_ids]
        unlinkable = [(c, l) for _, c, l, _ in rows if not c.gold_anchor_ids]
        correct = sum(1 for c, l in linkable if l.anchor_id in c.gold_anchor_ids)
        abstained = sum(1 for _, l in unlinkable if l.anchor_id is None)
        wrong = sum(
            1 for c, l in linkable + unlinkable
            if l.anchor_id is not None and l.anchor_id not in c.gold_anchor_ids
        )
        # Median, not mean: robust against residual first-call warm-up spikes.
        median_ms = 1000 * median(t for *_, t in rows)
        print(
            f"| {config} | {correct}/{len(linkable)} | "
            f"{abstained}/{len(unlinkable)} | {wrong} | {median_ms:.0f} |"
        )

    print(f"\n## Review policy: auto-accept links with confidence ≥ {AUTO_ACCEPT}\n")
    print("| config | links | auto-accepted | auto precision | routed to review |")
    print("|---|---|---|---|---|")
    for config in CONFIGS:
        linked = [
            (c, l) for _, c, l, _ in results[config] if l.anchor_id is not None
        ]
        auto = [(c, l) for c, l in linked if l.confidence >= AUTO_ACCEPT]
        auto_ok = sum(1 for c, l in auto if l.anchor_id in c.gold_anchor_ids)
        print(
            f"| {config} | {len(linked)} | {len(auto)} | "
            f"{auto_ok}/{len(auto) or 1} | {len(linked) - len(auto)} |"
        )

    print("\n## Calibration on confidence (linked claims, full range)\n")
    print("| config | bucket | links | precision |")
    print("|---|---|---|---|")
    for config in CONFIGS:
        for low, high in BUCKETS:
            linked = [
                (c, l) for _, c, l, _ in results[config]
                if l.anchor_id is not None and low <= l.confidence < high
            ]
            if not linked:
                continue
            precise = sum(1 for c, l in linked if l.anchor_id in c.gold_anchor_ids)
            print(
                f"| {config} | {low:.1f}–{min(high, 1.0):.1f} | "
                f"{len(linked)} | {precise}/{len(linked)} |"
            )

    print("\n## Per-claim breakdown\n")
    print("| doc | claim | gold | " + " | ".join(CONFIGS) + " |")
    print("|---" * (3 + len(CONFIGS)) + "|")
    # Every config walks the same claims in the same order, so zip aligns them.
    for per_config in zip(*(results[config] for config in CONFIGS)):
        doc_name, claim, _, _ = per_config[0]
        golds = claim.gold_anchor_ids
        cells = []
        for _, _, link, _ in per_config:
            correct = link.anchor_id in golds if golds else link.anchor_id is None
            anchor = (link.anchor_id or "—")[:18]
            cells.append(
                f"{'✓' if correct else '✗'} {anchor} "
                f"(s={link.score:.2f} c={link.confidence:.2f} {link.tier})"
            )
        value = str(claim.value)
        value = value if len(value) <= 40 else value[:37] + "…"
        gold_label = f"{golds[0][:18]}+{len(golds) - 1}" if len(golds) > 1 else (
            golds[0][:18] if golds else "—"
        )
        print(
            f"| {doc_name} | {value} | {gold_label} | " + " | ".join(cells) + " |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "dataset")))
