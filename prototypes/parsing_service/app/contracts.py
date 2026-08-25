"""Public HTTP models and the parser seam used by the task worker."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field


TaskStatus = Literal[
    "pending",
    "running",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
]


class TaskParameters(BaseModel):
    """The existing public parameter shape, including retired parser fields."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    pipeline: str
    policy_revision: int
    doctags_converter_revision: int
    v2_renderer_revision: int
    parsed_document_schema_revision: str
    docling_version: str
    ocr_fallback_dpi: int
    ocr_fallback_device_policy: str
    resolved_ocr_device: str
    paddleocr_model: str
    paddleocr_version: str
    source_name: str
    table_parser: str = "unknown"
    camelot_version: str = "unavailable"


class ParserProvenance(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    parser: str
    version: str | None = None
    status: Literal["success", "failed", "skipped"]
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None


class InterruptedTaskAttempt(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    attempt_count: Literal[1]
    stats: dict[str, dict[str, Any]]
    parser_runs: list[ParserProvenance]


class TaskCreatedResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    task_id: str
    document_id: str
    content_sha256: str
    status: Literal["pending"]
    created_at: str


class TaskStatusResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    task_id: str
    document_id: str
    content_sha256: str
    source_kind: Literal["upload"]
    status: TaskStatus
    created_at: str
    updated_at: str
    params: TaskParameters
    stats: dict[str, dict[str, Any]]
    parser_runs: list[ParserProvenance]
    interrupted_attempt: InterruptedTaskAttempt | None
    selected_parser: str | None = None
    error_code: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class ParseResult:
    """Value returned by ``Parser.parse``.

    The worker also accepts mappings and attribute-compatible objects so tests and
    the Docling adapter do not need inheritance or a compatibility wrapper.
    """

    parsed_document: Mapping[str, Any]
    markdown: str | bytes
    stats: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    parser_runs: tuple[Mapping[str, Any], ...] = ()
    selected_parser: str | None = "docling"
    warnings: tuple[str, ...] = ()
    docling_version: str | None = None


@runtime_checkable
class Parser(Protocol):
    """One synchronous boundary around Docling's blocking conversion call."""

    def parse(
        self,
        source_path: "Path",
        task_context: Mapping[str, Any],
    ) -> ParseResult | Mapping[str, Any]: ...


# Imported only for static typing; keeping it last avoids runtime coupling.
from pathlib import Path  # noqa: E402


__all__ = [
    "InterruptedTaskAttempt",
    "ParseResult",
    "Parser",
    "ParserProvenance",
    "TaskCreatedResponse",
    "TaskParameters",
    "TaskStatus",
    "TaskStatusResponse",
]
