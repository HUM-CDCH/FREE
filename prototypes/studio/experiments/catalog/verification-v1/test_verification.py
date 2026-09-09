import unittest
from run import decide, quote_spans


class EvidenceGateTests(unittest.TestCase):
    def setUp(self):
        self.text = 'Die Kiste ist O—W orientiert.'
        self.claim = {'catalog_number': 1, 'value': 'O-W', 'text': self.text,
                      'blocks': [{'anchorId': 'a', 'start': 0, 'end': len(self.text)}]}
        self.spans = quote_spans(self.text, self.text)

    def test_supported_quote_preserves_value_and_anchor(self):
        d = decide(self.claim, 'supported', self.spans, ['Kiste'])
        self.assertEqual((d['value'], d['evidence'], d['reviewRequired']), ('O-W', ['a'], False))

    def test_hallucinated_or_wrong_offset_quote_cannot_confirm(self):
        for spans in [quote_spans(self.text, 'erfundene Kiste O-W'), [{'start': 1, 'end': len(self.text), 'text': self.text}]]:
            self.assertEqual(decide(self.claim, 'supported', spans, ['Kiste'])['decision'], 'uncertain')

    def test_direction_alone_is_not_object_evidence(self):
        self.assertIsNone(decide(self.claim, 'supported', quote_spans(self.text, 'O—W'), ['O—W'])['value'])

    def test_uncertainty_is_retained_even_with_matching_words(self):
        d = decide(self.claim, 'uncertain', self.spans, ['Kiste'])
        self.assertIsNone(d['value'])
        self.assertTrue(d['reviewRequired'])
        self.assertEqual(d['originalValue'], 'O-W')

    def test_invalid_verdict_does_not_confirm(self):
        self.assertEqual(decide(self.claim, 'yes', self.spans, ['Kiste'])['decision'], 'invalid')

    def test_two_different_anchors_are_ambiguous(self):
        text = self.text + '\n' + self.text
        claim = {**self.claim, 'text': text, 'blocks': [self.claim['blocks'][0],
                 {'anchorId': 'b', 'start': len(self.text)+1, 'end': len(text)}]}
        self.assertIsNone(decide(claim, 'supported', quote_spans(text, self.text), ['Kiste'])['value'])


if __name__ == '__main__':
    unittest.main()
