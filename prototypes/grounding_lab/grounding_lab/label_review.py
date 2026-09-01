"""Validate hand-authored gold labels and print a human-skim review sheet.

For every claim in the given documents, shows the value, resultPath, note,
and the full text of each gold anchor (or the containment hits for
must-abstain claims, which should be empty). Meant for verifying the
REVIEW-marked multi-gold judgment calls and ADVERSARIAL absent-value labels.

Exits non-zero on hard label errors:
- a gold anchor id that does not exist in anchors.json;
- a must-abstain claim whose value has any bounded containment hit.

Containment/gold mismatches are listed with their complete hit sets for human
review, not failed: deliberate paraphrases and contextual ambiguities are
valid evidence judgments that lexical containment cannot settle.

Usage: uv run python -m grounding_lab.label_review dataset [doc ...]
       (no doc args = every evaluated document)
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

from .harness import load_dataset
from .pipeline import bounded_contains


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "dataset")
    docs = sys.argv[2:] or [name for name, _, _ in load_dataset(root)]
    print(f"# Label review\n\nGenerated {date.today().isoformat()} by "
          "`pnpm --filter grounding-lab label-review` — do not hand-edit.")
    errors: list[str] = []
    warnings: list[str] = []
    for doc in docs:
        anchors = {
            a["anchorId"]: a
            for a in json.loads((root / doc / "anchors.json").read_text("utf-8"))
        }
        claims = json.loads((root / doc / "claims.json").read_text("utf-8"))
        print(f"\n## {doc} — {len(claims)} claims\n")
        for c in claims:
            golds = c.get("goldAnchorIds")
            if golds is None:
                golds = [c["goldAnchorId"]] if c.get("goldAnchorId") else []
            kind = "ABSTAIN" if not golds else (
                "MULTI-GOLD" if len(golds) > 1 else "single"
            )
            print(f"### `{c['value']}`  ({kind})")
            print(f"- path: `{c.get('resultPath')}`")
            print(f"- note: {c.get('note', '—')}")
            hits = [
                aid for aid, a in anchors.items()
                if bounded_contains(c["value"], a["text"])
            ]
            if golds:
                for g in golds:
                    a = anchors.get(g)
                    if a is None:
                        errors.append(f"{doc}: `{c['value']}` gold {g} not in anchors.json")
                        print(f"- gold `{g[:18]}`: MISSING FROM anchors.json")
                        continue
                    text = " ".join(a["text"].split())
                    print(f"- gold `{g[:18]}` (p{a['page']}): {text}")
                print(
                    "- containment hits: "
                    + (", ".join(f"`{hit[:18]}`" for hit in hits) or "none")
                )
                gold_set, hit_set = set(golds), set(hits)
                if gold_set != hit_set:
                    missing = (
                        ", ".join(g[:18] for g in sorted(gold_set - hit_set))
                        or "none"
                    )
                    extra = (
                        ", ".join(h[:18] for h in sorted(hit_set - gold_set))
                        or "none"
                    )
                    warnings.append(
                        f"{doc}: `{c['value']}` golds without hits: {missing}; "
                        f"non-gold hits: {extra}; note: {c.get('note', '—')}"
                    )
            else:
                short_hits = [hit[:18] for hit in hits]
                print(f"- containment hits (must be empty): {short_hits or 'none'}")
                if hits:
                    errors.append(
                        f"{doc}: must-abstain `{c['value']}` found in {short_hits}"
                    )
            print()
    if warnings:
        print("## Warnings (containment/gold mismatches — human review required)\n")
        print("\n".join(f"- {w}" for w in warnings) + "\n")
    if errors:
        print("## LABEL ERRORS\n", file=sys.stderr)
        print("\n".join(f"- {e}" for e in errors), file=sys.stderr)
        return 1
    print(f"OK: {len(docs)} doc(s) validated, {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
