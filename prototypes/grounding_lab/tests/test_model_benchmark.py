import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from grounding_lab.model_benchmark import (
    CONTAINMENT_CAP,
    _candidate_labels,
    _candidates,
    _evaluation_metrics,
    _score_entries,
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

    def test_rich_hitset_is_rich_only_inside_the_hit_set(self):
        item = Claim("$83,730", ("medianHouseholdIncome2024",), ("a",), context="year: 2024")
        self.assertEqual(claim_text(item, "rich-hitset"), "$83,730")
        self.assertNotIn("year: 2024", claim_text(item, "rich-hitset", in_hitset=True))
        self.assertEqual(
            claim_text(item, "rich-hitset", in_hitset=True),
            "median Household Income 2024: $83,730",
        )


class CandidateLabelsTest(unittest.TestCase):
    def test_hitset_does_not_claim_a_k_limit(self):
        args = SimpleNamespace(candidates="hitset", zero_hit="abstain", k=2)
        self.assertEqual(_candidate_labels(args), ("all lexical hits", "hit-set recall"))


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
        abstain, accept, metrics = choose_thresholds(entries)
        self.assertGreater(abstain, -3.0)
        self.assertLessEqual(abstain, 8.0)
        self.assertEqual(metrics["total_correct"], 2)
        self.assertGreater(accept, CONTAINMENT_CAP)

    def test_accept_threshold_stays_above_containment_cap(self):
        anchors = [Anchor("gold", "1591", 1), Anchor("other", "1590", 1)]
        # Every dev margin is tiny and correct: the sweep would otherwise pick
        # an accept gate below the cap and auto-accept capped links downstream.
        entries = [
            ("dev", claim("1591", ("gold",)), "neural",
             (anchors, np.array([8.0, 7.9]), [True, False])),
        ]
        _, accept, _ = choose_thresholds(entries)
        self.assertGreater(accept, CONTAINMENT_CAP)

    def test_rerank_metrics_report_fallback_recall(self):
        anchors = [Anchor("gold", "1591", 1), Anchor("other", "1590", 1)]
        entries = [
            (
                "doc",
                claim("1591", ("gold",)),
                "neural",
                (anchors, np.array([8.0, 2.0]), [True, False]),
            ),
            (
                "doc",
                claim("1600", ("missing",)),
                "neural",
                (anchors, np.array([2.0, 1.0]), [False, False]),
            ),
            ("doc", claim("exact", ("gold",)), "lexical", "gold"),
            (
                "doc",
                claim("absent"),
                "neural",
                (anchors, np.array([0.0, -1.0]), [False, False]),
            ),
        ]
        metrics = _evaluation_metrics(entries, {"doc"}, 0.0, 1.0, [])
        self.assertEqual((metrics["recall_at_k"], metrics["recall_total"]), (1, 2))

    def test_k_caps_dense_candidates_but_not_hitset_evaluation(self):
        anchors = [
            Anchor("first", "1591", 1),
            Anchor("second", "1591", 1),
            Anchor("gold", "1591", 1),
        ]
        index = type("Index", (), {"anchors": anchors})()
        with (
            patch("grounding_lab.model_benchmark._encode", return_value=None),
            patch(
                "grounding_lab.model_benchmark._similarities",
                return_value=np.array([0.1, 0.2, 0.9]),
            ),
        ):
            dense = _candidates(
                [], index, object(), object(), object(), "1591", 2, "retrieval"
            )
        self.assertEqual([anchor.anchor_id for anchor in dense], ["gold", "second"])

        entries = [
            (
                "doc",
                claim("1591", ("gold",)),
                "neural",
                (anchors, np.array([0.1, 0.2, 0.9]), [True, True, True]),
            ),
            (
                "doc",
                claim("absent"),
                "neural",
                (anchors, np.array([0.1, 0.2, 0.8]), [False, False, False]),
            ),
        ]
        metrics = _evaluation_metrics(entries, {"doc"}, 0.0, 1.0, [])
        self.assertEqual(metrics["correct_links"], 1)
        self.assertEqual(metrics["recall_at_k"], 1)
        abstain, _, calibrated = choose_thresholds(entries)
        self.assertGreater(abstain, 0.8)
        self.assertLessEqual(abstain, 0.9)
        self.assertEqual(calibrated["total_correct"], 2)


class ContainmentTest(unittest.TestCase):
    def test_row_context_cannot_rescue_wrong_cell(self):
        wrong = Anchor("wrong", "Livorno", 1, "Livorno | Med | 1591")
        self.assertEqual(_verbatim_flags(claim("1591"), [wrong]), [False])

    def test_boolean_verbatim_check_is_exact(self):
        anchors = [Anchor("right", "true", 1), Anchor("wrong", "false", 1)]
        self.assertEqual(_verbatim_flags(claim(True), anchors), [True, False])


if __name__ == "__main__":
    unittest.main()


class HitSetCandidatesTest(unittest.TestCase):
    def test_multi_hit_reranks_inside_hit_set_and_never_retrieves(self):
        class Index:
            anchors = [
                Anchor("a", "income $83,730 in 2024", 1),
                Anchor("b", "income $83,730 in 2023", 1),
                Anchor("c", "unrelated", 1),
            ]

        def boom(*_, **__):
            raise AssertionError("dense retrieval must not run for a multi-hit claim")

        shortlist = _candidates(Index.anchors[:2], Index(), boom, None, None, "$83,730", 30, "hitset")
        self.assertEqual([a.anchor_id for a in shortlist], ["a", "b"])


class ZeroHitAbstainTest(unittest.TestCase):
    def test_zero_hit_abstains_without_neural_pass(self):
        class Index:
            anchors = [Anchor("a", "income $83,730", 1), Anchor("b", "income $82,690", 1)]

        def boom(*_, **__):
            raise AssertionError("no model may run for a zero-hit claim")

        import grounding_lab.model_benchmark as mb

        original = mb._encode
        mb._encode = boom  # hitset + abstain must not embed documents either
        try:
            entries, latencies = _score_entries(
                [("doc", Index(), [claim("$83,741", ("a",)), claim("nowhere")])],
                None, None, boom, None, "bare", 30, "hitset", "abstain",
            )
        finally:
            mb._encode = original
        self.assertEqual([e[2] for e in entries], ["abstain", "abstain"])
        self.assertEqual([t[1] for t in latencies], ["lexical", "lexical"])
        metrics = _evaluation_metrics(entries, {"doc"}, 0.0, 1.0, latencies)
        self.assertEqual(
            (metrics["correct_abstains"], metrics["wrong"], metrics["correct_links"], metrics["auto"]),
            (1, 0, 0, 0),
        )


class CrossValidationTests(unittest.TestCase):
    def test_folds_partition_documents_and_pooled_counts_sum_folds(self):
        from grounding_lab.model_benchmark import cv_evaluate, cv_folds
        from grounding_lab.pipeline import Claim

        names = ["f", "b", "d", "a", "e", "c"]
        folds = cv_folds(names, 3)
        self.assertEqual(sorted(sum(folds, [])), sorted(names))
        self.assertEqual([len(fold) for fold in folds], [2, 2, 2])
        entries = []
        for name in names:
            entries.append((name, Claim("1", ("x",), ("g",)), "lexical", "g"))
            entries.append((name, Claim("2", ("y",), ("g",)), "lexical", "wrong"))
            entries.append((name, Claim("3", ("z",), ()), "abstain", None))
        rows, pooled = cv_evaluate(entries, [], folds)
        self.assertEqual(len(rows), 3)
        self.assertEqual(pooled["total_correct"], sum(r[3]["total_correct"] for r in rows))
        self.assertEqual(pooled["total_correct"], 12)
        self.assertEqual(pooled["wrong"], 6)
        self.assertEqual(pooled["linkable"] + pooled["abstains_due"], 18)
