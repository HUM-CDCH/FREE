import asyncio
import unittest
from collections.abc import AsyncIterator
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import application
import main
from config import Settings
from model_providers import ModelProviderError
from shared.model_executor import ModelExecutor
from shared.request_compiler import RequestCompiler
from shared.streaming import JsonLineEvent
from use_cases.chat import ChatPipeline, ChatRequest


class ChatEndpointTests(unittest.TestCase):
    def collect_events(self, events: AsyncIterator[JsonLineEvent]):
        async def collect():
            return [event async for event in events]

        return asyncio.run(collect())

    def make_transport(self, chunks=None, error=None):
        class FakeTransport:
            def __init__(self):
                self.calls = []

            async def stream(self, prepared):
                self.calls.append(prepared)
                if error is not None:
                    raise error
                for chunk in chunks or []:
                    yield chunk

        return FakeTransport()

    def make_executor(self, transport) -> ModelExecutor:
        return ModelExecutor(
            RequestCompiler(
                Settings(
                    provider="vllm",
                    base_url="http://example.test/v1",
                    model="test-model",
                    max_tokens=123,
                    system_prompt="test system",
                    _env_file=None,
                )
            ),
            transport,
        )

    def test_chat_stream_emits_final_message(self) -> None:
        transport = self.make_transport(
            [("thinking ", ""), ("", "Hello"), ("", " world")]
        )
        pipeline = ChatPipeline(self.make_executor(transport))

        events = self.collect_events(
            pipeline.stream(
                ChatRequest(
                    text="Say hello",
                    temperature=0.6,
                    reasoning=True,
                )
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
        transport = self.make_transport([("", "Hi")])

        with patch.object(application, "ProviderHTTPTransport", return_value=transport):
            with TestClient(main.app) as client:
                response = client.post(
                    "/chat",
                    data={"text": " Hello "},
                    headers={"accept": "application/json"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(
            transport.calls[0].payload["messages"][1]["content"],
            [{"type": "text", "text": "Hello"}],
        )
        self.assertEqual(
            transport.calls[0].payload["chat_template_kwargs"],
            {"enable_thinking": False},
        )
        self.assertEqual(transport.calls[0].payload["temperature"], 0.2)
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
        cause = httpx.ConnectError("boom")
        error = ModelProviderError(
            "Model endpoint error: boom", raw_detail="boom", cause=cause
        )
        transport = self.make_transport(error=error)

        with patch.object(application, "ProviderHTTPTransport", return_value=transport):
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
