"""The extraction schema as FREE's editor writes it, and what a model call is told about it.

Mirrors `packages/extraction/src/schema.ts` in FREE field for field, so a schema round-trips through FREE's UI
and this service unchanged: the JSON names are FREE's, the Python names ours. From the tree come the strict JSON
schema a structured-output call is constrained to (every field present, null when unknown, no other keys), the
notes a prompt lists for described fields, and `conform`, which restricts a model's answer to the schema.
"""
from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Scalar = Literal["verbatim-string", "string", "date", "number", "integer", "boolean"]
EvidencePolicy = Literal["quoted", "derived", "unverified"]
SCALAR_JSON: dict[str, str] = {"verbatim-string": "string", "string": "string", "date": "string",
                               "number": "number", "integer": "integer", "boolean": "boolean"}
# FREE's FIELD_TYPES: an allowedValues member equal to one of these reads as a type marker, not a value.
FIELD_TYPE_TOKENS = frozenset(SCALAR_JSON) | {"object", "array"}


class Node(BaseModel):
    """One field: a scalar, an array of scalars, or an object or array of objects with children."""
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str | None = Field(default=None, min_length=1)
    value_source: Literal["document", "source-filename"] | None = Field(default=None, alias="valueSource")
    evidence_policy: EvidencePolicy | None = Field(default=None, alias="evidencePolicy")
    type: Literal["verbatim-string", "string", "date", "number", "integer", "boolean", "object", "array"]
    allowed_values: list[str] | None = Field(default=None, alias="allowedValues")
    item_type: Scalar | None = Field(default=None, alias="itemType")
    children: list[Node] | None = None

    @field_validator("evidence_policy")
    @classmethod
    def _explicit_policy_is_not_null(cls, value):
        if value is None:
            raise ValueError("omit evidencePolicy to inherit; explicit null is not a policy")
        return value

    @model_validator(mode="after")
    def _one_shape(self) -> Self:
        if self.type in SCALAR_JSON and (self.item_type is not None or self.children is not None):
            raise ValueError(f"field {self.name!r}: a {self.type} field takes no itemType or children")
        if self.allowed_values is not None:
            if self.type != "string":
                raise ValueError(f"field {self.name!r}: allowedValues belong to a string field")
            if len(self.allowed_values) < 2:
                raise ValueError(f"field {self.name!r}: allowedValues needs two or more values")
            if any(not value.strip() for value in self.allowed_values):
                raise ValueError(f"field {self.name!r}: allowedValues cannot hold an empty value")
            if any(value in FIELD_TYPE_TOKENS for value in self.allowed_values):
                raise ValueError(f"field {self.name!r}: allowedValues cannot hold a field-type name")
        if self.type == "array" and (self.item_type is None) == (self.children is None):
            raise ValueError(f"field {self.name!r}: an array has either itemType or children")
        if self.type == "object" and (self.item_type is not None or self.children is None):
            raise ValueError(f"field {self.name!r}: an object has children and no itemType")
        return self

    @model_validator(mode="after")
    def _children_differ_in_name(self) -> Self:
        _unique_names(self.children or [], f"field {self.name!r}")
        return self


def _unique_names(nodes: Sequence[Node], where: str) -> None:
    """Siblings differ in name: a record is a JSON object, and the merge and the evidence paths address fields by
    name, so a repeated name would silently lose one value while evidence still pointed at it."""
    seen: set[str] = set()
    for node in nodes:
        if node.name in seen:
            raise ValueError(f"{where}: field name {node.name!r} is used twice")
        seen.add(node.name)


def _descendants(node: Node) -> Iterator[Node]:
    for child in node.children or []:
        yield child
        yield from _descendants(child)


class Schema(BaseModel):
    """FREE's `SchemaDefinition`: what one record is, and its fields."""
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    record_description: str = Field(alias="recordDescription", min_length=1, max_length=1000)
    nodes: list[Node] = Field(alias="schemaNodes", min_length=1)

    @model_validator(mode="after")
    def _value_source_on_top_level_only(self) -> Self:
        for node in self.nodes:
            if any(child.value_source is not None for child in _descendants(node)):
                raise ValueError("valueSource is allowed only on top-level schema fields")
        return self

    @model_validator(mode="after")
    def _siblings_differ_in_name(self) -> Self:
        _unique_names(self.nodes, "schema")
        return self

    @property
    def record_nodes(self) -> list[Node]:
        return [node for node in self.nodes if node.value_source is None]

    @property
    def document_nodes(self) -> list[Node]:
        return [node for node in self.nodes if node.value_source == "document"]

    @property
    def filename_nodes(self) -> list[Node]:
        return [node for node in self.nodes if node.value_source == "source-filename"]


def json_schema(nodes: Sequence[Node]) -> dict:
    """A strict object schema over `nodes`: every field present (null when unknown), no other keys."""
    return {"type": "object", "properties": {node.name: _field_schema(node) for node in nodes},
            "required": [node.name for node in nodes], "additionalProperties": False}


def _field_schema(node: Node) -> dict:
    """A field's JSON schema. A scalar also names FREE's own type under `x-free-type`, which JSON's types collapse
    (verbatim-string, string and date are all "string"): a template extractor reads it, and `llm.OpenAIChat` strips
    every `x-` annotation, but no field name, before a schema constrains decoding."""
    if node.type in SCALAR_JSON:
        if node.allowed_values is not None:
            return {"type": ["string", "null"], "enum": [*node.allowed_values, None]}
        return {"type": [SCALAR_JSON[node.type], "null"], "x-free-type": node.type}
    if node.type == "array":
        items = ({"type": SCALAR_JSON[node.item_type], "x-free-type": node.item_type} if node.item_type
                 else json_schema(node.children or []))
        return {"type": ["array", "null"], "items": items}
    return {**json_schema(node.children or []), "type": ["object", "null"]}


def notes(nodes: Sequence[Node], prefix: str = "") -> list[str]:
    """Field descriptions and permitted labels, including nested fields.

    Constrained decoding does not put the reply schema in the model's prompt: enum choices must be shown.
    """
    lines: list[str] = []
    for node in nodes:
        path = f"{prefix}{node.name}"
        description = node.description or ""
        if node.allowed_values is not None:
            description += f" Allowed labels: {', '.join(repr(value) for value in node.allowed_values)}; null if unsupported."
        if description:
            lines.append(f"- {path}: {description.strip()}")
        lines.extend(notes(node.children or [], f"{path}."))
    return lines


def describe(nodes: Sequence[Node], path: Sequence[str | int]) -> str:
    """The dotted field name a result path names, with its description when it has one; indices are skipped."""
    names: list[str] = []
    current: Sequence[Node] = nodes
    found: Node | None = None
    for step in path:
        if isinstance(step, int):
            continue
        found = next((node for node in current if node.name == step), None)
        if found is None:
            break
        names.append(found.name)
        current = found.children or []
    dotted = ".".join(names) or ".".join(str(step) for step in path)
    return f"{dotted}: {found.description}" if found is not None and found.description else dotted


def evidence_policy(nodes: Sequence[Node], path: Sequence[str | int]) -> EvidencePolicy:
    """Resolve explicit subtree policy, allowing a descendant to override its parent.

    Missing policy requires source support. This classifies eligibility only;
    `derived` does not attest that a value was computed or that it is correct.
    """
    policy: EvidencePolicy = "quoted"
    current = nodes
    for step in path:
        if isinstance(step, int):
            continue
        node = next((node for node in current if node.name == step), None)
        if node is None:
            raise ValueError(f"evidence policy path leaves schema: {path!r}")
        policy = node.evidence_policy or policy
        current = node.children or []
    return policy


def conform(value: Any, nodes: Sequence[Node]) -> dict:
    """A model's answer restricted to the schema: fields in schema order, unknown keys dropped, missing or
    empty values null, arrays and objects conformed the same way."""
    given = value if isinstance(value, dict) else {}
    return {node.name: _conform_field(given.get(node.name), node) for node in nodes}


def _conform_field(value: Any, node: Node) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if node.type == "array":
        if not isinstance(value, list):
            return None
        if node.item_type is not None:
            kept = [item for item in value if item is not None and not (isinstance(item, str) and not item.strip())]
        else:
            kept = [conform(item, node.children or []) for item in value if isinstance(item, dict)]
        return kept or None
    if node.type == "object":
        return conform(value, node.children or []) if isinstance(value, dict) else None
    return value
