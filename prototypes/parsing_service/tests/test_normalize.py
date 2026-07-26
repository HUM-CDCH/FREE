import unittest

from app.parsing.adapters.pymupdf_inspect import PdfInspection, PdfPageInspection
from app.parsing.normalize import build_page_marked_text, normalize_markdown_to_pages


def make_inspection(page_count):
    return PdfInspection(
        status="completed",
        started_at="2026-01-01T00:00:00Z",
        finished_at="2026-01-01T00:00:01Z",
        duration_ms=1,
        page_count=page_count,
        pages=[
            PdfPageInspection(
                page=index,
                width_pt=595.0,
                height_pt=842.0,
                rotation=0,
                native_text=f"native {index}",
                char_count=8,
                word_count=2,
            )
            for index in range(1, page_count + 1)
        ],
    )


class TestNormalize(unittest.TestCase):
    def test_build_page_marked_text_produces_stable_markers(self):
        pages, _ = normalize_markdown_to_pages(
            selected_page_markdown=["Alpha", "Beta"],
            selected_parser="docling_images",
            inspection=make_inspection(2),
            exact_page_segmentation=True,
            document_markdown="Alpha\n\nBeta",
        )
        self.assertEqual(
            build_page_marked_text(pages), "[PAGE 1]\nAlpha\n\n[PAGE 2]\nBeta"
        )

    def test_exact_segmentation_spans_are_monotonic_and_valid(self):
        texts = ["Alpha", "Beta text", "Gamma"]
        pages, views = normalize_markdown_to_pages(
            selected_page_markdown=texts,
            selected_parser="docling_images",
            inspection=make_inspection(3),
            exact_page_segmentation=True,
            document_markdown="\n\n".join(texts),
        )
        self.assertEqual(views.page_marked_text, build_page_marked_text(pages))
        previous_plain_end = -1
        previous_marked_end = -1
        for page, text in zip(pages, texts, strict=True):
            span = page.char_span
            self.assertIsNotNone(span)
            self.assertIsNotNone(span.page_marked_text_start)
            self.assertIsNotNone(span.page_marked_text_end)
            self.assertLessEqual(span.plain_text_start, span.plain_text_end)
            self.assertGreater(span.plain_text_start, previous_plain_end)
            self.assertGreater(span.page_marked_text_start, previous_marked_end)
            previous_plain_end = span.plain_text_end
            previous_marked_end = span.page_marked_text_end
            # Spans must slice the views back to the exact page text.
            self.assertEqual(
                views.plain_text[span.plain_text_start : span.plain_text_end], text
            )
            self.assertEqual(
                views.page_marked_text[
                    span.page_marked_text_start : span.page_marked_text_end
                ],
                text,
            )

    def test_document_level_fallback_keeps_native_page_text(self):
        pages, views = normalize_markdown_to_pages(
            selected_page_markdown=["# Whole document markdown"],
            selected_parser="docling_pdf",
            inspection=make_inspection(2),
            exact_page_segmentation=False,
            document_markdown="# Whole document markdown",
        )
        self.assertEqual(len(pages), 2)
        self.assertEqual(
            views.page_marked_text, "[DOCUMENT]\n# Whole document markdown"
        )
        for index, page in enumerate(pages, start=1):
            self.assertEqual(page.text, f"native {index}")
            span = page.char_span
            self.assertIsNotNone(span)
            self.assertIsNone(span.page_marked_text_start)
            self.assertEqual(
                views.plain_text[span.plain_text_start : span.plain_text_end],
                page.text,
            )
            self.assertTrue(any("document-level" in w for w in page.quality.warnings))


if __name__ == "__main__":
    unittest.main()
