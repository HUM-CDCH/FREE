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
    required, pages reflect the rendered page count, and bad input is rejected."""

    def post_and_capture(self, **post_kwargs) -> dict:
        """POST to /generate-template, capturing the args handed to
        generate_template_events so we can assert on the page count."""
        captured: dict = {}

        async def fake_events(content, chat_kwargs, temperature, pages):
            captured["content"] = content
            captured["chat_kwargs"] = chat_kwargs
            captured["temperature"] = temperature
            captured["pages"] = pages
            yield main.JsonLineEvent(event="done", data={})

        with patch.object(generate_template, "generate_template_events", fake_events):
            with TestClient(main.app) as client:
                response = client.post(
                    "/generate-template",
                    headers={"accept": "application/json"},
                    **post_kwargs,
                )

        self.assertEqual(response.status_code, 200)
        return captured

    def test_file_branch_counts_pages(self) -> None:
        captured = self.post_and_capture(
            files={"file": ("doc.pdf", make_pdf(2), "application/pdf")},
        )

        # pages reflects the number of rendered PDF pages.
        self.assertEqual(captured["pages"], 2)

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
