"""Build the canonical ParsedDocument from source and parser artifacts."""

from __future__ import annotations

import importlib
import hashlib
import math
from collections.abc import Sequence
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Literal, cast

from app.models.parsed_document_v2 import (
    DocumentMetadata,
    InputProfile,
    ParsedDocument,
    PublicArbitrationResult,
    PublicPreprocessingMetadata,
    SourceInfo,
)
from app.models.parser_output import ParserRun
from app.models.parser import CANONICAL_OCR_DPI, MAX_INGESTION_PAGES
from app.parsing.adapters.pymupdf_inspect import PdfInspection, inspect_pdf
from app.parsing.normalize import read_text
from app.parsing.page_resolution import (
    _docling_arbitration,
    _merge_page_fallback_text,
    _pages_requiring_fallback,
)
from app.parsing.render import (
    DEFAULT_MAX_RENDER_PAGE_PIXELS,
    DEFAULT_MAX_RENDER_TOTAL_PIXELS,
)
from app.storage.atomic_json import write_json_atomic, write_text_atomic
from app.storage.hashing import document_id_from_hash, preprocess_id_from_hashes
from app.storage.manifests import load_task_metadata, preprocessing_config_hash
from app.storage.paths import (
    SERVICE_ROOT,
    SOURCE_FILENAME,
    document_artifacts_dir,
    service_relative_ref,
    task_dir_for,
)
from app.timing import utc_now

PREPROCESS_PROFILE = "production_default"


class CanonicalIngestionError(RuntimeError):
    """A safe task-facing failure carrying parser provenance."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        parser_runs: list[ParserRun] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.parser_runs = list(parser_runs or [])


@dataclass(frozen=True)
class _CanonicalTextRequest:
    source_path: Path
    content_sha256: str
    inspection: PdfInspection
    docling_output: Any
    params: dict[str, Any]
    artifact_root: Path | None
    parser_runs: tuple[ParserRun, ...]


@dataclass(frozen=True)
class _CanonicalTextResolution:
    doc_tags_simplified: str
    llm_markdown: str
    docling_spans: tuple[Any, ...]
    llm_spans: tuple[Any, ...]
    parser_by_page: dict[int, str]
    ocr_output: Any | None
    ocr_parser_run: ParserRun | None
    ocr_blocks_by_page: dict[int, list[dict[str, Any]]]
    page_mapping_verified: bool
    unresolved_pages: tuple[int, ...]


@dataclass(frozen=True)
class _DoclingTextSource:
    markdown: str
    spans: tuple[Any, ...]
    page_mapping_verified: bool


@dataclass(frozen=True)
class _BuildContext:
    task_id: str
    task_dir: Path
    metadata: dict[str, Any]
    content_sha256: str
    params: dict[str, Any]
    source_name: Any
    source_path: Path
    artifact_root: Path | None
    started_at: Any


@dataclass(frozen=True)
class _InspectionResult:
    inspection: PdfInspection
    artifact_ref: str
    parser_run: ParserRun


@dataclass(frozen=True)
class _ParsingResult:
    docling_output: Any
    docling_run: ParserRun
    text: _CanonicalTextResolution
    parser_runs: tuple[ParserRun, ...]


@dataclass(frozen=True)
class _TableResolution:
    tables: list[Any]
    parser_run: ParserRun
    parser_by_page: dict[int, str]
    # Rejected/excluded table candidates stay auditable as portable diagnostics.
    diagnostics: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class BuiltGeneration:
    """Portable document plus canonical bytes and internal cache manifest."""

    document: Any
    markdown_bytes: bytes
    generation_manifest: dict[str, Any]


def package_version(package_name: str) -> str | None:
    try:
        return version(package_name)
    except PackageNotFoundError:
        return None


def validate_inspection_for_ingestion(inspection: PdfInspection) -> None:
    """Reject sources that exceed parser budgets before running Docling."""
    if inspection.status != "completed":
        raise ValueError(
            f"PDF inspection failed: {inspection.error or 'unknown inspection error'}"
        )
    if inspection.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported by canonical ingestion.")
    if inspection.page_count < 1:
        raise ValueError("PDF contains no pages.")
    if inspection.page_count > MAX_INGESTION_PAGES:
        raise ValueError(
            f"PDF has too many pages: {inspection.page_count} > {MAX_INGESTION_PAGES}."
        )

    scale = CANONICAL_OCR_DPI / 72.0
    total_pixels = 0
    for page in inspection.pages:
        if (
            not math.isfinite(page.width_pt)
            or not math.isfinite(page.height_pt)
            or page.width_pt <= 0
            or page.height_pt <= 0
        ):
            raise ValueError(f"PDF page {page.page} has invalid physical geometry.")
        page_pixels = math.ceil(page.width_pt * scale) * math.ceil(
            page.height_pt * scale
        )
        if page_pixels > DEFAULT_MAX_RENDER_PAGE_PIXELS:
            raise ValueError(
                f"PDF page {page.page} exceeds the canonical render budget."
            )
        total_pixels += page_pixels
        if total_pixels > DEFAULT_MAX_RENDER_TOTAL_PIXELS:
            raise ValueError("PDF exceeds the canonical total render budget.")


def write_inspection_artifact(
    content_sha256: str,
    inspection: PdfInspection,
    *,
    artifact_root: Path | None = None,
) -> str:
    inspection_path = (
        artifact_root or document_artifacts_dir(content_sha256)
    ) / "pymupdf_inspection.json"
    write_json_atomic(inspection_path, inspection.model_dump(mode="json"))
    return service_relative_ref(inspection_path)


def parser_run_from_inspection(
    inspection: PdfInspection,
    input_sha256: str,
    inspection_ref: str,
) -> ParserRun:
    char_count = sum(page.char_count for page in inspection.pages)
    word_count = sum(page.word_count for page in inspection.pages)
    return ParserRun(
        parser="pymupdf_inspect",
        version=inspection.parser_version,
        status="success" if inspection.status == "completed" else "failed",
        started_at=inspection.started_at,
        finished_at=inspection.finished_at,
        duration_ms=inspection.duration_ms,
        input_ref=f"data/sources/{input_sha256}.pdf",
        output_ref=inspection_ref,
        metrics={
            "pages": inspection.page_count,
            "char_count": char_count,
            "word_count": word_count,
            "is_encrypted": inspection.is_encrypted,
            "input_sha256": input_sha256,
        },
        warnings=inspection.warnings,
        error=inspection.error,
    )


def _read_service_text(ref: str | None) -> str:
    if not ref:
        return ""
    path = (SERVICE_ROOT / ref).resolve()
    if not path.is_relative_to(SERVICE_ROOT.resolve()):
        raise ValueError("Artifact path escaped service root.")
    return read_text(path)


def _run_docling_ingestion(
    source_path: Path,
    content_sha256: str,
    physical_pages: list[int],
    artifact_root: Path | None,
) -> Any:
    module = importlib.import_module("app.parsing.docling_runner")
    return module.run_docling_ingestion(
        source_path,
        content_sha256,
        physical_pages=physical_pages,
        artifact_root=artifact_root,
    )


def _run_ocr_fallback(
    source_path: Path,
    content_sha256: str,
    page_numbers: list[int],
    device: str,
    artifact_root: Path | None,
) -> Any:
    module = importlib.import_module("app.parsing.ocr_fallback")
    return module.run_paddleocr_fallback(
        source_pdf=source_path,
        content_sha256=content_sha256,
        page_numbers=page_numbers,
        dpi=CANONICAL_OCR_DPI,
        device=device,
        artifact_root=artifact_root,
    )


def _run_table_extraction(
    source_path: Path,
    content_sha256: str,
    page_heights_pt: dict[int, float],
    page_rotations: dict[int, int],
    docling_tables: tuple[dict[str, Any], ...],
) -> Any:
    module = importlib.import_module("app.parsing.table_extraction")
    return module.extract_tables(
        source_pdf=source_path,
        content_sha256=content_sha256,
        page_heights_pt=page_heights_pt,
        page_rotations=page_rotations,
        docling_tables=docling_tables,
    )


def parser_run_from_docling_output(output: Any, content_sha256: str) -> ParserRun:
    metrics: dict[str, Any] = {
        "char_count": output.char_count,
        "raw_doctags_char_count": output.raw_doctags_char_count,
        "input_sha256": content_sha256,
    }
    metrics["page_mapping_verified"] = bool(output.page_mapping_verified)
    metrics["physical_page_export_complete"] = bool(
        output.physical_page_export_complete
    )
    metrics["table_inventory_count"] = len(getattr(output, "table_inventory", ()) or ())
    for name in (
        "raw_docling_json_ref",
        "raw_doctags_ref",
        "aggregate_doctags_ref",
        "llm_markdown_ref",
        "output_sha256",
    ):
        value = getattr(output, name, None)
        if value:
            metrics[name] = value
    if output.markdown_ref:
        metrics["diagnostic_markdown_ref"] = output.markdown_ref
    status = cast(Literal["success", "failed", "skipped"], output.status)
    return ParserRun(
        parser=output.parser,
        version=package_version("docling"),
        status=status,
        started_at=output.started_at,
        finished_at=output.finished_at,
        duration_ms=output.duration_ms,
        input_ref=f"data/sources/{content_sha256}.pdf",
        output_ref=output.llm_markdown_ref,
        metrics=metrics,
        warnings=output.warnings,
        error=output.error,
    )


def parser_run_from_ocr_output(output: Any, content_sha256: str) -> ParserRun:
    status = cast(Literal["success", "failed", "skipped"], output.status)
    return ParserRun(
        parser=output.parser,
        version=package_version("paddleocr"),
        status=status,
        started_at=output.started_at,
        finished_at=output.finished_at,
        duration_ms=output.duration_ms,
        input_ref=f"data/sources/{content_sha256}.pdf",
        output_ref=output.output_ref,
        metrics={
            "pages": sorted(output.pages),
            "char_count": sum(len(text) for text in output.pages.values()),
            "input_sha256": content_sha256,
        },
        warnings=output.warnings,
        error=output.error,
    )


def parser_run_from_table_output(output: Any, content_sha256: str) -> ParserRun:
    status = cast(Literal["success", "failed", "skipped"], output.status)
    version = (
        package_version("camelot-py") if output.parser == "camelot_stream" else None
    )
    return ParserRun(
        parser=output.parser,
        version=version,
        status=status,
        started_at=output.started_at,
        finished_at=output.finished_at,
        duration_ms=output.duration_ms,
        input_ref=f"data/sources/{content_sha256}.pdf",
        metrics={
            **output.metrics,
            "input_sha256": content_sha256,
            "diagnostics": list(getattr(output, "diagnostics", ()) or ()),
        },
        warnings=output.warnings,
        error=output.error,
    )


def _docling_text_source(request: _CanonicalTextRequest) -> _DoclingTextSource:
    output = request.docling_output
    runner_markdown = getattr(output, "llm_markdown", None)
    return _DoclingTextSource(
        markdown=(
            runner_markdown
            if isinstance(runner_markdown, str)
            else _read_service_text(output.llm_markdown_ref).removesuffix("\n")
        ),
        spans=tuple(getattr(output, "page_spans", ()) or ()),
        page_mapping_verified=bool(getattr(output, "page_mapping_verified", False)),
    )


def _document_level_text_resolution(
    request: _CanonicalTextRequest,
    source: _DoclingTextSource,
) -> _CanonicalTextResolution:
    parser_by_page = dict.fromkeys(
        range(1, request.inspection.page_count + 1),
        "docling_doctags",
    )
    return _CanonicalTextResolution(
        doc_tags_simplified=source.markdown,
        llm_markdown=source.markdown,
        docling_spans=source.spans,
        llm_spans=(),
        parser_by_page=parser_by_page,
        ocr_output=None,
        ocr_parser_run=None,
        ocr_blocks_by_page={},
        page_mapping_verified=False,
        unresolved_pages=(),
    )


def _mapped_text_resolution(
    request: _CanonicalTextRequest,
    source: _DoclingTextSource,
) -> _CanonicalTextResolution:
    page_count = request.inspection.page_count
    fallback_pages = _pages_requiring_fallback(source.spans, request.inspection)
    ocr_output = None
    ocr_parser_run = None
    if fallback_pages:
        ocr_output = _run_ocr_fallback(
            request.source_path,
            request.content_sha256,
            fallback_pages,
            str(request.params.get("resolved_ocr_device") or "cpu"),
            request.artifact_root,
        )
        ocr_parser_run = parser_run_from_ocr_output(
            ocr_output,
            request.content_sha256,
        )
    merged = _merge_page_fallback_text(
        docling_spans=source.spans,
        inspection=request.inspection,
        fallback_pages=fallback_pages,
        ocr_output=ocr_output,
    )
    return _CanonicalTextResolution(
        doc_tags_simplified=source.markdown,
        docling_spans=source.spans,
        llm_markdown=merged.llm_markdown,
        llm_spans=merged.llm_spans,
        parser_by_page=merged.parser_by_page,
        ocr_output=ocr_output,
        ocr_parser_run=ocr_parser_run,
        ocr_blocks_by_page=merged.ocr_blocks_by_page,
        page_mapping_verified=(
            {span.page for span in merged.llm_spans} == set(range(1, page_count + 1))
            and len(merged.llm_spans) == page_count
        ),
        unresolved_pages=tuple(merged.unresolved_pages),
    )


def _validate_text_resolution(
    request: _CanonicalTextRequest,
    resolution: _CanonicalTextResolution,
) -> None:
    parser_runs = list(request.parser_runs)
    if resolution.ocr_parser_run is not None:
        parser_runs.append(resolution.ocr_parser_run)
    if resolution.unresolved_pages:
        page_list = ", ".join(str(page) for page in resolution.unresolved_pages)
        raise CanonicalIngestionError(
            getattr(resolution.ocr_output, "error", None)
            or "canonical_page_unresolved",
            f"Canonical parsing could not resolve page(s): {page_list}.",
            parser_runs=parser_runs,
        )
    if resolution.page_mapping_verified:
        usable = any(span.text.strip() for span in resolution.llm_spans)
    else:
        usable = bool(resolution.llm_markdown.strip())
    if not usable:
        raise CanonicalIngestionError(
            "canonical_text_unavailable",
            "No parser produced usable canonical document text.",
            parser_runs=parser_runs,
        )


def _resolve_canonical_text(
    request: _CanonicalTextRequest,
) -> _CanonicalTextResolution:
    """Resolve page-safe canonical text, using OCR only for verified page gaps."""
    source = _docling_text_source(request)
    # Keep document-level text, but never invent page provenance when the
    # installed exporter cannot prove page identity.
    if not source.page_mapping_verified and source.markdown.strip():
        resolution = _document_level_text_resolution(request, source)
    else:
        resolution = _mapped_text_resolution(request, source)
    _validate_text_resolution(request, resolution)
    return resolution


def _build_context(
    task_id: str,
    source_path: Path | None,
    artifact_root: Path | None,
) -> _BuildContext:
    task_dir = task_dir_for(task_id)
    metadata = load_task_metadata(task_dir)
    content_sha256 = metadata.get("content_sha256")
    if not isinstance(content_sha256, str) or not content_sha256:
        raise ValueError("Task metadata is missing required content_sha256.")
    params = dict(metadata.get("params", {}))
    return _BuildContext(
        task_id=task_id,
        task_dir=task_dir,
        metadata=metadata,
        content_sha256=content_sha256,
        params=params,
        source_name=params.get("source_name", SOURCE_FILENAME),
        source_path=source_path or task_dir / SOURCE_FILENAME,
        artifact_root=artifact_root,
        started_at=metadata.get("created_at") or utc_now(),
    )


def _inspect_source(context: _BuildContext) -> _InspectionResult:
    inspection = inspect_pdf(
        context.source_path,
        max_pages=MAX_INGESTION_PAGES,
        render_dpi=CANONICAL_OCR_DPI,
        max_page_pixels=DEFAULT_MAX_RENDER_PAGE_PIXELS,
        max_total_pixels=DEFAULT_MAX_RENDER_TOTAL_PIXELS,
    )
    artifact_ref = write_inspection_artifact(
        context.content_sha256,
        inspection,
        artifact_root=context.artifact_root,
    )
    parser_run = parser_run_from_inspection(
        inspection,
        context.content_sha256,
        artifact_ref,
    )
    try:
        validate_inspection_for_ingestion(inspection)
    except ValueError as exc:
        raise CanonicalIngestionError(
            "pdf_preflight_failed",
            str(exc),
            parser_runs=[parser_run],
        ) from exc
    return _InspectionResult(
        inspection=inspection,
        artifact_ref=artifact_ref,
        parser_run=parser_run,
    )


def _run_canonical_parsers(
    context: _BuildContext,
    inspected: _InspectionResult,
) -> _ParsingResult:
    docling_output = _run_docling_ingestion(
        context.source_path,
        context.content_sha256,
        list(range(1, inspected.inspection.page_count + 1)),
        context.artifact_root,
    )
    docling_run = parser_run_from_docling_output(
        docling_output,
        context.content_sha256,
    )
    parser_runs = (inspected.parser_run, docling_run)
    text = _resolve_canonical_text(
        _CanonicalTextRequest(
            source_path=context.source_path,
            content_sha256=context.content_sha256,
            inspection=inspected.inspection,
            docling_output=docling_output,
            params=context.params,
            artifact_root=context.artifact_root,
            parser_runs=parser_runs,
        )
    )
    if text.ocr_parser_run is not None:
        parser_runs = (*parser_runs, text.ocr_parser_run)
    return _ParsingResult(
        docling_output=docling_output,
        docling_run=docling_run,
        text=text,
        parser_runs=parser_runs,
    )


def _table_parsers_by_page(tables: list[Any]) -> dict[int, str]:
    parser_by_page: dict[int, str] = {}
    for table in tables:
        current = parser_by_page.get(table.page_number)
        if current is None:
            parser_by_page[table.page_number] = table.source_parser or "unknown"
        elif current != table.source_parser:
            parser_by_page[table.page_number] = "table_reconciled"
    return parser_by_page


def _extract_document_tables(
    context: _BuildContext,
    inspected: _InspectionResult,
    parsing: _ParsingResult,
) -> _TableResolution:
    inspection = inspected.inspection
    docling_tables = tuple(getattr(parsing.docling_output, "table_inventory", ()) or ())
    output = _run_table_extraction(
        context.source_path,
        context.content_sha256,
        {page.page: page.height_pt for page in inspection.pages},
        {page.page: page.rotation for page in inspection.pages},
        docling_tables,
    )
    tables = list(output.tables)
    return _TableResolution(
        tables=tables,
        parser_run=parser_run_from_table_output(
            output,
            context.content_sha256,
        ),
        parser_by_page=_table_parsers_by_page(tables),
        diagnostics=tuple(
            dict(diagnostic)
            for diagnostic in (getattr(output, "diagnostics", ()) or ())
        ),
    )


def _arbitrate_parsers(
    inspected: _InspectionResult,
    parsing: _ParsingResult,
    tables: _TableResolution,
) -> PublicArbitrationResult:
    return _docling_arbitration(
        inspection=inspected.inspection,
        docling_run=parsing.docling_run,
        parser_by_page=parsing.text.parser_by_page,
        page_mapping_verified=parsing.text.page_mapping_verified,
        table_pages=frozenset(table.page_number for table in tables.tables),
        table_parser_by_page=tables.parser_by_page,
    )


def _source_byte_size(source_path: Path) -> int | None:
    if not source_path.exists():
        return None
    return source_path.stat().st_size


def _document_metadata(
    context: _BuildContext,
    inspection: PdfInspection,
) -> DocumentMetadata:
    return DocumentMetadata(
        document_id=document_id_from_hash(context.content_sha256),
        content_sha256=context.content_sha256,
        source=SourceInfo(
            kind="upload",
            original_filename=context.source_name,
            byte_size=_source_byte_size(context.source_path),
        ),
        created_at=context.started_at,
        page_count=inspection.page_count,
        is_encrypted=inspection.is_encrypted,
        input_profile=InputProfile(
            has_text_layer=any(page.char_count > 0 for page in inspection.pages)
        ),
    )


def _parser_warnings(parser_runs: list[ParserRun]) -> list[str]:
    warnings = [
        f"{run.parser}: {run.error}" for run in parser_runs if run.status == "failed"
    ]
    for run in parser_runs:
        warnings.extend(run.warnings)
    return warnings


def _preprocessing_metadata(
    context: _BuildContext,
    parser_runs: list[ParserRun],
) -> PublicPreprocessingMetadata:
    config_hash = preprocessing_config_hash(context.metadata)
    warnings = _parser_warnings(parser_runs)
    return PublicPreprocessingMetadata(
        preprocess_id=preprocess_id_from_hashes(
            context.content_sha256,
            config_hash,
        ),
        profile=PREPROCESS_PROFILE,
        service_version=package_version("parsing_service"),
        started_at=context.started_at,
        finished_at=utc_now(),
        status="completed_with_warnings" if warnings else "completed",
        warnings=warnings,
    )


def _reviewed_continuations(
    docling_output: Any,
) -> tuple[tuple[tuple[str, str], ...], tuple[dict[str, Any], ...]]:
    """Review every producer boundary once, returning its pairs and diagnostics.

    Admits only the checked-in producer review observation; the diagnostics
    retain each decision without turning any of them into a heuristic.
    """
    from app.parsing.continuation import (
        evaluate_reviewed_continuation,
        reviewed_boundary_from_doctags,
    )

    records = tuple(getattr(docling_output, "producer_records", ()) or ())
    doctags = str(getattr(docling_output, "canonical_doctags", "") or "")
    if not records:
        return (), ()
    pairs: list[tuple[str, str]] = []
    diagnostics: list[dict[str, Any]] = []
    for first, second in zip(records, records[1:], strict=False):
        first_ref = first.get("self_ref")
        second_ref = second.get("self_ref")
        boundary = (
            reviewed_boundary_from_doctags(doctags, (first, second))
            if doctags
            else None
        )
        if boundary is None:
            reason = "malformed_observation"
        else:
            decision = evaluate_reviewed_continuation(
                (first, second), boundary=boundary
            )
            reason = decision.reason
            if (
                decision.continue_table
                and isinstance(first_ref, str)
                and isinstance(second_ref, str)
            ):
                pairs.append((first_ref, second_ref))
        diagnostics.append(
            {
                "code": "continuation_reviewed"
                if reason == "reviewed_capture_continuation"
                else "continuation_rejected",
                "reason": reason,
                "first_producer_ref": str(first_ref) if first_ref is not None else None,
                "second_producer_ref": str(second_ref)
                if second_ref is not None
                else None,
                "first_page": first.get("page_no"),
                "second_page": second.get("page_no"),
            }
        )
    return tuple(pairs), tuple(diagnostics)


def _v2_logical_tables(
    tables: Sequence[Any],
    *,
    content_sha256: str,
    preprocess_id: str,
    continuation_pairs: Sequence[tuple[str, str]],
) -> tuple[list[Any], dict[str, str], dict[str, Any]]:
    from app.models.parsed_document_v2 import (
        CanonicalTableCell,
        LogicalTable,
        LogicalTablePageSpan,
        ParserAttribution,
        ProducerTableCellObservation,
        TableParserAttribution,
        V2_GEOMETRY_ERROR_CODE,
        deterministic_anchor_id,
        deterministic_block_id,
        deterministic_occurrence_id,
        deterministic_table_id,
    )
    from app.parsing.semantic_stream import derive_logical_table_groups

    # A table without a producer-local reference is Camelot-only (or otherwise
    # ungrounded). It may still be reported as unplaced by the caller, but it
    # must never become canonical v2 content or acquire a fabricated producer
    # identity from its derived table_id.
    grounded_tables = [
        table
        for table in tables
        if getattr(table, "producer_ref", None)
        and (
            getattr(table, "source_parser", None) == "docling_table"
            or getattr(table, "content_parser", None) == "docling_table"
        )
    ]
    groups = derive_logical_table_groups(
        grounded_tables, continuation_pairs=continuation_pairs
    )
    output: list[LogicalTable] = []
    table_id_by_observed_ref: dict[str, str] = {}
    observations: dict[str, list[ProducerTableCellObservation]] = {}
    for group in groups:
        producer_refs = tuple(
            str(
                getattr(fragment, "producer_ref", None)
                or getattr(fragment, "table_id", "")
            )
            for fragment in group.fragments
        )
        table_id = deterministic_table_id(
            content_sha256, preprocess_id, "+".join(producer_refs)
        )
        row_base = 0
        cells: list[CanonicalTableCell] = []
        spans: list[LogicalTablePageSpan] = []
        for fragment in group.fragments:
            producer_ref = getattr(fragment, "producer_ref", None)
            if not producer_ref:
                # Defensive guard: grounded_tables above should make this
                # unreachable, and failing closed is preferable to inventing
                # producer Evidence if a new table adapter bypasses it.
                continue
            table_id_by_observed_ref[str(producer_ref)] = table_id
            observed_root_rows = 0
            prior_cells = tuple(cells)
            for cell in getattr(fragment, "cells", ()) or ():
                if cell.bbox is None:
                    raise CanonicalIngestionError(
                        V2_GEOMETRY_ERROR_CODE,
                        f"Table cell {producer_ref}:{cell.row}:{cell.col} has no safe producer geometry.",
                    )
                canonical_row = row_base + int(cell.row)
                observed_root_rows = max(observed_root_rows, int(cell.row) + 1)
                roots = [
                    root
                    for root in prior_cells
                    if root.row < canonical_row
                    and canonical_row + cell.rowspan <= root.row + root.rowspan
                    and root.column <= cell.col
                    and cell.col + cell.colspan <= root.column + root.colspan
                ]
                if len(roots) > 1:
                    raise ValueError("continued_cell_root_ambiguous")
                if roots:
                    cell_id = roots[0].cell_id
                    anchor_id = roots[0].evidence_anchor_id
                else:
                    cell_id = deterministic_block_id(
                        content_sha256,
                        preprocess_id,
                        f"{table_id}:cell:{canonical_row}:{cell.col}",
                    )
                    anchor_id = deterministic_anchor_id(
                        content_sha256, preprocess_id, f"{table_id}:{cell_id}"
                    )
                observations.setdefault(anchor_id, []).append(
                    ProducerTableCellObservation(
                        occurrence_id=deterministic_occurrence_id(
                            content_sha256,
                            preprocess_id,
                            f"{table_id}:{cell_id}:{producer_ref}:{fragment.page_number}:{cell.row}:{cell.col}",
                        ),
                        page_number=fragment.page_number,
                        row_offset=cell.row,
                        column_offset=cell.col,
                        producer_ref=str(producer_ref),
                        row_span=cell.rowspan,
                        column_span=cell.colspan,
                        bbox=cell.bbox,
                    )
                )
                if not roots:
                    cells.append(
                        CanonicalTableCell(
                            cell_id=cell_id,
                            row=canonical_row,
                            column=cell.col,
                            text=cell.text,
                            role=cell.role,
                            rowspan=cell.rowspan,
                            colspan=cell.colspan,
                            bbox=cell.bbox,
                            evidence_anchor_id=anchor_id,
                        )
                    )
            spans.append(
                LogicalTablePageSpan(
                    page_number=fragment.page_number,
                    producer_table_ref=str(producer_ref),
                    page_local_row_start=0,
                    page_local_row_end=max(
                        (cell.row for cell in fragment.cells), default=0
                    ),
                    page_local_col_count=fragment.cols,
                )
            )
            row_base += max(int(fragment.rows or 0), observed_root_rows)
        first = group.fragments[0]
        parser = (
            getattr(first, "content_parser", None)
            or getattr(first, "source_parser", None)
            or "unknown"
        )
        structure = getattr(first, "structure_parser", None) or parser
        geometry = getattr(first, "geometry_parser", None)
        output.append(
            LogicalTable(
                table_id=table_id,
                rows=row_base,
                cols=max(
                    (
                        int(getattr(fragment, "cols", 0) or 0)
                        for fragment in group.fragments
                    ),
                    default=0,
                ),
                cells=cells,
                spans=spans,
                parser_attribution=TableParserAttribution(
                    content_parser=ParserAttribution(parser=parser),
                    structure_parser=ParserAttribution(parser=structure),
                    geometry_parser=ParserAttribution(parser=geometry)
                    if geometry
                    else None,
                ),
                continuation="derived_continuation"
                if group.continuation
                else "page_local",
            )
        )
    return output, table_id_by_observed_ref, observations


def build_parsed_document_v2(
    task_id: str,
    *,
    source_path: Path | None = None,
    artifact_root: Path | None = None,
):
    """Build v2 directly from the authenticated producer stages.

    The builder promotes DocTags semantic blocks and producer-inventory tables
    directly; no projection or compatibility view is involved.
    """
    from app.models.parsed_document_v2 import (
        ArtifactManifestV2,
        ParsedPageV2,
        ParserDiagnostic,
        PublicParserProvenance,
        V2_GEOMETRY_ERROR_CODE,
        V2_PAGE_MAPPING_ERROR_CODE,
    )
    from app.parsing.semantic_stream import (
        apply_multi_page_text_provenance,
        doctags_to_intermediate_blocks,
        ocr_pages_to_blocks,
        place_table_slots,
        semantic_blocks_to_v2,
    )
    from app.parsing.v2_publication import (
        apply_rendered_spans,
        build_evidence_index,
        render_canonical_markdown,
        validate_publication,
    )

    context = _build_context(task_id, source_path, artifact_root)
    inspected = _inspect_source(context)
    parsing = _run_canonical_parsers(context, inspected)
    tables_result = _extract_document_tables(context, inspected, parsing)
    parser_runs = [*parsing.parser_runs, tables_result.parser_run]
    content_sha256 = context.content_sha256
    preprocess = _preprocessing_metadata(context, parser_runs)
    preprocess_id = preprocess.preprocess_id
    continuation_pairs, continuation_diagnostics = _reviewed_continuations(
        parsing.docling_output
    )
    tables, observed_to_logical, observations = _v2_logical_tables(
        tables_result.tables,
        content_sha256=content_sha256,
        preprocess_id=preprocess_id,
        continuation_pairs=continuation_pairs,
    )

    producer_doctags = str(
        getattr(parsing.docling_output, "canonical_doctags", "") or ""
    )
    page_sizes = {
        page.page: (page.width_pt, page.height_pt)
        for page in inspected.inspection.pages
    }
    selected_ocr_pages = {
        page
        for page, parser in parsing.text.parser_by_page.items()
        if parser == "paddleocr"
    }
    ocr_warnings = set(getattr(parsing.text.ocr_output, "warnings", ()) or ())
    if selected_ocr_pages and "ocr_line_geometry_unavailable" in ocr_warnings:
        raise CanonicalIngestionError(
            V2_GEOMETRY_ERROR_CODE,
            "OCR produced text without complete safe line geometry.",
            parser_runs=list(parser_runs),
        )
    if producer_doctags:
        intermediate, slots = doctags_to_intermediate_blocks(
            producer_doctags, page_sizes=page_sizes
        )
        intermediate = apply_multi_page_text_provenance(
            intermediate,
            tuple(
                getattr(
                    parsing.docling_output,
                    "multi_page_text_inventory",
                    (),
                )
                or ()
            ),
            page_sizes=page_sizes,
        )
        # Only tables that can become canonical v2 objects may participate in
        # placement.  In particular, an ungrounded/ambiguous Camelot candidate
        # must never leave a dangling generated ref in the content stream.
        placement_tables = tuple(
            table
            for table in tables_result.tables
            if getattr(table, "producer_ref", None)
        )
        placement = place_table_slots(intermediate, slots, placement_tables)
        intermediate = placement.blocks
        if selected_ocr_pages:
            ocr_blocks = ocr_pages_to_blocks(
                {
                    page: parsing.text.ocr_blocks_by_page.get(page, ())
                    for page in selected_ocr_pages
                }
            )
            replacement: list[Any] = []
            for page in range(1, inspected.inspection.page_count + 1):
                page_blocks = [
                    block for block in intermediate if block.page_number == page
                ]
                if page in selected_ocr_pages:
                    replacement.extend(
                        block
                        for block in ocr_blocks
                        if block.page_number == page
                    )
                    replacement.extend(
                        block
                        for block in page_blocks
                        if block.kind in {"table_slot", "page_boundary"}
                    )
                else:
                    replacement.extend(page_blocks)
            intermediate = tuple(replacement)
        # place_table_slots stores the observed ParsedTable ID in table_slot;
        # reconcile that producer-local identity to the derived logical ID.
        table_ids = {
            block.table_slot: observed_to_logical.get(
                block.table_slot or "", block.table_slot or ""
            )
            for block in intermediate
            if getattr(block, "kind", None) == "table_slot" and block.table_slot
        }
        published_blocks, text_observations = semantic_blocks_to_v2(
            intermediate,
            content_sha256,
            preprocess_id,
            table_ids=table_ids,
        )
        blocks = list(published_blocks)
        placement_diagnostics = [
            {
                "code": diagnostic.code,
                "page_number": diagnostic.page_number,
                "slot_id": diagnostic.slot_id,
                "table_id": diagnostic.table_id,
                "detail": diagnostic.detail,
            }
            for diagnostic in placement.diagnostics
        ]
        # Placement reports producer identities, while the canonical renderer
        # resolves tables by derived logical IDs. Rebase unplaced refs through
        # the same observed-to-logical map used for ordered table slots.
        canonical_ids = {table.table_id for table in tables}
        unplaced = {
            page: tuple(
                observed_to_logical[table_ref]
                for table_ref in refs
                if table_ref in observed_to_logical
                and observed_to_logical[table_ref] in canonical_ids
            )
            for page, refs in placement.unplaced_content.items()
        }
    else:
        fallback_pages = parsing.text.ocr_blocks_by_page
        intermediate = ocr_pages_to_blocks(fallback_pages)
        published_blocks, text_observations = semantic_blocks_to_v2(
            intermediate, content_sha256, preprocess_id, parser="paddleocr"
        )
        blocks = list(published_blocks)
        placement_diagnostics = []
        # Without an authenticated DocTags inventory, no table is promoted to
        # the canonical stream. Camelot-only candidates remain diagnostics.
        unplaced = {}

    ungrounded_table_diagnostics = [
        {
            "code": "ungrounded_table_excluded",
            "table_id": str(getattr(table, "table_id", "")),
            "page_number": int(getattr(table, "page_number", 0)),
            "detail": "Table has no producer-local observation; excluded from v2 canonical tables.",
        }
        for table in tables_result.tables
        if not getattr(table, "producer_ref", None)
    ]
    diagnostics = [
        *continuation_diagnostics,
        *placement_diagnostics,
        *tables_result.diagnostics,
        *ungrounded_table_diagnostics,
    ]
    if not parsing.text.page_mapping_verified:
        raise CanonicalIngestionError(
            V2_PAGE_MAPPING_ERROR_CODE,
            "physical-page mapping could not be verified",
            parser_runs=list(parser_runs),
        )
    parser_runs_public = [
        PublicParserProvenance(
            parser=run.parser,
            version=run.version,
            status=run.status,
            warnings=list(run.warnings),
            error=run.error,
        )
        for run in parser_runs
    ]

    pages: list[ParsedPageV2] = []
    block_by_page: dict[int, list[str]] = {}
    for block in blocks:
        block_by_page.setdefault(block.page_number, []).append(block.block_id)
    for page_info in inspected.inspection.pages:
        pages.append(
            ParsedPageV2(
                page_number=page_info.page,
                width_pt=page_info.width_pt,
                height_pt=page_info.height_pt,
                rotation=page_info.rotation,
                ordered_content=block_by_page.get(page_info.page, []),
                unplaced_content=list(unplaced.get(page_info.page, ())),
            )
        )

    rendered = render_canonical_markdown(
        pages,
        blocks,
        tables,
        page_count=inspected.inspection.page_count,
    )
    blocks, pages = apply_rendered_spans(rendered, blocks, pages)
    try:
        evidence = build_evidence_index(
            rendered,
            blocks,
            tables,
            content_sha256=content_sha256,
            preprocess_id=preprocess_id,
            text_producer_observations=text_observations,
            producer_observations=observations,
        )
        validate_publication(
            rendered,
            pages,
            blocks,
            tables,
            evidence,
            page_count=inspected.inspection.page_count,
        )
    except ValueError as exc:
        if V2_GEOMETRY_ERROR_CODE not in str(exc):
            raise
        raise CanonicalIngestionError(
            V2_GEOMETRY_ERROR_CODE,
            "Canonical Evidence could not be published with safe physical-page geometry.",
            parser_runs=list(parser_runs),
        ) from exc
    if artifact_root is not None:
        artifact_root.mkdir(parents=True, exist_ok=True)
        write_text_atomic(
            artifact_root / "document.llm.md",
            rendered.markdown,
        )
    arbitration = _arbitrate_parsers(inspected, parsing, tables_result)
    return ParsedDocument(
        document=_document_metadata(context, inspected.inspection),
        preprocessing=preprocess,
        page_count=inspected.inspection.page_count,
        page_mapping_verified=True,
        artifacts=ArtifactManifestV2(),
        parser_runs=parser_runs_public,
        arbitration=arbitration,
        content_stream=blocks,
        pages=pages,
        tables=tables,
        diagnostics=[ParserDiagnostic.model_validate(item) for item in diagnostics],
        evidence_index=evidence,
    )


def build_canonical_generation(
    task_id: str,
    *,
    source_path: Path | None = None,
    artifact_root: Path | None = None,
) -> BuiltGeneration:
    """Run the one canonical PDF pipeline and return its portable generation.

    Parser-owned paths, raw artifacts, and digests are kept in the internal
    generation manifest; only the v2 document and canonical Markdown bytes are
    eligible for route/package publication.
    """
    document = build_parsed_document_v2(
        task_id,
        source_path=source_path,
        artifact_root=artifact_root,
    )
    markdown_path = (artifact_root / "document.llm.md") if artifact_root else None
    markdown_bytes = markdown_path.read_bytes() if markdown_path and markdown_path.is_file() else b""
    return BuiltGeneration(
        document=document,
        markdown_bytes=markdown_bytes,
        generation_manifest={
            "schema_version": "generation-manifest.v1",
            "source_sha256": document.document.content_sha256,
            "preprocess_id": document.preprocessing.preprocess_id,
            "canonical_markdown_sha256": hashlib.sha256(markdown_bytes).hexdigest(),
            "parser_runs": [
                run.model_dump(mode="json")
                for run in document.parser_runs
            ],
            "raw_artifacts_root": str(artifact_root) if artifact_root else None,
        },
    )
