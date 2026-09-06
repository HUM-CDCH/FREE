import unittest
import tempfile
from pathlib import Path
from grounding_lab.bounded_evaluation import emitted_values
from grounding_lab.bounded_evaluation import report
from grounding_lab.holdout_evaluation import write
from grounding_lab.bounded_scoring import hybrid_proposals


class BoundedScoringTests(unittest.TestCase):
    def test_fallback_keeps_ambiguous_quotes_reviewable(self):
        rows = [{'path': [i], 'value': 12, 'bestCandidateAnchorId': 'candidate'} for i in range(3)]
        quotes = [{'resultPath': [i], 'status': status, 'proposedAnchorSets': [['a', 'b']]} for i, status in enumerate(['mapped', 'ambiguous', 'missing'])]
        result = hybrid_proposals(rows, quotes)
        self.assertEqual(result[0]['proposedAnchorSets'], [['a', 'b']])
        self.assertEqual(result[1]['proposedAnchorSets'], [['candidate']])
        self.assertTrue(all(r['reviewRequired'] and not r['autoAccept'] for r in result))

    def test_diagnostic_labels_use_completed_batches_without_salvaging_prefixes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / 'workflow.json', {'calls': [{'name': 'quote-batch-0', 'complete': True}, {'name': 'quote-batch-2', 'complete': False}]})
            write(root / 'quote-batch-0.response.txt', {'message': {'content': '{"records":[{"sourceKey":"R001","record":{"id":{"value":"12a","evidenceQuote":"Grab 12a"},"depth":{"value":1.2,"evidenceQuote":null}}}]}'}})
            (root / 'quote-batch-2.response.txt').write_text('{"records":[', encoding='utf8')
            values, diagnostic = emitted_values(root, 'quote')
            self.assertTrue(diagnostic)
            self.assertEqual(values, {'records': [{'id': '12a', 'depth': 1.2}]})

    def test_report_does_not_count_ambiguous_quote_or_wrong_fallback_as_correct(self):
        import json
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packet = root / 'blind/round-1'
            write(packet / 'claims.json', [{'claimId': 'c1'}])
            write(packet / 'anchors.json', [{'anchorId': 'gold'}, {'anchorId': 'wrong'}])
            write(packet / 'final.json', [{'claimId': 'c1', 'valueSupported': True, 'goldAnchorSets': [['gold']], 'status': 'resolved', 'note': 'explicit source value'}])
            write(root / 'blind-map.json', [{'claimId': 'c1', 'attempt': 'conrad-attempt-3', 'arm': 'quote', 'path': ['x']}])
            write(root / 'conrad-scope-independent.json', {'records': [{'site': 'S', 'literal_grave_identity': '1', 'record_block_range': {'start': 0, 'end': 1}, 'mandatoryRecordBlockRange': {'start': 0, 'end': 1}, 'mandatoryContextBlocks': []}]})
            attempt = root / 'conrad-attempt-3'
            write(attempt / 'workflow.json', {'complete': True, 'calls': [], 'arms': {'quote': {'durationSeconds': 5, 'extractionAndMappingSeconds': 3}}})
            write(attempt / 'record-manifest.json', [{'start': 0, 'end': 1, 'identityBlock': 0, 'sourceKey': 'R001'}])
            run = attempt / 'quote'
            write(run / 'quote_mappings.json', [{'resultPath': ['x'], 'status': 'ambiguous', 'proposedAnchorSets': [['gold'], ['wrong']]}])
            (run / 'e-proposals.jsonl').write_text(json.dumps({'path': ['x'], 'bestCandidateAnchorId': 'wrong', 'valueRiskScore': .2, 'evidenceRiskScore': .3, 'reviewRiskScore': .4}) + '\n', encoding='utf8')
            report(root)
            result = json.loads((root / 'evaluation.json').read_text(encoding='utf8'))
            rows = {r['arm'].split('/')[-1]: r for r in result['pooled']}
            self.assertEqual(rows['quote-only']['missingEvidenceSupported'], 1)
            self.assertEqual(rows['hybrid']['wrongEvidenceSupported'], 1)
            self.assertEqual(rows['hybrid']['correctEvidence'], 0)
