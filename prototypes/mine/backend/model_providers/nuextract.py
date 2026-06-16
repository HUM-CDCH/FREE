from typing import Any

from model_providers.base import ChatContent


def nuextract_task_prompt(chat_kwargs: dict[str, Any]) -> str:
    mode = chat_kwargs.get("mode")
    if mode == "markdown":
        return (
            "Convert the supplied document page or image to faithful Markdown. "
            "Preserve reading order, headings, tables, lists, and visible text. "
            "Return only Markdown."
        )
    if mode == "template-generation":
        return (
            "Generate an extraction template for the supplied document or text. "
            "Return only a valid JSON object. Use concise field names and simple "
            "type hints such as string, number, YYYY-MM-DD, boolean, or arrays "
            "of objects."
        )
    if mode == "structured":
        return (
            "Extract source-grounded information from the supplied document or "
            "text using the extraction template and instructions. Return the "
            "final answer inside <answer>...</answer>. The answer content must "
            "be valid JSON matching the requested template."
        )
    if mode == "content":
        return (
            "Extract source-grounded information from the supplied document or "
            "text using any provided instructions. Return the final answer "
            "inside <answer>...</answer>."
        )
    return ""


def prepare_nuextract_content(
    content: ChatContent, chat_kwargs: dict[str, Any]
) -> ChatContent:
    task_prompt = nuextract_task_prompt(chat_kwargs)
    if not task_prompt or content_starts_with_prompt(content, task_prompt):
        return content
    return [{"type": "text", "text": task_prompt}, *content]


def content_starts_with_prompt(content: ChatContent, task_prompt: str) -> bool:
    if not content:
        return False
    first = content[0]
    text = first.get("text")
    return first.get("type") == "text" and isinstance(text, str) and text.startswith(
        task_prompt
    )
