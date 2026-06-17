import asyncio
import unittest
from typing import Any

import httpx

from config import Settings
from model_providers import (
    OllamaProvider,
    OpenAICompatibleProvider,
    create_model_provider,
)


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


class ModelProviderTests(unittest.TestCase):
    def make_settings(self, provider: str = "vllm") -> Settings:
        return Settings(
            provider=provider,
            base_url="http://example.test/v1",
            model="test-model",
            api_key="secret",
            max_tokens=123,
            system_prompt="test system",
            _env_file=None,
        )

    def collect(self, provider: OpenAICompatibleProvider):
        async def run():
            return [
                delta
                async for delta in provider.stream_chat(
                    [{"type": "text", "text": "Document body"}],
                    {"enable_thinking": True},
                    temperature=0.2,
                )
            ]

        return asyncio.run(run())

    def test_factory_selects_ollama_provider(self) -> None:
        client = FakeAsyncClient([])

        provider = create_model_provider(self.make_settings("ollama"), client)  # type: ignore[arg-type]

        self.assertIsInstance(provider, OllamaProvider)

    def test_factory_selects_vllm_provider(self) -> None:
        client = FakeAsyncClient([])

        provider = create_model_provider(self.make_settings("vllm"), client)  # type: ignore[arg-type]

        self.assertIs(type(provider), OpenAICompatibleProvider)

    def test_factory_keeps_openai_provider_as_openai_compatible(self) -> None:
        client = FakeAsyncClient([])

        provider = create_model_provider(self.make_settings("openai"), client)  # type: ignore[arg-type]

        self.assertIs(type(provider), OpenAICompatibleProvider)

    def test_stream_chat_yields_reasoning_and_content_deltas(self) -> None:
        client = FakeAsyncClient(
            [
                'data: {"choices":[{"delta":{"reasoning_content":"thinking ","content":"Hi"}}]}',
                'data: {"choices":[{"delta":{"content":[{"text":" there"}]}}]}',
                "data: [DONE]",
                'data: {"choices":[{"delta":{"content":"ignored"}}]}',
            ]
        )
        provider = OpenAICompatibleProvider(self.make_settings(), client)  # type: ignore[arg-type]

        self.assertEqual(
            self.collect(provider),
            [("thinking ", "Hi"), ("", " there")],
        )
        self.assertEqual(client.calls[0]["method"], "POST")
        self.assertEqual(
            client.calls[0]["url"],
            "http://example.test/v1/chat/completions",
        )
        self.assertEqual(client.calls[0]["headers"], {"Authorization": "Bearer secret"})

    def test_stream_chat_ignores_malformed_and_empty_chunks(self) -> None:
        client = FakeAsyncClient(
            [
                "event: keep-alive",
                "data: not-json",
                'data: {"choices":[]}',
                'data: {"choices":[{"delta":{"content":"done"}}]}',
                "data: [DONE]",
            ]
        )
        provider = OpenAICompatibleProvider(self.make_settings(), client)  # type: ignore[arg-type]

        self.assertEqual(self.collect(provider), [("", "done")])

    def test_stream_chat_error_reads_stream_body_before_raising(self) -> None:
        client = FakeErrorAsyncClient("upstream failed before streaming")
        provider = OpenAICompatibleProvider(self.make_settings(), client)  # type: ignore[arg-type]

        with self.assertRaises(httpx.HTTPStatusError) as error:
            self.collect(provider)

        message = str(error.exception)
        self.assertIn("HTTP 500 Internal Server Error", message)
        self.assertIn("upstream failed before streaming", message)

    def test_ollama_and_vllm_preserve_prepared_content(self) -> None:
        content = [
            {"type": "text", "text": "Prepared task prompt"},
            {"type": "text", "text": "Document body"},
        ]
        template_kwargs = {"mode": "structured", "enable_thinking": False}
        ollama = OllamaProvider(self.make_settings("ollama"), None)  # type: ignore[arg-type]
        vllm = OpenAICompatibleProvider(self.make_settings("vllm"), None)  # type: ignore[arg-type]

        ollama_payload = ollama.build_payload(
            content, template_kwargs, temperature=0.2, stream=True
        )
        vllm_payload = vllm.build_payload(
            content, template_kwargs, temperature=0.2, stream=True
        )

        self.assertEqual(ollama_payload["messages"][1]["content"], content)
        self.assertEqual(vllm_payload["messages"][1]["content"], content)
        self.assertEqual(ollama_payload["chat_template_kwargs"], template_kwargs)
        self.assertEqual(vllm_payload["chat_template_kwargs"], template_kwargs)

    def test_provider_package_does_not_export_nuextract_prompt_helpers(self) -> None:
        import model_providers

        self.assertFalse(hasattr(model_providers, "nuextract_task_prompt"))
        self.assertFalse(hasattr(model_providers, "prepare_nuextract_content"))


if __name__ == "__main__":
    unittest.main()
