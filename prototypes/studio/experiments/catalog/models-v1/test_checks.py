import unittest
from gliner import select
from score_ocr import normalize, substring_distance
from score_retrieval import rank_metrics
from normalize_ocr import unwrap
from normalize_ocr_v2 import plain_text

class Checks(unittest.TestCase):
    def test_markdown_plain_text(self):
        self.assertEqual(plain_text('### 205. **Place**, OT *Other*.\n2 * 3'), '205. Place, OT Other.\n2 * 3')

    def test_native_offsets_and_numeric_validation(self):
        text = 'Mbl. 2457 (4435)'
        spans = [{'text': '2457', 'start': 5, 'end': 9}, {'text': '4435', 'start': 11, 'end': 15}]
        self.assertEqual(select(text, spans[::-1], 'map_sheet')[0], 2457)
        self.assertEqual(select(text, [{'text': '2457', 'start': 0, 'end': 4}], 'map_sheet'), (None, None))
        self.assertEqual(select(text, [{'text': text, 'start': 0, 'end': len(text)}], 'map_sheet'), (None, None))

    def test_excerpt_alignment(self):
        self.assertEqual(substring_distance('abc', 'before abc after'), 0)
        self.assertEqual(substring_distance('abc', 'before axc after'), 1)
        self.assertEqual(substring_distance('abc', ''), 3)
        self.assertEqual(substring_distance('abc', 'ac'), 1)

    def test_typography_does_not_fix_ocr_letters(self):
        self.assertEqual(normalize('Sandstein-\nplatten O–W'), 'SandsteinplattenO-W')
        self.assertNotEqual(normalize('Groβkorbetha'), normalize('Großkorbetha'))

    def test_ranking_and_invalid_scores(self):
        result = rank_metrics([[1, 3, 2]], ['q'], ['a', 'b', 'c'], {'q': ['c']})
        self.assertEqual(result['hitAt1'], 0)
        self.assertEqual(result['hitAt3'], 1)
        self.assertEqual(result['mrr'], .5)
        with self.assertRaises(AssertionError):
            rank_metrics([[float('nan')]], ['q'], ['a'], {'q': ['a']})

    def test_native_layout_unwrap(self):
        text, boxes = unwrap('<x_0.1><y_0.2>205. Place<x_0.8><y_0.3><class_Text>')
        self.assertEqual(text, '205. Place')
        self.assertEqual(boxes[0]['bbox'], [.1, .2, .8, .3])
        self.assertEqual(unwrap('plain OCR'), ('plain OCR', []))

if __name__ == '__main__':
    unittest.main()
