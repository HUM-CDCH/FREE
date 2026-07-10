"""Public task request and response contracts."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from app.models.parsed_document import ParserRun

__all__ = ["TaskCreatedResponse", "TaskParameters", "TaskStatusResponse"]


class TaskParameters(BaseModel):
    model_config = ConfigDict(frozen=True)

    pipeline: str
    policy_revision: int
    doctags_converter_revision: int
    docling_version: str
    ocr_fallback_dpi: int
    ocr_fallback_device_policy: str
    resolved_ocr_device: str
    paddleocr_model: str
    paddleocr_version: str
    source_name: str


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
    source_path: str
    source_store_path: str
    source_kind: Literal["upload", "url"]
    submitted_url: str | None = None
    status: Literal["pending", "running", "completed", "failed"]
    created_at: str
    updated_at: str
    params: TaskParameters
    stats: dict[str, dict[str, Any]]
    parser_runs: list[ParserRun]
    selected_parser: str | None = None
    canonical_parsed_document_ref: str | None = None
    error_code: str | None = None
    error: str | None = None
