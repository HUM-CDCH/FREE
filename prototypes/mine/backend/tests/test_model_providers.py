import asyncio
import unittest
from typing import Any

import httpx

from model_providers import ModelProviderError, ProviderHTTPTransport, chat_delta_to_text
from shared.request_compiler import PreparedProviderRequest


class FakeStreamResponse:
    def __init__(self, lines: list[str]):
        self.lines = lines

    def raise_for_status(self) -> None:
        return None

    async def aiter_lines(self):
        for line in self.lines:
            yield line


class FakeErrorStreamResponse(FakeStreamResponse):
    status_code = 500
    reason_phrase = "Internal Server Error"

    def __init__(self, body: str):
        super().__init__([])
        self.body = body.encode()
        self.request = httpx.Request("POST", "http://example.test/v1/chat/completions")
        self.url = self.request.url

    def raise_for_status(self) -> None:
        raise httpx.HTTPStatusError(
            "unread streaming response",
            request=self.request,
            response=self,  # type: ignore[arg-type]
        )

    async def aread(self) -> bytes:
        return self.body


class FakeStreamContext:
    def __init__(self, response: FakeStreamResponse):
        self.response = response

    async def __aenter__(self) -> FakeStreamResponse:
        return self.response

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None


class FakeAsyncClient:
    def __init__(self, lines: list[str]):
        self.lines = lines
        self.calls: list[dict[str, Any]] = []

    def stream(self, method: str, url: str, **kwargs: Any) -> FakeStreamContext:
        self.calls.append({"method": method, "url": url, **kwargs})
        return FakeStreamContext(FakeStreamResponse(self.lines))


class FakeErrorAsyncClient(FakeAsyncClient):
    def __init__(self, body: str):
        super().__init__([])
        self.body = body

    def stream(self, method: str, url: str, **kwargs: Any) -> FakeStreamContext:
        self.calls.append({"method": method, "url": url, **kwargs})
        return FakeStreamContext(FakeErrorStreamResponse(self.body))


class FakeConnectErrorClient:
    def stream(self, method: str, url: str, **kwargs: Any) -> FakeStreamContext:
        raise httpx.ConnectError("boom")


class ProviderHTTPTransportTests(unittest.TestCase):
    def prepared(self) -> PreparedProviderRequest:
        return PreparedProviderRequest(
            url="http://example.test/v1/chat/completions",
            headers={"Authorization": "Bearer secret"},
            payload={
                "model": "test-model",
                "stream": True,
                "messages": [],
                "chat_template_kwargs": {"enable_thinking": True},
            },
        )

    def collect(self, transport: ProviderHTTPTransport, prepared=None):
        async def run():
            return [
                delta
                async for delta in transport.stream(prepared or self.prepared())
            ]

        return asyncio.run(run())

    def test_chat_delta_to_text_reads_reasoning_and_content(self) -> None:
        self.assertEqual(
            chat_delta_to_text(
                {
                    "choices": [
                        {
                            "delta": {
                                "reasoning_content": "thinking ",
                                "content": [{"text": "Hi"}, {"text": " there"}],
                            }
                        }
                    ]
                }
            ),
            ("thinking ", "Hi there"),
        )

    def test_stream_posts_prepared_request_unchanged(self) -> None:
        client = FakeAsyncClient(
            [
                'data: {"choices":[{"delta":{"reasoning_content":"thinking ","content":"Hi"}}]}',
                'data: {"choices":[{"delta":{"content":[{"text":" there"}]}}]}',
                "data: [DONE]",
                'data: {"choices":[{"delta":{"content":"ignored"}}]}',
            ]
        )
        transport = ProviderHTTPTransport(client)  # type: ignore[arg-type]
        prepared = self.prepared()

        self.assertEqual(
            self.collect(transport, prepared),
            [("thinking ", "Hi"), ("", " there")],
        )
        self.assertEqual(
            client.calls,
            [
                {
                    "method": "POST",
                    "url": prepared.url,
                    "json": dict(prepared.payload),
                    "headers": dict(prepared.headers),
                }
            ],
        )

    def test_stream_ignores_malformed_and_empty_chunks(self) -> None:
        client = FakeAsyncClient(
            [
                "event: keep-alive",
                "data: not-json",
                'data: {"choices":[]}',
                'data: {"choices":[{"delta":{"content":"done"}}]}',
                "data: [DONE]",
            ]
        )
        transport = ProviderHTTPTransport(client)  # type: ignore[arg-type]

        self.assertEqual(self.collect(transport), [("", "done")])

    def test_status_error_preserves_response_body(self) -> None:
        transport = ProviderHTTPTransport(  # type: ignore[arg-type]
            FakeErrorAsyncClient("upstream failed before streaming")
        )

        with self.assertRaises(ModelProviderError) as error:
            self.collect(transport)

        self.assertEqual(error.exception.status_code, 500)
        self.assertEqual(
            error.exception.url, "http://example.test/v1/chat/completions"
        )
        self.assertIn("HTTP 500 Internal Server Error", error.exception.raw_detail)
        self.assertIn(
            "upstream failed before streaming", error.exception.raw_detail
        )
        self.assertIn("Model endpoint error:", str(error.exception))

    def test_connection_error_preserves_cause(self) -> None:
        transport = ProviderHTTPTransport(FakeConnectErrorClient())  # type: ignore[arg-type]

        with self.assertRaises(ModelProviderError) as error:
            self.collect(transport)

        self.assertEqual(error.exception.raw_detail, "boom")
        self.assertIsInstance(error.exception.__cause__, httpx.ConnectError)

    def test_provider_package_does_not_export_legacy_adapters(self) -> None:
        import model_providers

        self.assertFalse(hasattr(model_providers, "ModelProvider"))
        self.assertFalse(hasattr(model_providers, "OllamaProvider"))
        self.assertFalse(hasattr(model_providers, "OpenAICompatibleProvider"))
        self.assertFalse(hasattr(model_providers, "create_model_provider"))


if __name__ == "__main__":
    unittest.main()
