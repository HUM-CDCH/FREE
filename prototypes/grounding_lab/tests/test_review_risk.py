import unittest

from grounding_lab.review_risk import fit_frozen, report, score_frozen, score_grouped


def row(doc, value, *, supported, picked=None, gold=(), score=None):
    candidate = [] if picked is None else [{
        "anchorId": picked,
        "rawScore": score,
        "verbatim": True,
        "hasRowContext": True,
        "rowSiblingCoverage": 1,
    }]
    return {
        "doc": doc,
        "value": value,
        "normalizedValue": str(value),
        "valueType": "str",
        "supported": supported,
        "goldAnchorIds": list(gold),
        "route": "zero-hit" if picked is None else "strict-single",
        "bareNumber": False,
        "siblingCount": 1,
        "candidateAnchorIdsBeforePruning": [] if picked is None else [picked],
        "candidates": candidate,
        "bestCandidateAnchorId": picked,
        "bestRawScore": score,
        "rawMargin": None,
    }


class ReviewRiskTest(unittest.TestCase):
    def test_frozen_inference_ignores_holdout_labels_and_rejects_overlap(self):
        train = [row("dev", "right", supported=True, picked="a", gold=("a",)),
                 row("dev", "wrong", supported=False, picked="b")]
        model = fit_frozen(train)
        held = [row("new", "right", supported=True, picked="a", gold=("a",))]
        first = score_frozen(held, model)[0]
        held[0].pop("supported")
        held[0].pop("goldAnchorIds")
        second = score_frozen(held, model)[0]
        for key in ("valueRiskScore", "evidenceRiskScore", "reviewRiskScore"):
            self.assertEqual(first[key], second[key])
        with self.assertRaisesRegex(ValueError, "overlap"):
            score_frozen(train, model)

    def test_requires_multiple_documents(self):
        with self.assertRaisesRegex(ValueError, "at least two documents"):
            score_grouped([row("a", "right", supported=True)])

    def test_fold_without_evidence_training_rows_stays_conservative(self):
        rows = [
            row("a", "invented", supported=False),
            row("b", "right", supported=True, picked="gold", gold=("gold",)),
        ]
        scored = score_grouped(rows)
        self.assertIsNone(scored[1]["evidenceRiskScore"])
        self.assertEqual(scored[1]["reviewRiskScore"], 1.0)

    def test_document_without_candidates_can_still_be_scored(self):
        rows = [
            row("a", "right", supported=True, picked="gold", gold=("gold",)),
            row("b", "right", supported=True, picked="gold", gold=("gold",)),
            row("c", "invented", supported=False),
        ]
        self.assertIsNone(score_grouped(rows)[2]["evidenceRiskScore"])

    def test_grouped_scores_separate_value_and_evidence_risk(self):
        rows = []
        for doc in ("a", "b", "c"):
            rows += [
                row(doc, "right", supported=True, picked="gold", gold=("gold",), score=5.0),
                row(doc, "wrong-anchor", supported=True, picked="wrong", gold=("gold",), score=-5.0),
                row(doc, "invented", supported=False, picked="wrong", score=-5.0),
                row(doc, "missing-link", supported=True),
            ]

        scored = score_grouped(rows)
        for item in scored:
            self.assertGreaterEqual(item["valueRiskScore"], 0.0)
            self.assertLessEqual(item["valueRiskScore"], 1.0)
            self.assertGreaterEqual(item["reviewRiskScore"], 0.0)
            self.assertLessEqual(item["reviewRiskScore"], 1.0)
        self.assertIsNone(scored[3]["evidenceRiskScore"])
        self.assertEqual(scored[3]["reviewRiskScore"], 1.0)
        self.assertLess(scored[0]["reviewRiskScore"], scored[1]["reviewRiskScore"])
        self.assertLess(scored[0]["valueRiskScore"], scored[2]["valueRiskScore"])
        self.assertIn("error precision@1", report(scored))

    def test_older_audit_rows_without_row_context_flag_still_score(self):
        rows = [
            row(doc, "right", supported=True, picked="gold", gold=("gold",), score=5.0)
            for doc in ("a", "b", "c")
        ] + [
            row(doc, "wrong", supported=True, picked="wrong", gold=("gold",), score=-5.0)
            for doc in ("a", "b", "c")
        ]
        for item in rows:
            item["candidates"][0].pop("hasRowContext")
        self.assertEqual(len(score_grouped(rows)), 6)


if __name__ == "__main__":
    unittest.main()
