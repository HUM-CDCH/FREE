"""Build the canonical ParsedDocument from source and parser artifacts."""

from __future__ import annotations

import importlib
import math
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Literal, cast

from app.models.parsed_document import (
    ArbitrationResult,
    ArtifactManifest,
    DocumentMetadata,
    EvidenceIndex,
    InputProfile,
    ParsedDocument,
    ParserRun,
    PreprocessingMetadata,
    SourceInfo,
)
from app.models.parser import CANONICAL_OCR_DPI, MAX_INGESTION_PAGES
from app.parsing.adapters.pymupdf_inspect import PdfInspection, inspect_pdf
from app.parsing.normalize import read_text
from app.parsing.page_resolution import (
    _PageViewResult,
    _docling_arbitration,
    _merge_page_fallback_text,
    _pages_and_views_from_llm_markdown,
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
    canonical_parsed_document_path,
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
        metrics={**output.metrics, "input_sha256": content_sha256},
        warnings=output.warnings,
        error=output.error,
    )


def _write_final_llm_markdown(
    content_sha256: str,
    llm_markdown: str,
    *,
    artifact_root: Path | None = None,
) -> str:
    final_path = (
        artifact_root or document_artifacts_dir(content_sha256)
    ) / "document.canonical.llm.md"
    write_text_atomic(final_path, llm_markdown + ("\n" if llm_markdown else ""))
    return service_relative_ref(final_path)


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
            {span.page for span in merged.llm_spans}
            == set(range(1, page_count + 1))
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
    docling_tables = tuple(
        getattr(parsing.docling_output, "table_inventory", ()) or ()
    )
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
    )


def _final_markdown_ref(
    context: _BuildContext,
    parsing: _ParsingResult,
) -> str | None:
    text = parsing.text
    if text.llm_markdown == text.doc_tags_simplified:
        return parsing.docling_output.llm_markdown_ref
    return _write_final_llm_markdown(
        context.content_sha256,
        text.llm_markdown,
        artifact_root=context.artifact_root,
    )


def _arbitrate_parsers(
    inspected: _InspectionResult,
    parsing: _ParsingResult,
    tables: _TableResolution,
) -> ArbitrationResult:
    return _docling_arbitration(
        inspection=inspected.inspection,
        docling_run=parsing.docling_run,
        parser_by_page=parsing.text.parser_by_page,
        page_mapping_verified=parsing.text.page_mapping_verified,
        table_pages=frozenset(table.page_number for table in tables.tables),
        table_parser_by_page=tables.parser_by_page,
    )


def _assemble_pages(
    inspected: _InspectionResult,
    parsing: _ParsingResult,
    arbitration: ArbitrationResult,
) -> _PageViewResult:
    text = parsing.text
    return _pages_and_views_from_llm_markdown(
        llm_markdown=text.llm_markdown,
        llm_spans=text.llm_spans,
        selected_parser=arbitration.primary_document_parser,
        inspection=inspected.inspection,
        parser_by_page=text.parser_by_page,
        doc_tags_simplified=text.doc_tags_simplified or None,
        doc_tags_spans=text.docling_spans,
        page_mapping_verified=text.page_mapping_verified,
        ocr_blocks_by_page=text.ocr_blocks_by_page,
    )


def _source_kind(metadata: dict[str, Any]) -> str:
    source_kind = metadata.get("source_kind")
    if source_kind:
        return cast(str, source_kind)
    if metadata.get("submitted_url"):
        return "url"
    return "upload"


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
            kind=_source_kind(context.metadata),
            original_filename=context.source_name,
            submitted_url=context.metadata.get("submitted_url"),
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
        f"{run.parser}: {run.error}"
        for run in parser_runs
        if run.status == "failed"
    ]
    for run in parser_runs:
        warnings.extend(run.warnings)
    return warnings


def _preprocessing_metadata(
    context: _BuildContext,
    parser_runs: list[ParserRun],
) -> PreprocessingMetadata:
    config_hash = preprocessing_config_hash(context.metadata)
    warnings = _parser_warnings(parser_runs)
    return PreprocessingMetadata(
        preprocess_id=preprocess_id_from_hashes(
            context.content_sha256,
            config_hash,
        ),
        profile=PREPROCESS_PROFILE,
        config_hash=config_hash,
        service_version=package_version("parsing_service"),
        started_at=context.started_at,
        finished_at=utc_now(),
        status="completed_with_warnings" if warnings else "completed",
        warnings=warnings,
    )


def _debug_artifact_refs(
    inspected: _InspectionResult,
    parsing: _ParsingResult,
    final_llm_markdown_ref: str | None,
) -> list[str]:
    output = parsing.docling_output
    return [
        ref
        for ref in (
            inspected.artifact_ref,
            output.raw_docling_json_ref,
            output.raw_doctags_ref,
            output.aggregate_doctags_ref,
            output.llm_markdown_ref,
            final_llm_markdown_ref,
            output.markdown_ref,
            parsing.docling_run.output_ref,
            getattr(parsing.text.ocr_output, "output_ref", None),
        )
        if ref
    ]


def _artifact_manifest(
    context: _BuildContext,
    inspected: _InspectionResult,
    parsing: _ParsingResult,
    final_llm_markdown_ref: str | None,
) -> ArtifactManifest:
    canonical_path = canonical_parsed_document_path(context.content_sha256)
    return ArtifactManifest(
        source_ref=context.metadata.get("source_store_path"),
        parsed_json_ref=f"data/tasks/{context.task_id}/parsed_document.json",
        canonical_parsed_json_ref=service_relative_ref(canonical_path),
        raw_docling_json_ref=parsing.docling_output.raw_docling_json_ref,
        raw_doctags_ref=parsing.docling_output.raw_doctags_ref,
        llm_markdown_ref=final_llm_markdown_ref,
        debug_refs=_debug_artifact_refs(
            inspected,
            parsing,
            final_llm_markdown_ref,
        ),
    )


def build_parsed_document(
    task_id: str,
    *,
    source_path: Path | None = None,
    artifact_root: Path | None = None,
) -> ParsedDocument:
    context = _build_context(task_id, source_path, artifact_root)
    inspected = _inspect_source(context)
    parsing = _run_canonical_parsers(context, inspected)
    tables = _extract_document_tables(context, inspected, parsing)
    parser_runs = [*parsing.parser_runs, tables.parser_run]
    final_llm_markdown_ref = _final_markdown_ref(context, parsing)
    arbitration = _arbitrate_parsers(inspected, parsing, tables)
    pages = _assemble_pages(inspected, parsing, arbitration)
    return ParsedDocument(
        document=_document_metadata(context, inspected.inspection),
        preprocessing=_preprocessing_metadata(context, parser_runs),
        artifacts=_artifact_manifest(
            context,
            inspected,
            parsing,
            final_llm_markdown_ref,
        ),
        parser_runs=parser_runs,
        arbitration=arbitration,
        text_views=pages.text_views,
        pages=pages.pages,
        tables=tables.tables,
        evidence_index=EvidenceIndex(),
    )
