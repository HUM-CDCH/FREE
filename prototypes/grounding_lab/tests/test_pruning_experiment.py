import unittest

from grounding_lab.pruning_experiment import inventory_comparison, summarize


class PruningExperimentTests(unittest.TestCase):
    def test_structural_enrichment_preserves_order_and_scoring_inputs(self):
        original = [{"anchorId": "a", "text": "10", "page": 1, "context": "grave A | 10"},
                    {"anchorId": "b", "text": "20", "page": 1}]
        enriched = [{**original[0], "kind": "table_cell", "logicalTableId": "t", "row": 1,
                     "column": 2, "role": None}, original[1]]
        result = inventory_comparison(original, enriched)
        self.assertTrue(result["compatible"])
        self.assertEqual(result["tableCellsWithIdentity"], 1)
        self.assertFalse(inventory_comparison(original, enriched[::-1])["compatible"])
        self.assertFalse(inventory_comparison(original, enriched[:1])["compatible"])
        self.assertFalse(inventory_comparison(original, [{**enriched[0], "context": "other"}, enriched[1]])["compatible"])

    def test_report_separates_unsupported_links_wrong_anchors_and_missing_gold(self):
        base = {"outcome": "link-correct", "supported": True, "goldAnchorIds": ["a"],
                "candidateAnchorIdsBeforePruning": ["a", "b"], "candidates": [{"anchorId": "a"}],
                "tier": "neural", "latencyMs": 10}
        rows = [base, {**base, "supported": False, "goldAnchorIds": [], "outcome": "link-wrong"},
                {**base, "outcome": "link-wrong", "candidates": [{"anchorId": "b"}]},
                {**base, "outcome": "abstain", "tier": "abstain", "candidates": []}]
        result = summarize(rows, {"doc": 45})
        self.assertEqual((result["supportedLinks"], result["unsupportedLinks"], result["wrongAnchors"],
                          result["reviewQueue"]), (1, 1, 1, 1))
        self.assertEqual((result["recoverableGoldBefore"], result["recoverableGoldRetained"]), (3, 1))
        self.assertEqual(result["groundingExtractionLatencyMs"]["p50"], 45)
