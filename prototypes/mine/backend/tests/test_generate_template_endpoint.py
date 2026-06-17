import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import application
import main


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

    def provider(self, chunks, check=None):
        class FakeProvider:
            async def stream_chat(self, content, template_kwargs, temperature):
                if check is not None:
                    check(content, template_kwargs, temperature)
                for chunk in chunks:
                    yield chunk

        return FakeProvider()

    def test_returns_template_and_counts_pages(self) -> None:
        def check(content, template_kwargs, temperature):
            self.assertEqual(temperature, 0.2)
            self.assertEqual(
                [part["type"] for part in content[:2]],
                ["image_url", "image_url"],
            )
            self.assertIn("Generate a concise JSON extraction template", content[2]["text"])
            self.assertEqual(template_kwargs["mode"], "template-generation")

        provider = self.provider([("", '{"site": "string"}')], check)

        with patch.object(main.settings, "provider", "vllm"):
            with patch.object(application, "create_model_provider", return_value=provider):
                with TestClient(main.app) as client:
                    response = client.post(
                        "/generate-template",
                        headers={"accept": "application/json"},
                        files={"file": ("doc.pdf", make_pdf(2), "application/pdf")},
                        data={"temperature": "0.2"},
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
