import json
import math
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from grounding_lab.model_benchmark import (
    CONTAINMENT_CAP,
    _candidate_labels,
    _candidates,
    _encode,
    _evaluation_metrics,
    _rerank_scores,
    _score_entries,
    _verification_entries,
    _verify_scores,
    DEFAULT_HELDOUT,
    RETRIEVERS,
    RERANKERS,
    VERIFIERS,
    _verbatim_flags,
    choose_thresholds,
    claim_text,
    scores_from_ranking,
    split_names,
    verifier_claim_text,
)
from grounding_lab.calibrate import evaluate
from grounding_lab.harness import load_dataset
from grounding_lab.pipeline import Anchor, Claim, lexical_candidates


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
        self.assertEqual(
            claim_text(item, "rich-hitset", in_hitset=True),
            "median Household Income 2024: $83,730 (year: 2024)",
        )

    def test_verifier_gets_one_grammatical_claim_sentence(self):
        self.assertEqual(
            verifier_claim_text(claim("Poul Kragh", context="site: Herredsvejen")),
            "The field name is Poul Kragh (site: Herredsvejen).",
        )


class CandidateLabelsTest(unittest.TestCase):
    def test_hitset_does_not_claim_a_k_limit(self):
        args = SimpleNamespace(candidates="hitset", zero_hit="abstain", k=2)
        self.assertEqual(_candidate_labels(args), ("all lexical hits", "hit-set recall"))


class MultiVectorRetrieverTest(unittest.TestCase):
    def test_liquid_colbert_uses_the_multi_vector_api(self):
        calls = []

        class Model:
            def encode_query(self, texts, **kwargs):
                calls.append(("query", texts, kwargs))
                return "query embeddings"

            def encode_document(self, texts, **kwargs):
                calls.append(("document", texts, kwargs))
                return "document embeddings"

        spec = RETRIEVERS["lfm-colbert-350m"]
        self.assertEqual(
            spec.revision, "9772bdf797255d8693b83e84aa98e9b2d36dd0be"
        )
        self.assertEqual(_encode(Model(), spec, ["q"], query=True), "query embeddings")
        self.assertEqual(_encode(Model(), spec, ["d"], query=False), "document embeddings")
        self.assertEqual([call[0] for call in calls], ["query", "document"])


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


class NemotronRerankerTest(unittest.TestCase):
    def test_uses_required_prompt_template_and_batching(self):
        seen = []

        class Batch(dict):
            def to(self, _device):
                return self

        class Tokenizer:
            def __call__(self, texts, **kwargs):
                seen.append((texts, kwargs))
                return Batch()

        class Logits:
            def view(self, *_args):
                return self

            def float(self):
                return self

            def cpu(self):
                return self

            def tolist(self):
                return [float(len(seen))] * len(seen[-1][0])

        class Classifier:
            device = "cpu"

            def __call__(self, **_inputs):
                return SimpleNamespace(logits=Logits())

        spec = RERANKERS["nemotron-1b"]
        with patch("grounding_lab.model_benchmark._torch") as torch:
            torch.return_value.inference_mode.return_value.__enter__ = lambda *_: None
            torch.return_value.inference_mode.return_value.__exit__ = lambda *_: None
            scores = _rerank_scores(
                (Tokenizer(), Classifier()), spec, "the query", [str(i) for i in range(9)]
            )

        self.assertEqual([len(texts) for texts, _ in seen], [8, 1])
        self.assertEqual(seen[0][0][0], "question:the query \n \n passage:0")
        self.assertEqual(seen[0][1]["max_length"], 512)
        np.testing.assert_allclose(scores, [1.0] * 8 + [2.0])


class MiniCheckVerifierTest(unittest.TestCase):
    def test_uses_document_claim_order_and_support_probability(self):
        seen = []

        class Batch(dict):
            def to(self, _device):
                return self

        class Tokenizer:
            eos_token = "[SEP]"

            def __call__(self, texts, **kwargs):
                seen.append((texts, kwargs))
                return Batch()

        class Probabilities:
            def __getitem__(self, key):
                self.key = key
                return self

            def cpu(self):
                return self

            def tolist(self):
                return [0.9] * len(seen[-1][0])

        class Logits:
            def float(self):
                return self

            def softmax(self, *, dim):
                self.dim = dim
                return Probabilities()

        class Classifier:
            device = "cpu"

            def __call__(self, **_inputs):
                return SimpleNamespace(logits=Logits())

        spec = VERIFIERS["minicheck-deberta-large"]
        self.assertEqual(
            spec.revision, "2f2d01a54fa022a7ffadb76260e1ea8bc88c82bb"
        )
        with patch("grounding_lab.model_benchmark._torch") as torch:
            torch.return_value.inference_mode.return_value.__enter__ = lambda *_: None
            torch.return_value.inference_mode.return_value.__exit__ = lambda *_: None
            scores = _verify_scores(
                (Tokenizer(), Classifier()), spec, "the claim", ["evidence"] * 9
            )

        self.assertEqual([len(texts) for texts, _ in seen], [8, 1])
        self.assertEqual(seen[0][0][0], "evidence[SEP]the claim")
        self.assertEqual(seen[0][1]["max_length"], 2048)
        np.testing.assert_allclose(scores, [0.9] * 9)

    def test_policy_g_verifies_one_multi_and_retrieved_zero_hits(self):
        anchors = [
            Anchor("one", "alpha", 1),
            Anchor("multi-a", "1591 first", 1),
            Anchor("multi-b", "1591 second", 1),
            Anchor("semantic", "paraphrased value", 1),
        ]
        index = type("Index", (), {"anchors": anchors})()
        claims = [claim("alpha"), claim("1591"), claim("missing")]
        verified = []

        def verify(_model, _spec, text, documents):
            verified.append((text, documents))
            return np.arange(len(documents), dtype=float)

        with (
            patch("grounding_lab.model_benchmark._encode", return_value=None),
            patch(
                "grounding_lab.model_benchmark._similarities",
                return_value=np.array([0.0, 0.1, 0.2, 0.9]),
            ),
            patch("grounding_lab.model_benchmark._verify_scores", side_effect=verify),
        ):
            entries, _ = _verification_entries(
                [("doc", index, claims)], object(), object(), object(), object(), 2
            )

        self.assertEqual(
            [[anchor.anchor_id for anchor in entry[3][0]] for entry in entries],
            [["one"], ["multi-a", "multi-b"], ["semantic", "multi-b"]],
        )
        self.assertTrue(all(entry[2] == "verifier" for entry in entries))
        self.assertEqual(len(verified), 3)


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

    def test_sub_threshold_links_are_reviewed_not_scored(self):
        anchor = [Anchor("candidate", "evidence", 1)]
        entries = [
            ("doc", claim("review-correct", ("candidate",)), "neural", (anchor, np.array([0.4]), [True])),
            ("doc", claim("review-wrong"), "neural", (anchor, np.array([0.4]), [True])),
            ("doc", claim("accept-correct", ("candidate",)), "neural", (anchor, np.array([0.8]), [True])),
            ("doc", claim("accept-wrong"), "neural", (anchor, np.array([0.8]), [True])),
        ]
        metrics = evaluate(entries, -math.inf, CONTAINMENT_CAP, 0.5)
        self.assertEqual(
            (metrics["review"], metrics["correct_links"], metrics["wrong"], metrics["auto_correct"], metrics["auto"]),
            (2, 1, 1, 1, 2),
        )

    def test_verifier_requires_exactly_one_strong_candidate(self):
        from grounding_lab.calibrate import decide

        anchors = [Anchor("gold", "1591", 1), Anchor("other", "1591", 1)]
        entry = (
            "dev",
            claim("1591", ("gold",)),
            "verifier",
            (anchors, np.array([0.9, 0.8]), [True, True]),
        )
        self.assertIsNone(decide(entry, 0.7, CONTAINMENT_CAP)[0])
        self.assertEqual(decide(entry, 0.85, CONTAINMENT_CAP)[0], "gold")

    def test_verifier_calibration_minimizes_wrong_links_first(self):
        anchor = [Anchor("candidate", "evidence", 1)]
        entries = [
            (
                "dev",
                claim(str(i), ("candidate",)),
                "verifier",
                (anchor, np.array([score]), [True]),
            )
            for i, score in enumerate((0.8, 0.82, 0.9))
        ]
        entries.append(
            (
                "dev",
                claim("absent"),
                "verifier",
                (anchor, np.array([0.85]), [True]),
            )
        )
        abstain, _, metrics = choose_thresholds(entries)
        self.assertGreaterEqual(abstain, 0.5)
        self.assertEqual(metrics["wrong"], 0)
        self.assertEqual(metrics["correct_links"], 1)

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
        metrics = _evaluation_metrics(entries, {"doc"}, 0.0, 0.5, [])
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


class FieldCollisionTest(unittest.TestCase):
    def test_value_claimed_under_two_fields_is_reranked_and_capped(self):
        class Index:
            anchors = [Anchor("a", "maskinfører Poul Kragh", 1), Anchor("b", "unrelated", 1)]

        import grounding_lab.model_benchmark as mb

        seen = []
        with patch.object(mb, "_rerank_scores", side_effect=lambda *a: (seen.append(a[2]), np.array([0.9]))[1]):
            entries, _ = _score_entries(
                [("doc", Index(), [
                    Claim("Poul Kragh", ("machine_operator",), ("a",)),
                    Claim("Poul Kragh", ("excavation_leader",), ()),
                    Claim("unrelated", ("site",), ("b",)),
                ])],
                None, None, object(), None, "rich-hitset", 30, "hitset", "abstain",
            )
        self.assertEqual([e[2] for e in entries], ["neural", "neural", "lexical"])
        self.assertTrue(all(text.startswith(("machine operator", "excavation leader")) for text in seen))
        for entry in entries[:2]:
            self.assertEqual(entry[3][2], [False])  # capped: review, never auto-accept
            picked, confidence, _ = mb.decide(entry, -np.inf, CONTAINMENT_CAP)
            self.assertEqual((picked, confidence), ("a", CONTAINMENT_CAP))

    def test_generic_one_hit_rerank_is_rich_and_keeps_verbatim(self):
        class Index:
            anchors = [Anchor("a", "maskinfører Poul Kragh", 1)]

        import grounding_lab.model_benchmark as mb

        seen = []
        with patch.object(
            mb,
            "_rerank_scores",
            side_effect=lambda *args: (seen.append(args[2]), np.array([0.9]))[1],
        ):
            entries, _ = _score_entries(
                [("doc", Index(), [
                    Claim("Poul Kragh", ("machine_operator",), ("a",)),
                    Claim("Poul Kragh", ("excavation_leader",), ()),
                ])],
                None, None, object(), None, "rich-hitset", 30, "hitset", "abstain", True,
            )

        self.assertEqual(seen, [
            "machine operator: Poul Kragh",
            "excavation leader: Poul Kragh",
        ])
        self.assertTrue(all(entry[3][2] == [True] for entry in entries))
        self.assertTrue(all(mb.decide(entry, -math.inf, CONTAINMENT_CAP)[1] == 0.9 for entry in entries))


class DatasetRegressionTest(unittest.TestCase):
    def test_zero_strict_hit_and_adversarial_sets_are_pinned(self):
        root = Path(__file__).parents[1]
        roots = [root / "dataset", root / "final_dataset", root / "final_dataset_2"]
        documents = [doc for dataset in roots for doc in load_dataset(dataset)]
        zero_hit_supported = {
            (name, str(item.value), item.result_path)
            for name, index, claims in documents
            for item in claims
            if item.gold_anchor_ids and not lexical_candidates(item, index.anchors)
        }
        self.assertEqual(zero_hit_supported, {
            ("age-related-disease", "Im Dol 2-6", ("affiliations", 4, "street")),
            ("age-related-disease", "Øster Voldgade 5-7", ("affiliations", 5, "street")),
            ("catfish-collagen", "Carlos José Dias Pereira", ("academic_editor",)),
            ("herredsvejen", "AAR33284", ("records", 3, "ams_lab_number")),
            ("brondbylund", "cirka 1100-900 f.Kr.", ("graveyard_use_period",)),
            ("hvissinge", "at least two individuals", ("loose_bone_minimum_individual_count",)),
        })

        adversarial = []
        for dataset in roots:
            for path in dataset.glob("*/claims.json"):
                for item in json.loads(path.read_text(encoding="utf-8")):
                    if item.get("goldAnchorId") is None and item.get("expectedLexicalHitIds"):
                        adversarial.append((path.parent.name, item["value"], tuple(item["resultPath"])))
        self.assertEqual(adversarial, [
            ("herredsvejen", "Poul Kragh", ("excavation_leader",)),
        ])


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
