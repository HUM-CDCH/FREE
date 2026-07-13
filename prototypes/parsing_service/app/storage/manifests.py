"""Task metadata and parsed-document manifest persistence (HTTP-free)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.models.parsed_document import ParsedDocument
from app.models.parser import canonical_preprocessing_config
from app.storage.atomic_json import read_json, write_json_atomic
from app.storage.hashing import (
    compute_config_hash,
    compute_sha256,
    document_id_from_hash,
)
from app.storage.paths import (
    PARSED_DOCUMENT_FILENAME,
    SERVICE_ROOT,
    SOURCE_FILENAME,
    canonical_parsed_document_path,
    document_store_dir,
    service_relative_ref,
)


class TaskNotFoundError(Exception):
    pass


def load_task_metadata(task_dir: Path) -> dict[str, Any]:
    meta_path = task_dir / "metadata.json"
    if not meta_path.exists():
        raise TaskNotFoundError("Task not found")
    return read_json(meta_path)


def save_task_metadata(task_dir: Path, data: dict[str, Any]) -> None:
    write_json_atomic(task_dir / "metadata.json", data)


def preprocessing_config_hash(metadata: dict[str, Any] | None = None) -> str:
    """Hash every runtime policy input capable of changing canonical text."""
    params = dict((metadata or {}).get("params", {}))
    resolved_device = str(params.get("resolved_ocr_device") or "unresolved")
    return compute_config_hash(
        canonical_preprocessing_config(resolved_ocr_device=resolved_device)
    )


def public_url_ref(url: str | None) -> str | None:
    if not isinstance(url, str) or not url:
        return None
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def rebind_parsed_document_for_task(
    task_dir: Path, metadata: dict[str, Any], parsed_document: ParsedDocument
) -> ParsedDocument:
    """Return a task-local view of a content-addressed ParsedDocument.

    Canonical documents are keyed by source hash, but public task responses must
    not leak the first task's filename, URL, timestamps, or task-local refs.
    """
    content_sha256 = str(
        metadata.get("content_sha256") or parsed_document.document.content_sha256
    )
    params = dict(metadata.get("params", {}))
    source_path = task_dir / str(metadata.get("source_path", SOURCE_FILENAME))
    byte_size = (
        source_path.stat().st_size
        if source_path.exists()
        else parsed_document.document.source.byte_size
    )

    source = parsed_document.document.source.model_copy(
        update={
            "kind": metadata.get("source_kind") or parsed_document.document.source.kind,
            "original_filename": params.get("source_name")
            or parsed_document.document.source.original_filename,
            "submitted_url": public_url_ref(metadata.get("submitted_url")),
            "byte_size": byte_size,
        }
    )
    document = parsed_document.document.model_copy(
        update={
            "document_id": document_id_from_hash(content_sha256),
            "content_sha256": content_sha256,
            "source": source,
            "created_at": metadata.get("created_at")
            or parsed_document.document.created_at,
        }
    )
    artifacts = parsed_document.artifacts.model_copy(
        update={
            "source_ref": metadata.get("source_store_path")
            or parsed_document.artifacts.source_ref,
            "parsed_json_ref": service_relative_ref(
                task_dir / PARSED_DOCUMENT_FILENAME
            ),
            "canonical_parsed_json_ref": service_relative_ref(
                canonical_parsed_document_path(content_sha256)
            ),
        }
    )
    return parsed_document.model_copy(
        update={
            "document": document,
            "artifacts": artifacts,
        }
    )


def json_payload_size(payload: Any) -> int:
    return len(json.dumps(payload, indent=2).encode("utf-8"))


def parsed_document_json_size(parsed_document: ParsedDocument) -> int:
    return json_payload_size(parsed_document.model_dump(mode="json"))


def _rebase_value(value: Any, old_prefix: str, new_prefix: str) -> Any:
    if isinstance(value, str):
        if value == old_prefix or value.startswith(f"{old_prefix}/"):
            return new_prefix + value[len(old_prefix) :]
        return value
    if isinstance(value, list):
        return [_rebase_value(item, old_prefix, new_prefix) for item in value]
    if isinstance(value, dict):
        return {
            key: _rebase_value(item, old_prefix, new_prefix)
            for key, item in value.items()
        }
    return value


def rebase_parsed_document_artifacts(
    parsed_document: ParsedDocument,
    old_root: Path,
    new_root: Path,
) -> ParsedDocument:
    """Repoint a fully built pending generation to its immutable final path."""
    old_prefix = service_relative_ref(old_root)
    new_prefix = service_relative_ref(new_root)
    artifacts = parsed_document.artifacts.model_copy(
        update={
            "raw_docling_json_ref": _rebase_value(
                parsed_document.artifacts.raw_docling_json_ref,
                old_prefix,
                new_prefix,
            ),
            "raw_doctags_ref": _rebase_value(
                parsed_document.artifacts.raw_doctags_ref,
                old_prefix,
                new_prefix,
            ),
            "llm_markdown_ref": _rebase_value(
                parsed_document.artifacts.llm_markdown_ref,
                old_prefix,
                new_prefix,
            ),
            "debug_refs": _rebase_value(
                parsed_document.artifacts.debug_refs,
                old_prefix,
                new_prefix,
            ),
        }
    )
    parser_runs = [
        run.model_copy(
            update={
                "output_ref": _rebase_value(
                    run.output_ref,
                    old_prefix,
                    new_prefix,
                ),
                "metrics": _rebase_value(
                    run.metrics,
                    old_prefix,
                    new_prefix,
                ),
            }
        )
        for run in parsed_document.parser_runs
    ]
    return parsed_document.model_copy(
        update={"artifacts": artifacts, "parser_runs": parser_runs}
    )


def validate_canonical_document(
    parsed_document: ParsedDocument,
    *,
    expected_sha256: str,
    expected_config_hash: str,
) -> None:
    """Authenticate a cache entry and every referenced canonical artifact."""
    if parsed_document.document.content_sha256 != expected_sha256:
        raise ValueError("Canonical document source hash mismatch.")
    if parsed_document.document.document_id != document_id_from_hash(expected_sha256):
        raise ValueError("Canonical document id mismatch.")
    if parsed_document.preprocessing.config_hash != expected_config_hash:
        raise ValueError("Canonical preprocessing policy mismatch.")

    document_root = document_store_dir(expected_sha256).resolve()
    refs = {
        ref
        for ref in (
            parsed_document.artifacts.raw_docling_json_ref,
            parsed_document.artifacts.raw_doctags_ref,
            parsed_document.artifacts.llm_markdown_ref,
            *parsed_document.artifacts.debug_refs,
        )
        if ref
    }
    if (
        parsed_document.text_views.llm_markdown
        and not parsed_document.artifacts.llm_markdown_ref
    ):
        raise ValueError("Canonical Markdown artifact reference is missing.")
    for ref in refs:
        candidate = SERVICE_ROOT / ref
        if candidate.is_symlink():
            raise ValueError("Canonical artifact may not be a symlink.")
        resolved = candidate.resolve()
        if not resolved.is_relative_to(document_root) or not resolved.is_file():
            raise ValueError("Canonical artifact reference is invalid.")

    for parser_run in parsed_document.parser_runs:
        input_hash = parser_run.metrics.get("input_sha256")
        if input_hash is not None and input_hash != expected_sha256:
            raise ValueError("Canonical parser input hash mismatch.")
        expected_output_hash = parser_run.metrics.get("output_sha256")
        if expected_output_hash and parser_run.output_ref:
            output_path = (SERVICE_ROOT / parser_run.output_ref).resolve()
            if compute_sha256(output_path) != expected_output_hash:
                raise ValueError("Canonical parser output digest mismatch.")


def write_parsed_document(task_dir: Path, parsed_document: ParsedDocument) -> None:
    destination = task_dir / PARSED_DOCUMENT_FILENAME
    write_json_atomic(destination, parsed_document.model_dump(mode="json"))


def write_canonical_parsed_document(
    content_sha256: str, parsed_document: ParsedDocument
) -> Path:
    destination = canonical_parsed_document_path(content_sha256)
    write_json_atomic(destination, parsed_document.model_dump(mode="json"))
    return destination


def read_canonical_parsed_document(content_sha256: str) -> ParsedDocument:
    parsed_path = canonical_parsed_document_path(content_sha256)
    if not parsed_path.exists():
        raise FileNotFoundError("Canonical parsed document JSON not found.")
    return ParsedDocument.model_validate(read_json(parsed_path))


def read_parsed_document(task_dir: Path) -> ParsedDocument:
    parsed_path = task_dir / PARSED_DOCUMENT_FILENAME
    if not parsed_path.exists():
        metadata_path = task_dir / "metadata.json"
        if metadata_path.exists():
            metadata = read_json(metadata_path)
            content_sha256 = metadata.get("content_sha256")
            if isinstance(content_sha256, str):
                try:
                    return rebind_parsed_document_for_task(
                        task_dir,
                        metadata,
                        read_canonical_parsed_document(content_sha256),
                    )
                except FileNotFoundError:
                    pass
        raise FileNotFoundError("Parsed document JSON not found.")
    parsed_document = ParsedDocument.model_validate(read_json(parsed_path))
    metadata_path = task_dir / "metadata.json"
    if metadata_path.exists():
        return rebind_parsed_document_for_task(
            task_dir, read_json(metadata_path), parsed_document
        )
    return parsed_document
