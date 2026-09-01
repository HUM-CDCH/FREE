import unittest

import numpy as np

from grounding_lab.model_benchmark import (
    DEFAULT_HELDOUT,
    _verbatim_flags,
    choose_thresholds,
    claim_text,
    scores_from_ranking,
    split_names,
)
from grounding_lab.pipeline import Anchor, Claim


def claim(value, golds=(), context=None):
    return Claim(value, ("record", 0, "field_name"), tuple(golds), context)


class QueryRenderingTest(unittest.TestCase):
    def test_bare_and_rich_inputs(self):
        item = claim("1591", context="port: Livorno")
        self.assertEqual(claim_text(item, "bare"), "1591")
        self.assertEqual(
            claim_text(item, "rich"),
            "field name: 1591 (port: Livorno)",
        )


class ListwiseMappingTest(unittest.TestCase):
    def test_ranking_is_restored_to_candidate_order(self):
        ranking = [
            {"index": 1, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.2},
        ]
        np.testing.assert_allclose(scores_from_ranking(ranking, 2), [0.2, 0.9])

    def test_missing_or_duplicate_indices_fail(self):
        with self.assertRaises(ValueError):
            scores_from_ranking([{"index": 0, "relevance_score": 0.2}], 2)
        with self.assertRaises(ValueError):
            scores_from_ranking(
                [
                    {"index": 0, "relevance_score": 0.2},
                    {"index": 0, "relevance_score": 0.9},
                ],
                2,
            )


class SplitAndCalibrationTest(unittest.TestCase):
    def test_validation_names_never_enter_dev(self):
        documents = [(name, None, []) for name in [*DEFAULT_HELDOUT, "dev-doc"]]
        self.assertEqual(split_names(documents, "dev"), {"dev-doc"})
        self.assertEqual(split_names(documents, "validation"), set(DEFAULT_HELDOUT))

    def test_thresholds_handle_model_specific_score_scale(self):
        anchors = [Anchor("gold", "1591", 1), Anchor("other", "1590", 1)]
        entries = [
            (
                "dev",
                claim("1591", ("gold",)),
                "neural",
                (anchors, np.array([8.0, 2.0]), [True, False]),
            ),
            (
                "dev",
                claim("absent"),
                "neural",
                (anchors, np.array([-3.0, -4.0]), [False, False]),
            ),
        ]
        abstain, _, metrics = choose_thresholds(entries)
        self.assertGreater(abstain, -3.0)
        self.assertLessEqual(abstain, 8.0)
        self.assertEqual(metrics["total_correct"], 2)


class ContainmentTest(unittest.TestCase):
    def test_row_context_cannot_rescue_wrong_cell(self):
        wrong = Anchor("wrong", "Livorno", 1, "Livorno | Med | 1591")
        self.assertEqual(_verbatim_flags(claim("1591"), [wrong]), [False])


if __name__ == "__main__":
    unittest.main()
