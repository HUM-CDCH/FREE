import inspect
import unittest
from importlib import resources

from config import Settings
from shared.model_command import (
    ChatTask,
    ContentExtractionTask,
    MarkdownTask,
    ModelCommand,
    StructuredExtractionTask,
    TemplateGenerationTask,
)
from shared.request_compiler import (
    TEMPLATE_GENERATION_TASK_INSTRUCTIONS,
    RequestCompiler,
    model_headers,
)
from shared.source_context import SourceAnnotation
from use_cases import extract, generate_template, markdown
from use_cases.generate_template import template_guidance


def load_prompt(name: str) -> str:
    return (
        resources.files("model_providers")
        .joinpath("task_instructions", name)
        .read_text(encoding="utf-8")
        .strip()
    )


STRUCTURED_PROMPT = load_prompt("structured.txt")
MARKDOWN_PROMPT = load_prompt("markdown.txt")
CONTENT_PROMPT = (
    "Extract source-grounded information from the supplied document or "
    "text using any provided instructions. Return the final answer "
    "inside <answer>...</answer>."
)


class RequestCompilerPayloadTests(unittest.TestCase):
    def settings(
        self,
        provider: str,
        *,
        base_url: str | None = None,
        api_key: str = "secret",
    ) -> Settings:
        return Settings(
            provider=provider,
            base_url=base_url or "http://example.test/v1",
            model="test-model",
            api_key=api_key,
            max_tokens=123,
            system_prompt="test system",
            _env_file=None,
        )

    def compile(
        self,
        provider: str,
        task,
        *,
        content=None,
        reasoning: bool = False,
        temperature: float | None = None,
        base_url: str | None = None,
        api_key: str = "secret",
    ):
        command = ModelCommand(
            task=task,
            content=content or [{"type": "text", "text": "Document body"}],
            reasoning=reasoning,
            temperature=temperature,
        )
        return RequestCompiler(
            self.settings(provider, base_url=base_url, api_key=api_key)
        ).compile(command)

    def test_model_commands_are_semantic_task_variants(self) -> None:
        command = ModelCommand(
            task=StructuredExtractionTask(
                template_json='{"name": "string"}',
                instruction="Use source text only.",
            ),
            content=[{"type": "text", "text": "Document body"}],
            reasoning=True,
        )

        self.assertEqual(command.task.template_json, '{"name": "string"}')
        self.assertFalse(hasattr(ChatTask(), "template_json"))
        self.assertFalse(hasattr(MarkdownTask(), "template_json"))
        self.assertFalse(hasattr(ContentExtractionTask(), "template_json"))
        self.assertFalse(hasattr(TemplateGenerationTask(), "template_json"))
        self.assertFalse(hasattr(command, "template_kwargs"))

    def test_chat_payloads_reasoning_disabled_and_enabled_across_providers(self) -> None:
        content = [{"type": "text", "text": "Say hello"}]
        for provider in ("ollama", "vllm", "openai"):
            for reasoning in (False, True):
                with self.subTest(provider=provider, reasoning=reasoning):
                    prepared = self.compile(
                        provider,
                        ChatTask(),
                        content=content,
                        reasoning=reasoning,
                        base_url="http://example.test"
                        if provider == "ollama"
                        else "http://example.test/v1",
                    )
                    expected_payload = {
                        "model": "test-model",
                        "temperature": 0.6 if reasoning else 0.2,
                        "max_tokens": 123,
                        "stream": True,
                        "messages": [
                            {"role": "system", "content": "test system"},
                            {"role": "user", "content": content},
                        ],
                        "chat_template_kwargs": {"enable_thinking": reasoning},
                    }
                    if provider == "ollama" and reasoning:
                        expected_payload["reasoning"] = {"effort": "medium"}

                    self.assertEqual(prepared.payload, expected_payload)
                    self.assertEqual(prepared.headers, {"Authorization": "Bearer secret"})

    def test_markdown_payloads_across_providers(self) -> None:
        content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}]
        for provider in ("ollama", "vllm", "openai"):
            with self.subTest(provider=provider):
                prepared = self.compile(
                    provider,
                    MarkdownTask(),
                    content=content,
                    reasoning=True,
                )

                if provider == "ollama":
                    self.assertEqual(
                        prepared.payload["messages"][1]["content"],
                        [{"type": "text", "text": MARKDOWN_PROMPT}, *content],
                    )
                    self.assertEqual(
                        prepared.payload["chat_template_kwargs"],
                        {"enable_thinking": True},
                    )
                    self.assertEqual(
                        prepared.payload["reasoning"], {"effort": "medium"}
                    )
                else:
                    self.assertEqual(prepared.payload["messages"][1]["content"], content)
                    self.assertEqual(
                        prepared.payload["chat_template_kwargs"],
                        {"mode": "markdown", "enable_thinking": True},
                    )
                    self.assertNotIn("reasoning", prepared.payload)

    def test_direct_extraction_payloads_with_and_without_instructions(self) -> None:
        content = [{"type": "text", "text": "Document body"}]
        for provider in ("ollama", "vllm", "openai"):
            for instruction in ("", "Summarize the site."):
                with self.subTest(provider=provider, instruction=instruction):
                    prepared = self.compile(
                        provider,
                        ContentExtractionTask(instruction=instruction),
                        content=content,
                    )
                    if provider == "ollama":
                        expected_content = [{"type": "text", "text": CONTENT_PROMPT}, *content]
                        if instruction:
                            expected_content.append(
                                {"type": "text", "text": f"Instructions:\n{instruction}"}
                            )
                        self.assertEqual(
                            prepared.payload["messages"][1]["content"],
                            expected_content,
                        )
                        self.assertEqual(
                            prepared.payload["chat_template_kwargs"],
                            {"enable_thinking": False},
                        )
                    else:
                        expected_kwargs = {
                            "mode": "content",
                            "enable_thinking": False,
                        }
                        if instruction:
                            expected_kwargs["instructions"] = instruction
                        self.assertEqual(
                            prepared.payload["messages"][1]["content"], content
                        )
                        self.assertEqual(
                            prepared.payload["chat_template_kwargs"], expected_kwargs
                        )

    def test_structured_extraction_payloads_across_providers(self) -> None:
        content = [{"type": "text", "text": "Document body"}]
        template_json = '{"name": "string"}'
        instruction = "Use source text only."
        for provider in ("ollama", "vllm", "openai"):
            with self.subTest(provider=provider):
                prepared = self.compile(
                    provider,
                    StructuredExtractionTask(
                        template_json=template_json,
                        instruction=instruction,
                    ),
                    content=content,
                    reasoning=True,
                )

                if provider == "ollama":
                    self.assertEqual(
                        prepared.payload["messages"][1]["content"],
                        [
                            {"type": "text", "text": STRUCTURED_PROMPT},
                            *content,
                            {
                                "type": "text",
                                "text": (
                                    "Instructions:\nUse source text only.\n\n"
                                    "Extraction template:\n```json\n"
                                    '{"name": "string"}\n```'
                                ),
                            },
                        ],
                    )
                    self.assertEqual(
                        prepared.payload["chat_template_kwargs"],
                        {"enable_thinking": True},
                    )
                else:
                    self.assertEqual(prepared.payload["messages"][1]["content"], content)
                    self.assertEqual(
                        prepared.payload["chat_template_kwargs"],
                        {
                            "mode": "structured",
                            "enable_thinking": True,
                            "template": template_json,
                            "instructions": (
                                f"{STRUCTURED_PROMPT}\n\n"
                                "Additional instructions:\nUse source text only."
                            ),
                        },
                    )
                self.assertEqual(prepared.payload["temperature"], 0.6)

    def test_schema_suggestion_payloads_and_guidance_cleanup(self) -> None:
        content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}]
        fields_guidance = template_guidance(
            [SourceAnnotation(text="field", page_number=1)], "fields"
        )
        hints_guidance = template_guidance(
            [SourceAnnotation(text="hint", page_number=1)], "hints"
        )
        cases = ("", fields_guidance, hints_guidance)

        self.assertEqual(template_guidance([], "hints"), "")
        self.assertNotIn(TEMPLATE_GENERATION_TASK_INSTRUCTIONS, fields_guidance)
        self.assertNotIn(TEMPLATE_GENERATION_TASK_INSTRUCTIONS, hints_guidance)

        for provider in ("ollama", "vllm", "openai"):
            for guidance in cases:
                with self.subTest(provider=provider, guidance=guidance):
                    prepared = self.compile(
                        provider,
                        TemplateGenerationTask(guidance=guidance),
                        content=content,
                    )

                    if provider == "ollama":
                        expected_content = [
                            {
                                "type": "text",
                                "text": TEMPLATE_GENERATION_TASK_INSTRUCTIONS,
                            },
                            *content,
                        ]
                        if guidance:
                            expected_content.append({"type": "text", "text": guidance})
                        self.assertEqual(
                            prepared.payload["messages"][1]["content"],
                            expected_content,
                        )
                    else:
                        expected_content = [*content]
                        if guidance:
                            expected_content.append({"type": "text", "text": guidance})
                        self.assertEqual(
                            prepared.payload["messages"][1]["content"],
                            expected_content,
                        )
                        rendered_text = "\n\n".join(
                            part["text"]
                            for part in expected_content
                            if part.get("type") == "text"
                        )
                        self.assertNotIn(
                            TEMPLATE_GENERATION_TASK_INSTRUCTIONS, rendered_text
                        )
                    self.assertEqual(
                        prepared.payload["chat_template_kwargs"],
                        {
                            **(
                                {}
                                if provider == "ollama"
                                else {"mode": "template-generation"}
                            ),
                            "enable_thinking": False,
                        },
                    )

    def test_url_headers_and_temperature_controls(self) -> None:
        self.assertEqual(model_headers(""), {})
        self.assertEqual(model_headers(" EMPTY "), {})
        self.assertEqual(model_headers("secret"), {"Authorization": "Bearer secret"})

        ollama_root = self.compile(
            "ollama", ChatTask(), base_url="http://127.0.0.1:11434"
        )
        ollama_v1 = self.compile(
            "ollama", ChatTask(), base_url="http://127.0.0.1:11434/v1/"
        )
        vllm = self.compile(
            "vllm", ChatTask(), base_url="http://127.0.0.1:12434/engines/v1"
        )
        explicit = self.compile(
            "openai",
            ChatTask(),
            base_url="http://127.0.0.1:12434/engines/v1",
            api_key="EMPTY",
            temperature=0.0,
            reasoning=True,
        )

        self.assertEqual(
            ollama_root.url, "http://127.0.0.1:11434/v1/chat/completions"
        )
        self.assertEqual(
            ollama_v1.url, "http://127.0.0.1:11434/v1/chat/completions"
        )
        self.assertEqual(
            vllm.url, "http://127.0.0.1:12434/engines/v1/chat/completions"
        )
        self.assertEqual(explicit.headers, {})
        self.assertEqual(explicit.payload["temperature"], 0.0)
        self.assertEqual(explicit.payload["stream"], True)
        self.assertEqual(explicit.payload["model"], "test-model")
        self.assertEqual(explicit.payload["max_tokens"], 123)
        self.assertEqual(
            explicit.payload["messages"][0],
            {"role": "system", "content": "test system"},
        )

    def test_use_cases_do_not_import_nuextract_task_prompts(self) -> None:
        for module in (extract, generate_template, markdown):
            with self.subTest(module=module.__name__):
                source = inspect.getsource(module)
                self.assertNotIn("task_instructions", source)
                self.assertNotIn("TEMPLATE_GENERATION_TASK_INSTRUCTIONS", source)


if __name__ == "__main__":
    unittest.main()
