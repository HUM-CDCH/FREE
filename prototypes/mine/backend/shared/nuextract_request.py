from pathlib import Path
from enum import Enum
from typing import Any, Literal

from model_providers import ChatContent
from shared.model_gateway import ModelRequest

_INSTRUCTIONS_DIR = (
    Path(__file__).resolve().parent.parent
    / "model_providers"
    / "task_instructions"
)


def _load_instructions(name: str) -> str:
    return (_INSTRUCTIONS_DIR / name).read_text(encoding="utf-8").strip()


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


class NuExtractTaskControlChannel(str, Enum):
    MESSAGE_TEXT = "message_text"
    TEMPLATE_KWARGS = "template_kwargs"


def nuextract_control_channel_for_provider(
    provider: Literal["ollama", "vllm", "openai"],
) -> NuExtractTaskControlChannel:
    if provider == "ollama":
        return NuExtractTaskControlChannel.MESSAGE_TEXT
    return NuExtractTaskControlChannel.TEMPLATE_KWARGS


def _prepend_task_prompt(content: ChatContent, task_prompt: str) -> ChatContent:
    if _content_starts_with_prompt(content, task_prompt):
        return content
    return [{"type": "text", "text": task_prompt}, *content]


def _content_starts_with_prompt(content: ChatContent, task_prompt: str) -> bool:
    if not content:
        return False
    first = content[0]
    text = first.get("text")
    return first.get("type") == "text" and isinstance(text, str) and text.startswith(
        task_prompt
    )


def _append_text(content: ChatContent, text: str | None) -> ChatContent:
    if not text:
        return content
    return [*content, {"type": "text", "text": text}]


def _without_repeated_task_prompt(guidance: str) -> str | None:
    if not guidance:
        return None
    if not guidance.startswith(TEMPLATE_GENERATION_TASK_INSTRUCTIONS):
        return guidance
    remainder = guidance[len(TEMPLATE_GENERATION_TASK_INSTRUCTIONS) :].strip()
    return remainder or None


class NuExtractRequestBuilder:
    def __init__(
        self,
        *,
        task_control_channel: NuExtractTaskControlChannel = (
            NuExtractTaskControlChannel.TEMPLATE_KWARGS
        ),
    ) -> None:
        self._task_control_channel = task_control_channel

    def _uses_message_text_controls(self) -> bool:
        return self._task_control_channel == NuExtractTaskControlChannel.MESSAGE_TEXT

    def _thinking_kwargs(self, reasoning: bool) -> dict[str, Any]:
        return {"enable_thinking": reasoning}

    def markdown(
        self,
        *,
        content: ChatContent,
        reasoning: bool,
        temperature: float | None,
    ) -> ModelRequest:
        if self._uses_message_text_controls():
            return ModelRequest(
                content=_prepend_task_prompt(content, _MARKDOWN_TASK_INSTRUCTIONS),
                template_kwargs=self._thinking_kwargs(reasoning),
                reasoning=reasoning,
                temperature=temperature,
            )
        return ModelRequest(
            content=content,
            template_kwargs={"mode": "markdown", "enable_thinking": reasoning},
            reasoning=reasoning,
            temperature=temperature,
        )

    def schema_suggestion(
        self,
        *,
        content: ChatContent,
        guidance: str,
        temperature: float | None,
    ) -> ModelRequest:
        if self._uses_message_text_controls():
            prepared_content = _append_text(
                content, _without_repeated_task_prompt(guidance)
            )
            prepared_content = _prepend_task_prompt(
                prepared_content, TEMPLATE_GENERATION_TASK_INSTRUCTIONS
            )
            return ModelRequest(
                content=prepared_content,
                template_kwargs={"enable_thinking": False},
                reasoning=False,
                temperature=temperature,
            )
        prepared_content = _append_text(content, guidance)
        return ModelRequest(
            content=prepared_content,
            template_kwargs={"mode": "template-generation", "enable_thinking": False},
            reasoning=False,
            temperature=temperature,
        )

    def template_generation(
        self,
        *,
        content: ChatContent,
        guidance: str,
        temperature: float | None,
    ) -> ModelRequest:
        return self.schema_suggestion(
            content=content,
            guidance=guidance,
            temperature=temperature,
        )

    def content_extraction(
        self,
        *,
        content: ChatContent,
        instruction: str,
        reasoning: bool,
        temperature: float | None,
    ) -> ModelRequest:
        prepared_content = content
        if self._uses_message_text_controls():
            prepared_content = _append_text(
                _prepend_task_prompt(content, _CONTENT_TASK_INSTRUCTIONS),
                f"Instructions:\n{instruction}" if instruction else None,
            )
            return ModelRequest(
                content=prepared_content,
                template_kwargs=self._thinking_kwargs(reasoning),
                reasoning=reasoning,
                temperature=temperature,
            )
        template_kwargs: dict[str, Any] = {
            "mode": "content",
            "enable_thinking": reasoning,
        }
        if instruction:
            template_kwargs["instructions"] = instruction
        return ModelRequest(
            content=prepared_content,
            template_kwargs=template_kwargs,
            reasoning=reasoning,
            temperature=temperature,
        )

    def structured_extraction(
        self,
        *,
        content: ChatContent,
        template_json: str,
        instruction: str,
        reasoning: bool,
        temperature: float | None,
    ) -> ModelRequest:
        prepared_content = content
        template_kwargs: dict[str, Any] = {
            "mode": "structured",
            "enable_thinking": reasoning,
            "template": template_json,
        }
        if instruction:
            template_kwargs["instructions"] = instruction
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
            template_kwargs = self._thinking_kwargs(reasoning)
        else:
            # For providers that don't use message text controls
            # we include _STRUCTURED_TASK_INSTRUCTIONS in template_kwargs to ensure the model understands the task, since it won't see the prompt in the message text.
            template_kwargs["instructions"] = _STRUCTURED_TASK_INSTRUCTIONS
           
        return ModelRequest(
            content=prepared_content,
            template_kwargs=template_kwargs,
            reasoning=reasoning,
            temperature=temperature,
        )
