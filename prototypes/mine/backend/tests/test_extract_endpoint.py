import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import main
from shared.json_repair import parse_json_object_result
from use_cases import extract


class ExtractEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_settings = main.settings

    def tearDown(self) -> None:
        main.settings = self.original_settings

    def configure(self, provider: str) -> None:
        main.settings = main.Settings(
            provider=provider,
            base_url="http://127.0.0.1:11434",
            model="test-model",
            api_key="",
            max_tokens=123,
            system_prompt="test system",
            _env_file=None,
        )

    def post_extract(self, data: dict) -> "object":
        with TestClient(main.app) as client:
            return client.post(
                "/extract", data=data, headers={"accept": "application/json"}
            )

    def test_structured_extract_rejects_invalid_json_result(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            yield "", "not json at all"

        with patch.object(extract, "call_model_stream", fake_model_stream):
            response = self.post_extract(
                {"text": "Document", "template": '{"field":"string"}'}
            )

        self.assertEqual(response.status_code, 502)
        detail = response.json()["detail"]
        self.assertEqual(
            detail["message"],
            "Model returned invalid JSON for the extraction result",
        )
        self.assertEqual(detail["raw"], "not json at all")

    def test_structured_extract_repairs_object_sequence_with_hyphenated_ids(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            yield "", (
                '{"Gravnummer": 8, "fund": [{"nummer": 8-1}]}, '
                '{"Gravnummer": 13, "fund": [{"nummer": 13-2}]}'
            )

        with patch.object(extract, "call_model_stream", fake_model_stream):
            response = self.post_extract(
                {"text": "Document", "template": '{"field":"string"}'}
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(
            body["result"],
            {
                "items": [
                    {"Gravnummer": 8, "fund": [{"nummer": "8-1"}]},
                    {"Gravnummer": 13, "fund": [{"nummer": "13-2"}]},
                ]
            },
        )
        self.assertEqual(body["pages"], 0)

    def test_structured_extract_repairs_missing_opening_array_bracket(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            yield "", (
                '{"Gravnummer": 8, "fund": [{"nummer": 8-1}]}, '
                '{"Gravnummer": 13, "fund": [{"nummer": 13-2}]}]'
            )

        with patch.object(extract, "call_model_stream", fake_model_stream):
            response = self.post_extract(
                {"text": "Document", "template": '{"field":"string"}'}
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["result"]["items"]), 2)

    def test_structured_result_parser_repairs_missing_opening_array_bracket(self) -> None:
        result = parse_json_object_result(
            '{"Gravnummer": 8, "fund": [{"nummer": 8-1}]}, '
            '{"Gravnummer": 13, "fund": [{"nummer": 13-2}]}]'
        )

        self.assertEqual(
            result,
            {
                "items": [
                    {"Gravnummer": 8, "fund": [{"nummer": "8-1"}]},
                    {"Gravnummer": 13, "fund": [{"nummer": "13-2"}]},
                ]
            },
        )

    def test_pages_to_jpeg_renders_pdf_at_default_dpi(self) -> None:
        original_settings = main.settings
        try:
            main.settings = main.Settings(pdf_dpi=64, _env_file=None)
            pdf = io.BytesIO()
            Image.new("RGB", (10, 10), "white").save(pdf, format="PDF")

            pages = main.pages_to_jpeg(pdf.getvalue(), "application/pdf")
        finally:
            main.settings = original_settings

        self.assertEqual(len(pages), 1)
        self.assertTrue(pages[0].startswith(b"\xff\xd8"))

    def test_vllm_extract_duplicates_nuextract_controls_in_message_text(self) -> None:
        self.configure(provider="vllm")
        expected_template = '{\n    "store": "verbatim-string"\n}'
        expected_text = (
            "Invoice text\n\n"
            "Instructions:\nUse ISO dates\n\n"
            f"Extraction template:\n```json\n{expected_template}\n```"
        )

        async def fake_model_stream(content, chat_kwargs, temperature):
            self.assertEqual(content, [{"type": "text", "text": expected_text}])
            self.assertEqual(
                chat_kwargs,
                {
                    "mode": "structured",
                    "enable_thinking": False,
                    "template": expected_template,
                    "instructions": "Use ISO dates",
                },
            )
            self.assertEqual(temperature, 0.2)
            yield "", '{"store": "Trader Joe\'s"}'

        with patch.object(extract, "call_model_stream", fake_model_stream):
            response = self.post_extract(
                {
                    "text": " Invoice text ",
                    "template": '{"store":"verbatim-string"}',
                    "instruction": " Use ISO dates ",
                }
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"]["store"], "Trader Joe's")

    def test_ollama_extract_embeds_nuextract_controls_in_message_text(self) -> None:
        self.configure(provider="ollama")
        expected_template = '{\n    "store": "verbatim-string"\n}'

        async def fake_model_stream(content, chat_kwargs, temperature):
            self.assertEqual(len(content), 1)
            self.assertIn("Invoice text", content[0]["text"])
            self.assertIn("Instructions:\nUse ISO dates", content[0]["text"])
            self.assertIn(
                f"Extraction template:\n```json\n{expected_template}\n```",
                content[0]["text"],
            )
            self.assertEqual(
                chat_kwargs,
                {
                    "mode": "structured",
                    "enable_thinking": False,
                    "template": expected_template,
                    "instructions": "Use ISO dates",
                },
            )
            yield "", '{"store": "Trader Joe\'s"}'

        with patch.object(extract, "call_model_stream", fake_model_stream):
            response = self.post_extract(
                {
                    "text": " Invoice text ",
                    "template": '{"store":"verbatim-string"}',
                    "instruction": " Use ISO dates ",
                }
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"]["store"], "Trader Joe's")


if __name__ == "__main__":
    unittest.main()
