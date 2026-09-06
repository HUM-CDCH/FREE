import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from grounding_lab.evaluation_labels import evidence_correct, evidence_sets
from grounding_lab.label_review import main


class EvaluationLabelsTest(unittest.TestCase):
    def test_alternatives_and_required_sets_are_distinct(self):
        gold = evidence_sets({"goldAnchorSets": [["a", "b"], ["c"]]})
        self.assertFalse(evidence_correct(["a"], gold))
        self.assertTrue(evidence_correct(["b", "a"], gold))
        self.assertTrue(evidence_correct(["c"], gold))
        self.assertFalse(evidence_correct(["c", "unrelated"], gold))
        self.assertEqual(evidence_sets({"goldAnchorIds": ["a", "b"]}), [["a"], ["b"]])
        for claim in ({"goldAnchorIds": None}, {}, {"goldAnchorSets": [[]]}):
            with self.assertRaises(ValueError):
                evidence_sets(claim)

    def test_natural_output_keeps_absent_errors_but_rejects_missing_labels_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            doc = root / "doc"
            doc.mkdir()
            files = {
                "anchors.json": [{"anchorId": "a", "text": "source", "page": 1}],
                "schema.json": {"field": "string"},
                "extracted_raw.json": {"field": "invented"},
                "extracted_meta.json": {"metadata": {"finishReason": "stop"}, "error": None},
                "claims_extracted.json": [{"value": "invented", "resultPath": ["field"], "goldAnchorIds": []}],
            }
            def run(natural=True):
                for name, data in files.items():
                    (doc / name).write_text(json.dumps(data), encoding="utf-8")
                with patch("sys.argv", ["label-review", str(root), "--claims", "claims_extracted.json"] + (["--natural-output"] if natural else [])), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    return main()
            self.assertEqual(run(), 0)
            self.assertEqual(run(False), 1)
            files["claims_extracted.json"][0]["goldAnchorIds"] = None
            self.assertEqual(run(), 1)
            files["claims_extracted.json"] = []
            self.assertEqual(run(), 1)
            files["extracted_meta.json"]["metadata"]["finishReason"] = "length"
            self.assertEqual(run(), 1)
            files["extracted_meta.json"]["metadata"]["finishReason"] = "stop"
            files["extracted_meta.json"]["complete"] = False
            self.assertEqual(run(), 1)
            del files["claims_extracted.json"]
            (doc / "claims_extracted.json").unlink()
            self.assertEqual(run(), 1)


if __name__ == "__main__":
    unittest.main()
