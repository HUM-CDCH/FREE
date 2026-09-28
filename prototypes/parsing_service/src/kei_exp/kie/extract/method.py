"""Explicit experimental choices. Omitted options retain the captured production reference."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator


class ArticleOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    context: Literal["full", "bounded"] = "full"
    context_tokens: int = Field(default=12288, ge=8192)
    overlap_passages: int = Field(default=0, ge=0, le=2)
    identity: Literal["reference", "conservative"] = "reference"
    identity_fields: tuple[str, ...] = ()
    prompt: Literal["reference", "schema"] = "reference"
    grounding: Literal["semantic", "quoted", "spans", "off"] = "semantic"
    grounding_schedule: Literal["unresolved"] | None = None
    selection: Literal["supported"] | None = None
    rendering: Literal["structured"] | None = None
    grouping: Literal["structural"] | None = None

    @model_serializer(mode="wrap")
    def serialized(self, handler):
        result = handler(self)
        if self.grounding_schedule is None:
            result.pop("grounding_schedule")
        if self.selection is None:
            result.pop("selection")  # preserve the registered all-unit reference serialization
        if self.rendering is None:
            result.pop("rendering")
        if self.grouping is None:
            result.pop("grouping")
        return result

    @model_validator(mode="after")
    def coherent(self):
        if self.grounding_schedule is not None and self.grounding == "off":
            raise ValueError("grounding scheduling requires verification")
        if self.identity == "conservative" and not self.identity_fields:
            raise ValueError("conservative reconciliation requires explicit identity_fields")
        if len(set(self.identity_fields)) != len(self.identity_fields):
            raise ValueError("identity_fields must be unique")
        if self.context == "full" and self.overlap_passages:
            raise ValueError("overlap applies to bounded contexts only")
        if self.selection is not None and self.context != "bounded":
            raise ValueError("record-specific selection requires bounded contexts")
        if self.grouping is not None and self.context != "bounded":
            raise ValueError("structural grouping requires bounded contexts")
        return self


class CatalogFactors(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    glossary: bool = True
    headings: bool = True
    overlap: bool = True
    verification: bool = True


class LimitedCounter:
    """Count the exact serving template while enforcing a fixed experimental context ceiling."""
    def __init__(self, counter, limit: int):
        self.counter = counter
        self.context_tokens = min(counter.context_tokens, limit)

    def request_tokens(self, system: str, user: str, schema=None) -> int:
        return self.counter.request_tokens(system, user, schema)
