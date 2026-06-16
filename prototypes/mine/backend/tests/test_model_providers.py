import asyncio
import unittest
from typing import Any

import main
from model_providers import (
    OllamaProvider,
    OpenAICompatibleProvider,
    create_model_provider,
    nuextract_task_prompt,
    prepare_nuextract_content,
)


class FakeStreamResponse:
    def __init__(self, lines: list[str]):
        self.lines = lines

    def raise_for_status(self) -> None:
        return None

    async def aiter_lines(self):
        for line in self.lines:
            yield line


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


class ModelProviderTests(unittest.TestCase):
    def make_settings(self, provider: str = "vllm") -> main.Settings:
        return main.Settings(
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

    def test_ollama_and_vllm_share_mode_task_prompts(self) -> None:
        content = [{"type": "text", "text": "Document body"}]
        modes = ["structured", "content", "markdown", "template-generation"]

        for mode in modes:
            chat_kwargs = {"mode": mode, "enable_thinking": False}
            ollama = OllamaProvider(self.make_settings("ollama"), None)  # type: ignore[arg-type]
            vllm = OpenAICompatibleProvider(self.make_settings("vllm"), None)  # type: ignore[arg-type]

            ollama_payload = ollama.build_payload(
                content, chat_kwargs, temperature=0.2, stream=True
            )
            vllm_payload = vllm.build_payload(
                content, chat_kwargs, temperature=0.2, stream=True
            )
            ollama_content = ollama_payload["messages"][1]["content"]
            vllm_content = vllm_payload["messages"][1]["content"]

            self.assertEqual(ollama_content[0], vllm_content[0])
            self.assertEqual(ollama_content[0]["text"], nuextract_task_prompt(chat_kwargs))
            self.assertEqual(ollama_content[1], content[0])
            self.assertEqual(vllm_content[1], content[0])

    def test_shared_task_prompt_is_not_duplicated(self) -> None:
        chat_kwargs = {"mode": "structured", "enable_thinking": False}
        prompt = nuextract_task_prompt(chat_kwargs)
        prepared = [{"type": "text", "text": prompt}, {"type": "text", "text": "Document"}]

        self.assertIs(prepare_nuextract_content(prepared, chat_kwargs), prepared)
        payload = OpenAICompatibleProvider(self.make_settings("vllm"), None).build_payload(  # type: ignore[arg-type]
            prepared, chat_kwargs, temperature=0.2, stream=True
        )
        user_content = payload["messages"][1]["content"]

        self.assertEqual(
            [part for part in user_content if part.get("text") == prompt],
            [prepared[0]],
        )


if __name__ == "__main__":
    unittest.main()
