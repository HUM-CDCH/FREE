"""Catalog values typed to their fields."""
from typing import Any
from kei_exp.kie.extract.schema import Node


def typed_value(value: Any, node: Node) -> Any:
    """The value conformed to its field's type, or None when it cannot be."""
    kind = node.type if node.type != "array" else node.item_type
    if kind == "boolean" or isinstance(value, bool) or value is None:
        return value if kind == "boolean" and isinstance(value, bool) else None
    if kind == "integer":
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return int(value) if isinstance(value, str) and value.strip().isdigit() else None
    if kind == "number":
        if isinstance(value, (int, float)):
            return value
        try:
            return float(str(value).replace(",", "."))
        except ValueError:
            return None
    text = str(value).strip() if isinstance(value, (str, int, float)) else ""
    if not text:
        return None
    if node.allowed_values is not None and text not in node.allowed_values:
        return None
    return text
