import unittest

import main


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
        main.settings = main.Settings(
            provider=provider,
            base_url=base_url,
            model="test-model",
            api_key=api_key,
            max_tokens=123,
            system_prompt="test system",
            _env_file=None,
        )

    def test_ollama_root_url_is_normalized_to_v1(self) -> None:
        self.assertEqual(
            main.model_api_base_url("http://127.0.0.1:11434", "ollama"),
            "http://127.0.0.1:11434/v1",
        )

    def test_ollama_explicit_v1_url_is_preserved(self) -> None:
        self.assertEqual(
            main.model_api_base_url("http://127.0.0.1:11434/v1/", "ollama"),
            "http://127.0.0.1:11434/v1",
        )

    def test_openai_base_url_is_preserved(self) -> None:
        self.assertEqual(
            main.model_api_base_url("http://127.0.0.1:12434/engines/v1", "openai"),
            "http://127.0.0.1:12434/engines/v1",
        )

    def test_auth_header_is_omitted_for_empty_or_placeholder_keys(self) -> None:
        self.assertEqual(main.model_headers(""), {})
        self.assertEqual(main.model_headers(" EMPTY "), {})

    def test_auth_header_is_sent_for_real_keys(self) -> None:
        self.assertEqual(
            main.model_headers("secret"),
            {"Authorization": "Bearer secret"},
        )

    def test_ollama_payload_excludes_custom_template_kwargs(self) -> None:
        self.configure(provider="ollama")
        content = [{"type": "text", "text": "Document body"}]
        chat_kwargs = {
            "mode": "structured",
            "enable_thinking": True,
            "template": '{"name": "string"}',
        }

        payload = main.build_payload(content, chat_kwargs, temperature=0.2, stream=True)

        self.assertNotIn("chat_template_kwargs", payload)
        self.assertEqual(payload["model"], "test-model")
        self.assertEqual(payload["max_tokens"], 123)
        self.assertEqual(payload["reasoning"], {"effort": "medium"})
        user_content = payload["messages"][1]["content"]
        self.assertIn("<answer>", user_content[0]["text"])
        self.assertIn("valid JSON", user_content[0]["text"])
        self.assertEqual(user_content[1], content[0])

    def test_ollama_payload_omits_reasoning_when_disabled(self) -> None:
        self.configure(provider="ollama")

        payload = main.build_payload(
            [{"type": "text", "text": "Document body"}],
            {"mode": "content", "enable_thinking": False},
            temperature=0.2,
            stream=True,
        )

        self.assertNotIn("reasoning", payload)

    def test_openai_payload_preserves_custom_template_kwargs(self) -> None:
        self.configure(provider="openai", base_url="http://127.0.0.1:12434/engines/v1")
        content = [{"type": "text", "text": "Document body"}]
        chat_kwargs = {"mode": "structured", "enable_thinking": True}

        payload = main.build_payload(content, chat_kwargs, temperature=0.2, stream=True)

        self.assertEqual(payload["chat_template_kwargs"], chat_kwargs)
        self.assertEqual(payload["messages"][1]["content"], content)
        self.assertNotIn("reasoning", payload)

    def test_ollama_task_prompts_cover_supported_modes(self) -> None:
        self.assertIn("valid JSON object", main.ollama_task_prompt({"mode": "template-generation"}))
        self.assertIn("valid JSON", main.ollama_task_prompt({"mode": "structured"}))
        self.assertIn("<answer>", main.ollama_task_prompt({"mode": "content"}))
        self.assertIn("Markdown", main.ollama_task_prompt({"mode": "markdown"}))


if __name__ == "__main__":
    unittest.main()
