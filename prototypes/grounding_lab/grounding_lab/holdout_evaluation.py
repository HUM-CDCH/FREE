"""Blind packaging and adjudication for the paired, frozen four-family experiment.

python -m grounding_lab.holdout_evaluation ROOT prepare|disagreements|finalize
ROOT contains holdout/, runs/{baseline,quote}/FAMILY and blind/FAMILY.
The arm mapping stays outside blind directories. No policy is fit here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from .evaluation_labels import evidence_sets
from .pipeline import bounded_contains
from .raw_claims import labeling_sheet

LAB = Path(__file__).resolve().parents[1]
POLICY_FILES = ("grounding_lab/pipeline.py", "grounding_lab/calibrate.py",
                "grounding_lab/model_benchmark.py", "grounding_lab/review_risk.py",
                "scripts/quote-extraction.mts", "scripts/dump-anchors.mts", "scripts/parse-source.py",
                "../parsing_service/app/docling_parser.py")


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def freeze(root: Path) -> None:
    """Freeze using development labels only, before any holdout label is opened."""
    import numpy as np
    from .pipeline import Anchor, Claim
    from .model_benchmark import CONTAINMENT_CAP, RERANKERS, choose_thresholds
    from .review_risk import fit_frozen

    if (root / "freeze.json").exists() or (root / "blind-map.json").exists():
        raise ValueError("experiment already frozen or labels prepared")
    for family in ("beier", "bosch", "wiermann", "kirsch"):
        for name in ("schema.json", "instruction.txt"):
            if not (root / "holdout" / family / name).is_file():
                raise ValueError(f"cannot freeze before {family}/{name} exists")
    training = LAB / "outcomes/extracted_cv6_E_ranked.jsonl"
    rows = [json.loads(line) for line in training.read_text(encoding="utf-8").splitlines()]
    entries = []
    for row in rows:
        claim = Claim(value=row["value"], result_path=tuple(row["path"]),
                      gold_anchor_ids=tuple(row["goldAnchorIds"]), context=row.get("context"))
        if row["tier"] in {"neural", "verifier"}:
            candidates = row["candidates"]
            payload = ([Anchor(c["anchorId"], "", c["page"]) for c in candidates],
                       np.asarray([c["rawScore"] for c in candidates]), [c["verbatim"] for c in candidates])
        else:
            payload = row["bestCandidateAnchorId"]
        entries.append((row["doc"], claim, row["tier"], payload))
    abstain, accept, metrics = choose_thresholds(entries)
    files = [LAB / p for p in POLICY_FILES] + [training]
    files += [p for p in (root / "holdout").glob("*/*") if p.name in {"schema.json", "instruction.txt"}]
    spec = RERANKERS["nemotron-1b"]
    write(root / "freeze.json", {
        "frozenAt": datetime.now(timezone.utc).isoformat(),
        "policy": "E; hitset; rich-hitset; zero-hit abstain; no pruning",
        "reranker": {"repo": spec.repo, "revision": spec.revision},
        "thresholds": {"abstain": abstain, "legacyAccept": accept, "containmentCap": CONTAINMENT_CAP},
        "trainingMetrics": metrics, "riskModel": fit_frozen(rows),
        "recordLimit": 20, "autoAccept": False,
        "sources": [{"family": e["family"], "source": e["source"], "sha256": e["sha256"]} for e in read(root / "holdout/sources.json")],
        "sourceBinding": "Original PDFs and parser code frozen; every extraction binds its complete parsed source and canonical text by SHA-256 in prepared.json.",
        "files": {str(p.relative_to(LAB)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
    })


def verify_freeze(root: Path) -> dict:
    frozen = read(root / "freeze.json")
    for relative, expected in frozen["files"].items():
        if hashlib.sha256((LAB / relative).read_bytes()).hexdigest() != expected:
            raise ValueError(f"frozen experiment input changed: {relative}")
    for source in frozen["sources"]:
        if hashlib.sha256(Path(source["source"]).read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError(f"frozen original PDF changed: {source['family']}")
    return frozen


def output_files(run: Path):
    """Keep scope failures failed while exposing their complete typed emissions."""
    meta_path = run / "extracted_meta.json"
    meta = read(meta_path) if meta_path.exists() else {}
    if meta.get("complete") and not meta.get("error"):
        return run / "extracted_raw.json", run / "quote_mappings.json", False
    diagnostic = run / "diagnostic_meta.json"
    if meta.get("error") == "Error: Result exceeds 20 burial records" and diagnostic.exists() and read(diagnostic).get("usableForLabeling") is True:
        return run / "diagnostic_extracted_raw.json", run / "diagnostic_quote_mappings.json", True
    return None


def score(root: Path, family: str | None = None) -> None:
    """Produce frozen E suggestions before opening labels, for both extraction arms."""
    from .harness import load_dataset
    from .model_benchmark import RETRIEVERS, RERANKERS, _load_reranker, _warm_reranker, _score_entries, dump_outcomes
    from .review_risk import score_frozen

    frozen = verify_freeze(root)
    spec = RERANKERS["nemotron-1b"]
    model = _load_reranker(spec)
    _warm_reranker(model, spec)
    for arm in ("baseline", "quote"):
        run_root = root / "runs" / arm
        if not run_root.exists():
            continue
        for run in sorted(p for p in run_root.iterdir() if p.is_dir()):
            if family and run.name != family:
                continue
            files = output_files(run)
            if files is None:
                continue
            output = run / "e-proposals.jsonl"
            if output.exists():
                if not (run / "grounding_meta.json").exists():
                    raise ValueError(f"partial suggestions require inspection: {output}")
                continue
            source = root / "holdout" / run.name
            shutil.copyfile(source / "anchors.json", run / "anchors.json")
            write(run / "claims_unlabelled.json", labeling_sheet(read(files[0])))
        documents = load_dataset(run_root, ("claims_unlabelled.json",))
        if family:
            documents = [doc for doc in documents if doc[0] == family]
        documents = [doc for doc in documents if not (run_root / doc[0] / "e-proposals.jsonl").exists()]
        for doc in documents:
            started = time.perf_counter()
            entries, latencies = _score_entries([doc], None, RETRIEVERS["mini"], model, spec, "rich-hitset")
            elapsed = time.perf_counter()-started
            output = run_root / doc[0] / "e-proposals.jsonl"
            dump_outcomes(output, entries, {doc[0]: (frozen["thresholds"]["abstain"], frozen["thresholds"]["legacyAccept"])}, [doc], latencies)
            rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            for row in rows:
                row["routingDecision"] = "linked" if row["outcome"].startswith("link-") else row["outcome"]
                for key in ("supported", "goldAnchorIds", "outcome"):
                    row.pop(key)
            rows = score_frozen(rows, frozen["riskModel"])
            output.write_text("".join(json.dumps(row, ensure_ascii=False)+"\n" for row in rows), encoding="utf-8")
            write(run_root / doc[0] / "grounding_meta.json", {"durationSeconds": elapsed, "reranker": frozen["reranker"], "calls": sum(tier == "neural" for _, tier, _ in latencies), "autoAccept": False})
            print(f"Scored {arm}/{doc[0]}: {len(rows)} claims in {elapsed:.2f}s", flush=True)


def prepare(root: Path, family: str | None = None) -> None:
    if (root / "blind-map.json").exists() and not family:
        raise ValueError("blind package already exists; do not reshuffle an active labeling round")
    mapping = read(root / "blind-map.json") if (root / "blind-map.json").exists() else []
    failures = read(root / "failures.json") if (root / "failures.json").exists() else []
    if family and (root / "blind" / family / "claims.json").exists():
        raise ValueError(f"blind package already exists: {family}")
    selected_family = family
    for source in sorted(p for p in (root / "holdout").iterdir() if p.is_dir()):
        if selected_family and source.name != selected_family:
            continue
        family = source.name
        unique, arm_claims = {}, []
        for arm in ("baseline", "quote"):
            run = root / "runs" / arm / family
            meta_path = run / "extracted_meta.json"
            meta = read(meta_path) if meta_path.exists() else {"error": "not executed"}
            if not meta.get("complete") or meta.get("error"):
                failures.append({"family": family, "arm": arm, "metadata": meta})
            files = output_files(run)
            if files is None:
                continue
            for name in ("anchors.json", "schema.json"):
                shutil.copyfile(source / name, run / name)
            raw = read(files[0])
            for claim in labeling_sheet(raw):
                path = claim["resultPath"]
                # Nested inventory leaves need their burial identity even when
                # two anonymous outputs use the same array index differently.
                if len(path) >= 3 and path[0] == "records" and isinstance(path[1], int):
                    claim["recordContext"] = {k: v for k, v in raw["records"][path[1]].items()
                                              if isinstance(v, (str, int, float, bool))}
                key = json.dumps([path, claim["value"], claim["context"], claim.get("recordContext")], ensure_ascii=False)
                unique.setdefault(key, claim)
                arm_claims.append((arm, key))
        ordered = list(unique)
        random.Random(20260905).shuffle(ordered)
        ids = {key: f"c{i+1:04d}" for i, key in enumerate(ordered)}
        blind = root / "blind" / family
        blind.mkdir(parents=True, exist_ok=True)
        for name in ("document.md", "parsed_document.json", "anchors.json", "schema.json", "instruction.txt"):
            if (source / name).exists():
                shutil.copyfile(source / name, blind / name)
        write(blind / "claims.json", [{"claimId": ids[key], **unique[key]} for key in ordered])
        mapping.extend({"family": family, "arm": arm, "claimId": ids[key], "claim": unique[key]} for arm, key in arm_claims)
    write(root / "blind-map.json", mapping)
    write(root / "failures.json", failures)


def checked_labels(path: Path, claim_ids: set[str], anchor_ids: set[str]) -> dict:
    rows = read(path)
    if not isinstance(rows, list) or len(rows) != len(claim_ids) or {r.get("claimId") for r in rows} != claim_ids:
        raise ValueError(f"{path}: label every claim exactly once")
    for row in rows:
        sets = evidence_sets(row)
        supported = row.get("valueSupported", bool(sets))
        if not isinstance(supported, bool) and not (supported is None and row.get("status") == "unresolved"):
            raise ValueError(f"{path}: valueSupported must be boolean, or null for unresolved judgments")
        if sets and supported is not True:
            raise ValueError(f"{path}: acceptable evidence requires a supported value")
        if any(a not in anchor_ids for group in sets for a in group):
            raise ValueError(f"{path}: unknown gold anchor")
        if not row.get("note"):
            raise ValueError(f"{path}: each label needs a source-backed rationale")
        if row.get("status", "resolved") not in {"resolved", "unresolved"}:
            raise ValueError(f"{path}: invalid label status")
    return {r["claimId"]: r for r in rows}


def signature(row: dict):
    groups = evidence_sets(row)
    return row.get("status", "resolved"), row.get("valueSupported", bool(groups)), sorted(sorted(group) for group in groups)


def adjudicate(root: Path, finalize: bool, family: str | None = None) -> None:
    final_by_family = {}
    for blind in sorted(p for p in (root / "blind").iterdir() if p.is_dir()):
        if family and blind.name != family:
            continue
        claims = read(blind / "claims.json")
        ids = {c["claimId"] for c in claims}
        if not ids:
            # Failed generations with no usable values need no invented labels.
            write(blind / ("final-labels.json" if finalize else "disagreements.json"), [])
            final_by_family[blind.name] = {}
            continue
        anchors = {a["anchorId"] for a in read(blind / "anchors.json")}
        a = checked_labels(blind / "labels-a.json", ids, anchors)
        b = checked_labels(blind / "labels-b.json", ids, anchors)
        differences = [c for c in claims if signature(a[c["claimId"]]) != signature(b[c["claimId"]]) or a[c["claimId"]].get("status") == "unresolved"]
        if not finalize:
            write(blind / "disagreements.json", [{"claim": c, "labelA": a[c["claimId"]], "labelB": b[c["claimId"]]} for c in differences])
            continue
        resolved = checked_labels(blind / "adjudicated.json", {c["claimId"] for c in differences}, anchors) if differences else {}
        final = {cid: resolved.get(cid, a[cid]) for cid in ids}
        write(blind / "final-labels.json", list(final.values()))
        final_by_family[blind.name] = final
    if not finalize:
        return
    mapped = read(root / "blind-map.json")
    for family in final_by_family:
        anchor_rows = read(root / "holdout" / family / "anchors.json")
        for arm in ("baseline", "quote"):
            entries = [m for m in mapped if m["family"] == family and m["arm"] == arm]
            if not entries:
                continue
            output = []
            for entry in entries:
                label = final_by_family[family][entry["claimId"]]
                gold = evidence_sets(label)
                claim = {**entry["claim"], "goldAnchorSets": gold,
                         "goldAnchorIds": [group[0] for group in gold if len(group) == 1],
                         "supported": label.get("valueSupported", bool(gold)), "note": label["note"],
                         "labelStatus": label.get("status", "resolved"), "blindClaimId": entry["claimId"]}
                if claim["supported"] is False:
                    claim["expectedLexicalHitIds"] = [a["anchorId"] for a in anchor_rows if bounded_contains(claim["value"], a["text"])]
                output.append(claim)
            write(root / "runs" / arm / family / "claims_extracted.json", output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("operation", choices=("freeze", "verify", "score", "prepare", "disagreements", "finalize"))
    parser.add_argument("--family", choices=("beier", "bosch", "wiermann", "kirsch"))
    args = parser.parse_args()
    args.root = args.root.resolve()
    if args.operation == "freeze":
        freeze(args.root)
    elif args.operation == "verify":
        verify_freeze(args.root)
    elif args.operation == "score":
        score(args.root, args.family)
    elif args.operation == "prepare":
        verify_freeze(args.root)
        prepare(args.root, args.family)
    else:
        verify_freeze(args.root)
        adjudicate(args.root, args.operation == "finalize", args.family)


if __name__ == "__main__":
    main()
