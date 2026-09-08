import copy
import unittest
from evaluate import score, normalize


class ScoringTests(unittest.TestCase):
    def setUp(self):
        self.row = {'values': {'catalog_number': 901, 'locality': 'Großdorf', 'locality_part': None},
                    'evidence': {'catalog_number': ['a'], 'locality': ['a'], 'locality_part': []}}
        self.reference = {'inputSha256': 'snapshot', 'referenceSha256': 'gold', 'status': 'test',
                          'columns': list(self.row['values']), 'development': [901], 'evaluation': [], 'rows': [self.row]}
        self.run = {'inputSha256': 'snapshot', 'strategy': 'test', 'model': 'test', 'rows': [copy.deepcopy(self.row)], 'calls': [], 'durationMs': 0}

    def test_exact_answers(self):
        metrics = score(self.run, self.reference, 'all')
        self.assertEqual(metrics['fieldAccuracy'], 1)
        self.assertEqual(metrics['supportedAccuracy'], 1)

    def test_correct_value_with_wrong_existing_anchor_is_not_supported(self):
        self.run['rows'][0]['evidence']['locality'] = ['another-entry']
        metrics = score(self.run, self.reference, 'all')
        self.assertEqual(metrics['fieldAccuracy'], 1)
        self.assertEqual(metrics['evidencePrecision'], .5)

    def test_missing_record_does_not_get_credit_for_null_fields(self):
        self.run['rows'] = []
        self.assertEqual(score(self.run, self.reference, 'all')['fieldAccuracy'], 0)

    def test_duplicate_record_cannot_improve_score_by_best_of_two(self):
        self.run['rows'].append(copy.deepcopy(self.row))
        metrics = score(self.run, self.reference, 'all')
        self.assertEqual(metrics['duplicates'], 1)
        self.assertEqual(metrics['fieldAccuracy'], 0)

    def test_ocr_tolerance_never_changes_primary_accuracy(self):
        self.run['rows'][0]['values']['locality'] = 'Groβdorf'
        metrics = score(self.run, self.reference, 'all')
        self.assertLess(metrics['fieldAccuracy'], 1)
        self.assertEqual(metrics['ocrTolerantFieldAccuracy'], 1)

    def test_source_snapshot_mismatch_fails_closed(self):
        self.run['inputSha256'] = 'other'
        with self.assertRaises(ValueError):
            score(self.run, self.reference, 'all')

    def test_integer_fields_reject_prose_and_numeric_strings(self):
        self.assertNotEqual(normalize('901', 'catalog_number'), normalize(901, 'catalog_number'))
        self.assertNotEqual(normalize('901 near town', 'catalog_number'), normalize(901, 'catalog_number'))


if __name__ == '__main__':
    unittest.main()
