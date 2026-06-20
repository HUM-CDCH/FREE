"""Utilities for wrapping an extraction template with evidence fields and
splitting the model's response back into (result, evidence) pairs.

The evidence block asks the model to return, for each top-level field, the
verbatim snippet it used and the 1-based page number where it appears.
Nested objects and lists are not expanded — only top-level scalar fields get
individual evidence entries, which keeps the template small and the model
output predictable.
"""

import json
from typing import Any


_EVIDENCE_KEY = "_evidence"

_EVIDENCE_FIELD_SCHEMA = {"snippet": "string", "page": "number"}


def _top_level_scalar_keys(template: dict[str, Any]) -> list[str]:
    """Return keys whose values are scalar type hints (string, number, etc.)
    rather than nested objects or arrays."""
    scalar_keys = []
    for key, value in template.items():
        if key == _EVIDENCE_KEY:
            continue
        if isinstance(value, (dict, list)):
            continue
        scalar_keys.append(key)
    return scalar_keys


def wrap_template_with_evidence(template_json: str) -> str:
    """Add a top-level _evidence block to the template JSON.

    Only top-level scalar fields get evidence entries — nested objects and
    arrays are skipped to keep the wrapped template compact.

    Returns the original template_json unchanged if it cannot be parsed or
    has no scalar fields to add evidence for.
    """
    try:
        template = json.loads(template_json)
    except (json.JSONDecodeError, ValueError):
        return template_json

    if not isinstance(template, dict):
        return template_json

    scalar_keys = _top_level_scalar_keys(template)
    if not scalar_keys:
        return template_json

    wrapped = dict(template)
    wrapped[_EVIDENCE_KEY] = {key: dict(_EVIDENCE_FIELD_SCHEMA) for key in scalar_keys}
    return json.dumps(wrapped, indent=4, ensure_ascii=False)


def split_evidence_result(result: Any) -> tuple[Any, dict[str, Any] | None]:
    """Separate the _evidence block from the extraction result.

    Returns (clean_result, evidence) where clean_result has _evidence removed
    and evidence is the dict (or None if absent / not a dict).
    """
    if not isinstance(result, dict):
        return result, None

    evidence = result.get(_EVIDENCE_KEY)
    clean = {k: v for k, v in result.items() if k != _EVIDENCE_KEY}
    return clean, (evidence if isinstance(evidence, dict) else None)
