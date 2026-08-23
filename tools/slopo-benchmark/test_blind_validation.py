from __future__ import annotations

import copy
import unittest

from blind_validation import (
    acceptance_status,
    remove_evaluation_labels,
    select_review_clusters,
    verify_frozen_model_runtime,
)


def member(unit_id: int) -> dict:
    return {
        "unit_id": unit_id,
        "path": f"slopo/{unit_id}.py",
        "name": f"unit_{unit_id}",
        "start_line": 1,
        "end_line": 2,
    }


class BlindValidationTest(unittest.TestCase):
    def test_review_queue_is_stable_union_without_ranking_metadata(self) -> None:
        model_summary = {
            "configurations": [
                {
                    "configuration": "pplx-v1-0.6b-512d",
                    "full_repository": {
                        "top": [
                            {"id": "baseline-a", "members": [member(1), member(2)]},
                            {"id": "shared", "members": [member(3), member(4)]},
                        ]
                    },
                }
            ]
        }
        ensemble_payload = {
            "strategies": {
                "consensus_only": {
                    "top": [
                        {
                            "id": "shared",
                            "member_details": [member(3), member(4)],
                        },
                        {
                            "id": "consensus-b",
                            "member_details": [member(5), member(6)],
                        },
                    ]
                }
            }
        }

        first = select_review_clusters(
            model_summary, ensemble_payload, limit=2, seed="frozen"
        )
        second = select_review_clusters(
            model_summary, ensemble_payload, limit=2, seed="frozen"
        )

        self.assertEqual(first, second)
        self.assertEqual(
            {item["cluster_id"] for item in first},
            {"baseline-a", "shared", "consensus-b"},
        )
        self.assertTrue(
            all(set(item) == {"cluster_id", "members"} for item in first)
        )

    def test_acceptance_requires_twenty_completed_consensus_reviews(self) -> None:
        passing = {
            "returned": 20,
            "reviewed": 20,
            "unknown": 0,
            "reviewed_precision": 0.90,
        }
        self.assertEqual(acceptance_status(passing, 20), "pass")
        self.assertEqual(acceptance_status({**passing, "reviewed_precision": 0.85}, 20), "fail")
        self.assertEqual(
            acceptance_status({**passing, "reviewed": 19, "unknown": 1}, 20),
            "incomplete",
        )
        self.assertEqual(acceptance_status(passing, 19), "inconclusive")

    def test_model_output_is_stripped_of_pre_review_labels(self) -> None:
        full = {
            "top": [
                {"id": "exact", "relevant": True, "state": "known_positive"},
                {"id": "unknown", "relevant": None, "state": "unreviewed"},
            ],
            "p20": {"returned": 2, "reviewed": 1, "unknown": 1},
            "p50": {"returned": 2, "reviewed": 1, "unknown": 1},
        }

        stripped = remove_evaluation_labels(copy.deepcopy(full))

        self.assertTrue(all(item["relevant"] is None for item in stripped["top"]))
        self.assertTrue(all(item["state"] == "unreviewed" for item in stripped["top"]))
        self.assertEqual(stripped["p20"]["reviewed"], 0)
        self.assertEqual(stripped["p20"]["unknown"], 2)

    def test_frozen_model_artifacts_are_enforced(self) -> None:
        frozen = {
            "model_repo": "owner/model",
            "model_revision": "abc123",
            "model_filename": "model.gguf",
        }
        verify_frozen_model_runtime(
            frozen,
            {
                "repo": "owner/model",
                "revision": "abc123",
                "filename": "model.gguf",
            },
        )
        with self.assertRaisesRegex(ValueError, "frozen configuration"):
            verify_frozen_model_runtime(
                frozen,
                {
                    "repo": "owner/model",
                    "revision": "changed",
                    "filename": "model.gguf",
                },
            )


if __name__ == "__main__":
    unittest.main()
