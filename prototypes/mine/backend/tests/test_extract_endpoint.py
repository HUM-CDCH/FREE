import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import application
import main


class ExtractEndpointTests(unittest.TestCase):
    def test_structured_extract_sends_prepared_nuextract_request(self) -> None:
        calls = []
        test_case = self

        class FakeProvider:
            async def stream_chat(self, content, template_kwargs, temperature):
                calls.append((content, template_kwargs, temperature))
                test_case.assertIn("Return ONLY a single JSON object", content[0]["text"])
                test_case.assertEqual(content[1]["text"], "Document body")
                test_case.assertEqual(
                    content[2]["text"],
                    'Instructions:\nUse source text only.\n\n'
                    'Extraction template:\n```json\n{\n    "name": "string"\n}\n```',
                )
                test_case.assertEqual(
                    template_kwargs,
                    {
                        "mode": "structured",
                        "enable_thinking": False,
                        "template": '{\n    "name": "string"\n}',
                        "instructions": "Use source text only.",
                    },
                )
                test_case.assertEqual(temperature, 0.2)
                yield "", '{"name": "Ellekilde"}'

        with patch.object(application, "create_model_provider", return_value=FakeProvider()):
            with TestClient(main.app) as client:
                response = client.post(
                    "/extract",
                    headers={"accept": "application/json"},
                    data={
                        "text": "Document body",
                        "template": '{"name": "string"}',
                        "instruction": "Use source text only.",
                    },
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"], {"name": "Ellekilde"})
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
