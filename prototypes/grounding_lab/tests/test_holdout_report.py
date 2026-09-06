import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from grounding_lab.holdout_report import build, diagnostics, metrics, quantiles, queue_metrics, record_scope, quote_order, summarize, QUOTE_REVIEW_PRIORITY
from grounding_lab.holdout_evaluation import write


class HoldoutReportTest(unittest.TestCase):
    def test_missing_evidence_and_unsupported_values_are_separate(self):
        rows = [
            {"path": [0], "resolved": True, "supported": False, "proposed": ["a"], "correctEvidence": False, "reviewRiskScore": .9, "valueRiskScore": .8, "evidenceRiskScore": .5},
            {"path": [1], "resolved": True, "supported": True, "supportedWithoutCanonicalEvidence": True, "proposed": [], "correctEvidence": False, "reviewRiskScore": 1., "valueRiskScore": .1, "evidenceRiskScore": None},
            {"path": [2], "resolved": True, "supported": True, "proposed": ["a"], "correctEvidence": True, "reviewRiskScore": .1, "valueRiskScore": .1, "evidenceRiskScore": 0.},
            {"path": [3], "resolved": False, "supported": False, "proposed": [], "correctEvidence": False},
        ]
        summary = metrics(rows)
        self.assertEqual(summary["unsupportedProposals"], 1)
        self.assertEqual(summary["missingEvidenceSupported"], 1)
        self.assertEqual(summary["unresolved"], 1)
        self.assertEqual(summary["supportedWithoutCanonicalEvidence"], 1)
        self.assertEqual(queue_metrics(rows)["joint"]["at1"]["recall"], .5)
        self.assertAlmostEqual(diagnostics(rows)["value"]["brier"], .02)
        self.assertEqual(diagnostics(rows)["evidence"]["reliability"][-1]["n"], 1)
        self.assertEqual(quantiles([2, 1, 3, 4]), {"n": 4, "p50": 2, "p95": 4, "p99": 4})
        self.assertEqual(quantiles([])["p95"], None)

    def test_transfer_exclusion_physical_attempt_totals_and_missing_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "review-order.json", {"priorityByStatus": QUOTE_REVIEW_PRIORITY})
            write(root / "holdout/sources.json", [{"family": "beier", "untouchedStatus": "transfer"},
                                                   {"family": "bosch", "untouchedStatus": "untouched"},
                                                   {"family": "wiermann", "untouchedStatus": "pending"}])
            failure = {"complete": False, "error": "length", "modelCalls": 1, "elapsedSeconds": 5, "metadata": {"promptTokens": 30}}
            write(root / "failures.json", [{"family": "beier", "arm": "quote", "metadata": failure}])
            for arm in ("baseline", "quote"):
                for family in ("beier", "bosch"):
                    run = root / "runs" / arm / family
                    if (arm, family) == ("quote", "beier"):
                        write(run / "extracted_meta.json", failure)
                        continue
                    write(run / "extracted_meta.json", {"complete": True, "modelCalls": 1, "elapsedSeconds": 2, "metadata": {"promptTokens": 100, "outputTokens": 20}})
                    write(run / "extracted_raw.json", {"records": [{"catalogue_id": "1"}]})
                    write(run / "grounding_meta.json", {"durationSeconds": 1, "calls": 2})
                    write(root / "holdout" / family / "expected_records.json", {"expected_record_count": 2, "records": [{"catalogue_id": "1"}, {"catalogue_id": "2"}]})
                    write(run / "claims_extracted.json", [{"resultPath": ["records", 0, "catalogue_id"], "value": "1", "supported": family == "bosch", "goldAnchorSets": [["a"]] if family == "bosch" and arm == "baseline" else []}])
                    abstained = (arm, family) == ("baseline", "bosch")
                    (run / "e-proposals.jsonl").write_text(json.dumps({"path": ["records", 0, "catalogue_id"], "bestCandidateAnchorId": "a", "valueRiskScore": .2, "evidenceRiskScore": .2, "reviewRiskScore": .36,
                        "routingDecision": "abstain" if abstained else "linked", "linkedAnchorId": None if abstained else "a"}) + "\n", encoding="utf-8")
                    if arm == "quote":
                        write(run / "quote_mappings.json", [{"resultPath": ["records", 0, "catalogue_id"], "status": "mapped", "proposedAnchorSets": [["a"]]}])
            with patch("grounding_lab.holdout_report.verify_freeze"):
                result = build(root)
            diagnostic_run = root / "runs/quote/beier"
            write(diagnostic_run / "extracted_meta.json", {**failure, "error": "Error: Result exceeds 20 burial records"})
            write(diagnostic_run / "diagnostic_meta.json", {"usableForLabeling": True, "recordCount": 25})
            write(diagnostic_run / "diagnostic_extracted_raw.json", {"records": [{"catalogue_id": str(i)} for i in range(25)]})
            write(diagnostic_run / "diagnostic_quote_mappings.json", [{"resultPath": ["records", i, "catalogue_id"], "status": "mapped", "proposedAnchorSets": [["a"]]} for i in range(25)])
            write(diagnostic_run / "claims_extracted.json", [{"resultPath": ["records", i, "catalogue_id"], "value": str(i), "supported": True, "goldAnchorSets": [["a"]]} for i in range(25)])
            write(diagnostic_run / "grounding_meta.json", {"durationSeconds": 1, "calls": 25})
            (diagnostic_run / "e-proposals.jsonl").write_text("".join(json.dumps({"path": ["records", i, "catalogue_id"], "bestCandidateAnchorId": "a", "valueRiskScore": .2, "evidenceRiskScore": .2, "reviewRiskScore": .36,
                "routingDecision": "linked", "linkedAnchorId": "a"}) + "\n" for i in range(25)), encoding="utf-8")
            with patch("grounding_lab.holdout_report.verify_freeze"):
                recovered_report = build(root)
        self.assertEqual(result["untouched"]["families"], ["bosch"])
        self.assertEqual(result["untouched"]["excludedFamilies"], {"beier": "transfer", "wiermann": "pending"})
        pooled = next(row for row in result["pooled"] if row["arm"] == "baseline/E")
        untouched = next(row for row in result["untouched"]["pooled"] if row["arm"] == "baseline/E")
        self.assertEqual(pooled["claims"], 2)
        self.assertEqual(untouched["claims"], 1)
        self.assertEqual(untouched["unsupportedProposals"], 0)
        self.assertEqual(untouched["latencySeconds"]["n"], 1)
        self.assertEqual(untouched["correctEvidence"], 1)
        self.assertEqual(untouched["routing"]["abstain"], 1)
        self.assertEqual(untouched["routing"]["correctLinkedEvidence"], 0)
        self.assertEqual(pooled["routing"]["unsupportedLinked"], 1)
        totals = result["attemptTotals"]
        self.assertEqual((totals["plannedExtractions"], totals["complete"], totals["failed"], totals["notExecuted"]), (6, 3, 1, 2))
        self.assertEqual((totals["literalScopeMismatches"], totals["scopeUnassessed"]), (3, 3))
        self.assertEqual(totals["extractionModelCalls"]["reportedTotal"], 4)
        self.assertEqual(totals["rerankerCalls"]["reportedTotal"], 6)
        self.assertEqual(totals["promptTokens"]["reportedTotal"], 330)
        self.assertEqual(totals["outputTokens"], {"reportedTotal": 60, "attemptsWithUnknownUsage": 1})
        quote_only = next(row for row in result["pooled"] if row["arm"] == "quote/quote-only")
        self.assertEqual(quote_only["diagnostics"], {})
        self.assertTrue(quote_only["riskCoverage"])
        self.assertEqual(quote_only["supported"], 1)
        self.assertEqual(quote_only["supportedWithoutCanonicalEvidence"], 1)
        self.assertEqual(quote_only["unsupportedProposals"], 0)
        self.assertFalse(result["attempts"][0]["recordScope"]["recordCountMatches"])
        self.assertEqual(recovered_report["attemptTotals"]["failed"], 1)
        self.assertEqual(recovered_report["attemptTotals"]["complete"], 3)
        self.assertEqual(recovered_report["attemptTotals"]["diagnosticOutputs"], 1)
        self.assertEqual(recovered_report["pairedConformingFamilies"], ["bosch"])
        all_quote = next(r for r in recovered_report["pooled"] if r["arm"] == "quote/E")
        conforming_quote = next(r for r in recovered_report["conforming"]["pooled"] if r["arm"] == "quote/E")
        self.assertEqual((all_quote["claims"], all_quote["diagnosticClaims"]), (26, 25))
        self.assertEqual((conforming_quote["claims"], conforming_quote["diagnosticClaims"]), (1, 0))
        diagnostic_attempt = next(a for a in recovered_report["attempts"] if a["diagnosticOnly"])
        self.assertEqual(diagnostic_attempt["status"], "failed")
        self.assertEqual(diagnostic_attempt["recordScope"]["emittedRecords"], 25)

    def test_literal_scope_diagnostic_does_not_strip_record_suffixes(self):
        result = record_scope({"records": [{"catalogue_id": "12a"}]}, {"expected_record_count": 1, "records": [{"catalogue_id": "12"}]})
        self.assertTrue(result["recordCountMatches"])
        self.assertFalse(result["catalogueIdSequenceMatches"])
        self.assertIsNone(record_scope({"records": []}, None)["recordCountMatches"])

    def test_quote_ordinal_queue_is_shared_by_joint_and_value_without_probabilities(self):
        rows = [{"family": "fixture", "arm": "quote/quote-only", "path": ["records", path], "resolved": True,
                 "supported": supported, "proposed": ["a"] if status == "mapped" else [], "correctEvidence": correct,
                 "quoteReviewPriority": QUOTE_REVIEW_PRIORITY[status]}
                for path, status, supported, correct in [(10, "missing", True, False), (2, "not_found", False, False),
                    (3, "mapping_failure", True, False), (1, "ambiguous", True, False), (0, "mapped", True, True), (20, "mapped", False, False)]]
        self.assertEqual([r["path"][-1] for r in sorted(rows, key=quote_order)], [2, 3, 10, 1, 0, 20])
        queues = queue_metrics(rows)
        self.assertEqual(queues["joint"]["at1"]["precision"], 1)
        self.assertEqual(queues["value"]["at1"]["precision"], 1)
        self.assertAlmostEqual(queues["value"]["at3"]["precision"], 1/3)
        self.assertEqual(queues["joint"]["at5"]["recall"], .8)
        self.assertEqual(queues["value"]["at5"]["recall"], .5)
        summary = summarize(rows, [])["pooled"][0]
        self.assertEqual(summary["riskCoverage"][0]["observedJointRisk"], 0)
        self.assertEqual(summary["diagnostics"], {})
        self.assertEqual(summary["riskCoverageOrdering"], "reversed frozen quote status order")
        self.assertTrue(all("reviewRiskScore" not in row for row in rows))


if __name__ == "__main__":
    unittest.main()
