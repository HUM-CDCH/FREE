import unittest

import main
from config import Settings
from model_providers import (
    OllamaProvider,
    OpenAICompatibleProvider,
    model_headers,
)


class ModelConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_settings = main.settings

    def tearDown(self) -> None:
        main.settings = self.original_settings

    def configure(
        self,
        provider: str = "ollama",
        base_url: str = "http://127.0.0.1:11434",
        api_key: str = "",
    ) -> None:
        main.settings = Settings(
            provider=provider,
            base_url=base_url,
            model="test-model",
            api_key=api_key,
            max_tokens=123,
            system_prompt="test system",
            _env_file=None,
        )

    def test_ollama_root_url_is_normalized_to_v1(self) -> None:
        self.configure(provider="ollama", base_url="http://127.0.0.1:11434")
        provider = OllamaProvider(main.settings, None)  # type: ignore[arg-type]

        self.assertEqual(
            provider.api_base_url(),
            "http://127.0.0.1:11434/v1",
        )

    def test_ollama_explicit_v1_url_is_preserved(self) -> None:
        self.configure(provider="ollama", base_url="http://127.0.0.1:11434/v1/")
        provider = OllamaProvider(main.settings, None)  # type: ignore[arg-type]

        self.assertEqual(
            provider.api_base_url(),
            "http://127.0.0.1:11434/v1",
        )

    def test_vllm_base_url_is_preserved(self) -> None:
        self.configure(provider="vllm", base_url="http://127.0.0.1:12434/engines/v1")
        provider = OpenAICompatibleProvider(main.settings, None)  # type: ignore[arg-type]

        self.assertEqual(
            provider.api_base_url(),
            "http://127.0.0.1:12434/engines/v1",
        )

    def test_auth_header_is_omitted_for_empty_or_placeholder_keys(self) -> None:
        self.assertEqual(model_headers(""), {})
        self.assertEqual(model_headers(" EMPTY "), {})

    def test_auth_header_is_sent_for_real_keys(self) -> None:
        self.assertEqual(
            model_headers("secret"),
            {"Authorization": "Bearer secret"},
        )

    def test_ollama_payload_includes_custom_template_kwargs(self) -> None:
        self.configure(provider="ollama")
        content = [
            {"type": "text", "text": "Prepared structured prompt"},
            {"type": "text", "text": "Document body"},
        ]
        template_kwargs = {
            "mode": "structured",
            "enable_thinking": True,
            "template": '{"name": "string"}',
        }

        provider = OllamaProvider(main.settings, None)  # type: ignore[arg-type]

        payload = provider.build_payload(content, template_kwargs, temperature=0.2, stream=True)

        self.assertEqual(payload["chat_template_kwargs"], template_kwargs)
        self.assertEqual(payload["model"], "test-model")
        self.assertEqual(payload["max_tokens"], 123)
        self.assertEqual(payload["reasoning"], {"effort": "medium"})
        user_content = payload["messages"][1]["content"]
        self.assertEqual(user_content, content)

    def test_ollama_payload_omits_reasoning_when_disabled(self) -> None:
        self.configure(provider="ollama")

        provider = OllamaProvider(main.settings, None)  # type: ignore[arg-type]

        payload = provider.build_payload(
            [{"type": "text", "text": "Document body"}],
            {"mode": "content", "enable_thinking": False},
            temperature=0.2,
            stream=True,
        )

        self.assertNotIn("reasoning", payload)

    def test_vllm_payload_preserves_prepared_content(self) -> None:
        self.configure(provider="vllm", base_url="http://127.0.0.1:12434/engines/v1")
        content = [
            {"type": "text", "text": "Prepared structured prompt"},
            {"type": "text", "text": "Document body"},
        ]
        template_kwargs = {"mode": "structured", "enable_thinking": True}

        provider = OpenAICompatibleProvider(main.settings, None)  # type: ignore[arg-type]

        payload = provider.build_payload(content, template_kwargs, temperature=0.2, stream=True)

        self.assertEqual(payload["chat_template_kwargs"], template_kwargs)
        user_content = payload["messages"][1]["content"]
        self.assertEqual(user_content, content)
        self.assertNotIn("reasoning", payload)

    def test_openai_provider_means_extension_compatible_endpoint(self) -> None:
        self.configure(provider="openai", base_url="http://127.0.0.1:12434/engines/v1")
        content = [{"type": "text", "text": "Document body"}]
        template_kwargs = {
            "mode": "structured",
            "enable_thinking": False,
            "instructions": "Return structured JSON.",
        }

        provider = OpenAICompatibleProvider(main.settings, None)  # type: ignore[arg-type]

        payload = provider.build_payload(
            content, template_kwargs, temperature=0.2, stream=True
        )

        self.assertEqual(payload["chat_template_kwargs"], template_kwargs)
        self.assertEqual(payload["messages"][1]["content"], content)
        self.assertNotIn("reasoning", payload)


if __name__ == "__main__":
    unittest.main()
