import asyncio
import unittest
from collections.abc import AsyncIterator
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import main
from use_cases import chat


class ChatEndpointTests(unittest.TestCase):
    def collect_events(self, events: AsyncIterator[main.JsonLineEvent]):
        async def collect():
            return [event async for event in events]

        return asyncio.run(collect())

    def test_chat_events_emit_final_message(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            yield "thinking ", ""
            yield "", "Hello"
            yield "", " world"

        content = [{"type": "text", "text": "Say hello"}]
        with patch.object(chat, "call_model_stream", fake_model_stream):
            events = self.collect_events(
                main.chat_events(
                    content,
                    {"enable_thinking": True},
                    temperature=0.6,
                    reasoning=True,
                )
            )

        self.assertEqual(events[0].event, "delta")
        self.assertEqual(events[0].data, {"think": "thinking ", "output": ""})
        self.assertEqual(events[1].data, {"think": "", "output": "Hello"})
        self.assertEqual(events[2].data, {"think": "", "output": " world"})
        self.assertEqual(events[3].event, "done")
        self.assertEqual(
            events[3].data,
            {
                "message": "Hello world",
                "reasoning": "thinking",
                "raw": "Hello world",
            },
        )

    def test_chat_returns_buffered_json_for_json_clients(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            self.assertEqual(content, [{"type": "text", "text": "Hello"}])
            self.assertEqual(chat_kwargs, {"enable_thinking": False})
            self.assertEqual(temperature, 0.2)
            yield "", "Hi"

        with patch.object(chat, "call_model_stream", fake_model_stream):
            with TestClient(main.app) as client:
                response = client.post(
                    "/chat",
                    data={"text": " Hello "},
                    headers={"accept": "application/json"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/json")
        self.assertEqual(
            response.json(),
            [
                {"event": "delta", "data": {"think": "", "output": "Hi"}},
                {
                    "event": "done",
                    "data": {"message": "Hi", "reasoning": None, "raw": "Hi"},
                },
            ],
        )

    def test_chat_rejects_empty_text(self) -> None:
        with TestClient(main.app) as client:
            response = client.post(
                "/chat",
                data={"text": "   "},
                headers={"accept": "application/json"},
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "Provide chat text"})

    def test_chat_returns_error_event_for_model_http_errors(self) -> None:
        async def fake_model_stream(content, chat_kwargs, temperature):
            if False:
                yield "", ""
            raise httpx.ConnectError("boom")

        with patch.object(chat, "call_model_stream", fake_model_stream):
            with TestClient(main.app) as client:
                response = client.post(
                    "/chat",
                    data={"text": "Hello"},
                    headers={"accept": "application/json"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            [
                {
                    "event": "error",
                    "data": {"detail": "Model endpoint error: boom"},
                }
            ],
        )

    def test_only_chat_advertises_jsonl_other_endpoints_json_only(self) -> None:
        with TestClient(main.app) as client:
            openapi = client.get("/openapi.json").json()

        chat_content = openapi["paths"]["/chat"]["post"]["responses"]["200"]["content"]
        self.assertIn("application/json", chat_content)
        self.assertIn("application/jsonl", chat_content)

        for path in ["/extract", "/generate-template", "/markdown"]:
            content = openapi["paths"][path]["post"]["responses"]["200"]["content"]
            self.assertIn("application/json", content)
            self.assertNotIn("application/jsonl", content)


if __name__ == "__main__":
    unittest.main()
