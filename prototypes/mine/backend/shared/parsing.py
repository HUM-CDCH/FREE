import json
import re
from typing import Any


def resolve_temperature(temperature: float | None, reasoning: bool) -> float:
    # model card recommends 0.2 without reasoning, 0.6 with reasoning
    if temperature is not None:
        return temperature
    return 0.6 if reasoning else 0.2


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


def quote_bare_hyphenated_numbers(payload: str) -> str:
    """Quote JSON-like ID values such as 8-1 without touching string content."""
    output: list[str] = []
    in_string = False
    escaped = False
    last_significant: str | None = None
    index = 0
    while index < len(payload):
        char = payload[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
                last_significant = '"'
            index += 1
            continue

        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char.isspace():
            output.append(char)
            index += 1
            continue
        if last_significant in {":", "[", ","} and (char.isdigit() or char == "-"):
            end = index + 1
            while end < len(payload) and (
                payload[end].isdigit() or payload[end] == "-"
            ):
                end += 1
            token = payload[index:end]
            next_index = end
            while next_index < len(payload) and payload[next_index].isspace():
                next_index += 1
            if (
                re.fullmatch(r"-?\d+(?:-\d+)+", token)
                and next_index < len(payload)
                and payload[next_index] in {",", "}", "]"}
            ):
                output.append(json.dumps(token))
                last_significant = '"'
                index = end
                continue

        output.append(char)
        last_significant = char
        index += 1

    return "".join(output)


def parse_repaired_json_result(answer: str) -> Any:
    repaired = quote_bare_hyphenated_numbers(answer)
    candidates = [repaired]
    stripped = repaired.strip()
    if stripped.startswith("{"):
        candidates.append(f"[{stripped}")
        if stripped.endswith("}"):
            candidates.append(f"[{stripped}]")

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    raise ValueError("Model returned invalid JSON for the extraction result")


def parse_json_object_result(answer: str) -> dict[str, Any]:
    try:
        result = json.loads(answer)
    except json.JSONDecodeError:
        result = parse_repaired_json_result(answer)
    if not isinstance(result, dict):
        if isinstance(result, list):
            return {"items": result}
        raise ValueError("Model returned a JSON value instead of an object")
    return result
