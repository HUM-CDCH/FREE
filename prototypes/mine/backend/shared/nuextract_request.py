from pathlib import Path
from typing import Any

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
_TEMPLATE_GENERATION_TASK_INSTRUCTIONS = (
    "Generate an extraction template for the supplied document or text. "
    "Return only a valid JSON object. Use concise field names and simple "
    "type hints such as string, number, YYYY-MM-DD, boolean, or arrays "
    "of objects."
)


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


class NuExtractRequestBuilder:
    def markdown(
        self,
        *,
        content: ChatContent,
        reasoning: bool,
        temperature: float | None,
    ) -> ModelRequest:
        return ModelRequest(
            content=_prepend_task_prompt(content, _MARKDOWN_TASK_INSTRUCTIONS),
            template_kwargs={"mode": "markdown", "enable_thinking": reasoning},
            reasoning=reasoning,
            temperature=temperature,
        )

    def template_generation(
        self,
        *,
        content: ChatContent,
        guidance: str,
        temperature: float | None,
    ) -> ModelRequest:
        prepared_content = _append_text(
            _prepend_task_prompt(content, _TEMPLATE_GENERATION_TASK_INSTRUCTIONS),
            guidance,
        )
        return ModelRequest(
            content=prepared_content,
            template_kwargs={"mode": "template-generation", "enable_thinking": False},
            reasoning=False,
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
        prepared_content = _append_text(
            _prepend_task_prompt(content, _CONTENT_TASK_INSTRUCTIONS),
            f"Instructions:\n{instruction}" if instruction else None,
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
        controls = []
        if instruction:
            controls.append(f"Instructions:\n{instruction}")
        if template_json:
            controls.append(f"Extraction template:\n```json\n{template_json}\n```")
        prepared_content = _append_text(
            _prepend_task_prompt(content, _STRUCTURED_TASK_INSTRUCTIONS),
            "\n\n".join(controls) or None,
        )
        template_kwargs: dict[str, Any] = {
            "mode": "structured",
            "enable_thinking": reasoning,
            "template": template_json,
        }
        if instruction:
            template_kwargs["instructions"] = instruction
        return ModelRequest(
            content=prepared_content,
            template_kwargs=template_kwargs,
            reasoning=reasoning,
            temperature=temperature,
        )
