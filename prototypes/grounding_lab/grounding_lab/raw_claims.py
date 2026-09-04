"""What the lexical tier does with the real extractor's raw output.

The benchmark's claims.json values were hand-authored by copying verbatim
strings out of anchors.json, so every value was a `str` that the document
contained literally. The real extractor emits typed JSON. This module replays
policy E's first tier over `extracted_raw.json` (written by
`scripts/extract-real.mts`) and reports how often containment still fires.

Usage:
    .venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims \
        dataset final_dataset final_dataset_2
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

from .pipeline import Anchor, Claim, lexical_candidates, lexical_tier

Path_ = tuple[str | int, ...]


def populated_content_paths(value: object, path: Path_ = ()) -> list[Path_]:
    """Port of `populatedContentPaths` in packages/extraction/src/grounding.ts:
    every non-empty string/number/boolean leaf, addressed by result path."""
    if isinstance(value, list):
        return [p for i, entry in enumerate(value) for p in populated_content_paths(entry, (*path, i))]
    if isinstance(value, dict):
        return [p for key, entry in value.items() for p in populated_content_paths(entry, (*path, key))]
    if value is None or value == "":
        return []
    return [path] if isinstance(value, (str, int, float, bool)) else []


def value_at(result: object, path: Path_) -> object:
    for segment in path:
        result = result[segment]  # type: ignore[index]
    return result


def render_value(value: object) -> str:
    """How a claim value reaches the grounder as text (pipeline uses str())."""
    return "true" if value is True else "false" if value is False else str(value)


def load_documents(roots: list[Path]):
    for root in roots:
        for doc_dir in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
            raw_file = doc_dir / "extracted_raw.json"
            if not raw_file.exists():
                continue
            anchors = [
                Anchor(a["anchorId"], a["text"], a["page"], a.get("context"))
                for a in json.loads((doc_dir / "anchors.json").read_text(encoding="utf-8"))
            ]
            # First claim at a result path is the genuine one; later duplicates
            # are the authored near-variant traps.
            authored: dict[Path_, dict] = {}
            for c in json.loads((doc_dir / "claims.json").read_text(encoding="utf-8")):
                authored.setdefault(tuple(c.get("resultPath", [])), c)
            raw = json.loads(raw_file.read_text(encoding="utf-8"))
            meta = json.loads((doc_dir / "extracted_meta.json").read_text(encoding="utf-8"))
            yield f"{root.name}/{doc_dir.name}", anchors, authored, raw, meta


def degraded(meta: dict) -> str:
    """The local Ollama server grants far less context than the model's
    advertised 262k, so some prompts are cut and some answers stop early.
    A prompt averaging under six characters per counted input token was cut."""
    metadata = meta.get("metadata") or {}
    tokens = metadata.get("inputTokens") or 0
    flags = []
    if tokens and tokens * 6 < meta.get("markdownChars", 0):
        flags.append("prompt truncated")
    if metadata.get("finishReason") == "length":
        flags.append("answer cut")
    return ", ".join(flags)


def golds(claim: dict) -> tuple[str, ...]:
    ids = claim.get("goldAnchorIds")
    if ids is None:
        ids = [claim["goldAnchorId"]] if claim.get("goldAnchorId") else []
    return tuple(ids)


def main(roots: list[Path]) -> int:
    documents = list(load_documents(roots))
    if not documents:
        print("No documents with extracted_raw.json found.", file=sys.stderr)
        return 1

    rows = []
    per_doc = []
    for doc, anchors, authored, raw, meta in documents:
        counts = Counter()
        for path in populated_content_paths(raw):
            value = value_at(raw, path)
            claim = Claim(value=value, result_path=path, gold_anchor_ids=())
            link, hits = lexical_tier(claim, anchors)
            strict = lexical_candidates(claim, anchors)
            bucket = (
                "single" if len(strict) == 1
                else "rerank" if len(strict) > 1
                else "review" if hits
                else "abstain"
            )
            counts[bucket] += 1
            counterpart = authored.get(path)
            gold = golds(counterpart) if counterpart else ()
            rendered = render_value(value)
            rows.append({
                "doc": doc,
                "path": path,
                "value": value,
                "rendered": rendered,
                "bucket": bucket,
                "strict": len(strict),
                "loose": len(hits) if bucket == "review" else 0,
                "linked": link.anchor_id if link else None,
                "authored": counterpart["value"] if counterpart else None,
                "gold": gold,
                "windowed": bool(meta.get("windowed")),
            })
        per_doc.append((doc, counts, meta))

    total = len(rows)
    by = Counter(r["bucket"] for r in rows)
    matched = [r for r in rows if r["authored"] is not None]
    identical = [r for r in matched if r["rendered"] == r["authored"]]
    single_judged = [r for r in matched if r["bucket"] == "single" and r["gold"]]
    single_right = [r for r in single_judged if r["linked"] in r["gold"]]
    single_wrong = [r for r in single_judged if r["linked"] not in r["gold"]]

    def pct(n: int, d: int) -> str:
        return f"{n} ({n / d:.0%})" if d else "0"

    print("## Per document\n")
    print("| document | raw claims | abstain (0 hits) | review (loose only) | single hit | 2+ hits | model s | note |")
    print("|---|---:|---:|---:|---:|---:|---:|---|")
    for doc, counts, meta in per_doc:
        n = sum(counts.values())
        note = ", ".join(x for x in ("windowed" if meta.get("windowed") else "", degraded(meta)) if x) or ""
        print(
            f"| {doc} | {n} | {counts['abstain']} | {counts['review']} | "
            f"{counts['single']} | {counts['rerank']} | {meta.get('elapsedSeconds', 0):.0f} | {note} |"
        )
    print(
        f"| **pooled** | **{total}** | **{by['abstain']}** | **{by['review']}** | "
        f"**{by['single']}** | **{by['rerank']}** | |"
    )

    print("\n## Pooled\n")
    print(f"- raw claims: {total}")
    print(f"- zero strict hits: {pct(by['abstain'] + by['review'], total)} — of these "
          f"{by['abstain']} abstain outright and {by['review']} reach the review bucket "
          "through the whitespace-tolerant fallback")
    print(f"- exactly one strict hit (E links at confidence 1.0, no verification): {pct(by['single'], total)}")
    print(f"- two or more strict hits (E reranks inside the hit set): {pct(by['rerank'], total)}")

    print("\n## Against the hand-authored claims\n")
    print(f"- raw fields with a hand-authored counterpart at the same result path: {len(matched)}/{total}")
    print(f"- raw value string identical to the hand-authored value: {pct(len(identical), len(matched))}")
    print(f"- single-hit raw claims whose counterpart has a gold anchor: {len(single_judged)}")
    print(f"  - hit is in the gold set (correct auto-link): {len(single_right)}")
    print(f"  - hit is outside the gold set (confidently wrong link at 1.0): {len(single_wrong)}")
    scalar_wrong = [r for r in single_wrong if not any(isinstance(s, int) for s in r["path"])]
    print(f"  - of those, on a non-indexed (scalar) result path: {len(scalar_wrong)} — "
          "an array index in the raw result need not describe the same entity the "
          "hand-authored claim indexed, so indexed rows are agreement, not error")
    if single_wrong:
        print("\n| document | path | raw value | hand-authored | linked anchor |")
        print("|---|---|---|---|---|")
        for r in single_wrong:
            print(f"| {r['doc']} | {fmt_path(r['path'])} | `{r['rendered']}` | "
                  f"`{r['authored']}` | `{r['linked'][:20]}…` |")

    print("\n## Zero-hit raw values\n")
    print("| document | path | raw value | hand-authored value | fallback |")
    print("|---|---|---|---|---|")
    for r in rows:
        if r["bucket"] not in ("abstain", "review"):
            continue
        authored = f"`{r['authored']}`" if r["authored"] is not None else "—"
        print(f"| {r['doc']} | {fmt_path(r['path'])} | `{r['rendered']}` | {authored} | "
              f"{'loose ' + str(r['loose']) if r['bucket'] == 'review' else 'none'} |")
    return 0


def fmt_path(path: Path_) -> str:
    return ".".join(str(s) for s in path)


if __name__ == "__main__":
    raise SystemExit(main([Path(a) for a in sys.argv[1:]] or [Path("dataset")]))
