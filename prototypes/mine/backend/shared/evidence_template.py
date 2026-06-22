"""Utilities for wrapping an extraction template with evidence fields and
splitting the model's response back into (result, evidence) pairs.

The evidence block asks the model to return, for each top-level field, the
verbatim snippet it used and the 1-based page number where it appears.

Top-level scalars get a single evidence entry.
Top-level arrays of objects get a single-item array in _evidence whose item
mirrors the scalar fields of the array item schema — the model fills in one
evidence entry per extracted array item.
Nested plain objects and non-object arrays are skipped.
"""

import json
from typing import Any


_EVIDENCE_KEY = "_evidence"

_EVIDENCE_FIELD_SCHEMA = {"snippet": "string", "page": "number"}


def _scalar_evidence(item_schema: dict[str, Any]) -> dict[str, Any]:
    """Return an evidence dict for the scalar fields of an object schema."""
    return {
        key: dict(_EVIDENCE_FIELD_SCHEMA)
        for key, value in item_schema.items()
        if key != _EVIDENCE_KEY and not isinstance(value, (dict, list))
    }


def wrap_template_with_evidence(template_json: str) -> str:
    """Add a top-level _evidence block to the template JSON.

    Scalar top-level fields get individual evidence entries.
    Top-level arrays of objects get a single-item array evidence entry whose
    item covers the scalar fields of the array item schema.

    Returns the original template_json unchanged if it cannot be parsed or
    has no fields to add evidence for.
    """
    try:
        template = json.loads(template_json)
    except (json.JSONDecodeError, ValueError):
        return template_json

    if not isinstance(template, dict):
        return template_json

    evidence_block: dict[str, Any] = {}
    for key, value in template.items():
        if key == _EVIDENCE_KEY:
            continue
        if isinstance(value, list) and value and isinstance(value[0], dict):
            item_ev = _scalar_evidence(value[0])
            if item_ev:
                evidence_block[key] = [item_ev]
        elif not isinstance(value, (dict, list)):
            evidence_block[key] = dict(_EVIDENCE_FIELD_SCHEMA)

    if not evidence_block:
        return template_json

    wrapped = dict(template)
    wrapped[_EVIDENCE_KEY] = evidence_block
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
