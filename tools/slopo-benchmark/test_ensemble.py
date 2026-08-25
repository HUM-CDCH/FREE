from __future__ import annotations

import unittest

from ensemble import (
    build_ensemble,
    clusters_match,
    deduplicate_proposals,
    member_jaccard,
    precision_at,
)


def cluster(
    cluster_id: str,
    members: list[int],
    relevant: bool | None,
) -> dict:
    return {
        "id": cluster_id,
        "min_score": 0.9,
        "max_score": 1.0,
        "state": "known" if relevant is not None else "unreviewed",
        "relevant": relevant,
        "members": [
            {
                "unit_id": unit_id,
                "path": f"source/{unit_id}.py",
                "name": f"unit_{unit_id}",
                "start_line": 1,
                "end_line": 2,
            }
            for unit_id in members
        ],
    }


def configuration(name: str, clusters: list[dict]) -> dict:
    positives = sum(item["relevant"] is True for item in clusters)
    return {
        "configuration": name,
        "full_repository": {
            "top": clusters,
            "p20": {
                "returned": len(clusters),
                "known_precision_lower_bound": positives / len(clusters),
                "reviewed_precision": positives / len(clusters),
            },
            "p50": {},
        },
    }


class EnsembleTest(unittest.TestCase):
    def test_member_matching_uses_jaccard_and_two_shared_members(self) -> None:
        self.assertAlmostEqual(member_jaccard({1, 2}, {1, 2, 3}), 2 / 3)
        self.assertTrue(clusters_match({1, 2}, {1, 2, 3}, 0.5))
        self.assertFalse(clusters_match({1, 2}, {2, 3}, 0.5))
        self.assertFalse(clusters_match({1, 2}, {1, 2, 3, 4, 5}, 0.5))

    def test_deduplication_does_not_apply_transitive_union(self) -> None:
        def proposal(identifier: str, members: list[int]) -> dict:
            return {
                "id": identifier,
                "members": members,
                "support_count": 1,
                "rrf_score": 0.1,
                "best_rank": 1,
                "member_count": len(members),
            }

        accepted = deduplicate_proposals(
            [
                proposal("a", [1, 2]),
                proposal("b", [1, 2, 3]),
                proposal("c", [2, 3]),
            ],
            0.5,
        )
        self.assertEqual([item["id"] for item in accepted], ["a", "c"])

    def test_build_ensemble_fuses_support_and_preserves_novel_candidates(self) -> None:
        names = ("primary", "second", "third")
        summary = {
            "generated_at": "2026-01-01T00:00:00+0000",
            "corpus": {"fingerprint": "fixture"},
            "configurations": [
                configuration(
                    "primary",
                    [cluster("core-a", [1, 2], True), cluster("novel-a", [4, 5], True)],
                ),
                configuration(
                    "second",
                    [cluster("core-b", [1, 2, 3], True), cluster("novel-b", [6, 7], False)],
                ),
                configuration(
                    "third",
                    [cluster("core-a", [1, 2], True), cluster("novel-c", [8, 9], None)],
                ),
                configuration(
                    "confirm",
                    [
                        cluster("core-confirm", [1, 2], True),
                        cluster("confirm-only", [10, 11], True),
                    ],
                ),
            ],
        }

        result = build_ensemble(
            summary,
            {},
            configuration_names=names,
            confirmation_configuration_names=("confirm",),
            pool_size=2,
            match_jaccard=0.5,
            primary_configuration="primary",
        )

        self.assertEqual(result["input"]["occurrences"], 8)
        self.assertEqual(result["input"]["fused_representatives"], 4)
        self.assertEqual(
            result["input"]["support_distribution"],
            {"1": 3, "2": 0, "3": 0, "4": 1},
        )
        consensus = result["strategies"]["consensus_only"]
        self.assertEqual(consensus["candidates"], 1)
        self.assertEqual(consensus["top"][0]["support_count"], 4)
        self.assertNotIn(
            "confirm-only",
            {item["id"] for item in result["strategies"]["support_first"]["top"]},
        )
        round_robin = result["strategies"]["round_robin_union"]["top"]
        self.assertEqual(
            [item["id"] for item in round_robin[:4]],
            ["core-a", "novel-a", "novel-b", "novel-c"],
        )

    def test_operational_filter_excludes_adjudicated_negative_variants(self) -> None:
        summary = {
            "generated_at": "2026-01-01T00:00:00+0000",
            "corpus": {"fingerprint": "fixture"},
            "configurations": [
                configuration("primary", [cluster("same-a", [1, 2], None)]),
                configuration("second", [cluster("same-b", [1, 2, 3], None)]),
            ],
        }
        arguments = {
            "configuration_names": ("primary", "second"),
            "pool_size": 1,
            "match_jaccard": 0.5,
            "primary_configuration": "primary",
        }

        benchmark_result = build_ensemble(
            summary, {"same-b": {"duplicate": False}}, **arguments
        )
        operational_result = build_ensemble(
            summary,
            {"same-b": {"duplicate": False}},
            exclude_adjudicated_negatives=True,
            **arguments,
        )

        self.assertEqual(
            1, benchmark_result["strategies"]["consensus_only"]["candidates"]
        )
        self.assertEqual(
            0, operational_result["strategies"]["consensus_only"]["candidates"]
        )
        self.assertEqual(0, operational_result["input"]["fused_representatives"])

    def test_precision_tracks_unknown_and_primary_novelty(self) -> None:
        candidates = [
            {"relevant": True, "primary_supported": True},
            {"relevant": True, "primary_supported": False},
            {"relevant": False, "primary_supported": False},
            {"relevant": None, "primary_supported": False},
        ]
        metrics = precision_at(candidates, 20)
        self.assertEqual(metrics["positives"], 2)
        self.assertEqual(metrics["unknown"], 1)
        self.assertEqual(metrics["reviewed"], 3)
        self.assertEqual(metrics["confirmed_novel_positives"], 1)
        self.assertAlmostEqual(metrics["known_precision_lower_bound"], 0.5)


if __name__ == "__main__":
    unittest.main()
