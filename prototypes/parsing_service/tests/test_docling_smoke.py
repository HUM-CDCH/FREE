from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from support import PDF_BYTES


@unittest.skipUnless(
    os.environ.get("RUN_DOCLING_SMOKE") == "1"
    or os.environ.get("npm_lifecycle_event") == "test:live-model",
    "run pnpm test:live-model or set RUN_DOCLING_SMOKE=1",
)
class RealDoclingSmokeTests(unittest.TestCase):
    def test_real_converter_produces_parsed_document_v2(self) -> None:
        # Keep the heavyweight import out of normal unit-test discovery. This
        # smoke test is intentionally opt-in because Docling may download models.
        from app.docling_parser import DoclingParser

        with tempfile.TemporaryDirectory() as temporary:
            source_path = Path(temporary) / "source.pdf"
            source_path.write_bytes(PDF_BYTES)
            content_sha256 = hashlib.sha256(PDF_BYTES).hexdigest()
            result = DoclingParser().parse(
                source_path,
                {
                    "document_id": f"sha256:{content_sha256}",
                    "content_sha256": content_sha256,
                    "preprocess_id": "preprocess-smoke",
                    "source_name": "source.pdf",
                    "created_at": "2026-01-01T00:00:00+00:00",
                },
            )

        document = (
            result["parsed_document"]
            if isinstance(result, dict)
            else result.parsed_document
        )
        self.assertEqual(document["schema_version"], "parsed_document.v2")
        self.assertTrue(document["page_mapping_verified"])
        self.assertEqual(document["page_count"], 1)


if __name__ == "__main__":
    unittest.main()
