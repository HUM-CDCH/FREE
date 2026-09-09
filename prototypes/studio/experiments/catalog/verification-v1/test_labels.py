import unittest
from labels import decision


class LabelTests(unittest.TestCase):
    def setUp(self):
        self.claim = {'catalog_number': 1, 'value': 'O-W', 'blocks': [
            {'anchorId': 'a', 'text': 'Kiste O—W.'}, {'anchorId': 'b', 'text': 'Hang nach S.'}]}

    def test_valid_label_maps_to_source_anchor(self):
        d = decision(self.claim, {'verdict': 'supported', 'evidence_anchor': 'E1'})
        self.assertEqual(d['evidence'], ['a'])
        self.assertEqual(d['value'], 'O-W')

    def test_missing_wrong_or_non_string_label_abstains(self):
        for label in ['E2', 'E99', None, ['E1']]:
            self.assertTrue(decision(self.claim, {'verdict': 'supported', 'evidence_anchor': label})['reviewRequired'])

    def test_uncertainty_cannot_be_overridden_by_valid_label(self):
        d = decision(self.claim, {'verdict': 'uncertain', 'evidence_anchor': 'E1'})
        self.assertIsNone(d['value'])
        self.assertEqual(d['originalValue'], 'O-W')


if __name__ == '__main__':
    unittest.main()
