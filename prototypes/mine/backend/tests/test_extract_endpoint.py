import asyncio
import io
import unittest
from collections.abc import AsyncIterator
from unittest.mock import patch

from PIL import Image

import main


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

    def collect_events(self, events: AsyncIterator[main.JsonLineEvent]):
        async def collect():
            return [event async for event in events]

        return asyncio.run(collect())

    def test_structured_extract_rejects_invalid_json_result(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            yield "", "not json at all"

        with patch.object(main, "call_model_stream", fake_model_stream):
            events = self.collect_events(
                main.extract_events(
                    [{"type": "text", "text": "Document"}],
                    {"mode": "structured", "template": '{"field":"string"}'},
                    temperature=0.2,
                    reasoning=False,
                    pages=0,
                )
            )

        self.assertEqual(events[0].event, "delta")
        self.assertEqual(events[1].event, "error")
        self.assertEqual(
            events[1].data["detail"],
            "Model returned invalid JSON for the extraction result",
        )
        self.assertEqual(len(events), 2)

    def test_structured_extract_repairs_object_sequence_with_hyphenated_ids(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            yield "", (
                '{"Gravnummer": 8, "fund": [{"nummer": 8-1}]}, '
                '{"Gravnummer": 13, "fund": [{"nummer": 13-2}]}'
            )

        with patch.object(main, "call_model_stream", fake_model_stream):
            events = self.collect_events(
                main.extract_events(
                    [{"type": "text", "text": "Document"}],
                    {"mode": "structured", "template": '{"field":"string"}'},
                    temperature=0.2,
                    reasoning=False,
                    pages=0,
                )
            )

        self.assertEqual(events[0].event, "delta")
        self.assertEqual(events[1].event, "done")
        self.assertEqual(
            events[1].data["result"],
            {
                "items": [
                    {"Gravnummer": 8, "fund": [{"nummer": "8-1"}]},
                    {"Gravnummer": 13, "fund": [{"nummer": "13-2"}]},
                ]
            },
        )

    def test_structured_extract_repairs_missing_opening_array_bracket(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            yield "", (
                '{"Gravnummer": 8, "fund": [{"nummer": 8-1}]}, '
                '{"Gravnummer": 13, "fund": [{"nummer": 13-2}]}]'
            )

        with patch.object(main, "call_model_stream", fake_model_stream):
            events = self.collect_events(
                main.extract_events(
                    [{"type": "text", "text": "Document"}],
                    {"mode": "structured", "template": '{"field":"string"}'},
                    temperature=0.2,
                    reasoning=False,
                    pages=0,
                )
            )

        self.assertEqual(events[1].event, "done")
        self.assertEqual(len(events[1].data["result"]["items"]), 2)

    def test_structured_result_parser_repairs_missing_opening_array_bracket(self) -> None:
        result = main.parse_json_object_result(
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

    def test_openai_extract_duplicates_nuextract_controls_in_message_text(self) -> None:
        self.configure(provider="openai")
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

        with patch.object(main, "call_model_stream", fake_model_stream):
            from fastapi.testclient import TestClient

            with TestClient(main.app) as client:
                response = client.post(
                    "/extract",
                    data={
                        "text": " Invoice text ",
                        "template": '{"store":"verbatim-string"}',
                        "instruction": " Use ISO dates ",
                    },
                    headers={"accept": "application/json"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[-1]["event"], "done")
        self.assertEqual(response.json()[-1]["data"]["result"]["store"], "Trader Joe's")

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

        with patch.object(main, "call_model_stream", fake_model_stream):
            from fastapi.testclient import TestClient

            with TestClient(main.app) as client:
                response = client.post(
                    "/extract",
                    data={
                        "text": " Invoice text ",
                        "template": '{"store":"verbatim-string"}',
                        "instruction": " Use ISO dates ",
                    },
                    headers={"accept": "application/json"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[-1]["event"], "done")


if __name__ == "__main__":
    unittest.main()
