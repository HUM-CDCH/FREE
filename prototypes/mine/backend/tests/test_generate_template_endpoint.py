import io
import unittest
from collections.abc import AsyncIterator
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

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
    """Exercise the /generate-template routing: file -> vision model (None),
    text -> schema_model, and pages reflecting the rendered page count."""

    def post_and_capture(self, **post_kwargs) -> dict:
        """POST to /generate-template, capturing the args handed to
        generate_template_events so we can assert on model + page count."""
        captured: dict = {}

        async def fake_events(content, chat_kwargs, temperature, pages, model=None):
            captured["content"] = content
            captured["chat_kwargs"] = chat_kwargs
            captured["temperature"] = temperature
            captured["pages"] = pages
            captured["model"] = model
            yield main.JsonLineEvent(event="done", data={})

        with patch.object(main, "generate_template_events", fake_events):
            with TestClient(main.app) as client:
                response = client.post(
                    "/generate-template",
                    headers={"accept": "application/json"},
                    **post_kwargs,
                )

        self.assertEqual(response.status_code, 200)
        return captured

    def test_file_branch_uses_vision_model_and_counts_pages(self) -> None:
        captured = self.post_and_capture(
            files={"file": ("doc.pdf", make_pdf(2), "application/pdf")},
        )

        # File path routes to the vision model (model=None lets the provider
        # fall back to its configured default vision model).
        self.assertIsNone(captured["model"])
        # pages reflects the number of rendered PDF pages.
        self.assertEqual(captured["pages"], 2)

    def test_text_branch_keeps_schema_model_and_zero_pages(self) -> None:
        captured = self.post_and_capture(
            data={"text": "Some annotations to turn into a schema."},
        )

        # Text path uses the dedicated schema (text) model.
        self.assertEqual(captured["model"], main.settings.schema_model)
        # No images are rendered for the text path.
        self.assertEqual(captured["pages"], 0)

    def test_invalid_annotations_mode_is_rejected(self) -> None:
        with TestClient(main.app) as client:
            response = client.post(
                "/generate-template",
                headers={"accept": "application/json"},
                data={"text": "x", "annotations_mode": "bogus"},
            )

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
