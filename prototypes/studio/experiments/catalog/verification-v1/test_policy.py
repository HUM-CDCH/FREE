import unittest
from report import semantic_projection


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.baseline = {'rows': [{'values': {'catalog_number': 1, 'burial_axis': 'O-W'},
                                  'evidence': {'burial_axis': ['existing']}}], 'durationMs': 10, 'calls': []}

    def project(self, verdict):
        return semantic_projection(self.baseline, [{'catalog_number': 1, 'modelVerdict': verdict,
                 'originalValue': 'O-W', 'durationMs': 5}])

    def test_support_preserves_existing_evidence_without_inventing_it(self):
        self.assertEqual(self.project('supported')['rows'][0]['evidence']['burial_axis'], ['existing'])
        self.baseline['rows'][0]['evidence']['burial_axis'] = []
        self.assertEqual(self.project('supported')['rows'][0]['evidence']['burial_axis'], [])

    def test_uncertainty_removes_value_and_links_but_keeps_original(self):
        row = self.project('uncertain')['rows'][0]
        self.assertIsNone(row['values']['burial_axis'])
        self.assertEqual(row['evidence']['burial_axis'], [])
        self.assertEqual(row['verification']['originalValue'], 'O-W')
        self.assertTrue(row['verification']['reviewRequired'])
        self.assertEqual(self.baseline['rows'][0]['values']['burial_axis'], 'O-W')

    def test_unknown_verdict_requires_review(self):
        row = self.project('unexpected')['rows'][0]
        self.assertIsNone(row['values']['burial_axis'])
        self.assertTrue(row['verification']['reviewRequired'])


if __name__ == '__main__':
    unittest.main()
