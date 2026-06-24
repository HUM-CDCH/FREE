"""Wrap an extraction template with inline evidence fields and split the
model's response back into (result, evidence) pairs.

Each scalar field in the template is replaced with:
    {"value": <original_type_hint>, "snippet": "string", "page": "number"}

The model fills all three keys. split_evidence_result then recursively
separates value from {snippet, page}, returning a clean result alongside a
mirrored evidence structure.
"""

import json
from typing import Any


def _wrap_value(type_hint: Any) -> dict[str, Any]:
    return {"value": type_hint, "snippet": "string", "page": "number"}


def _wrap_schema(template: Any) -> Any:
    if isinstance(template, dict):
        return {key: _wrap_schema(value) for key, value in template.items()}
    if isinstance(template, list):
        return [_wrap_schema(item) for item in template]
    return _wrap_value(template)


def wrap_template_with_evidence(template_json: str) -> str:
    """Replace every scalar in the template JSON with an inline evidence object."""
    try:
        template = json.loads(template_json)
    except (json.JSONDecodeError, ValueError):
        return template_json
    if not isinstance(template, dict):
        return template_json
    return json.dumps(_wrap_schema(template), indent=4, ensure_ascii=False)


def _is_inline_evidence(value: Any) -> bool:
    return isinstance(value, dict) and "value" in value and "snippet" in value and "page" in value


def _split(node: Any) -> tuple[Any, Any]:
    if _is_inline_evidence(node):
        snippet = node.get("snippet")
        page = node.get("page")
        value = node["value"]
        has_snippet = isinstance(snippet, str) and bool(snippet)
        has_page = isinstance(page, int | float) and page > 0
        ev = {"snippet": snippet, "page": int(page), "value": value} if (has_snippet and has_page) else None
        return value, ev

    if isinstance(node, dict):
        clean: dict[str, Any] = {}
        ev_dict: dict[str, Any] = {}
        for key, value in node.items():
            c, e = _split(value)
            clean[key] = c
            if e is not None:
                ev_dict[key] = e
        return clean, (ev_dict if ev_dict else None)

    if isinstance(node, list):
        clean_list: list[Any] = []
        ev_list: list[Any] = []
        has_evidence = False
        for item in node:
            c, e = _split(item)
            clean_list.append(c)
            ev_list.append(e)
            if e is not None:
                has_evidence = True
        return clean_list, (ev_list if has_evidence else None)

    return node, None


def split_evidence_result(result: Any) -> tuple[Any, dict[str, Any] | None]:
    """Separate inline evidence from the extraction result.

    Returns (clean_result, evidence) where evidence mirrors the result
    structure with {snippet, page, value} at the leaves, or None if the
    model provided no conforming evidence.
    """
    clean, ev = _split(result)
    return clean, (ev if isinstance(ev, dict) else None)
