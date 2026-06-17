import io
import unittest

from PIL import Image

import shared.source_document as source_document
from shared.source_document import (
    SourceDocumentError,
    SourceDocumentInput,
    SourceDocumentInputPreparer,
)


class SourceDocumentInputPreparerTests(unittest.TestCase):
    def test_prepares_image_bytes_without_fastapi_errors(self) -> None:
        image = io.BytesIO()
        Image.new("RGB", (10, 10), "white").save(image, format="PNG")

        preparer = SourceDocumentInputPreparer(pdf_dpi=96)
        prepared = preparer.prepare(
            SourceDocumentInput(data=image.getvalue(), content_type="image/png")
        )

        self.assertEqual(prepared.page_count, 1)
        self.assertEqual(prepared.content[0]["type"], "image_url")

        with self.assertRaises(SourceDocumentError):
            preparer.prepare(
                SourceDocumentInput(data=b"not an image", content_type="text/plain")
            )

    def test_pdf_rendering_uses_constructor_dpi(self) -> None:
        scales = []

        class FakeRenderedPage:
            def to_pil(self):
                return Image.new("RGB", (10, 10), "white")

        class FakePage:
            def render(self, scale):
                scales.append(scale)
                return FakeRenderedPage()

        class FakePdf:
            def __init__(self, data):
                self.data = data

            def __iter__(self):
                return iter([FakePage()])

            def close(self):
                pass

        original = source_document.pdfium.PdfDocument
        source_document.pdfium.PdfDocument = FakePdf
        try:
            preparer = SourceDocumentInputPreparer(pdf_dpi=144)
            prepared = preparer.prepare(
                SourceDocumentInput(data=b"%PDF fake", content_type="application/pdf")
            )
        finally:
            source_document.pdfium.PdfDocument = original

        self.assertEqual(prepared.page_count, 1)
        self.assertEqual(scales, [2.0])


if __name__ == "__main__":
    unittest.main()
