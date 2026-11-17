"""Explicit experimental choices. Omitted options retain the captured production reference."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

GroundingChoice = Literal["semantic", "quoted", "spans", "off"]


class ArticleOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    context: Literal["full", "bounded"] = "full"
    context_tokens: int = Field(default=12288, ge=8192)
    overlap_passages: int = Field(default=0, ge=0, le=2)
    grounding: GroundingChoice = "semantic"
    evidence_policy: Literal["schema"] | None = None
    rendering: Literal["structured"] | None = None
    grouping: Literal["structural"] | None = None
    grounding_overflow: Literal["windows"] | None = None

    @model_serializer(mode="wrap")
    def serialized(self, handler):
        result = handler(self)
        if self.evidence_policy is None:
            result.pop("evidence_policy")
        if self.rendering is None:
            result.pop("rendering")
        if self.grouping is None:
            result.pop("grouping")
        if self.grounding_overflow is None:
            result.pop("grounding_overflow")
        return result

    @model_validator(mode="after")
    def coherent(self):
        if self.evidence_policy is not None and self.grounding not in {"quoted", "spans"}:
            raise ValueError("schema evidence policy requires quoted or span grounding")
        if self.grounding_overflow is not None and self.grounding == "off":
            raise ValueError("grounding overflow windows require verification")
        if self.context == "full" and self.overlap_passages:
            raise ValueError("overlap applies to bounded contexts only")
        if self.grouping is not None and self.context != "bounded":
            raise ValueError("structural grouping requires bounded contexts")
        return self


# Article uses the same explicit defaults in Studio and the Parsing Service.
REFERENCE = ArticleOptions(grounding_overflow="windows")


class LimitedCounter:
    """Count the exact serving template while enforcing a fixed experimental context ceiling."""
    def __init__(self, counter, limit: int):
        self.counter = counter
        self.upper_bound = getattr(counter, "upper_bound", False)
        self.context_tokens = min(counter.context_tokens, limit)

    def request_tokens(self, system: str, user: str, schema=None) -> int:
        return self.counter.request_tokens(system, user, schema)

    def identity(self) -> dict:
        return self.counter.identity()
