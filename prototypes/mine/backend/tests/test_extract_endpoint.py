import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import application
import main


class ExtractEndpointTests(unittest.TestCase):
    def test_structured_extract_sends_prepared_nuextract_request(self) -> None:
        calls = []
        test_case = self

        class FakeTransport:
            async def stream(self, prepared):
                calls.append(prepared)
                payload = prepared.payload
                content = payload["messages"][1]["content"]
                template_kwargs = payload["chat_template_kwargs"]
                test_case.assertEqual(content[0]["text"], "Document body")
                test_case.assertEqual(
                    {
                        key: value
                        for key, value in template_kwargs.items()
                        if key != "instructions"
                    },
                    {
                        "mode": "structured",
                        "enable_thinking": False,
                        "template": '{\n    "name": "string"\n}',
                    },
                )
                instructions = template_kwargs["instructions"]
                test_case.assertIn(
                    "Return ONLY a single JSON object",
                    instructions,
                )
                test_case.assertIn(
                    "Additional instructions:\nUse source text only.",
                    instructions,
                )
                test_case.assertNotIn("task_instructions", template_kwargs)
                test_case.assertEqual(payload["temperature"], 0.2)
                yield "", '{"name": "Ellekilde"}'

        with patch.object(main.settings, "provider", "vllm"):
            transport_patch = patch.object(
                application, "ProviderHTTPTransport", return_value=FakeTransport()
            )
            with transport_patch:
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
