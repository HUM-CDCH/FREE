import json
import re
from typing import Any


def strip_code_fence(payload: str) -> str:
    return re.sub(
        r"^```(?:json|markdown|text)?\s*|\s*```$",
        "",
        payload.strip(),
        flags=re.IGNORECASE | re.MULTILINE,
    ).strip()


def pretty_json_or_text(payload: str) -> str:
    if not payload:
        return ""
    cleaned = strip_code_fence(payload)
    try:
        return json.dumps(json.loads(cleaned), indent=4, ensure_ascii=False)
    except Exception:
        return cleaned


def extract_answer_block(text: str) -> str:
    if not text:
        return ""
    match = re.search(
        r"<answer>\s*(.*?)\s*</answer>", text, flags=re.DOTALL | re.IGNORECASE
    )
    if match:
        return pretty_json_or_text(match.group(1).strip())

    json_objects = list(re.finditer(r"\{[\s\S]*\}", text))
    if json_objects:
        candidate = max(json_objects, key=lambda m: len(m.group(0))).group(0)
        return pretty_json_or_text(candidate)

    return text.strip()


def normalize_template(template: str | None) -> str:
    """Pretty-print valid JSON templates; pass anything else through untouched."""
    tpl = (template or "").strip()
    if not tpl:
        return "{}"
    try:
        return json.dumps(json.loads(tpl), indent=4, ensure_ascii=False)
    except Exception:
        return tpl


def parse_result(answer: str) -> Any:
    try:
        return json.loads(answer)
    except Exception:
        return answer
