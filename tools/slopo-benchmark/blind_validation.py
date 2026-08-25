"""Run a frozen, label-blind ensemble validation on an independent source package."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
import sqlite3
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

import numpy as np
import slopo

import benchmark
from ensemble import (
    DEFAULT_CONFIGURATIONS,
    DEFAULT_CONFIRMATION_CONFIGURATIONS,
    DEFAULT_MATCH_JACCARD,
    DEFAULT_POOL_SIZE,
    PRIMARY_CONFIGURATION,
    build_ensemble,
)
from report_sanitizer import remove_evaluation_labels


BENCH_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BENCH_DIR / "results"
TRAINING_SUMMARY = RESULTS_DIR / "summary.json"
HOLDOUT_WORK: Path
HOLDOUT_CORPUS: Path
HOLDOUT_DB: Path
HOLDOUT_MANIFEST: Path
HOLDOUT_NATIVE: Path
HOLDOUT_LOGS: Path
HOLDOUT_RUNS: Path
NO_ADJUDICATIONS: Path
FREEZE_PATH: Path
MODEL_SUMMARY_PATH: Path
UNSCORED_ENSEMBLE_PATH: Path
QUEUE_PATH: Path
DECISIONS_PATH: Path
SCORED_ENSEMBLE_PATH: Path
REPORT_PATH: Path

REVIEW_LIMIT = 20
MINIMUM_CONSENSUS_CANDIDATES = 20
MINIMUM_CONSENSUS_P20 = 0.90


def configure_validation_paths(validation_id: str) -> None:
    if validation_id and not re.fullmatch(r"[a-z0-9-]+", validation_id):
        raise ValueError("Validation ID may contain only lowercase letters, digits, and hyphens")
    suffix = f"-{validation_id}" if validation_id else ""
    work_name = f"blind-validation{suffix}"
    result_prefix = f"blind-validation{suffix}"
    global HOLDOUT_WORK, HOLDOUT_CORPUS, HOLDOUT_DB, HOLDOUT_MANIFEST
    global HOLDOUT_NATIVE, HOLDOUT_LOGS, HOLDOUT_RUNS, NO_ADJUDICATIONS
    global FREEZE_PATH, MODEL_SUMMARY_PATH, UNSCORED_ENSEMBLE_PATH
    global QUEUE_PATH, DECISIONS_PATH, SCORED_ENSEMBLE_PATH, REPORT_PATH
    HOLDOUT_WORK = BENCH_DIR / "work" / work_name
    HOLDOUT_CORPUS = HOLDOUT_WORK / "corpus"
    HOLDOUT_DB = HOLDOUT_WORK / "base.db"
    HOLDOUT_MANIFEST = HOLDOUT_WORK / "corpus-manifest.json"
    HOLDOUT_NATIVE = HOLDOUT_WORK / "native"
    HOLDOUT_LOGS = HOLDOUT_WORK / "logs"
    HOLDOUT_RUNS = HOLDOUT_WORK / "runs"
    NO_ADJUDICATIONS = HOLDOUT_WORK / "no-adjudications.json"
    FREEZE_PATH = RESULTS_DIR / f"{result_prefix}-freeze.json"
    MODEL_SUMMARY_PATH = RESULTS_DIR / f"{result_prefix}-models.json"
    UNSCORED_ENSEMBLE_PATH = RESULTS_DIR / f"{result_prefix}-unscored.json"
    QUEUE_PATH = RESULTS_DIR / f"{result_prefix}-review-queue.md"
    DECISIONS_PATH = RESULTS_DIR / f"{result_prefix}-decisions.json"
    SCORED_ENSEMBLE_PATH = RESULTS_DIR / f"{result_prefix}-scored.json"
    REPORT_PATH = RESULTS_DIR / f"{result_prefix}-summary.md"


configure_validation_paths("")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    return benchmark.sha256_file(path)


def sha256_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@contextmanager
def isolated_benchmark_paths() -> Iterator[None]:
    overrides = {
        "WORK": HOLDOUT_WORK,
        "CORPUS": HOLDOUT_CORPUS,
        "BASE_DB": HOLDOUT_DB,
        "RUNS": HOLDOUT_RUNS,
        "NATIVE": HOLDOUT_NATIVE,
        "LOGS": HOLDOUT_LOGS,
        "ADJUDICATIONS_PATH": NO_ADJUDICATIONS,
    }
    originals = {name: getattr(benchmark, name) for name in overrides}
    try:
        for name, value in overrides.items():
            setattr(benchmark, name, value)
        benchmark.ensure_directories()
        yield
    finally:
        for name, value in originals.items():
            setattr(benchmark, name, value)


def installed_slopo_source() -> tuple[Path, str]:
    source = Path(slopo.__file__).resolve().parent
    version = importlib.metadata.version("slopo")
    return source, version


def prepare_holdout(
    source_root: Path,
    source_identity: dict[str, Any],
    destination_prefix: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    source_root = source_root.resolve()
    with isolated_benchmark_paths():
        benchmark.safe_reset_directory(HOLDOUT_CORPUS)
        copied: list[dict[str, Any]] = []
        for source in sorted(source_root.rglob("*")):
            if (
                ".git" in source.parts
                or "__pycache__" in source.parts
                or not source.is_file()
                or source.suffix.lower() not in benchmark.SUPPORTED_EXTENSIONS
            ):
                continue
            relative = source.relative_to(source_root)
            destination = HOLDOUT_CORPUS / destination_prefix / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            copied.append(
                {
                    "path": destination.relative_to(HOLDOUT_CORPUS).as_posix(),
                    "sha256": sha256_file(destination),
                }
            )

        if not copied:
            raise ValueError(f"No Python source files found under {source_root}")
        fingerprint = sha256_json(copied)
        manifest = {
            "schema_version": 1,
            **source_identity,
            "fingerprint": fingerprint,
            "files": copied,
        }
        write_json(HOLDOUT_MANIFEST, manifest)
        counts = benchmark.build_base_index()
    return manifest, counts


def verify_prepared_corpus(manifest: dict[str, Any]) -> None:
    for item in manifest["files"]:
        path = HOLDOUT_CORPUS / Path(item["path"])
        if not path.is_file() or sha256_file(path) != item["sha256"]:
            raise ValueError(f"Prepared holdout corpus changed: {item['path']}")


def configuration_lookup(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["configuration"]: item for item in summary["configurations"]}


def model_spec(family: str) -> benchmark.ModelSpec:
    matches = [spec for spec in benchmark.MODEL_SPECS if spec.family == family]
    if len(matches) != 1:
        raise ValueError(f"Expected one model spec for {family}, found {len(matches)}")
    return matches[0]


def build_freeze(
    manifest: dict[str, Any],
    index_counts: dict[str, Any],
) -> dict[str, Any]:
    training = load_json(TRAINING_SUMMARY)
    by_name = configuration_lookup(training)
    discovery = list(DEFAULT_CONFIGURATIONS)
    confirmation = list(DEFAULT_CONFIRMATION_CONFIGURATIONS)
    selected = discovery + confirmation
    missing = [name for name in selected if name not in by_name]
    if missing:
        raise ValueError(f"Training summary is missing configurations: {missing}")

    models: list[dict[str, Any]] = []
    for name in selected:
        configuration = by_name[name]
        runtime = configuration.get("runtime", {})
        models.append(
            {
                "configuration": name,
                "family": configuration["family"],
                "dimensions": configuration["dimensions"],
                "role": "discovery" if name in discovery else "confirmation_only",
                "similarity_threshold": configuration["thresholds"][
                    "similarity_threshold"
                ],
                "rerank_threshold": configuration["thresholds"]["rerank_threshold"],
                "model_repo": runtime.get("repo"),
                "model_revision": runtime.get("revision"),
                "model_filename": runtime.get("filename"),
            }
        )

    frozen = {
        "schema_version": 1,
        "frozen_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "training": {
            "summary_sha256": sha256_file(TRAINING_SUMMARY),
            "corpus_fingerprint": training["corpus"]["fingerprint"],
        },
        "holdout": {
            "kind": manifest["kind"],
            "distribution": manifest["distribution"],
            "version": manifest["version"],
            "corpus_fingerprint": manifest["fingerprint"],
            "files": len(manifest["files"]),
            "index": index_counts,
        },
        "models": models,
        "fusion": {
            "discovery_configurations": discovery,
            "confirmation_configurations": confirmation,
            "primary_configuration": PRIMARY_CONFIGURATION,
            "pool_size_per_configuration": DEFAULT_POOL_SIZE,
            "member_jaccard_threshold": DEFAULT_MATCH_JACCARD,
            "minimum_shared_members": 2,
            "rrf_k": 60,
            "transitive_member_union": False,
        },
        "review_protocol": {
            "selection": "union of primary-model top 20 and consensus top 20",
            "order": "deterministic SHA-256 shuffle",
            "reviewer_hidden_fields": [
                "source model",
                "model support",
                "rank",
                "similarity score",
            ],
            "positive_rule": "all reported members are one coherent duplicate implementation or refactoring opportunity",
        },
        "acceptance": {
            "minimum_consensus_candidates": MINIMUM_CONSENSUS_CANDIDATES,
            "minimum_consensus_p20": MINIMUM_CONSENSUS_P20,
            "requires_all_consensus_top20_reviewed": True,
            "threshold_retuning_allowed": False,
        },
    }
    if FREEZE_PATH.exists():
        existing = load_json(FREEZE_PATH)
        comparable_existing = {key: value for key, value in existing.items() if key != "frozen_at"}
        comparable_new = {key: value for key, value in frozen.items() if key != "frozen_at"}
        if comparable_existing != comparable_new:
            raise ValueError(
                "Blind-validation inputs differ from the existing freeze; use a new validation version"
            )
        return existing
    write_json(FREEZE_PATH, frozen)
    return frozen


def empty_labels() -> dict[str, set[tuple[int, int]]]:
    return {"positive_pairs": set(), "explicit_negative_pairs": set()}


def verify_frozen_model_runtime(
    frozen_model: dict[str, Any], runtime: dict[str, Any]
) -> None:
    expected = {
        "repo": frozen_model.get("model_repo"),
        "revision": frozen_model.get("model_revision"),
        "filename": frozen_model.get("model_filename"),
    }
    mismatches = {
        key: {"expected": value, "actual": runtime.get(key)}
        for key, value in expected.items()
        if value is not None and runtime.get(key) != value
    }
    if mismatches:
        raise ValueError(
            f"Model artifact differs from the frozen configuration: {mismatches}"
        )


def run_frozen_models(freeze: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    verify_prepared_corpus(manifest)
    configurations: list[dict[str, Any]] = []
    model_runs: list[dict[str, Any]] = []
    with isolated_benchmark_paths():
        units = benchmark.load_units(HOLDOUT_DB)
        for frozen_model in freeze["models"]:
            spec = model_spec(frozen_model["family"])
            dimensions = int(frozen_model["dimensions"])
            benchmark.log(f"Holdout: embedding {frozen_model['configuration']}.")
            body_hashes, source_vectors, runtime = benchmark.embed_model(
                spec,
                manifest["fingerprint"],
                use_cache=True,
            )
            verify_frozen_model_runtime(frozen_model, runtime)
            vectors = benchmark.l2_normalize(source_vectors[:, :dimensions])
            by_hash = {
                body_hash: vector for body_hash, vector in zip(body_hashes, vectors)
            }
            missing = [unit.body_hash for unit in units if unit.body_hash not in by_hash]
            if missing:
                raise ValueError(f"Missing {len(missing)} holdout embeddings")
            matrix = np.stack([by_hash[unit.body_hash] for unit in units])
            similarity_matrix = matrix @ matrix.T
            full = benchmark.evaluate_full_clusters(
                matrix=similarity_matrix,
                units=units,
                labels=empty_labels(),
                similarity_threshold=float(frozen_model["similarity_threshold"]),
                rerank_threshold=float(frozen_model["rerank_threshold"]),
            )
            configurations.append(
                {
                    "configuration": frozen_model["configuration"],
                    "family": frozen_model["family"],
                    "dimensions": dimensions,
                    "thresholds": {
                        "similarity_threshold": frozen_model["similarity_threshold"],
                        "rerank_threshold": frozen_model["rerank_threshold"],
                    },
                    "runtime": runtime,
                    "full_repository": remove_evaluation_labels(full),
                }
            )
            model_runs.append(runtime)

    summary = {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "freeze_sha256": sha256_file(FREEZE_PATH),
        "corpus": manifest,
        "index": freeze["holdout"]["index"],
        "model_runs": model_runs,
        "configurations": configurations,
    }
    write_json(MODEL_SUMMARY_PATH, summary)
    return summary


def select_review_clusters(
    model_summary: dict[str, Any],
    ensemble_payload: dict[str, Any],
    *,
    limit: int = REVIEW_LIMIT,
    seed: str,
) -> list[dict[str, Any]]:
    by_configuration = configuration_lookup(model_summary)
    baseline = by_configuration[PRIMARY_CONFIGURATION]["full_repository"]["top"][:limit]
    consensus = ensemble_payload["strategies"]["consensus_only"]["top"][:limit]
    selected: dict[str, dict[str, Any]] = {}
    for cluster in baseline:
        selected.setdefault(
            cluster["id"],
            {"cluster_id": cluster["id"], "members": cluster["members"]},
        )
    for cluster in consensus:
        selected[cluster["id"]] = {
            "cluster_id": cluster["id"],
            "members": cluster["member_details"],
        }
    return sorted(
        selected.values(),
        key=lambda item: hashlib.sha256(
            f"{seed}\0{item['cluster_id']}".encode("utf-8")
        ).hexdigest(),
    )


def queue_fingerprint(entries: Sequence[dict[str, Any]]) -> str:
    stable = [
        {
            "cluster_id": entry["cluster_id"],
            "unit_ids": sorted(member["unit_id"] for member in entry["members"]),
        }
        for entry in entries
    ]
    return sha256_json(stable)


def write_blind_queue(
    entries: Sequence[dict[str, Any]],
    units: Sequence[benchmark.IndexedUnit],
    freeze_sha256: str,
) -> None:
    by_id = {unit.unit_id: unit for unit in units}
    fingerprint = queue_fingerprint(entries)
    reviews = [
        {
            "blind_id": f"HV-{index:03d}",
            "cluster_id": entry["cluster_id"],
            "duplicate": None,
            "note": "",
        }
        for index, entry in enumerate(entries, start=1)
    ]
    if DECISIONS_PATH.exists():
        existing = load_json(DECISIONS_PATH)
        if (
            existing.get("freeze_sha256") != freeze_sha256
            or existing.get("queue_fingerprint") != fingerprint
        ):
            raise ValueError("Existing blind decisions belong to a different frozen queue")
        existing_by_id = {item["cluster_id"]: item for item in existing["reviews"]}
        for review in reviews:
            if review["cluster_id"] in existing_by_id:
                prior = existing_by_id[review["cluster_id"]]
                review["duplicate"] = prior.get("duplicate")
                review["note"] = prior.get("note", "")

    write_json(
        DECISIONS_PATH,
        {
            "schema_version": 1,
            "freeze_sha256": freeze_sha256,
            "queue_fingerprint": fingerprint,
            "reviews": reviews,
        },
    )

    lines = [
        "# Slopo blind-validation review queue",
        "",
        f"Frozen configuration SHA-256: `{freeze_sha256}`",
        "",
        f"Queue SHA-256: `{fingerprint}`",
        "",
        "Review the candidates in this shuffled order. Model identity, support, rank, and "
        "similarity scores are intentionally hidden. Mark a candidate positive only when "
        "all reported members form one coherent duplicate implementation or refactoring "
        "opportunity.",
        "",
    ]
    for index, entry in enumerate(entries, start=1):
        lines.extend([f"## HV-{index:03d}", ""])
        for member in entry["members"]:
            unit = by_id[int(member["unit_id"])]
            lines.append(
                f"- `{unit.file_path}::{unit.name}` "
                f"lines {unit.start_line}-{unit.end_line}"
            )
        lines.append("")
    QUEUE_PATH.write_text("\n".join(lines), encoding="utf-8")


def build_unscored_ensemble(
    freeze: dict[str, Any], model_summary: dict[str, Any]
) -> dict[str, Any]:
    fusion = freeze["fusion"]
    payload = build_ensemble(
        model_summary,
        {},
        configuration_names=tuple(fusion["discovery_configurations"]),
        confirmation_configuration_names=tuple(
            fusion["confirmation_configurations"]
        ),
        pool_size=int(fusion["pool_size_per_configuration"]),
        match_jaccard=float(fusion["member_jaccard_threshold"]),
        primary_configuration=fusion["primary_configuration"],
    )
    payload["freeze_sha256"] = sha256_file(FREEZE_PATH)
    write_json(UNSCORED_ENSEMBLE_PATH, payload)
    with isolated_benchmark_paths():
        units = benchmark.load_units(HOLDOUT_DB)
    entries = select_review_clusters(
        model_summary,
        payload,
        seed=payload["freeze_sha256"],
    )
    write_blind_queue(entries, units, payload["freeze_sha256"])
    return payload


def acceptance_status(consensus_p20: dict[str, Any], candidates: int) -> str:
    if candidates < MINIMUM_CONSENSUS_CANDIDATES or consensus_p20["returned"] < REVIEW_LIMIT:
        return "inconclusive"
    if consensus_p20["reviewed"] < REVIEW_LIMIT or consensus_p20["unknown"]:
        return "incomplete"
    return (
        "pass"
        if consensus_p20["reviewed_precision"] >= MINIMUM_CONSENSUS_P20
        else "fail"
    )


def load_completed_decisions(freeze_sha256: str) -> dict[str, Any]:
    decisions = load_json(DECISIONS_PATH)
    if decisions.get("freeze_sha256") != freeze_sha256:
        raise ValueError("Blind decisions do not match the frozen configuration")
    return {
        item["cluster_id"]: {
            "duplicate": item["duplicate"],
            "note": item.get("note", ""),
        }
        for item in decisions["reviews"]
        if isinstance(item.get("duplicate"), bool)
    }


def percentage(value: float) -> str:
    return f"{value * 100:.1f}%"


def score_holdout(freeze: dict[str, Any], model_summary: dict[str, Any]) -> dict[str, Any]:
    freeze_sha256 = sha256_file(FREEZE_PATH)
    if model_summary.get("freeze_sha256") != freeze_sha256:
        raise ValueError("Model output does not match the frozen configuration")
    adjudications = load_completed_decisions(freeze_sha256)
    fusion = freeze["fusion"]
    payload = build_ensemble(
        model_summary,
        adjudications,
        configuration_names=tuple(fusion["discovery_configurations"]),
        confirmation_configuration_names=tuple(
            fusion["confirmation_configurations"]
        ),
        pool_size=int(fusion["pool_size_per_configuration"]),
        match_jaccard=float(fusion["member_jaccard_threshold"]),
        primary_configuration=fusion["primary_configuration"],
    )
    consensus = payload["strategies"]["consensus_only"]
    baseline = payload["baseline"]["p20"]
    status = acceptance_status(consensus["p20"], consensus["candidates"])
    payload["freeze_sha256"] = freeze_sha256
    payload["validation"] = {
        "status": status,
        "completed_reviews": len(adjudications),
        "required_precision": MINIMUM_CONSENSUS_P20,
        "required_consensus_candidates": MINIMUM_CONSENSUS_CANDIDATES,
    }
    write_json(SCORED_ENSEMBLE_PATH, payload)

    p20 = consensus["p20"]
    holdout = freeze["holdout"]
    if holdout["kind"] == "git_repository":
        source_description = (
            f"pinned {holdout['distribution']} repository commit `{holdout['version']}`"
        )
    else:
        source_description = (
            f"installed {holdout['distribution']} `{holdout['version']}` production source"
        )
    primary_top = configuration_lookup(model_summary)[PRIMARY_CONFIGURATION][
        "full_repository"
    ]["top"][:REVIEW_LIMIT]
    baseline_false_ids = {
        cluster["id"]
        for cluster in primary_top
        if adjudications.get(cluster["id"], {}).get("duplicate") is False
    }
    consensus_false_ids = {
        cluster["id"]
        for cluster in consensus["top"][:REVIEW_LIMIT]
        if cluster["relevant"] is False
    }
    rejected_baseline_clusters_removed = len(
        baseline_false_ids - consensus_false_ids
    )
    baseline_ids = {cluster["id"] for cluster in primary_top}
    consensus_ids = {
        cluster["id"] for cluster in consensus["top"][:REVIEW_LIMIT]
    }
    entered_ids = consensus_ids - baseline_ids
    exited_ids = baseline_ids - consensus_ids
    entered_positives = sum(
        adjudications.get(cluster_id, {}).get("duplicate") is True
        for cluster_id in entered_ids
    )
    exited_positives = sum(
        adjudications.get(cluster_id, {}).get("duplicate") is True
        for cluster_id in exited_ids
    )
    lines = [
        "# Slopo blind-validation result",
        "",
        f"Decision: **{status.upper()}**",
        "",
        f"Holdout: {source_description}, {holdout['files']} files and "
        f"{holdout['index']['units']} indexed units.",
        "",
        f"Frozen configuration SHA-256: `{freeze_sha256}`",
        "",
        "The model thresholds, dimensions, fusion cutoff, candidate pool, and acceptance "
        "rule were frozen before model output was reviewed. No planted fixtures or holdout "
        "threshold tuning were used.",
        "",
        "| Ranking | Returned | Reviewed | Positives | Unknown | Reviewed precision |",
        "|---|---:|---:|---:|---:|---:|",
        f"| pplx baseline P@20 | {baseline['returned']} | {baseline['reviewed']} | "
        f"{baseline['positives']} | {baseline['unknown']} | "
        f"{percentage(baseline['reviewed_precision'])} |",
        f"| consensus P@20 | {p20['returned']} | {p20['reviewed']} | "
        f"{p20['positives']} | {p20['unknown']} | "
        f"{percentage(p20['reviewed_precision'])} |",
        "",
        f"Acceptance requires at least {MINIMUM_CONSENSUS_CANDIDATES} consensus candidates, "
        f"all first {REVIEW_LIMIT} reviewed, and at least "
        f"{percentage(MINIMUM_CONSENSUS_P20)} precision.",
        "",
        f"Completed blinded reviews: {len(adjudications)}.",
        "",
        "## Post-unblinding audit",
        "",
        f"Consensus moved {rejected_baseline_clusters_removed} manually rejected pplx "
        "top-20 candidate(s) below the review cutoff.",
        "",
        f"It changed {len(entered_ids)} of 20 slots: the entering candidates contained "
        f"{entered_positives} positive(s) and {len(entered_ids) - entered_positives} "
        f"negative(s), while the displaced candidates contained {exited_positives} "
        f"positive(s) and {len(exited_ids) - exited_positives} negative(s).",
        "",
        f"Confirmed positives in the consensus top 20 without a matching primary-model "
        f"top-50 cluster: {p20['confirmed_novel_positives']}.",
        "",
    ]
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")
    return payload


def load_prepared() -> tuple[dict[str, Any], dict[str, Any]]:
    if not HOLDOUT_MANIFEST.exists() or not HOLDOUT_DB.exists():
        raise FileNotFoundError("Run blind_validation.py prepare first")
    manifest = load_json(HOLDOUT_MANIFEST)
    verify_prepared_corpus(manifest)
    conn = sqlite3.connect(HOLDOUT_DB)
    try:
        counts = {
            "files": conn.execute("SELECT COUNT(*) FROM files").fetchone()[0],
            "units": conn.execute("SELECT COUNT(*) FROM code_units").fetchone()[0],
            "unique_bodies": conn.execute(
                "SELECT COUNT(DISTINCT body_hash) FROM code_units"
            ).fetchone()[0],
        }
    finally:
        conn.close()
    return manifest, counts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the frozen Slopo ensemble against an independent package"
    )
    parser.add_argument(
        "command", choices=("prepare", "run", "queue", "score", "all")
    )
    parser.add_argument(
        "--validation-id",
        default="",
        help="Optional lowercase ID that isolates work and result files",
    )
    parser.add_argument(
        "--source-root",
        type=Path,
        help="Python package root; defaults to the installed Slopo package",
    )
    parser.add_argument(
        "--source-distribution",
        help="Distribution name for a non-Git installed-package source root",
    )
    parser.add_argument(
        "--source-version",
        help="Pinned distribution version for a non-Git installed-package source root",
    )
    return parser.parse_args()


def git_source_identity(source_root: Path) -> dict[str, Any]:
    def git_output(*arguments: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(source_root), *arguments],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return completed.stdout.strip()

    revision = git_output("rev-parse", "HEAD")
    return {
        "kind": "git_repository",
        "distribution": "slopo",
        "version": revision,
        "revision": revision,
        "repository": git_output("remote", "get-url", "origin"),
        "git_dirty": bool(git_output("status", "--porcelain")),
    }


def main() -> None:
    args = parse_args()
    configure_validation_paths(args.validation_id)
    if args.command in {"prepare", "all"}:
        if args.source_root:
            source_root = args.source_root.resolve()
            if args.source_distribution or args.source_version:
                if not args.source_distribution or not args.source_version:
                    raise ValueError(
                        "--source-distribution and --source-version must be provided together"
                    )
                source_identity = {
                    "kind": "installed_python_distribution",
                    "distribution": args.source_distribution,
                    "version": args.source_version,
                }
                destination_prefix = Path(args.source_distribution)
            else:
                source_identity = git_source_identity(source_root)
                destination_prefix = Path()
        else:
            source_root, version = installed_slopo_source()
            source_identity = {
                "kind": "installed_python_distribution",
                "distribution": "slopo",
                "version": version,
            }
            destination_prefix = Path("slopo")
        manifest, counts = prepare_holdout(
            source_root,
            source_identity,
            destination_prefix,
        )
        freeze = build_freeze(manifest, counts)
        benchmark.log(f"Frozen holdout configuration: {FREEZE_PATH}")
        if args.command == "prepare":
            return
    else:
        manifest, counts = load_prepared()
        if args.command in {"queue", "score"}:
            freeze = load_json(FREEZE_PATH)
            if (
                freeze["holdout"]["corpus_fingerprint"]
                != manifest["fingerprint"]
            ):
                raise ValueError("Prepared corpus does not match the frozen holdout")
        else:
            freeze = build_freeze(manifest, counts)

    if args.command in {"run", "all"}:
        model_summary = run_frozen_models(freeze, manifest)
        ensemble_payload = build_unscored_ensemble(freeze, model_summary)
        benchmark.log(
            f"Blind queue: {QUEUE_PATH} "
            f"({len(load_json(DECISIONS_PATH)['reviews'])} candidates; "
            f"{ensemble_payload['strategies']['consensus_only']['candidates']} consensus)"
        )
        return

    model_summary = load_json(MODEL_SUMMARY_PATH)
    if args.command == "queue":
        payload = build_unscored_ensemble(freeze, model_summary)
        benchmark.log(
            f"Blind queue regenerated: {QUEUE_PATH} "
            f"({len(load_json(DECISIONS_PATH)['reviews'])} candidates; "
            f"{payload['strategies']['consensus_only']['candidates']} consensus)"
        )
        return
    payload = score_holdout(freeze, model_summary)
    benchmark.log(f"Blind validation: {payload['validation']['status'].upper()}")
    benchmark.log(f"Report: {REPORT_PATH}")


if __name__ == "__main__":
    main()
