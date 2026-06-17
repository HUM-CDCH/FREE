import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import main
from use_cases import markdown


def make_pdf(page_count: int) -> bytes:
    images = [Image.new("RGB", (80, 100), "white") for _ in range(page_count)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="PDF", save_all=True, append_images=images[1:])
    return buffer.getvalue()


class MarkdownEndpointTests(unittest.TestCase):
    def test_renders_whole_document_in_one_call(self) -> None:
        calls: list[list[dict]] = []

        async def fake_model_stream(content, chat_kwargs, temperature):
            calls.append(content)
            self.assertEqual(chat_kwargs["mode"], "markdown")
            yield "", "  # Document\n\nbody text  "

        with patch.object(markdown, "call_model_stream", fake_model_stream):
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
            ["image_url", "image_url", "image_url"],
        )


if __name__ == "__main__":
    unittest.main()
