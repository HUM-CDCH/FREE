import json
import hashlib
import tempfile
import unittest
from pathlib import Path

from grounding_lab.holdout_evaluation import adjudicate, checked_labels, prepare, read, signature, verify_freeze, write


class BlindPackageTest(unittest.TestCase):
    def test_failed_generations_without_values_do_not_require_fabricated_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "holdout/bosch/anchors.json", [])
            for arm in ("baseline", "quote"):
                write(root / "runs" / arm / "bosch/extracted_meta.json", {"complete": False, "error": "context exceeded"})
            prepare(root)
            adjudicate(root, False)
            adjudicate(root, True)
            self.assertEqual(read(root / "blind/bosch/final-labels.json"), [])
            self.assertEqual(len(read(root / "failures.json")), 2)
            self.assertFalse((root / "blind/bosch/labels-a.json").exists())

    def test_freeze_checks_the_original_source_before_labeling(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            pdf.write_bytes(b"original")
            write(root / "freeze.json", {"files": {}, "sources": [{"family": "beier", "source": str(pdf),
                  "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest()}]})
            verify_freeze(root)
            pdf.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "original PDF changed"):
                verify_freeze(root)

    def test_source_support_can_survive_missing_canonical_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "labels.json"
            supported = {"claimId": "c1", "goldAnchorSets": [], "valueSupported": True,
                         "note": "Original PDF states the value; OCR omitted its passage", "status": "resolved"}
            write(path, [supported])
            self.assertTrue(checked_labels(path, {"c1"}, set())["c1"]["valueSupported"])
            unsupported = {**supported, "valueSupported": False}
            self.assertNotEqual(signature(supported), signature(unsupported))
            write(path, [{**unsupported, "goldAnchorSets": [["a"]]}])
            with self.assertRaisesRegex(ValueError, "requires a supported value"):
                checked_labels(path, {"c1"}, {"a"})

    def test_incremental_family_packages_preserve_existing_blinding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for family in ("beier", "bosch"):
                write(root / "holdout" / family / "anchors.json", [])
                write(root / "holdout" / family / "schema.json", {"field": "string"})
                for arm in ("baseline", "quote"):
                    run = root / "runs" / arm / family
                    write(run / "extracted_meta.json", {"complete": True})
                    write(run / "extracted_raw.json", {"field": family})
            prepare(root, "beier")
            before = (root / "blind/beier/claims.json").read_bytes()
            self.assertFalse((root / "blind/bosch/claims.json").exists())
            prepare(root, "bosch")
            self.assertEqual((root / "blind/beier/claims.json").read_bytes(), before)
            self.assertEqual(len(read(root / "blind-map.json")), 4)
            with self.assertRaisesRegex(ValueError, "already exists"):
                prepare(root, "beier")

    def test_nested_values_keep_blind_burial_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "holdout/beier/anchors.json", [])
            write(root / "holdout/beier/schema.json", {})
            for arm, site in (("baseline", "A"), ("quote", "B")):
                run = root / "runs" / arm / "beier"
                if arm == "quote":
                    write(run / "extracted_meta.json", {"complete": False, "error": "Error: Result exceeds 20 burial records"})
                    write(run / "diagnostic_meta.json", {"usableForLabeling": True})
                else:
                    write(run / "extracted_meta.json", {"complete": True})
                write(run / ("diagnostic_extracted_raw.json" if arm == "quote" else "extracted_raw.json"),
                      {"records": [{"site": site, "grave_goods": [{"item_type": "cup"}]}]})
            prepare(root)
            nested = [c for c in read(root / "blind/beier/claims.json") if c["value"] == "cup"]
            self.assertEqual(len(nested), 2)
            self.assertEqual({c["recordContext"]["site"] for c in nested}, {"A", "B"})
            self.assertEqual(len(read(root / "failures.json")), 1)

    def test_paired_claims_are_blinded_and_disagreements_require_adjudication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "holdout/family"
            write(source / "anchors.json", [{"anchorId": "a", "text": "Vessel", "page": 1}])
            write(source / "schema.json", {"field": "string"})
            (source / "document.md").write_text("Vessel", encoding="utf-8")
            for arm in ("baseline", "quote"):
                run = root / "runs" / arm / "family"
                write(run / "extracted_meta.json", {"complete": True, "error": None})
                write(run / "extracted_raw.json", {"field": "Vessel"})
            prepare(root)
            blind = root / "blind/family"
            claims = read(blind / "claims.json")
            self.assertEqual(len(claims), 1)
            self.assertNotIn("arm", claims[0])
            self.assertFalse((blind / "extracted_meta.json").exists())
            self.assertEqual(len(read(root / "blind-map.json")), 2)
            cid = claims[0]["claimId"]
            write(blind / "labels-a.json", [{"claimId": cid, "goldAnchorSets": [["a"]], "note": "States value"}])
            write(blind / "labels-b.json", [{"claimId": cid, "goldAnchorSets": [], "note": "Wrong field"}])
            adjudicate(root, False)
            self.assertEqual(len(read(blind / "disagreements.json")), 1)
            with self.assertRaises(FileNotFoundError):
                adjudicate(root, True)
            write(blind / "adjudicated.json", [{"claimId": cid, "goldAnchorSets": [["a"]], "note": "Confirmed field against source"}])
            adjudicate(root, True)
            for arm in ("baseline", "quote"):
                final = read(root / "runs" / arm / "family/claims_extracted.json")
                self.assertEqual(final[0]["goldAnchorSets"], [["a"]])
            with self.assertRaisesRegex(ValueError, "already exists"):
                prepare(root)


if __name__ == "__main__":
    unittest.main()
