"""Reproduce the three pruning ablations with one loaded, warmed reranker.

Run from the lab: python -m grounding_lab.pruning_experiment final_dataset_3
experiments/2026-09-05/pruning [--prepare-only]. Historical incomplete extraction
is retained only as a development stress case, never as a valid holdout.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import time

from . import model_benchmark as mb
from .harness import load_dataset

POLICIES = ("E", "bare-number-row", "all-value-row")


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory_comparison(original, regenerated):
    """Scoring inputs must stay byte-for-byte equivalent; metadata may expand."""
    fields = ("anchorId", "text", "page", "context")
    differences = {
        field: [i for i, (old, new) in enumerate(zip(original, regenerated))
                if old.get(field) != new.get(field)]
        for field in fields
    }
    return {
        "originalCount": len(original), "regeneratedCount": len(regenerated),
        "differentPositionsByField": differences,
        "compatible": len(original) == len(regenerated) and not any(differences.values()),
        "tableCells": sum(a.get("kind") == "table_cell" for a in regenerated),
        "tableCellsWithIdentity": sum(a.get("kind") == "table_cell" and
            a.get("logicalTableId") is not None and a.get("row") is not None and
            a.get("column") is not None and "role" in a for a in regenerated),
    }


def prepare(source, output):
    dataset = output / "dataset"
    manifest = {}
    for doc in sorted(source.iterdir()):
        if not doc.is_dir() or not (doc / "claims_extracted.json").exists():
            continue
        destination = dataset / doc.name
        destination.mkdir(parents=True, exist_ok=True)
        subprocess.run(["node", "--experimental-strip-types", "scripts/dump-anchors.mts",
                        str(doc / "parsed_document.json"), str(destination / "anchors.json")], check=True)
        comparison = inventory_comparison(
            json.loads((doc / "anchors.json").read_text(encoding="utf-8")),
            json.loads((destination / "anchors.json").read_text(encoding="utf-8")))
        for filename in ("claims_extracted.json", "extracted_meta.json"):
            shutil.copyfile(doc / filename, destination / filename)
        manifest[doc.name] = {
            **comparison,
            "sourceHashes": {p.name: sha256(p) for p in sorted(doc.iterdir()) if p.is_file()},
            "regeneratedAnchorsSha256": sha256(destination / "anchors.json"),
        }
    write_json(output / "inventory.json", manifest)
    if not manifest or not all(doc["compatible"] for doc in manifest.values()):
        raise ValueError("Anchor scoring inputs differ; inspect inventory.json before comparing policies")
    return dataset


def distribution(values):
    ordered = sorted(values)
    return {"n": len(ordered), "p50": statistics.median(ordered) if ordered else None,
            "p95": ordered[int(.95 * (len(ordered) - 1))] if ordered else None,
            "p99": ordered[int(.99 * (len(ordered) - 1))] if ordered else None,
            "max": max(ordered) if ordered else None}


def summarize(rows, document_ms):
    linked = [row for row in rows if row["outcome"].startswith("link-")]
    recoverable = [row for row in rows if set(row["goldAnchorIds"]) &
                   set(row["candidateAnchorIdsBeforePruning"])]
    counts = [len(row["candidates"]) for row in rows if row["tier"] == "neural"]
    return {
        "claims": len(rows), "supportedValues": sum(row["supported"] for row in rows),
        "supportedLinks": sum(row["outcome"] == "link-correct" for row in rows),
        "unsupportedLinks": sum(not row["supported"] for row in linked),
        "wrongAnchors": sum(row["supported"] and row["outcome"] == "link-wrong" for row in rows),
        "reviewQueue": sum(not row["outcome"].startswith("link-") for row in rows),
        "recoverableGoldBefore": len(recoverable),
        "recoverableGoldRetained": sum(bool(set(row["goldAnchorIds"]) &
            {a["anchorId"] for a in row["candidates"]}) for row in recoverable),
        "neuralCandidatePairs": sum(counts), "neuralCandidateCounts": distribution(counts),
        "claimLatencyMs": distribution([row["latencyMs"] for row in rows]),
        "groundingExtractionLatencyMs": distribution(list(document_ms.values())),
        "perDocumentGroundingMs": document_ms,
    }


def run(source, output, prepare_only=False):
    output.mkdir(parents=True, exist_ok=True)
    dataset = prepare(source, output)
    if prepare_only:
        return
    documents = load_dataset(dataset, ("claims_extracted.json",))
    stress = {name for name, _, _ in documents if json.loads(
        (dataset / name / "extracted_meta.json").read_text(encoding="utf-8")
    )["metadata"]["finishReason"] == "length"}
    spec = mb.RERANKERS["nemotron-1b"]
    torch = mb._torch()
    metadata = {
        "startedAt": datetime.now(timezone.utc).isoformat(), "source": str(source.resolve()),
        "model": asdict(spec), "python": platform.python_version(), "torch": torch.__version__,
        "device": torch.cuda.get_device_name() if torch.cuda.is_available() else platform.processor(),
        "cuda": torch.version.cuda, "stressDocuments": sorted(stress),
        "configuration": {"claimMode": "rich-hitset", "candidates": "hitset", "zeroHit": "abstain",
            "folds": len(documents), "repetitions": 3, "containmentCap": mb.CONTAINMENT_CAP,
            "maxLength": 512, "warmup": "model warmup before each timed policy; model loaded once",
            "policyOrder": [list(POLICIES[i:] + POLICIES[:i]) for i in range(3)]},
        "codeHashes": {str(p): sha256(p) for p in [Path(__file__), Path(mb.__file__),
            Path("grounding_lab/pipeline.py"), Path("scripts/dump-anchors.mts")]},
        "latencyScope": "Grounding path only; extraction was historical and is not rerun. Document wall time includes index and routing; excludes loading, warmup, calibration and dump.",
        "failures": [], "runs": [],
    }
    write_json(output / "run.json", metadata)
    try:
        reranker = mb._load_reranker(spec)
        for repetition in range(3):
            for policy in POLICIES[repetition:] + POLICIES[:repetition]:
                mb._warm_reranker(reranker, spec)
                entries, latencies, document_ms = [], [], {}
                print(f"Repetition {repetition + 1}: {policy}", flush=True)
                for doc in documents:
                    started = time.perf_counter()
                    current, timing = mb._score_entries([doc], None, None, reranker, spec,
                        "rich-hitset", bare_number_prune=policy == "bare-number-row",
                        row_prune=policy == "all-value-row")
                    document_ms[doc[0]] = 1000 * (time.perf_counter() - started)
                    entries.extend(current)
                    latencies.extend(timing)
                folds, _ = mb.cv_evaluate(entries, latencies, mb.cv_folds(document_ms, len(documents)))
                thresholds = {name: (abstain, accept) for fold, abstain, accept, _ in folds for name in fold}
                dump = output / f"rep-{repetition + 1}-{policy}.jsonl"
                mb.dump_outcomes(dump, entries, thresholds, documents, latencies, policy)
                rows = [json.loads(line) for line in dump.read_text(encoding="utf-8").splitlines()]
                record = {"repetition": repetition + 1, "policy": policy, "dump": dump.name,
                    "dumpSha256": sha256(dump), "all": summarize(rows, document_ms),
                    "withoutStress": summarize([r for r in rows if r["doc"] not in stress],
                        {name: ms for name, ms in document_ms.items() if name not in stress}),
                    "perDocument": {name: summarize([r for r in rows if r["doc"] == name], {name: ms})
                        for name, ms in document_ms.items()}}
                metadata["runs"].append(record)
                write_json(output / "run.json", metadata)
                print(json.dumps({"policy": policy, **record["all"]}), flush=True)
    except Exception as error:
        metadata["failures"].append({"at": datetime.now(timezone.utc).isoformat(), "error": repr(error)})
        raise
    finally:
        metadata["finishedAt"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "run.json", metadata)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    run(args.source, args.output, args.prepare_only)
