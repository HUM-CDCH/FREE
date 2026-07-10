from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.parsing.ocr_fallback import run_paddleocr_fallback
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


if __name__ == "__main__":
    unittest.main()
