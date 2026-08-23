"""Run the benchmark-selected Slopo pipeline against FREE production source."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

import numpy as np
import yaml

import benchmark
import ensemble
from report_sanitizer import remove_evaluation_labels
from slopo.analysis.command import run_analyze
from slopo.config import Config, load_config
from slopo.db import create_db
from slopo.indexing.command import run_index


BENCH_DIR = Path(__file__).resolve().parent
ROOT = BENCH_DIR.parents[1]
DEFAULT_PIPELINE_CONFIG = BENCH_DIR / "slopo.pipeline.yaml"


@dataclass(frozen=True)
class PipelineModel:
    configuration: str
    family: str
    dimensions: int
    role: str
    similarity_threshold: float
    rerank_threshold: float


@dataclass(frozen=True)
class FusionSettings:
    primary_configuration: str
    pool_size_per_configuration: int
    member_jaccard_threshold: float
    minimum_shared_members: int
    minimum_support: int
    rrf_k: int
    transitive_member_union: bool


@dataclass(frozen=True)
class PipelineSettings:
    config_path: Path
    source_config_path: Path
    source_config: Config
    source_dir: Path
    work_dir: Path
    model_cache_dir: Path
    review_dir: Path
    adjudications_path: Path
    models: tuple[PipelineModel, ...]
    fusion: FusionSettings

    @property
    def index_dir(self) -> Path:
        return self.work_dir / "index"

    @property
    def base_db(self) -> Path:
        return self.index_dir / "slopo.db"

    @property
    def index_manifest(self) -> Path:
        return self.index_dir / "manifest.json"

    @property
    def embedding_state(self) -> Path:
        return self.work_dir / "embedding-state.json"

    @property
    def results_dir(self) -> Path:
        return self.work_dir / "results"

    @property
    def runs_dir(self) -> Path:
        return self.work_dir / "runs"

    def ignore_path(self, configuration: str) -> Path:
        return self.review_dir / f"{configuration}.txt"

    @property
    def discovery_configurations(self) -> tuple[str, ...]:
        return tuple(item.configuration for item in self.models if item.role == "discovery")

    @property
    def confirmation_configurations(self) -> tuple[str, ...]:
        return tuple(item.configuration for item in self.models if item.role == "confirmation")


def log(message: str) -> None:
    print(message, flush=True)


def timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def sha256_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def require_mapping(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{context} must be a mapping")
    return value


def require_exact_keys(value: Mapping[str, Any], expected: set[str], context: str) -> None:
    actual = set(value)
    if actual != expected:
        raise ValueError(
            f"{context} keys differ: missing={sorted(expected - actual)}, "
            f"unexpected={sorted(actual - expected)}"
        )


def require_string(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{context} must be a non-empty string")
    return value


def require_positive_int(value: Any, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{context} must be a positive integer")
    return value


def require_threshold(value: Any, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{context} must be a number")
    result = float(value)
    if not 0.0 < result <= 1.0:
        raise ValueError(f"{context} must be greater than zero and at most one")
    return result


def repo_path(value: Any, context: str) -> Path:
    raw = Path(require_string(value, context))
    resolved = raw.resolve() if raw.is_absolute() else (ROOT / raw).resolve()
    if resolved != ROOT and ROOT not in resolved.parents:
        raise ValueError(f"{context} must stay within {ROOT}")
    return resolved


def model_spec(family: str) -> benchmark.ModelSpec:
    matches = [item for item in benchmark.MODEL_SPECS if item.family == family]
    if len(matches) != 1:
        raise ValueError(f"Unknown model family: {family}")
    return matches[0]


def load_pipeline_settings(path: Path = DEFAULT_PIPELINE_CONFIG) -> PipelineSettings:
    config_path = path.resolve() if path.is_absolute() else (ROOT / path).resolve()
    raw = require_mapping(yaml.safe_load(config_path.read_text(encoding="utf-8")), str(config_path))
    require_exact_keys(
        raw,
        {
            "schema_version",
            "source_config",
            "work_dir",
            "model_cache_dir",
            "review_dir",
            "adjudications_file",
            "models",
            "fusion",
        },
        "pipeline config",
    )
    if raw["schema_version"] != 1:
        raise ValueError("pipeline config schema_version must be 1")

    source_config_path = repo_path(raw["source_config"], "source_config")
    source_config = load_config(source_config_path)
    source_dir = repo_path(str(source_config.source_dir), "source_dir")
    source_config = replace(source_config, source_dir=source_dir)
    work_dir = repo_path(raw["work_dir"], "work_dir")
    model_cache_dir = repo_path(raw["model_cache_dir"], "model_cache_dir")
    review_dir = repo_path(raw["review_dir"], "review_dir")
    adjudications_path = repo_path(raw["adjudications_file"], "adjudications_file")
    if work_dir == ROOT:
        raise ValueError("work_dir may not be the repository root")

    model_values = raw["models"]
    if not isinstance(model_values, list) or not model_values:
        raise ValueError("models must be a non-empty list")
    models: list[PipelineModel] = []
    for index, raw_model in enumerate(model_values):
        context = f"models[{index}]"
        value = require_mapping(raw_model, context)
        require_exact_keys(
            value,
            {
                "configuration",
                "family",
                "dimensions",
                "role",
                "similarity_threshold",
                "rerank_threshold",
            },
            context,
        )
        family = require_string(value["family"], f"{context}.family")
        spec = model_spec(family)
        dimensions = require_positive_int(value["dimensions"], f"{context}.dimensions")
        if dimensions not in spec.dimensions:
            raise ValueError(f"{context}.dimensions is not supported by {family}")
        configuration = require_string(value["configuration"], f"{context}.configuration")
        if configuration != f"{family}-{dimensions}d":
            raise ValueError(f"{context}.configuration must be {family}-{dimensions}d")
        role = require_string(value["role"], f"{context}.role")
        if role not in {"discovery", "confirmation"}:
            raise ValueError(f"{context}.role must be discovery or confirmation")
        models.append(
            PipelineModel(
                configuration=configuration,
                family=family,
                dimensions=dimensions,
                role=role,
                similarity_threshold=require_threshold(
                    value["similarity_threshold"], f"{context}.similarity_threshold"
                ),
                rerank_threshold=require_threshold(
                    value["rerank_threshold"], f"{context}.rerank_threshold"
                ),
            )
        )
    configurations = [item.configuration for item in models]
    if len(set(configurations)) != len(configurations):
        raise ValueError("model configuration names must be unique")

    raw_fusion = require_mapping(raw["fusion"], "fusion")
    require_exact_keys(
        raw_fusion,
        {
            "primary_configuration",
            "pool_size_per_configuration",
            "member_jaccard_threshold",
            "minimum_shared_members",
            "minimum_support",
            "rrf_k",
            "transitive_member_union",
        },
        "fusion",
    )
    fusion = FusionSettings(
        primary_configuration=require_string(
            raw_fusion["primary_configuration"], "fusion.primary_configuration"
        ),
        pool_size_per_configuration=require_positive_int(
            raw_fusion["pool_size_per_configuration"], "fusion.pool_size_per_configuration"
        ),
        member_jaccard_threshold=require_threshold(
            raw_fusion["member_jaccard_threshold"], "fusion.member_jaccard_threshold"
        ),
        minimum_shared_members=require_positive_int(
            raw_fusion["minimum_shared_members"], "fusion.minimum_shared_members"
        ),
        minimum_support=require_positive_int(
            raw_fusion["minimum_support"], "fusion.minimum_support"
        ),
        rrf_k=require_positive_int(raw_fusion["rrf_k"], "fusion.rrf_k"),
        transitive_member_union=raw_fusion["transitive_member_union"],
    )
    if not isinstance(fusion.transitive_member_union, bool):
        raise ValueError("fusion.transitive_member_union must be boolean")
    discovery = {item.configuration for item in models if item.role == "discovery"}
    if fusion.primary_configuration not in discovery:
        raise ValueError("fusion.primary_configuration must be a discovery model")
    if fusion.minimum_shared_members != 2:
        raise ValueError("the current fusion implementation requires minimum_shared_members: 2")
    if fusion.minimum_support != 2:
        raise ValueError("the current consensus strategy requires minimum_support: 2")
    if fusion.rrf_k != ensemble.RRF_K:
        raise ValueError(f"the current fusion implementation requires rrf_k: {ensemble.RRF_K}")
    if fusion.transitive_member_union:
        raise ValueError("transitive member union is intentionally unsupported")

    return PipelineSettings(
        config_path=config_path,
        source_config_path=source_config_path,
        source_config=source_config,
        source_dir=source_dir,
        work_dir=work_dir,
        model_cache_dir=model_cache_dir,
        review_dir=review_dir,
        adjudications_path=adjudications_path,
        models=tuple(models),
        fusion=fusion,
    )


def source_plan(settings: PipelineSettings) -> dict[str, Any]:
    return {
        "source_dir": str(settings.source_dir),
        "source_dir_exclude": settings.source_config.source_dir_exclude,
        "body_node_count_threshold": settings.source_config.body_node_count_threshold,
    }


def embedding_plan(settings: PipelineSettings) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in settings.models:
        spec = model_spec(item.family)
        result.append(
            {
                "configuration": item.configuration,
                "family": item.family,
                "dimensions": item.dimensions,
                "repo": spec.repo,
                "revision": spec.revision,
                "filename": spec.filename,
                "sha256": spec.sha256,
                "transform": spec.transform,
                "projection_filename": spec.projection_filename,
                "projection_sha256": spec.projection_sha256,
            }
        )
    return result


@contextmanager
def operational_benchmark_paths(settings: PipelineSettings) -> Iterator[None]:
    overrides = {
        "WORK": settings.work_dir,
        "RESULTS": settings.results_dir,
        "CORPUS": settings.source_dir,
        "BASE_DB": settings.base_db,
        "MODEL_CACHE": settings.model_cache_dir,
        "RUNS": settings.runs_dir,
        "NATIVE": settings.work_dir / "native",
        "LOGS": settings.work_dir / "logs",
        "ADJUDICATIONS_PATH": settings.work_dir / "no-adjudications.json",
    }
    originals = {name: getattr(benchmark, name) for name in overrides}
    try:
        for name, value in overrides.items():
            setattr(benchmark, name, value)
        benchmark.ensure_directories()
        settings.index_dir.mkdir(parents=True, exist_ok=True)
        if not benchmark.ADJUDICATIONS_PATH.exists():
            write_json(benchmark.ADJUDICATIONS_PATH, {"clusters": {}})
        yield
    finally:
        for name, value in originals.items():
            setattr(benchmark, name, value)


def database_snapshot(conn: sqlite3.Connection) -> tuple[str, dict[str, int]]:
    digest = hashlib.sha256()
    rows = conn.execute(
        """
        SELECT f.path, cu.name, cu.start_line, cu.end_line, cu.body_hash
        FROM code_units AS cu
        JOIN files AS f ON f.id = cu.file_id
        ORDER BY f.path, cu.start_line, cu.end_line, cu.name, cu.body_hash
        """
    )
    for row in rows:
        digest.update(json.dumps(row, separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    counts = {
        "files": int(conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]),
        "units": int(conn.execute("SELECT COUNT(*) FROM code_units").fetchone()[0]),
        "unique_bodies": int(
            conn.execute("SELECT COUNT(DISTINCT body_hash) FROM code_units").fetchone()[0]
        ),
    }
    return digest.hexdigest(), counts


def index_config(settings: PipelineSettings) -> Config:
    return replace(
        settings.source_config,
        source_dir=settings.source_dir,
        db_file=settings.base_db,
        report_dir=settings.index_dir / "report",
        ignore_file=settings.index_dir / "slopo.ignore.txt",
        embedding_model="pipeline/index",
        embedding_dimensions=1,
    )


def run_index_stage(settings: PipelineSettings) -> dict[str, Any]:
    settings.index_dir.mkdir(parents=True, exist_ok=True)
    plan = source_plan(settings)
    plan_sha256 = sha256_json(plan)
    prior = load_json(settings.index_manifest) if settings.index_manifest.exists() else None
    rebuild = not settings.base_db.exists() or not prior or prior.get("source_plan_sha256") != plan_sha256
    if rebuild and settings.base_db.exists():
        settings.base_db.unlink()

    cfg = index_config(settings)
    conn = create_db(cfg) if rebuild else sqlite3.connect(settings.base_db)
    try:
        log("[index] Synchronizing production source with Slopo.")
        run_index(conn, cfg, log)
        fingerprint, counts = database_snapshot(conn)
    finally:
        conn.close()
    manifest = {
        "schema_version": 1,
        "generated_at": timestamp(),
        "source_plan": plan,
        "source_plan_sha256": plan_sha256,
        "fingerprint": fingerprint,
        "counts": counts,
        "db_file": str(settings.base_db.relative_to(ROOT).as_posix()),
    }
    write_json(settings.index_manifest, manifest)
    log(
        f"[index] {counts['units']} units from {counts['files']} files; "
        f"fingerprint {fingerprint[:12]}."
    )
    return manifest


def run_embedding_stage(
    settings: PipelineSettings,
    manifest: dict[str, Any],
    *,
    use_cache: bool,
) -> dict[str, Any]:
    model_results: list[dict[str, Any]] = []
    with operational_benchmark_paths(settings):
        for item in settings.models:
            spec = model_spec(item.family)
            log(f"[embed] {item.configuration}")
            body_hashes, source_vectors, runtime = benchmark.embed_model(
                spec,
                manifest["fingerprint"],
                use_cache=use_cache,
            )
            vectors = benchmark.l2_normalize(source_vectors[:, : item.dimensions])
            db_file, _ = benchmark.write_run_database(
                spec=spec,
                dimensions=item.dimensions,
                body_hashes=body_hashes,
                vectors=vectors,
                thresholds={
                    "similarity_threshold": item.similarity_threshold,
                    "rerank_threshold": item.rerank_threshold,
                },
            )
            sync_ignore_file(settings, item.configuration, db_file.parent)
            result = {
                "configuration": item.configuration,
                "family": item.family,
                "dimensions": item.dimensions,
                "role": item.role,
                "similarity_threshold": item.similarity_threshold,
                "rerank_threshold": item.rerank_threshold,
                "adapter_steps": benchmark.required_adapter_steps(spec, item.dimensions),
                "db_file": str(db_file.relative_to(ROOT).as_posix()),
                "runtime": runtime,
            }
            write_json(db_file.parent / "pipeline.json", result)
            model_results.append(result)
    state = {
        "schema_version": 1,
        "generated_at": timestamp(),
        "index_fingerprint": manifest["fingerprint"],
        "embedding_plan": embedding_plan(settings),
        "embedding_plan_sha256": sha256_json(embedding_plan(settings)),
        "models": model_results,
    }
    write_json(settings.embedding_state, state)
    log(f"[embed] Completed {len(model_results)} model configurations.")
    return state


def load_embedding_state(
    settings: PipelineSettings, manifest: dict[str, Any]
) -> dict[str, Any]:
    if not settings.embedding_state.exists():
        raise FileNotFoundError("No embedding state exists; run the embed stage first")
    state = load_json(settings.embedding_state)
    if state.get("index_fingerprint") != manifest["fingerprint"]:
        raise ValueError("Indexed source changed after embedding; run the embed stage again")
    expected_plan = sha256_json(embedding_plan(settings))
    if state.get("embedding_plan_sha256") != expected_plan:
        raise ValueError("Embedding model plan changed; run the embed stage again")
    return state


def load_unit_matrix(db_file: Path, dimensions: int) -> tuple[list[benchmark.IndexedUnit], np.ndarray]:
    units = benchmark.load_units(db_file)
    conn = sqlite3.connect(db_file)
    try:
        by_hash = {
            str(body_hash): np.frombuffer(blob, dtype=np.float32)
            for body_hash, blob in conn.execute("SELECT body_hash, embedding FROM embeddings")
        }
    finally:
        conn.close()
    missing = sorted({item.body_hash for item in units if item.body_hash not in by_hash})
    if missing:
        raise ValueError(f"Run database is missing {len(missing)} embeddings")
    wrong = sorted({vector.size for vector in by_hash.values() if vector.size != dimensions})
    if wrong:
        raise ValueError(f"Run database has embedding dimensions {wrong}; expected {dimensions}")
    return units, np.stack([by_hash[item.body_hash] for item in units])


def sync_ignore_file(settings: PipelineSettings, configuration: str, run_dir: Path) -> Path:
    source = settings.ignore_path(configuration)
    if not source.exists():
        raise FileNotFoundError(f"Missing tracked Slopo ignore file: {source}")
    target = run_dir / "slopo.ignore.txt"
    target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    return target


def candidate_report(
    title: str,
    candidates: Sequence[dict[str, Any]],
    settings: PipelineSettings,
) -> str:
    lines = [
        f"# {title}",
        "",
        f"Generated: {timestamp()}",
        "",
        f"Candidates: {len(candidates)}. Model-cluster matching uses member Jaccard "
        f"{settings.fusion.member_jaccard_threshold:.2f}; no transitive member union is used.",
        "",
    ]
    for rank, candidate in enumerate(candidates, start=1):
        matches = ", ".join(
            f"{item['configuration']} #{item['rank']}"
            for item in sorted(candidate["matched_occurrences"], key=lambda value: value["rank"])
        )
        lines.extend(
            [
                f"## {rank}. {candidate['id']}",
                "",
                f"Support: {candidate['support_count']} model(s); {matches}.",
                "",
            ]
        )
        for member in candidate["member_details"]:
            lines.append(
                f"- `{member['path']}::{member['name']}` "
                f"lines {member['start_line']}-{member['end_line']}"
            )
        lines.append("")
    return "\n".join(lines)


def write_summary_report(
    settings: PipelineSettings,
    manifest: dict[str, Any],
    configurations: Sequence[dict[str, Any]],
    payload: dict[str, Any],
) -> None:
    consensus = payload["strategies"]["consensus_only"]
    expanded = payload["strategies"]["support_first"]
    lines = [
        "# FREE Slopo operational analysis",
        "",
        f"Generated: {timestamp()}",
        "",
        f"Indexed {manifest['counts']['units']} production code units from "
        f"{manifest['counts']['files']} files.",
        "",
        "| Configuration | Role | Dimensions | Similarity | Rerank | Clusters |",
        "|---|---|---:|---:|---:|---:|",
    ]
    model_by_name = {item.configuration: item for item in settings.models}
    for item in configurations:
        configured = model_by_name[item["configuration"]]
        lines.append(
            f"| {configured.configuration} | {configured.role} | {configured.dimensions} | "
            f"{configured.similarity_threshold:.6f} | {configured.rerank_threshold:.6f} | "
            f"{item['full_repository']['clusters']} |"
        )
    lines.extend(
        [
            "",
            "## Merged results",
            "",
            f"- [Consensus queue](consensus.md): {consensus['candidates']} candidates "
            "supported by at least two models; use this first.",
            f"- [Expanded queue](expanded.md): {expanded['candidates']} candidates, "
            "including single-model discoveries for exploratory review.",
            "",
            "Individual Slopo reports are under `../runs/<configuration>/report/`.",
            "These are review queues, not a portable precision claim; thresholds were "
            "calibrated specifically on FREE.",
            "",
        ]
    )
    (settings.results_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def run_analysis_stage(
    settings: PipelineSettings,
    manifest: dict[str, Any],
    embedding_state: dict[str, Any],
) -> dict[str, Any]:
    state_by_name = {item["configuration"]: item for item in embedding_state["models"]}
    configurations: list[dict[str, Any]] = []
    with operational_benchmark_paths(settings):
        for item in settings.models:
            log(f"[analyze] {item.configuration}")
            state = state_by_name.get(item.configuration)
            if state is None:
                raise ValueError(f"Embedding state is missing {item.configuration}")
            db_file = ROOT / state["db_file"]
            run_dir = db_file.parent
            sync_ignore_file(settings, item.configuration, run_dir)
            cfg = load_config(run_dir / "slopo.conf.yaml")
            benchmark.safe_reset_directory(cfg.report_dir)
            conn = sqlite3.connect(db_file)
            try:
                run_analyze(conn, cfg, log)
            finally:
                conn.close()

            units, matrix = load_unit_matrix(db_file, item.dimensions)
            similarities = matrix @ matrix.T
            full = benchmark.evaluate_full_clusters(
                matrix=similarities,
                units=units,
                labels={"positive_pairs": set(), "explicit_negative_pairs": set()},
                similarity_threshold=item.similarity_threshold,
                rerank_threshold=item.rerank_threshold,
            )
            configurations.append(
                {
                    "configuration": item.configuration,
                    "family": item.family,
                    "dimensions": item.dimensions,
                    "role": item.role,
                    "thresholds": {
                        "similarity_threshold": item.similarity_threshold,
                        "rerank_threshold": item.rerank_threshold,
                    },
                    "runtime": state["runtime"],
                    "full_repository": remove_evaluation_labels(full),
                }
            )

    model_summary = {
        "schema_version": 1,
        "generated_at": timestamp(),
        "corpus": {"fingerprint": manifest["fingerprint"], **manifest["counts"]},
        "configurations": configurations,
    }
    settings.results_dir.mkdir(parents=True, exist_ok=True)
    write_json(settings.results_dir / "models.json", model_summary)
    adjudications = ensemble.load_adjudications(settings.adjudications_path)
    payload = ensemble.build_ensemble(
        model_summary,
        adjudications,
        configuration_names=settings.discovery_configurations,
        confirmation_configuration_names=settings.confirmation_configurations,
        pool_size=settings.fusion.pool_size_per_configuration,
        match_jaccard=settings.fusion.member_jaccard_threshold,
        primary_configuration=settings.fusion.primary_configuration,
        exclude_adjudicated_negatives=True,
    )
    payload["pipeline"] = {
        "config": str(settings.config_path.relative_to(ROOT).as_posix()),
        "index_fingerprint": manifest["fingerprint"],
        "source_plan_sha256": manifest["source_plan_sha256"],
        "embedding_plan_sha256": embedding_state["embedding_plan_sha256"],
        "review_state_sha256": sha256_json(adjudications),
        "reviewed_negative_count": sum(
            item.get("duplicate") is False for item in adjudications.values()
        ),
    }
    write_json(settings.results_dir / "ensemble.json", payload)
    consensus = payload["strategies"]["consensus_only"]["top"]
    expanded = payload["strategies"]["support_first"]["top"]
    (settings.results_dir / "consensus.md").write_text(
        candidate_report("FREE Slopo consensus queue", consensus, settings),
        encoding="utf-8",
    )
    (settings.results_dir / "expanded.md").write_text(
        candidate_report("FREE Slopo expanded queue", expanded, settings),
        encoding="utf-8",
    )
    write_summary_report(settings, manifest, configurations, payload)
    log(
        f"[analyze] {len(consensus)} consensus and {len(expanded)} expanded candidates."
    )
    log(f"[analyze] Summary: {settings.results_dir / 'summary.md'}")
    return payload


def show_status(settings: PipelineSettings) -> None:
    print(f"Pipeline config: {settings.config_path}")
    print(f"Work directory: {settings.work_dir}")
    if settings.index_manifest.exists():
        manifest = load_json(settings.index_manifest)
        print(
            f"Index: {manifest['counts']['units']} units / {manifest['counts']['files']} files "
            f"({manifest['fingerprint'][:12]})"
        )
    else:
        print("Index: not run")
    if settings.embedding_state.exists():
        state = load_json(settings.embedding_state)
        print(f"Embeddings: {len(state.get('models', []))} configurations")
    else:
        print("Embeddings: not run")
    ensemble_path = settings.results_dir / "ensemble.json"
    if ensemble_path.exists():
        payload = load_json(ensemble_path)
        print(
            "Analysis: "
            f"{payload['strategies']['consensus_only']['candidates']} consensus / "
            f"{payload['strategies']['support_first']['candidates']} expanded"
        )
    else:
        print("Analysis: not run")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the FREE Slopo operational pipeline")
    parser.add_argument("command", choices=("index", "embed", "analyze", "all", "status"))
    parser.add_argument("--config", type=Path, default=DEFAULT_PIPELINE_CONFIG)
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Recompute native embeddings; valid with embed or all",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.no_cache and args.command not in {"embed", "all"}:
        raise ValueError("--no-cache is valid only with embed or all")
    settings = load_pipeline_settings(args.config)
    if args.command == "status":
        show_status(settings)
        return

    with operational_benchmark_paths(settings):
        manifest = run_index_stage(settings)
    if args.command == "index":
        return

    if args.command in {"embed", "all"}:
        embedding_state = run_embedding_stage(
            settings,
            manifest,
            use_cache=not args.no_cache,
        )
    else:
        embedding_state = load_embedding_state(settings, manifest)
    if args.command == "embed":
        return

    run_analysis_stage(settings, manifest, embedding_state)


if __name__ == "__main__":
    main()
