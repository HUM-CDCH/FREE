import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import main
from use_cases import generate_template


def make_pdf(page_count: int) -> bytes:
    """Build an in-memory PDF with the requested number of pages."""
    images = [Image.new("RGB", (80, 100), "white") for _ in range(page_count)]
    buffer = io.BytesIO()
    images[0].save(
        buffer, format="PDF", save_all=True, append_images=images[1:]
    )
    return buffer.getvalue()


class GenerateTemplateEndpointTests(unittest.TestCase):
    """Exercise the file-only /generate-template routing: a document file is
    required, the buffered response carries the template and the rendered page
    count, and bad input is rejected."""

    def test_returns_template_and_counts_pages(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            self.assertEqual(temperature, 0.2)
            self.assertEqual(chat_kwargs["mode"], "template-generation")
            yield "", '{"site": "string"}'

        with patch.object(generate_template, "call_model_stream", fake_model_stream):
            with TestClient(main.app) as client:
                response = client.post(
                    "/generate-template",
                    headers={"accept": "application/json"},
                    files={"file": ("doc.pdf", make_pdf(2), "application/pdf")},
                )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["template"], {"site": "string"})
        self.assertEqual(body["pages"], 2)

    def test_missing_file_is_rejected(self) -> None:
        with TestClient(main.app) as client:
            response = client.post(
                "/generate-template",
                headers={"accept": "application/json"},
                data={"annotations_mode": "hints"},
            )

        self.assertEqual(response.status_code, 400)

    def test_invalid_annotations_mode_is_rejected(self) -> None:
        with TestClient(main.app) as client:
            response = client.post(
                "/generate-template",
                headers={"accept": "application/json"},
                files={"file": ("doc.pdf", make_pdf(1), "application/pdf")},
                data={"annotations_mode": "bogus"},
            )

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
