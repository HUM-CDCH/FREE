"""Fuse independently clustered Slopo model reports without merging graph edges."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Iterable, Sequence


BENCH_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BENCH_DIR / "results"
SUMMARY_PATH = RESULTS_DIR / "summary.json"
ADJUDICATIONS_PATH = BENCH_DIR / "adjudications.json"
OUTPUT_JSON = RESULTS_DIR / "ensemble-summary.json"
OUTPUT_MARKDOWN = RESULTS_DIR / "ensemble-summary.md"
REVIEW_MARKDOWN = RESULTS_DIR / "ensemble-review-candidates.md"

DEFAULT_CONFIGURATIONS = (
    "pplx-v1-0.6b-512d",
    "jina-v2-code-768d",
    "qwen3-0.6b-1024d",
)
DEFAULT_CONFIRMATION_CONFIGURATIONS = ("voyage-4-nano-512d",)
PRIMARY_CONFIGURATION = DEFAULT_CONFIGURATIONS[0]
DEFAULT_POOL_SIZE = 50
DEFAULT_MATCH_JACCARD = 0.60
RRF_K = 60
SENSITIVITY_THRESHOLDS = (0.40, 0.50, 0.60, 0.70, 0.80, 1.00)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_adjudications(path: Path = ADJUDICATIONS_PATH) -> dict[str, Any]:
    if not path.exists():
        return {}
    value = load_json(path)
    return value.get("clusters", value)


def member_ids(cluster: dict[str, Any]) -> frozenset[int]:
    return frozenset(int(member["unit_id"]) for member in cluster["members"])


def member_jaccard(first: Iterable[int], second: Iterable[int]) -> float:
    first_set = frozenset(first)
    second_set = frozenset(second)
    union = first_set | second_set
    return len(first_set & second_set) / len(union) if union else 1.0


def clusters_match(
    first: Iterable[int],
    second: Iterable[int],
    threshold: float = DEFAULT_MATCH_JACCARD,
) -> bool:
    first_set = frozenset(first)
    second_set = frozenset(second)
    return len(first_set & second_set) >= 2 and member_jaccard(
        first_set, second_set
    ) >= threshold


def selected_occurrences(
    summary: dict[str, Any],
    configuration_names: Sequence[str],
    pool_size: int,
) -> dict[str, list[dict[str, Any]]]:
    configurations = {
        item["configuration"]: item for item in summary["configurations"]
    }
    missing = [name for name in configuration_names if name not in configurations]
    if missing:
        raise ValueError(f"Configurations are missing from summary.json: {missing}")

    result: dict[str, list[dict[str, Any]]] = {}
    for name in configuration_names:
        top = configurations[name]["full_repository"]["top"][:pool_size]
        result[name] = [
            {
                "configuration": name,
                "rank": rank,
                "cluster_id": cluster["id"],
                "members": member_ids(cluster),
                "cluster": cluster,
            }
            for rank, cluster in enumerate(top, start=1)
        ]
    return result


def unique_cluster_proposals(
    occurrences_by_configuration: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    proposals: dict[str, dict[str, Any]] = {}
    for occurrences in occurrences_by_configuration.values():
        for occurrence in occurrences:
            proposal = proposals.setdefault(
                occurrence["cluster_id"],
                {
                    "id": occurrence["cluster_id"],
                    "members": occurrence["members"],
                    "cluster": occurrence["cluster"],
                    "exact_occurrences": [],
                },
            )
            if proposal["members"] != occurrence["members"]:
                raise ValueError(
                    f"Cluster ID {occurrence['cluster_id']} has inconsistent members"
                )
            proposal["exact_occurrences"].append(occurrence)
    return list(proposals.values())


def best_occurrence_match(
    anchor_members: frozenset[int],
    occurrences: Sequence[dict[str, Any]],
    match_jaccard: float,
) -> tuple[dict[str, Any], float] | None:
    matches: list[tuple[tuple[float, int, int], dict[str, Any], float]] = []
    for occurrence in occurrences:
        overlap = member_jaccard(anchor_members, occurrence["members"])
        if not clusters_match(anchor_members, occurrence["members"], match_jaccard):
            continue
        key = (
            overlap,
            -abs(len(anchor_members) - len(occurrence["members"])),
            -occurrence["rank"],
        )
        matches.append((key, occurrence, overlap))
    if not matches:
        return None
    _, occurrence, overlap = max(matches, key=lambda item: item[0])
    return occurrence, overlap


def effective_relevance(
    cluster: dict[str, Any], adjudications: dict[str, Any]
) -> tuple[bool | None, str, str | None]:
    adjudication = adjudications.get(cluster["id"])
    if adjudication is not None:
        duplicate = bool(adjudication["duplicate"])
        return (
            duplicate,
            "adjudicated_positive" if duplicate else "adjudicated_negative",
            adjudication.get("note"),
        )
    return cluster.get("relevant"), cluster.get("state", "unreviewed"), None


def enrich_proposal(
    proposal: dict[str, Any],
    occurrences_by_configuration: dict[str, list[dict[str, Any]]],
    adjudications: dict[str, Any],
    match_jaccard: float,
    primary_configuration: str,
) -> dict[str, Any]:
    matched: list[dict[str, Any]] = []
    variant_labels: set[bool] = set()
    for configuration, occurrences in occurrences_by_configuration.items():
        result = best_occurrence_match(proposal["members"], occurrences, match_jaccard)
        if result is None:
            continue
        occurrence, overlap = result
        relevance, state, _ = effective_relevance(
            occurrence["cluster"], adjudications
        )
        if relevance is not None:
            variant_labels.add(relevance)
        matched.append(
            {
                "configuration": configuration,
                "rank": occurrence["rank"],
                "cluster_id": occurrence["cluster_id"],
                "member_count": len(occurrence["members"]),
                "member_jaccard": overlap,
                "state": state,
                "relevant": relevance,
            }
        )

    relevance, state, note = effective_relevance(proposal["cluster"], adjudications)
    matched.sort(key=lambda item: item["configuration"])
    ranks = [item["rank"] for item in matched]
    return {
        "id": proposal["id"],
        "members": sorted(proposal["members"]),
        "member_details": proposal["cluster"]["members"],
        "member_count": len(proposal["members"]),
        "min_score": proposal["cluster"]["min_score"],
        "max_score": proposal["cluster"]["max_score"],
        "support_count": len(matched),
        "supporting_configurations": sorted(
            item["configuration"] for item in matched
        ),
        "primary_supported": any(
            item["configuration"] == primary_configuration for item in matched
        ),
        "rrf_score": sum(1.0 / (RRF_K + rank) for rank in ranks),
        "best_rank": min(ranks),
        "mean_rank": sum(ranks) / len(ranks),
        "matched_occurrences": matched,
        "variant_label_conflict": len(variant_labels) > 1,
        "state": state,
        "relevant": relevance,
        "adjudication_note": note,
    }


def proposal_rank_key(candidate: dict[str, Any]) -> tuple[Any, ...]:
    return (
        -candidate["support_count"],
        -candidate["rrf_score"],
        candidate["best_rank"],
        candidate["member_count"],
        candidate["id"],
    )


def deduplicate_proposals(
    proposals: Sequence[dict[str, Any]],
    match_jaccard: float,
) -> list[dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    for proposal in sorted(proposals, key=proposal_rank_key):
        if any(
            clusters_match(proposal["members"], item["members"], match_jaccard)
            for item in accepted
        ):
            continue
        accepted.append(proposal)
    return accepted


def representative_for_occurrence(
    occurrence: dict[str, Any],
    candidates: Sequence[dict[str, Any]],
    match_jaccard: float,
) -> dict[str, Any]:
    matches = [
        candidate
        for candidate in candidates
        if clusters_match(occurrence["members"], candidate["members"], match_jaccard)
    ]
    if not matches:
        raise ValueError(f"No fused representative for {occurrence['cluster_id']}")
    return max(
        matches,
        key=lambda candidate: (
            member_jaccard(occurrence["members"], candidate["members"]),
            candidate["support_count"],
            -candidate["member_count"],
            -candidate["best_rank"],
        ),
    )


def round_robin_order(
    occurrences_by_configuration: dict[str, list[dict[str, Any]]],
    candidates: Sequence[dict[str, Any]],
    configuration_order: Sequence[str],
    match_jaccard: float,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    max_rank = max(map(len, occurrences_by_configuration.values()), default=0)
    for rank_index in range(max_rank):
        for configuration in configuration_order:
            occurrences = occurrences_by_configuration[configuration]
            if rank_index >= len(occurrences):
                continue
            representative = representative_for_occurrence(
                occurrences[rank_index], candidates, match_jaccard
            )
            if representative["id"] in seen:
                continue
            seen.add(representative["id"])
            result.append(representative)
    for candidate in candidates:
        if candidate["id"] not in seen:
            result.append(candidate)
    return result


def precision_at(candidates: Sequence[dict[str, Any]], k: int) -> dict[str, Any]:
    selected = list(candidates[:k])
    reviewed = [item for item in selected if item["relevant"] is not None]
    positives = sum(item["relevant"] is True for item in selected)
    unknown = sum(item["relevant"] is None for item in selected)
    return {
        "k": k,
        "returned": len(selected),
        "reviewed": len(reviewed),
        "positives": positives,
        "unknown": unknown,
        "known_precision_lower_bound": positives / len(selected) if selected else 0.0,
        "reviewed_precision": positives / len(reviewed) if reviewed else 0.0,
        "confirmed_novel_positives": sum(
            item["relevant"] is True and not item["primary_supported"]
            for item in selected
        ),
    }


def strategy_payload(
    candidates: Sequence[dict[str, Any]],
    baseline_positives: int,
) -> dict[str, Any]:
    p20 = precision_at(candidates, 20)
    p50 = precision_at(candidates, 50)
    return {
        "candidates": len(candidates),
        "p20": p20,
        "p50": p50,
        "all": precision_at(candidates, len(candidates)),
        "confirmed_positive_delta_at_20": p20["positives"] - baseline_positives,
        "top": list(candidates),
    }


def build_ensemble(
    summary: dict[str, Any],
    adjudications: dict[str, Any],
    configuration_names: Sequence[str] = DEFAULT_CONFIGURATIONS,
    confirmation_configuration_names: Sequence[str] = (),
    pool_size: int = DEFAULT_POOL_SIZE,
    match_jaccard: float = DEFAULT_MATCH_JACCARD,
    primary_configuration: str = PRIMARY_CONFIGURATION,
    exclude_adjudicated_negatives: bool = False,
) -> dict[str, Any]:
    if primary_configuration not in configuration_names:
        raise ValueError("The primary configuration must be selected")
    all_configuration_names = tuple(
        dict.fromkeys((*configuration_names, *confirmation_configuration_names))
    )
    occurrences = selected_occurrences(summary, all_configuration_names, pool_size)
    discovery_occurrences = {
        name: occurrences[name] for name in configuration_names
    }
    proposals = [
        enrich_proposal(
            proposal,
            occurrences,
            adjudications,
            match_jaccard,
            primary_configuration,
        )
        for proposal in unique_cluster_proposals(discovery_occurrences)
    ]
    if exclude_adjudicated_negatives:
        proposals = [
            proposal
            for proposal in proposals
            if proposal["state"] != "adjudicated_negative"
            and not any(
                occurrence["state"] == "adjudicated_negative"
                for occurrence in proposal["matched_occurrences"]
            )
        ]
    fused = deduplicate_proposals(proposals, match_jaccard)
    support_first = sorted(fused, key=proposal_rank_key)
    consensus_only = [
        candidate for candidate in support_first if candidate["support_count"] >= 2
    ]
    round_robin_occurrences = discovery_occurrences
    if exclude_adjudicated_negatives:
        round_robin_occurrences = {
            name: [
                occurrence
                for occurrence in configuration_occurrences
                if any(
                    clusters_match(
                        occurrence["members"], candidate["members"], match_jaccard
                    )
                    for candidate in fused
                )
            ]
            for name, configuration_occurrences in discovery_occurrences.items()
        }
    round_robin = round_robin_order(
        round_robin_occurrences, fused, configuration_names, match_jaccard
    )

    primary_candidates: list[dict[str, Any]] = []
    for occurrence in occurrences[primary_configuration]:
        relevance, _, _ = effective_relevance(
            occurrence["cluster"], adjudications
        )
        primary_candidates.append(
            {"relevant": relevance, "primary_supported": True}
        )
    primary_p20 = precision_at(primary_candidates, 20)
    primary_p50 = precision_at(primary_candidates, 50)
    baseline_positives = primary_p20["positives"]

    return {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source_summary_generated_at": summary.get("generated_at"),
        "corpus_fingerprint": summary["corpus"]["fingerprint"],
        "configurations": list(configuration_names),
        "confirmation_configurations": list(confirmation_configuration_names),
        "primary_configuration": primary_configuration,
        "pool_size_per_configuration": pool_size,
        "matching": {
            "member_jaccard_threshold": match_jaccard,
            "minimum_shared_members": 2,
            "transitive_member_union": False,
            "rrf_k": RRF_K,
        },
        "input": {
            "occurrences": sum(map(len, occurrences.values())),
            "discovery_occurrences": sum(
                len(occurrences[name]) for name in configuration_names
            ),
            "confirmation_occurrences": sum(
                len(occurrences[name]) for name in confirmation_configuration_names
            ),
            "unique_discovery_cluster_ids": len(
                unique_cluster_proposals(discovery_occurrences)
            ),
            "fused_representatives": len(fused),
            "variant_label_conflicts": sum(
                candidate["variant_label_conflict"] for candidate in fused
            ),
            "support_distribution": {
                str(support): sum(
                    candidate["support_count"] == support for candidate in fused
                )
                for support in range(1, len(all_configuration_names) + 1)
            },
        },
        "baseline": {
            "configuration": primary_configuration,
            "p20": primary_p20,
            "p50": primary_p50,
        },
        "recommended_strategy": "consensus_only",
        "exploration_strategy": "support_first",
        "strategies": {
            "consensus_only": strategy_payload(
                consensus_only, baseline_positives
            ),
            "support_first": strategy_payload(support_first, baseline_positives),
            "round_robin_union": strategy_payload(round_robin, baseline_positives),
        },
    }


def percentage(value: float) -> str:
    return f"{value * 100:.1f}%"


def build_sensitivity(
    summary: dict[str, Any],
    adjudications: dict[str, Any],
    configuration_names: Sequence[str],
    confirmation_configuration_names: Sequence[str],
    pool_size: int,
    primary_configuration: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for threshold in SENSITIVITY_THRESHOLDS:
        candidate = build_ensemble(
            summary,
            adjudications,
            configuration_names=configuration_names,
            confirmation_configuration_names=confirmation_configuration_names,
            pool_size=pool_size,
            match_jaccard=threshold,
            primary_configuration=primary_configuration,
        )
        consensus = candidate["strategies"]["consensus_only"]
        expanded = candidate["strategies"]["support_first"]
        rows.append(
            {
                "member_jaccard_threshold": threshold,
                "fused_representatives": candidate["input"][
                    "fused_representatives"
                ],
                "consensus_candidates": consensus["candidates"],
                "consensus_p20": consensus["p20"],
                "consensus_all": consensus["all"],
                "expanded_all": expanded["all"],
            }
        )
    return rows


def write_review_candidates(payload: dict[str, Any]) -> None:
    appearances: dict[str, dict[str, Any]] = {}
    for strategy_name, strategy in payload["strategies"].items():
        for rank, candidate in enumerate(strategy["top"], start=1):
            if candidate["relevant"] is not None:
                continue
            entry = appearances.setdefault(
                candidate["id"],
                {"candidate": candidate, "strategies": []},
            )
            entry["strategies"].append((strategy_name, rank))

    ordered = sorted(
        appearances.values(),
        key=lambda item: min(rank for _, rank in item["strategies"]),
    )
    lines = [
        "# Ensemble cluster review candidates",
        "",
        "Only unreviewed candidates are listed. Decisions use the shared "
        "`../adjudications.json` file; rerun `ensemble.py` after adding or changing a "
        "decision.",
        "",
    ]
    if not ordered:
        lines.extend(["All fused candidates are reviewed.", ""])
    for entry in ordered:
        candidate = entry["candidate"]
        strategy_text = ", ".join(
            f"{name} #{rank}" for name, rank in sorted(entry["strategies"])
        )
        support_text = ", ".join(
            f"{item['configuration']} #{item['rank']} "
            f"({item['member_jaccard']:.2f} overlap)"
            for item in candidate["matched_occurrences"]
        )
        lines.extend(
            [
                f"## {candidate['id']} -- {candidate['state']}",
                "",
                f"Strategies: {strategy_text}",
                "",
                f"Model support: {support_text}",
                "",
            ]
        )
        if candidate["variant_label_conflict"]:
            lines.extend(["**Variant labels conflict. Review this representative.**", ""])
        for member in candidate["member_details"]:
            lines.append(
                f"- `{member['path']}::{member['name']}` "
                f"lines {member['start_line']}-{member['end_line']}"
            )
        lines.append("")
    REVIEW_MARKDOWN.write_text("\n".join(lines), encoding="utf-8")


def write_markdown(payload: dict[str, Any]) -> None:
    baseline_p20 = payload["baseline"]["p20"]
    baseline_p50 = payload["baseline"]["p50"]
    consensus = payload["strategies"]["consensus_only"]
    expanded = payload["strategies"]["support_first"]
    marginal_candidates = expanded["candidates"] - consensus["candidates"]
    marginal_positives = expanded["all"]["positives"] - consensus["all"]["positives"]
    marginal_precision = (
        marginal_positives / marginal_candidates if marginal_candidates else 0.0
    )
    lines = [
        "# Slopo late-fusion ensemble benchmark",
        "",
        f"Corpus fingerprint: `{payload['corpus_fingerprint']}`",
        "",
        "Discovery models: "
        + ", ".join(f"`{name}`" for name in payload["configurations"]),
        "",
        "Confirmation-only models: "
        + (
            ", ".join(
                f"`{name}`" for name in payload["confirmation_configurations"]
            )
            or "none"
        ),
        "",
        f"The input contains {payload['input']['discovery_occurrences']} discovery "
        f"occurrences plus {payload['input']['confirmation_occurrences']} confirmation-only "
        f"occurrences, {payload['input']['unique_discovery_cluster_ids']} unique discovery "
        "cluster IDs, and "
        f"{payload['input']['fused_representatives']} non-transitively deduplicated "
        "representatives.",
        "",
        "Clusters are produced independently by each model. Fusion matches cluster member "
        "sets at Jaccard >= "
        f"{payload['matching']['member_jaccard_threshold']:.2f}, keeps one representative, "
        "and never unions cross-model similarity edges or members transitively.",
        "",
        f"Matched variants have {payload['input']['variant_label_conflicts']} manual-label "
        "conflicts. Labels are used only to evaluate the final ranking, never to form or "
        "rank it; metrics score the retained representative rather than a broader matched "
        "variant.",
        "",
        "## Results",
        "",
        f"Single-model baseline: `{payload['primary_configuration']}` with "
        f"{baseline_p20['positives']}/{baseline_p20['returned']} positives at 20 "
        f"({percentage(baseline_p20['reviewed_precision'])}) and "
        f"{baseline_p50['positives']}/{baseline_p50['returned']} at 50 "
        f"({percentage(baseline_p50['reviewed_precision'])}).",
        "",
        "| Strategy | Candidates | Positives@20 | Unknown@20 | Reviewed P@20 | Delta vs baseline | Novel positives@20 | Positives@50 | Unknown@50 | Total positives | Total unknown | Total reviewed P | Novel positives total |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, strategy in payload["strategies"].items():
        p20 = strategy["p20"]
        p50 = strategy["p50"]
        all_metrics = strategy["all"]
        lines.append(
            f"| {name} | {strategy['candidates']} | {p20['positives']} | "
            f"{p20['unknown']} | {percentage(p20['reviewed_precision'])} | "
            f"{strategy['confirmed_positive_delta_at_20']:+d} | "
            f"{p20['confirmed_novel_positives']} | "
            f"{p50['positives']} | {p50['unknown']} | "
            f"{all_metrics['positives']} | {all_metrics['unknown']} | "
            f"{percentage(all_metrics['reviewed_precision'])} | "
            f"{all_metrics['confirmed_novel_positives']} |"
        )

    distribution = payload["input"]["support_distribution"]
    model_count = len(payload["configurations"]) + len(
        payload["confirmation_configurations"]
    )
    lines.extend(
        [
            "",
            "## Candidate support",
            "",
            *[
                f"- {support}-model support: {distribution.get(str(support), 0)} representatives."
                for support in range(model_count, 1, -1)
            ],
            f"- Single-model discoveries: {distribution.get('1', 0)} representatives.",
            "",
            "`consensus_only` is the precision lane. `support_first` retains all candidates "
            "but ranks agreement before single-model findings. `round_robin_union` deliberately "
            "interleaves model-specific discoveries to maximize diversity at a fixed review "
            "budget.",
            "",
            "## Recommendation",
            "",
            f"Use `consensus_only` by default. It raises P@20 from "
            f"{baseline_p20['positives']}/{baseline_p20['returned']} to "
            f"{consensus['p20']['positives']}/{consensus['p20']['returned']}, raises the "
            f"first-50 yield from {baseline_p50['positives']} to "
            f"{consensus['p50']['positives']}, and returns "
            f"{consensus['all']['positives']}/{consensus['all']['returned']} confirmed "
            f"clusters ({percentage(consensus['all']['reviewed_precision'])}). "
            f"Of those, {consensus['all']['confirmed_novel_positives']} are confirmed "
            "positives with no matching cluster in the primary model's top 50.",
            "",
            f"Use `support_first` as an optional exploration tail when finding more "
            f"clusters matters more than review efficiency. It increases the confirmed "
            f"pool from {consensus['all']['positives']} to "
            f"{expanded['all']['positives']}, but the {marginal_candidates} additional "
            f"candidates contain only {marginal_positives} positives "
            f"({percentage(marginal_precision)} marginal precision); the full lane is "
            f"{expanded['all']['positives']}/{expanded['all']['returned']} "
            f"({percentage(expanded['all']['reviewed_precision'])}).",
            "",
            "`round_robin_union` is retained as a diversity-oriented negative control; it "
            "finds the same final set as `support_first` but ranks substantially fewer true "
            "clusters into the first 20 and 50 review slots.",
            "",
            "Novel means a confirmed positive whose member set has no match in the primary "
            "pplx top-50 pool at the selected cutoff. Voyage can add support to a discovery "
            "but cannot introduce a candidate by itself.",
            "",
            "`ensemble-review-candidates.md` is regenerated with any unreviewed fused "
            "representatives; the selected 0.60 run currently has none.",
            "",
        ]
    )
    sensitivity = payload.get("sensitivity", [])
    if sensitivity:
        lines.extend(
            [
                "",
                "## Match-cutoff sensitivity",
                "",
                "The 0.60 cutoff is the strongest fully reviewed precision/yield point on "
                "this repository. This sweep uses the same adjudications as the reported "
                "ensemble, so it is diagnostic rather than an independent test.",
                "",
                "| Member Jaccard | Representatives | Consensus candidates | Positives@20 | Consensus positives | Consensus unknown | Expanded positives |",
                "|---:|---:|---:|---:|---:|---:|---:|",
            ]
        )
        for row in sensitivity:
            lines.append(
                f"| {row['member_jaccard_threshold']:.2f} | "
                f"{row['fused_representatives']} | {row['consensus_candidates']} | "
                f"{row['consensus_p20']['positives']} | "
                f"{row['consensus_all']['positives']}/{row['consensus_all']['returned']} | "
                f"{row['consensus_all']['unknown']} | "
                f"{row['expanded_all']['positives']}/{row['expanded_all']['returned']} |"
            )
    OUTPUT_MARKDOWN.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fuse ranked clusters from multiple Slopo embedding configurations"
    )
    parser.add_argument("--summary", type=Path, default=SUMMARY_PATH)
    parser.add_argument("--adjudications", type=Path, default=ADJUDICATIONS_PATH)
    parser.add_argument("--pool-size", type=int, default=DEFAULT_POOL_SIZE)
    parser.add_argument(
        "--match-jaccard", type=float, default=DEFAULT_MATCH_JACCARD
    )
    parser.add_argument(
        "--confirmation-configuration",
        action="append",
        dest="confirmation_configurations",
        help="Configuration that may confirm discoveries but cannot introduce candidates.",
    )
    parser.add_argument(
        "--configuration",
        action="append",
        dest="configurations",
        help="Configuration to include, in round-robin order; may be repeated.",
    )
    parser.add_argument("--primary", default=PRIMARY_CONFIGURATION)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    configurations = tuple(args.configurations or DEFAULT_CONFIGURATIONS)
    confirmation_configurations = tuple(
        args.confirmation_configurations or DEFAULT_CONFIRMATION_CONFIGURATIONS
    )
    summary = load_json(args.summary)
    adjudications = load_adjudications(args.adjudications)
    payload = build_ensemble(
        summary,
        adjudications,
        configuration_names=configurations,
        confirmation_configuration_names=confirmation_configurations,
        pool_size=args.pool_size,
        match_jaccard=args.match_jaccard,
        primary_configuration=args.primary,
    )
    payload["sensitivity"] = build_sensitivity(
        summary,
        adjudications,
        configurations,
        confirmation_configurations,
        args.pool_size,
        args.primary,
    )
    OUTPUT_JSON.write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
    write_markdown(payload)
    write_review_candidates(payload)
    print(f"Ensemble summary written to {OUTPUT_MARKDOWN}")


if __name__ == "__main__":
    main()
