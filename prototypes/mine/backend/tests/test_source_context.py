import unittest

from shared.source_context import (
    SourceAnnotation,
    SourceContextBuilder,
    SourceContextRequest,
)
from shared.source_document import PreparedSourceDocument


class SourceContextBuilderTests(unittest.TestCase):
    def test_builds_source_context_without_task_specific_helpers(self) -> None:
        document = PreparedSourceDocument(
            content=[{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,x"}}],
            page_count=2,
        )
        request = SourceContextRequest(
            text="Invoice text",
            document=document,
            annotations=(SourceAnnotation(text="total", page_number=1),),
        )

        context = SourceContextBuilder().build(request)

        self.assertEqual(context.page_count, 2)
        self.assertEqual(
            context.content,
            [
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,x"}},
                {"type": "text", "text": "Invoice text"},
                {
                    "type": "text",
                    "text": "Annotations from source document:\n- page 1: total",
                },
            ],
        )
        self.assertFalse(hasattr(context, "with_task_text"))
        self.assertFalse(hasattr(context, "template"))
        self.assertFalse(hasattr(context, "template_guidance"))
        self.assertFalse(hasattr(context, "instruction"))
        self.assertFalse(hasattr(context, "annotations_mode"))

    def test_omits_empty_annotations(self) -> None:
        context = SourceContextBuilder().build(
            SourceContextRequest(
                annotations=(SourceAnnotation(text="  ", page_number=3),)
            )
        )

        self.assertEqual(context.content, [])
        self.assertEqual(context.page_count, 0)


if __name__ == "__main__":
    unittest.main()
