from pathlib import Path
from typing import Any

from model_providers.base import ChatContent

# Official NuExtract3 task instructions, verbatim from the model repo
# (numind/NuExtract3: task_instructions_structured.txt, task_instructions_markdown.txt).
# In the reference vLLM deployment the model's chat template injects the
# 【task】/【template】/【document】 framing from chat_template_kwargs; these instruction
# texts are the system-prompt half of that contract. We send them in the message so
# the behavior holds on runtimes (e.g. Ollama) that do not forward chat_template_kwargs
# to the template.
_INSTRUCTIONS_DIR = Path(__file__).resolve().parent / "task_instructions"


def _load_instructions(name: str) -> str:
    return (_INSTRUCTIONS_DIR / name).read_text(encoding="utf-8").strip()


STRUCTURED_TASK_INSTRUCTIONS = _load_instructions("structured.txt")
MARKDOWN_TASK_INSTRUCTIONS = _load_instructions("markdown.txt")

# FREE-specific modes NuExtract ships no official instructions for.
CONTENT_TASK_INSTRUCTIONS = (
    "Extract source-grounded information from the supplied document or "
    "text using any provided instructions. Return the final answer "
    "inside <answer>...</answer>."
)
TEMPLATE_GENERATION_TASK_INSTRUCTIONS = (
    "Generate an extraction template for the supplied document or text. "
    "Return only a valid JSON object. Use concise field names and simple "
    "type hints such as string, number, YYYY-MM-DD, boolean, or arrays "
    "of objects."
)


def nuextract_task_prompt(chat_kwargs: dict[str, Any]) -> str:
    mode = chat_kwargs.get("mode")
    if mode == "markdown":
        return MARKDOWN_TASK_INSTRUCTIONS
    if mode == "template-generation":
        return TEMPLATE_GENERATION_TASK_INSTRUCTIONS
    if mode == "structured":
        return STRUCTURED_TASK_INSTRUCTIONS
    if mode == "content":
        return CONTENT_TASK_INSTRUCTIONS
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
