"""Validate hand-authored gold labels and print a human-skim review sheet.

For every claim in the given documents, shows the value, resultPath, note,
and the full text of each gold anchor (or the containment hits for
must-abstain claims, which must match ``expectedLexicalHitIds`` when present).
Meant for verifying the
REVIEW-marked multi-gold judgment calls and ADVERSARIAL absent-value labels.

Exits non-zero on hard label errors:
- a gold anchor id that does not exist in anchors.json;
- a must-abstain claim whose bounded containment hits differ from the expected set;
- an extractor-output set whose generation did not finish normally;
- a challenge-set typed-schema document (schema.json present) with fewer than half of its
  unsupported claims occurring in the text: abstention is only measured when
  the value is there under the wrong meaning (wrong row, wrong field,
  computed), so a set of never-stated values measures string inequality only.
  With --natural-output this prevalence is a distribution statistic only.

Containment/gold mismatches are listed with their complete hit sets for human
review, not failed: deliberate paraphrases and contextual ambiguities are
valid evidence judgments that lexical containment cannot settle.

Usage: uv run python -m grounding_lab.label_review dataset [doc ...] [--claims traps.json]
       (no doc args = every evaluated document)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from .harness import load_dataset
from .pipeline import bounded_contains
from .evaluation_labels import evidence_sets
from .raw_claims import labeling_sheet
from .holdout_evaluation import output_files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default="dataset", type=Path)
    parser.add_argument("docs", nargs="*")
    parser.add_argument("--natural-output", action="store_true",
                        help="validate all emitted values; report rather than select on unsupported lexical prevalence")
    parser.add_argument(
        "--claims", default="claims.json",
        help="comma-separated claim files reviewed per document",
    )
    args = parser.parse_args()
    root = args.root
    claims_files = tuple(n.strip() for n in args.claims.split(",") if n.strip())
    docs = args.docs or (sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("_"))
                         if args.natural_output else [name for name, _, _ in load_dataset(root, claims_files)])
    print(f"# Label review\n\nGenerated {date.today().isoformat()} by "
          "`pnpm --filter grounding-lab label-review` — do not hand-edit.")
    errors: list[str] = []
    warnings: list[str] = []
    if args.natural_output and not docs:
        errors.append("no extraction attempts found")
    for doc in docs:
        meta_path = root / doc / "extracted_meta.json"
        extracted_claims = root / doc / "claims_extracted.json"
        if args.natural_output:
            for name in claims_files:
                if not (root / doc / name).is_file():
                    errors.append(f"{doc}: missing labels: {name}")
        if "claims_extracted.json" in claims_files and (args.natural_output or extracted_claims.exists()):
            if not meta_path.exists():
                errors.append(f"{doc}: extraction incomplete — extracted_meta.json missing")
            else:
                meta = json.loads(meta_path.read_text("utf-8"))
                metadata = meta.get("metadata")
                finish_reason = (
                    metadata.get("finishReason") if isinstance(metadata, dict) else None
                )
                if meta.get("error") or meta.get("complete") is False or finish_reason != "stop":
                    errors.append(
                        f"{doc}: extraction incomplete — finish reason {finish_reason!r}, "
                        f"error {meta.get('error')!r}"
                    )
        if not (root / doc / "anchors.json").is_file():
            errors.append(f"{doc}: anchors.json missing")
            continue
        anchors = {
            a["anchorId"]: a
            for a in json.loads((root / doc / "anchors.json").read_text("utf-8"))
        }
        claims = [
            c
            for name in claims_files
            if (root / doc / name).exists()
            for c in json.loads((root / doc / name).read_text("utf-8"))
        ]
        if args.natural_output:
            raw_path = root / doc / "extracted_raw.json"
            if not raw_path.exists():
                diagnostic = output_files(root / doc)
                if diagnostic is not None:
                    raw_path = diagnostic[0]
            if not raw_path.exists():
                errors.append(f"{doc}: extracted_raw.json missing")
            else:
                expected = labeling_sheet(json.loads(raw_path.read_text(encoding="utf-8")))
                actual = [(c.get("resultPath"), c.get("value")) for c in claims]
                wanted = [(c["resultPath"], c["value"]) for c in expected]
                if actual != wanted:
                    errors.append(f"{doc}: labels must cover every emitted populated value exactly once in result order")
        print(f"\n## {doc} — {len(claims)} claims\n")
        unsupported = present = 0
        for c in claims:
            try:
                groups = evidence_sets(c)
                golds = list(dict.fromkeys(g for group in groups for g in group))
            except ValueError as error:
                errors.append(f"{doc}: {error}")
                continue
            kind = ("MISSING CANONICAL EVIDENCE" if c.get("supported") is True else "ABSTAIN") if not golds else (
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
                if c.get("labelStatus") == "unresolved":
                    warnings.append(f"{doc}: unresolved judgment for {c.get('resultPath')}")
                    continue
                if c.get("supported") is True:
                    warnings.append(f"{doc}: supported value has no acceptable canonical evidence: {c.get('resultPath')}")
                    continue
                unsupported += 1
                present += bool(hits)
                short_hits = [hit[:18] for hit in hits]
                expected_hits = set(c.get("expectedLexicalHitIds", ()))
                print(f"- containment hits: {short_hits or 'none'}")
                if set(hits) != expected_hits:
                    errors.append(
                        f"{doc}: must-abstain `{c['value']}` expected lexical hits "
                        f"{sorted(expected_hits)}, got {hits}"
                    )
            print()
        print(f"Unsupported claims occurring in the text: {present}/{unsupported}\n")
        if not args.natural_output and (root / doc / "schema.json").exists() and 2 * present < unsupported:
            errors.append(
                f"{doc}: abstention too soft — {present}/{unsupported} unsupported "
                "claims occur in the text; at least half must"
            )
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
