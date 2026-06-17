import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import application
import main


def make_pdf(page_count: int) -> bytes:
    images = [Image.new("RGB", (80, 100), "white") for _ in range(page_count)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="PDF", save_all=True, append_images=images[1:])
    return buffer.getvalue()


class MarkdownEndpointTests(unittest.TestCase):
    def test_renders_whole_document_in_one_call(self) -> None:
        calls: list[list[dict]] = []
        test_case = self

        class FakeProvider:
            async def stream_chat(self, content, template_kwargs, temperature):
                calls.append(content)
                test_case.assertIn("Markdown", content[0]["text"])
                test_case.assertEqual(template_kwargs["mode"], "markdown")
                yield "", "  # Document\n\nbody text  "

        with patch.object(
            application, "create_model_provider", return_value=FakeProvider()
        ):
            with TestClient(main.app) as client:
                response = client.post(
                    "/markdown",
                    headers={"accept": "application/json"},
                    files={"file": ("doc.pdf", make_pdf(3), "application/pdf")},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(), {"markdown": "# Document\n\nbody text", "pages": 3}
        )
        # One model call carrying all three page images, in page order.
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            [part["type"] for part in calls[0]],
            ["text", "image_url", "image_url", "image_url"],
        )


if __name__ == "__main__":
    unittest.main()
