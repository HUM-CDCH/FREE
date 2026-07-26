"""Production Docling ingestion runner.

Docling converts each source document once. The resulting document is then
serialized per physical page so page identity never depends on collapsed
``<page_break>`` ordinals.
"""

from __future__ import annotations

import importlib
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.parsing.docling_inventory import table_inventory as _table_inventory
from app.storage.atomic_json import write_json_atomic, write_text_atomic
from app.storage.hashing import compute_sha256
from app.storage.paths import document_artifacts_dir, service_relative_ref
from app.timing import duration_ms, utc_now

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DoclingRunnerOutput:
    parser: str
    status: str
    started_at: str
    finished_at: str
    duration_ms: int
    raw_docling_json_ref: str | None = None
    raw_doctags_ref: str | None = None
    aggregate_doctags_ref: str | None = None
    llm_markdown_ref: str | None = None
    markdown_ref: str | None = None
    llm_markdown: str = ""
    char_count: int = 0
    raw_doctags_char_count: int = 0
    output_sha256: str | None = None
    page_spans: tuple[Any, ...] = ()
    page_mapping_verified: bool = False
    physical_page_export_complete: bool = False
    table_inventory: tuple[dict[str, Any], ...] = ()
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)


def _export_docling_json(document: Any) -> dict[str, Any] | None:
    for method_name in ("export_to_dict", "model_dump", "dict"):
        method = getattr(document, method_name, None)
        if callable(method):
            try:
                exported = method()
            except Exception:
                logger.debug(
                    "Docling JSON export method %s failed",
                    method_name,
                    exc_info=True,
                )
                exported = None
            if isinstance(exported, dict):
                return exported
    return None


def _convert_document(source_pdf: Path) -> Any:
    module = importlib.import_module("docling.document_converter")
    converter_cls = module.DocumentConverter  # type: ignore[attr-defined]
    converter = converter_cls()
    result = converter.convert(str(source_pdf))
    return result.document


def _convert_doctags(raw_doctags: str) -> Any:
    module = importlib.import_module("app.parsing.doctags_to_markdown")
    return module.convert_doctags_to_markdown(raw_doctags, drop_page_footers=True)


def _physical_doctags(
    export_doctags: Any,
    physical_pages: list[int],
    warnings: list[str],
) -> tuple[str | None, bool]:
    page_streams: list[str] = []
    complete = True
    for page_number in physical_pages:
        try:
            page_streams.append(
                str(
                    export_doctags(
                        pages={page_number},
                        add_page_index=False,
                    )
                    or ""
                )
            )
        except Exception as exc:
            if isinstance(exc, TypeError):
                warnings.append("doctags_physical_page_export_unsupported")
                return None, False
            logger.exception(
                "Docling physical-page DocTags export failed for page %s",
                page_number,
            )
            warnings.append(f"doctags_physical_page_export_failed:{page_number}")
            page_streams.append("")
            complete = False
    return "<page_break>".join(page_streams), complete


@dataclass(frozen=True)
class _DoctagsStreams:
    raw: str
    canonical: str
    requested_pages: tuple[int, ...]
    page_mapping_verified: bool
    physical_page_export_complete: bool


@dataclass(frozen=True)
class _SimplifiedDoctags:
    markdown: str
    markdown_ref: str | None
    page_spans: tuple[Any, ...]
    page_mapping_verified: bool


def _persist_docling_json(
    document: Any,
    artifact_dir: Path,
    warnings: list[str],
) -> str | None:
    docling_json = _export_docling_json(document)
    if docling_json is None:
        warnings.append("raw_docling_json_unavailable")
        return None

    json_path = artifact_dir / "document.docling.json"
    try:
        write_json_atomic(json_path, _jsonable(docling_json))
        return service_relative_ref(json_path)
    except Exception:
        logger.exception("Could not persist raw Docling JSON")
        warnings.append("raw_docling_json_write_failed")
        return None


def _select_doctags_streams(
    document: Any,
    physical_pages: list[int] | None,
    warnings: list[str],
) -> _DoctagsStreams:
    export_doctags = getattr(document, "export_to_doctags", None)
    raw_doctags = ""
    if callable(export_doctags):
        try:
            raw_doctags = str(export_doctags() or "")
        except Exception:
            logger.exception("Docling aggregate DocTags export failed")
            warnings.append("doctags_export_failed")
    else:
        warnings.append("doctags_export_unavailable")

    canonical_doctags = raw_doctags
    requested_pages = tuple(sorted(set(physical_pages or [])))
    page_mapping_verified = False
    physical_page_export_complete = False
    if requested_pages and callable(export_doctags):
        physical_stream, physical_page_export_complete = _physical_doctags(
            export_doctags,
            list(requested_pages),
            warnings,
        )
        if physical_stream is not None:
            canonical_doctags = physical_stream
            page_mapping_verified = True

    return _DoctagsStreams(
        raw=raw_doctags,
        canonical=canonical_doctags,
        requested_pages=requested_pages,
        page_mapping_verified=page_mapping_verified,
        physical_page_export_complete=physical_page_export_complete,
    )


def _persist_doctags(
    streams: _DoctagsStreams,
    artifact_dir: Path,
    warnings: list[str],
) -> tuple[str | None, str | None]:
    """Persist the canonical page stream and, when it differs, the aggregate."""
    raw_ref: str | None = None
    if streams.canonical:
        doctags_path = artifact_dir / "document.doctags"
        try:
            # This is the exact physical-page stream consumed by the simplifier.
            write_text_atomic(doctags_path, streams.canonical)
            raw_ref = service_relative_ref(doctags_path)
        except Exception:
            logger.exception("Could not persist canonical-input DocTags")
            warnings.append("raw_doctags_write_failed")

    aggregate_ref: str | None = None
    if streams.raw and streams.raw != streams.canonical:
        aggregate_path = artifact_dir / "document.aggregate.doctags"
        try:
            write_text_atomic(aggregate_path, streams.raw)
            aggregate_ref = service_relative_ref(aggregate_path)
        except Exception:
            logger.exception("Could not persist aggregate DocTags")
            warnings.append("aggregate_doctags_write_failed")

    return raw_ref, aggregate_ref


def _simplify_doctags(
    streams: _DoctagsStreams,
    artifact_dir: Path,
    warnings: list[str],
) -> _SimplifiedDoctags:
    if not streams.canonical:
        warnings.append("doctags_empty")
        return _SimplifiedDoctags("", None, (), False)

    try:
        conversion = _convert_doctags(streams.canonical)
        markdown = str(conversion.markdown)
        page_spans: tuple[Any, ...] = ()
        page_mapping_verified = streams.page_mapping_verified
        if page_mapping_verified:
            page_spans = tuple(conversion.page_spans)
            if len(page_spans) != len(streams.requested_pages):
                warnings.append("doctags_physical_page_count_mismatch")
                page_spans = ()
                page_mapping_verified = False
        markdown_path = artifact_dir / "document.llm.md"
        write_text_atomic(markdown_path, markdown + ("\n" if markdown else ""))
        return _SimplifiedDoctags(
            markdown,
            service_relative_ref(markdown_path),
            page_spans,
            page_mapping_verified,
        )
    except Exception:
        logger.exception("DocTags simplification failed")
        warnings.append("doctags_simplification_failed")
        return _SimplifiedDoctags("", None, (), False)


def _persist_diagnostic_markdown(
    document: Any,
    artifact_dir: Path,
    warnings: list[str],
) -> str | None:
    export_markdown = getattr(document, "export_to_markdown", None)
    if not callable(export_markdown):
        return None
    try:
        diagnostic_markdown = str(export_markdown() or "")
        if not diagnostic_markdown:
            return None
        markdown_path = artifact_dir / "document.diagnostic.md"
        write_text_atomic(markdown_path, diagnostic_markdown)
        return service_relative_ref(markdown_path)
    except Exception:
        logger.exception("Docling diagnostic Markdown export failed")
        warnings.append("diagnostic_markdown_export_failed")
        return None


def run_docling_ingestion(
    source_pdf: Path,
    content_sha256: str,
    *,
    physical_pages: list[int] | None = None,
    artifact_root: Path | None = None,
) -> DoclingRunnerOutput:
    """Run Docling once and persist raw and canonical DocTags artifacts."""
    started_at = utc_now()
    start = time.time()
    artifact_dir = (artifact_root or document_artifacts_dir(content_sha256)) / "docling"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

    try:
        document = _convert_document(source_pdf)
    except Exception:
        logger.exception("Docling conversion failed")
        return DoclingRunnerOutput(
            parser="docling_doctags",
            status="failed",
            started_at=started_at,
            finished_at=utc_now(),
            duration_ms=duration_ms(start),
            error="docling_conversion_failed",
        )

    inventory = _table_inventory(document)
    raw_docling_json_ref = _persist_docling_json(document, artifact_dir, warnings)
    streams = _select_doctags_streams(document, physical_pages, warnings)
    raw_doctags_ref, aggregate_doctags_ref = _persist_doctags(
        streams, artifact_dir, warnings
    )
    simplified = _simplify_doctags(streams, artifact_dir, warnings)
    markdown_ref = _persist_diagnostic_markdown(document, artifact_dir, warnings)

    status = "success" if simplified.markdown else "failed"
    output_sha256 = (
        compute_sha256(artifact_dir / "document.llm.md")
        if simplified.markdown_ref
        else None
    )
    return DoclingRunnerOutput(
        parser="docling_doctags",
        status=status,
        started_at=started_at,
        finished_at=utc_now(),
        duration_ms=duration_ms(start),
        raw_docling_json_ref=raw_docling_json_ref,
        raw_doctags_ref=raw_doctags_ref,
        aggregate_doctags_ref=aggregate_doctags_ref,
        llm_markdown_ref=simplified.markdown_ref,
        markdown_ref=markdown_ref,
        llm_markdown=simplified.markdown,
        char_count=len(simplified.markdown),
        raw_doctags_char_count=len(streams.canonical),
        output_sha256=output_sha256,
        page_spans=simplified.page_spans,
        page_mapping_verified=simplified.page_mapping_verified,
        physical_page_export_complete=streams.physical_page_export_complete,
        table_inventory=inventory,
        warnings=warnings,
        error=None if status == "success" else "canonical_doctags_unavailable",
    )
