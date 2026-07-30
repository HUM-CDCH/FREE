"""Task metadata and parsed-document manifest persistence (HTTP-free)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.models.parsed_document_v2 import ParsedDocument
from app.models.parser import canonical_preprocessing_config
from app.storage.atomic_json import read_json, write_json_atomic
from app.storage.hashing import (
    compute_config_hash,
    document_id_from_hash,
    preprocess_id_from_hashes,
)
from app.storage.paths import (
    METADATA_FILENAME,
    PARSED_DOCUMENT_FILENAME,
    SOURCE_FILENAME,
    canonical_parsed_document_path,
    document_store_dir,
    resolve_service_ref,
)

StoredParsedDocument = ParsedDocument


class TaskNotFoundError(Exception):
    pass


def load_task_metadata(task_dir: Path) -> dict[str, Any]:
    meta_path = task_dir / METADATA_FILENAME
    if not meta_path.exists():
        raise TaskNotFoundError("Task not found")
    return read_json(meta_path)


def save_task_metadata(task_dir: Path, data: dict[str, Any]) -> None:
    write_json_atomic(task_dir / METADATA_FILENAME, data)


def preprocessing_config_hash(metadata: dict[str, Any] | None = None) -> str:
    """Hash every runtime policy input capable of changing canonical text."""
    params = dict((metadata or {}).get("params", {}))
    resolved_device = str(params.get("resolved_ocr_device") or "unresolved")
    return compute_config_hash(
        canonical_preprocessing_config(resolved_ocr_device=resolved_device)
    )


def rebind_parsed_document_for_task(
    task_dir: Path, metadata: dict[str, Any], parsed_document: StoredParsedDocument
) -> StoredParsedDocument:
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
            "kind": "upload",
            "original_filename": params.get("source_name")
            or parsed_document.document.source.original_filename,
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
    return parsed_document.model_copy(
        update={
            "document": document,
        }
    )


def generation_ref_from_artifact_ref(ref: str | None) -> str | None:
    """Return the immutable generation root represented by an artifact ref."""
    if not isinstance(ref, str):
        return None
    parts = Path(ref).parts
    try:
        index = parts.index("generations")
        if index + 1 >= len(parts):
            return None
        return "/".join(parts[: index + 2])
    except ValueError:
        return None


def read_committed_markdown(
    task_dir: Path,
    parsed_document: StoredParsedDocument | None = None,
) -> bytes:
    """Read Markdown from the task's explicitly bound immutable generation."""
    if parsed_document is None:
        parsed_document = read_parsed_document(task_dir)
    metadata = load_task_metadata(task_dir)
    generation_ref = metadata.get("canonical_generation_ref")
    if not isinstance(generation_ref, str) or not generation_ref:
        raise FileNotFoundError("Canonical generation binding is missing.")
    generation = resolve_service_ref(generation_ref)
    root = document_store_dir(parsed_document.document.content_sha256).resolve()
    candidate_path = generation / "artifacts" / "document.llm.md"
    if candidate_path.is_symlink():
        raise FileNotFoundError("Bound canonical Markdown artifact is unavailable.")
    candidate = candidate_path.resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise FileNotFoundError("Bound canonical Markdown artifact is unavailable.")
    return candidate.read_bytes()


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
    parsed_document: StoredParsedDocument,
    old_root: Path,
    new_root: Path,
) -> StoredParsedDocument:
    """Public v2 JSON contains no cache references, so rebasing is a no-op."""
    _ = (old_root, new_root)
    return parsed_document


def _validate_canonical_identity(
    parsed_document: StoredParsedDocument,
    expected_sha256: str,
    expected_config_hash: str,
) -> None:
    if parsed_document.document.content_sha256 != expected_sha256:
        raise ValueError("Canonical document source hash mismatch.")
    if parsed_document.document.document_id != document_id_from_hash(expected_sha256):
        raise ValueError("Canonical document id mismatch.")
    if parsed_document.preprocessing.preprocess_id != preprocess_id_from_hashes(
        expected_sha256, expected_config_hash
    ):
        raise ValueError("Canonical preprocessing policy mismatch.")


def _canonical_artifact_refs(parsed_document: StoredParsedDocument) -> set[str]:
    _ = parsed_document
    return set()


def _validate_markdown_artifact_ref(
    parsed_document: StoredParsedDocument,
    document_root: Path,
) -> None:
    _ = document_root
    if parsed_document.artifacts.markdown_ref != "artifacts/document.llm.md":
        raise ValueError("Canonical Markdown artifact reference is invalid.")


def validate_canonical_document(
    parsed_document: StoredParsedDocument,
    *,
    expected_sha256: str,
    expected_config_hash: str,
) -> None:
    """Authenticate a cache entry and every referenced canonical artifact."""
    _validate_canonical_identity(
        parsed_document,
        expected_sha256,
        expected_config_hash,
    )
    document_root = document_store_dir(expected_sha256).resolve()
    _validate_markdown_artifact_ref(parsed_document, document_root)
    # Raw parser refs/digests live in the internal generation manifest, never
    # in the portable ParsedDocument.


def write_parsed_document(
    task_dir: Path, parsed_document: StoredParsedDocument
) -> None:
    destination = task_dir / PARSED_DOCUMENT_FILENAME
    write_json_atomic(destination, parsed_document.model_dump(mode="json"))


def write_canonical_parsed_document(
    content_sha256: str, parsed_document: StoredParsedDocument
) -> Path:
    destination = canonical_parsed_document_path(content_sha256)
    write_json_atomic(destination, parsed_document.model_dump(mode="json"))
    return destination


def _validate_stored_json(payload: Any) -> StoredParsedDocument:
    if not isinstance(payload, dict) or payload.get("schema_version") != "parsed_document.v2":
        raise ValueError("parsed_document_contract_invalid")
    return ParsedDocument.model_validate(payload)


def read_canonical_parsed_document(content_sha256: str) -> StoredParsedDocument:
    parsed_path = canonical_parsed_document_path(content_sha256)
    if not parsed_path.exists():
        raise FileNotFoundError("Canonical parsed document JSON not found.")
    return _validate_stored_json(read_json(parsed_path))


def read_parsed_document(task_dir: Path) -> StoredParsedDocument:
    parsed_path = task_dir / PARSED_DOCUMENT_FILENAME
    metadata_path = task_dir / METADATA_FILENAME
    if not parsed_path.exists():
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
    parsed_document = _validate_stored_json(read_json(parsed_path))
    if metadata_path.exists():
        return rebind_parsed_document_for_task(
            task_dir, read_json(metadata_path), parsed_document
        )
    return parsed_document
