from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.parsing.ocr_fallback import (
    _extract_lines_from_result,
    run_paddleocr_fallback,
)
from app.storage.paths import SERVICE_ROOT


class TestOcrFallback(unittest.TestCase):
    def test_missing_dependency_returns_safe_diagnostic(self):
        with tempfile.TemporaryDirectory(dir=SERVICE_ROOT) as tmp_dir:
            root = Path(tmp_dir)
            source = root / "source.pdf"
            image = root / "page_01.png"
            source.write_bytes(b"%PDF-1.4\n")
            image.write_bytes(b"image")
            with (
                patch(
                    "app.parsing.ocr_fallback.convert_pdf_to_images",
                    return_value=[str(image)],
                ),
                patch("app.parsing.ocr_fallback.logger.exception"),
                patch(
                    "app.parsing.ocr_fallback.importlib.import_module",
                    side_effect=ModuleNotFoundError(
                        "/private/paddle?token=do-not-expose"
                    ),
                ),
            ):
                output = run_paddleocr_fallback(
                    source_pdf=source,
                    content_sha256="a" * 64,
                    page_numbers=[1],
                    dpi=150,
                    device="cpu",
                    artifact_root=root / "artifacts",
                )

        self.assertEqual(output.status, "failed")
        self.assertEqual(output.error, "ocr_fallback_unavailable")
        self.assertNotIn("private", output.error or "")
        self.assertNotIn("token", output.error or "")


class TestExtractLines(unittest.TestCase):
    SCALE = 72.0 / 150.0

    def test_scales_pixels_to_points(self):
        result = {
            "overall_ocr_res": {
                "rec_texts": ["a", "b"],
                "rec_scores": [0.9, 0.8],
                "rec_boxes": [[150, 150, 300, 300], [0, 0, 75, 75]],
            }
        }
        warnings: list[str] = []
        lines = _extract_lines_from_result(result, self.SCALE, warnings)
        self.assertEqual(warnings, [])
        self.assertEqual(
            lines,
            [
                {
                    "type": "ocr_line",
                    "text": "a",
                    "confidence": 0.9,
                    "bbox": [72.0, 72.0, 144.0, 144.0],
                },
                {
                    "type": "ocr_line",
                    "text": "b",
                    "confidence": 0.8,
                    "bbox": [0.0, 0.0, 36.0, 36.0],
                },
            ],
        )

    def test_length_mismatch_returns_empty_with_warning(self):
        result = {
            "overall_ocr_res": {
                "rec_texts": ["a", "b"],
                "rec_scores": [0.9],
                "rec_boxes": [[0, 0, 1, 1], [0, 0, 1, 1]],
            }
        }
        warnings: list[str] = []
        self.assertEqual(_extract_lines_from_result(result, self.SCALE, warnings), [])
        self.assertEqual(warnings, ["ocr_line_geometry_unavailable"])

    def test_missing_ocr_res_returns_empty_with_single_warning(self):
        warnings: list[str] = []
        self.assertEqual(_extract_lines_from_result({}, self.SCALE, warnings), [])
        self.assertEqual(_extract_lines_from_result(object(), self.SCALE, warnings), [])
        self.assertEqual(warnings, ["ocr_line_geometry_unavailable"])

    def test_invalid_geometry_and_confidence_are_rejected_with_warning(self):
        cases = [
            ([0, 0, 1], 0.5),
            ([10, 20, 1, 2], 0.5),
            ([0, 0, math.nan, 2], 0.5),
            ([0, 0, 1, 2], math.nan),
        ]
        for box, score in cases:
            warnings: list[str] = []
            result = {
                "overall_ocr_res": {
                    "rec_texts": ["bad"],
                    "rec_scores": [score],
                    "rec_boxes": [box],
                }
            }
            self.assertEqual(
                _extract_lines_from_result(result, self.SCALE, warnings), []
            )
            self.assertEqual(warnings, ["ocr_line_geometry_unavailable"])

    def test_score_clamped_to_unit_interval(self):
        result = {
            "overall_ocr_res": {
                "rec_texts": ["a", "b"],
                "rec_scores": [1.7, -0.2],
                "rec_boxes": [[0, 0, 1, 1], [0, 0, 1, 1]],
            }
        }
        lines = _extract_lines_from_result(result, self.SCALE, [])
        self.assertEqual([line["confidence"] for line in lines], [1.0, 0.0])


if __name__ == "__main__":
    unittest.main()
