from dataclasses import dataclass
from importlib import resources
from typing import Any, Mapping

from model_providers.base import ChatContent, ProviderSettings
from shared.model_command import (
    ChatTask,
    ContentExtractionTask,
    MarkdownTask,
    ModelCommand,
    StructuredExtractionTask,
    TemplateGenerationTask,
)
from shared.temperature import ReasoningTemperature, TemperaturePolicy


@dataclass(frozen=True, slots=True)
class PreparedProviderRequest:
    url: str
    headers: Mapping[str, str]
    payload: Mapping[str, Any]


def model_headers(api_key: str) -> dict[str, str]:
    key = api_key.strip()
    if not key or key.upper() == "EMPTY":
        return {}
    return {"Authorization": f"Bearer {key}"}


def _load_instructions(name: str) -> str:
    return (
        resources.files("model_providers")
        .joinpath("task_instructions", name)
        .read_text(encoding="utf-8")
        .strip()
    )


_STRUCTURED_TASK_INSTRUCTIONS = _load_instructions("structured.txt")
_MARKDOWN_TASK_INSTRUCTIONS = _load_instructions("markdown.txt")
_CONTENT_TASK_INSTRUCTIONS = (
    "Extract source-grounded information from the supplied document or "
    "text using any provided instructions. Return the final answer "
    "inside <answer>...</answer>."
)
TEMPLATE_GENERATION_TASK_INSTRUCTIONS = (
    "Generate a concise JSON extraction template for the supplied document "
    "or text. Use descriptive field names and simple type hints such as "
    "string, number, YYYY-MM-DD, boolean, or arrays of objects. Return only "
    "the JSON template."
)


def _prepend_task_prompt(content: ChatContent, task_prompt: str) -> ChatContent:
    return [{"type": "text", "text": task_prompt}, *content]


def _append_text(content: ChatContent, text: str | None) -> ChatContent:
    if not text:
        return content
    return [*content, {"type": "text", "text": text}]


class RequestCompiler:
    def __init__(
        self,
        settings: ProviderSettings,
        *,
        temperature: TemperaturePolicy | None = None,
    ) -> None:
        self._settings = settings
        self._temperature = temperature or ReasoningTemperature()

    def compile(self, command: ModelCommand) -> PreparedProviderRequest:
        content, template_kwargs = self._encode_task(command)
        payload: dict[str, Any] = {
            "model": self._settings.model,
            "temperature": self._temperature.resolve(
                command.temperature, command.reasoning
            ),
            "max_tokens": self._settings.max_tokens,
            "stream": True,
            "messages": [
                {"role": "system", "content": self._settings.system_prompt},
                {"role": "user", "content": content},
            ],
            "chat_template_kwargs": template_kwargs,
        }
        if self._settings.provider == "ollama" and command.reasoning:
            payload["reasoning"] = {"effort": "medium"}
        return PreparedProviderRequest(
            url=self._chat_completions_url(),
            headers=model_headers(self._settings.api_key),
            payload=payload,
        )

    def _chat_completions_url(self) -> str:
        return f"{self._api_base_url()}/chat/completions"

    def _api_base_url(self) -> str:
        normalized = self._settings.base_url.rstrip("/")
        if self._settings.provider == "ollama" and not normalized.endswith("/v1"):
            return f"{normalized}/v1"
        return normalized

    def _encode_task(self, command: ModelCommand) -> tuple[ChatContent, dict[str, Any]]:
        task = command.task
        match task:
            case ChatTask():
                return command.content, {"enable_thinking": command.reasoning}
            case MarkdownTask():
                return self._encode_markdown(command.content, command.reasoning)
            case ContentExtractionTask(instruction=instruction):
                return self._encode_content_extraction(
                    command.content, instruction, command.reasoning
                )
            case StructuredExtractionTask(
                template_json=template_json, instruction=instruction
            ):
                return self._encode_structured_extraction(
                    command.content, template_json, instruction, command.reasoning
                )
            case TemplateGenerationTask(guidance=guidance):
                return self._encode_template_generation(
                    command.content, guidance, command.reasoning
                )
        raise TypeError(f"Unsupported model command task: {task!r}")

    def _encode_markdown(
        self, content: ChatContent, reasoning: bool
    ) -> tuple[ChatContent, dict[str, Any]]:
        if self._uses_message_text_controls():
            return _prepend_task_prompt(content, _MARKDOWN_TASK_INSTRUCTIONS), {
                "enable_thinking": reasoning
            }
        return content, {"mode": "markdown", "enable_thinking": reasoning}

    def _encode_content_extraction(
        self, content: ChatContent, instruction: str, reasoning: bool
    ) -> tuple[ChatContent, dict[str, Any]]:
        if self._uses_message_text_controls():
            prepared_content = _append_text(
                _prepend_task_prompt(content, _CONTENT_TASK_INSTRUCTIONS),
                f"Instructions:\n{instruction}" if instruction else None,
            )
            return prepared_content, {"enable_thinking": reasoning}

        template_kwargs: dict[str, Any] = {
            "mode": "content",
            "enable_thinking": reasoning,
        }
        if instruction:
            template_kwargs["instructions"] = instruction
        return content, template_kwargs

    def _encode_structured_extraction(
        self,
        content: ChatContent,
        template_json: str,
        instruction: str,
        reasoning: bool,
    ) -> tuple[ChatContent, dict[str, Any]]:
        if self._uses_message_text_controls():
            controls = []
            if instruction:
                controls.append(f"Instructions:\n{instruction}")
            if template_json:
                controls.append(f"Extraction template:\n```json\n{template_json}\n```")
            prepared_content = _append_text(
                _prepend_task_prompt(content, _STRUCTURED_TASK_INSTRUCTIONS),
                "\n\n".join(controls) or None,
            )
            return prepared_content, {"enable_thinking": reasoning}

        instructions = [_STRUCTURED_TASK_INSTRUCTIONS]
        if instruction:
            instructions.append(f"Additional instructions:\n{instruction}")
        return content, {
            "mode": "structured",
            "enable_thinking": reasoning,
            "template": template_json,
            "instructions": "\n\n".join(instructions),
        }

    def _encode_template_generation(
        self, content: ChatContent, guidance: str, reasoning: bool
    ) -> tuple[ChatContent, dict[str, Any]]:
        if self._uses_message_text_controls():
            prepared_content = _append_text(
                _prepend_task_prompt(content, TEMPLATE_GENERATION_TASK_INSTRUCTIONS),
                guidance,
            )
            return prepared_content, {"enable_thinking": reasoning}
        return _append_text(content, guidance), {
            "mode": "template-generation",
            "enable_thinking": reasoning,
        }

    def _uses_message_text_controls(self) -> bool:
        return self._settings.provider == "ollama"
