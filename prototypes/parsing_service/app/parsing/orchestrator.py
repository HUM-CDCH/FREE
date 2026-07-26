"""Build the canonical ParsedDocument from source and parser artifacts."""

from __future__ import annotations

import importlib
import math
import re
import unicodedata
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Literal, cast

from app.models.parsed_document import (
    ArbitrationResult,
    ArtifactManifest,
    CharSpan,
    DocumentMetadata,
    EvidenceIndex,
    InputProfile,
    PageDecision,
    PageQuality,
    ParsedDocument,
    ParsedPage,
    ParserRun,
    PreprocessingMetadata,
    SourceInfo,
    TextViews,
)
from app.models.parser import CANONICAL_OCR_DPI, MAX_INGESTION_PAGES
from app.parsing.adapters.pymupdf_inspect import PdfInspection, inspect_pdf
from app.parsing.normalize import read_text
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


def _compose_page_markdown(page_texts: list[str]) -> Any:
    module = importlib.import_module("app.parsing.doctags_to_markdown")
    return module.compose_page_markdown(page_texts)


def _run_ocr_fallback(
    source_path: Path,
    content_sha256: str,
    page_numbers: list[int],
    dpi: int,
    device: str,
    artifact_root: Path | None = None,
) -> Any:
    module = importlib.import_module("app.parsing.ocr_fallback")
    return module.run_paddleocr_fallback(
        source_pdf=source_path,
        content_sha256=content_sha256,
        page_numbers=page_numbers,
        dpi=dpi,
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


def _garbled_text_score(text: str) -> float:
    if not text:
        return 1.0
    suspicious = sum(
        1
        for character in text
        if character == "\ufffd"
        or (unicodedata.category(character) == "Cc" and character not in "\n\r\t")
    )
    non_space = [character for character in text if not character.isspace()]
    alphanumeric = sum(character.isalnum() for character in non_space)
    low_alphanumeric = (
        max(0.0, 0.35 - (alphanumeric / len(non_space))) if non_space else 0.35
    )
    repeated_runs = len(re.findall(r"(.)\1{7,}", text))
    return min(
        1.0,
        (suspicious / len(text)) * 4 + low_alphanumeric + min(0.5, repeated_runs * 0.1),
    )


def _quality_for_text(
    text: str, warnings: list[str], ocr_confidence: float | None = None
) -> PageQuality:
    return PageQuality(
        char_count=len(text),
        word_count=len(text.split()),
        ocr_confidence=ocr_confidence,
        garbled_text_score=_garbled_text_score(text),
        warnings=warnings,
    )


def _pages_and_views_from_llm_markdown(
    *,
    llm_markdown: str,
    llm_spans: list[Any] | tuple[Any, ...],
    selected_parser: str,
    inspection: PdfInspection,
    parser_by_page: dict[int, str],
    doc_tags_simplified: str | None = None,
    doc_tags_spans: list[Any] | tuple[Any, ...] = (),
    page_mapping_verified: bool = True,
    ocr_blocks_by_page: dict[int, list[dict[str, Any]]] | None = None,
) -> tuple[list[ParsedPage], TextViews]:
    ocr_blocks_by_page = ocr_blocks_by_page or {}
    if not page_mapping_verified:
        pages = [
            ParsedPage(
                page=page.page,
                width_pt=page.width_pt,
                height_pt=page.height_pt,
                rotation=page.rotation,
                selected_parser=None,
                text="",
                markdown=None,
                char_span=None,
                quality=_quality_for_text(
                    "",
                    [*page.warnings, "physical_page_mapping_unavailable"],
                ),
            )
            for page in inspection.pages
        ]
        return pages, TextViews(
            plain_text=llm_markdown,
            page_marked_text=(
                f"[DOCUMENT]\n{llm_markdown}" if llm_markdown else "[DOCUMENT]\n"
            ),
            markdown=llm_markdown,
            llm_markdown=llm_markdown,
            doc_tags_simplified=doc_tags_simplified,
        )

    spans = list(llm_spans)
    span_by_page = {span.page: span for span in spans}
    doctag_span_by_page = {span.page: span for span in doc_tags_spans}
    inspected_pages = list(inspection.pages)
    page_count = max(
        inspection.page_count,
        max((span.page for span in spans), default=0),
    )

    pages: list[ParsedPage] = []
    marked_chunks: list[str] = []
    marked_cursor = 0
    for page_number in range(1, page_count + 1):
        span = span_by_page.get(page_number)
        text = span.text if span is not None else ""
        inspected = (
            inspected_pages[page_number - 1]
            if page_number <= len(inspected_pages)
            else None
        )
        if marked_chunks:
            marked_chunks.append("\n\n")
            marked_cursor += 2
        marker = f"[PAGE {page_number}]\n"
        marked_chunks.append(marker)
        marked_cursor += len(marker)
        page_marked_start = marked_cursor
        marked_chunks.append(text)
        marked_cursor += len(text)
        page_marked_end = marked_cursor

        llm_start = span.llm_markdown_start if span is not None else len(llm_markdown)
        llm_end = span.llm_markdown_end if span is not None else len(llm_markdown)
        doctag_span = doctag_span_by_page.get(page_number)
        warnings = list(getattr(inspected, "warnings", []) if inspected else [])
        if span is None:
            warnings.append("Canonical parsing did not provide a physical page span.")
        blocks = ocr_blocks_by_page.get(page_number, [])
        ocr_confidence = (
            round(sum(block["confidence"] for block in blocks) / len(blocks), 4)
            if blocks
            else None
        )
        pages.append(
            ParsedPage(
                page=page_number,
                width_pt=getattr(inspected, "width_pt", None),
                height_pt=getattr(inspected, "height_pt", None),
                rotation=getattr(inspected, "rotation", None),
                selected_parser=parser_by_page.get(page_number, selected_parser),
                text=text,
                markdown=text,
                char_span=CharSpan(
                    plain_text_start=llm_start,
                    plain_text_end=llm_end,
                    page_marked_text_start=page_marked_start,
                    page_marked_text_end=page_marked_end,
                    llm_markdown_start=llm_start,
                    llm_markdown_end=llm_end,
                    doc_tags_simplified_start=(
                        doctag_span.llm_markdown_start if doctag_span else None
                    ),
                    doc_tags_simplified_end=(
                        doctag_span.llm_markdown_end if doctag_span else None
                    ),
                ),
                quality=_quality_for_text(
                    text, warnings, ocr_confidence=ocr_confidence
                ),
                blocks=blocks,
            )
        )

    return pages, TextViews(
        plain_text=llm_markdown,
        page_marked_text="".join(marked_chunks),
        markdown=llm_markdown,
        llm_markdown=llm_markdown,
        doc_tags_simplified=doc_tags_simplified,
    )


def _pages_requiring_fallback(
    docling_spans: list[Any] | tuple[Any, ...], inspection: PdfInspection
) -> list[int]:
    span_by_page = {span.page: span for span in docling_spans}
    fallback_pages: list[int] = []
    for page_number in range(1, inspection.page_count + 1):
        span = span_by_page.get(page_number)
        doctag_text = span.text.strip() if span is not None else ""
        inspected_page = inspection.pages[page_number - 1]
        native_text = inspected_page.native_text.strip()
        # Unknown visual inventories still require OCR; only a fully inspected
        # empty page is safe to preserve as an intentional blank.
        verified_blank = (
            span is not None
            and not doctag_text
            and not native_text
            and inspected_page.image_count == 0
            and inspected_page.drawing_count == 0
        )
        if verified_blank:
            continue
        garbled_score = _garbled_text_score(doctag_text)
        clearly_low_quality = (
            len(doctag_text) < 32 and len(native_text) >= 200
        ) or garbled_score >= 0.25
        if not doctag_text or clearly_low_quality:
            fallback_pages.append(page_number)
    return fallback_pages


def _merge_page_fallback_text(
    *,
    docling_spans: list[Any] | tuple[Any, ...],
    inspection: PdfInspection,
    fallback_pages: list[int],
    ocr_output: Any | None,
) -> tuple[
    str, tuple[Any, ...], dict[int, str], list[int], dict[int, list[dict[str, Any]]]
]:
    span_by_page = {span.page: span for span in docling_spans}
    parser_by_page: dict[int, str] = {}
    page_texts: list[str] = []
    unresolved_pages: list[int] = []
    ocr_blocks_by_page: dict[int, list[dict[str, Any]]] = {}
    fallback_set = set(fallback_pages)

    for page_number in range(1, inspection.page_count + 1):
        span = span_by_page.get(page_number)
        text = span.text.strip() if span is not None else ""
        parser = "docling_doctags"
        if page_number in fallback_set:
            ocr_completed_page = False
            ocr_text = ""
            if ocr_output is not None and ocr_output.status == "success":
                ocr_completed_page = page_number in ocr_output.pages
                if ocr_completed_page:
                    ocr_text = str(ocr_output.pages.get(page_number) or "").strip()
            if ocr_text:
                text = ocr_text
                parser = "paddleocr_fallback"
                lines = getattr(ocr_output, "page_lines", {}).get(page_number)
                if lines:
                    ocr_blocks_by_page[page_number] = lines
            elif ocr_completed_page and not text:
                # The OCR adapter processed the page and confirmed it is blank.
                parser = "paddleocr_fallback"
            elif not text:
                unresolved_pages.append(page_number)
        parser_by_page[page_number] = parser
        page_texts.append(text)

    composed = _compose_page_markdown(page_texts)
    return (
        composed.markdown,
        tuple(composed.page_spans),
        parser_by_page,
        unresolved_pages,
        ocr_blocks_by_page,
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


def _docling_arbitration(
    inspection: PdfInspection,
    docling_run: ParserRun,
    parser_by_page: dict[int, str],
    *,
    page_mapping_verified: bool = True,
    table_pages: frozenset[int] = frozenset(),
    table_parser_by_page: dict[int, str] | None = None,
) -> ArbitrationResult:
    page_decisions: list[PageDecision] = []
    for page in range(1, inspection.page_count + 1):
        selected_parser = parser_by_page.get(page, "docling_doctags")
        fallback_used = selected_parser != "docling_doctags"
        scores = {"docling_doctags": 1.0 if not fallback_used else 0.0}
        if fallback_used:
            scores[selected_parser] = 1.0
        page_decisions.append(
            PageDecision(
                page=page,
                selected_text_parser=selected_parser,
                selected_layout_parser=(
                    "docling_doctags" if docling_run.status == "success" else None
                ),
                selected_table_parser=(
                    (table_parser_by_page or {}).get(page)
                    or ("camelot_stream" if page in table_pages else None)
                    or ("docling_doctags" if docling_run.status == "success" else None)
                ),
                fallback_used=fallback_used,
                reason=(
                    "document_level_mapping_unavailable"
                    if not page_mapping_verified
                    else (
                        "docling_doctags_primary"
                        if not fallback_used
                        else f"{selected_parser}_page_fallback"
                    )
                ),
                scores=scores,
            )
        )

    selected = set(parser_by_page.values())
    primary_parser = (
        "docling_doctags" if "docling_doctags" in selected else "paddleocr_fallback"
    )
    return ArbitrationResult(
        primary_document_parser=primary_parser,
        strategy=(
            "docling_primary_ocr_page_fallback"
            if page_mapping_verified
            else "docling_document_level_mapping_unavailable"
        ),
        page_decisions=page_decisions,
    )


def build_parsed_document(
    task_id: str,
    *,
    source_path: Path | None = None,
    artifact_root: Path | None = None,
) -> ParsedDocument:
    task_dir = task_dir_for(task_id)
    metadata = load_task_metadata(task_dir)
    content_sha256 = metadata.get("content_sha256")
    if not isinstance(content_sha256, str) or not content_sha256:
        raise ValueError("Task metadata is missing required content_sha256.")
    params = dict(metadata.get("params", {}))
    source_name = params.get("source_name", SOURCE_FILENAME)
    source_path = source_path or task_dir / SOURCE_FILENAME

    started_at = metadata.get("created_at") or utc_now()
    inspection = inspect_pdf(
        source_path,
        max_pages=MAX_INGESTION_PAGES,
        render_dpi=CANONICAL_OCR_DPI,
        max_page_pixels=DEFAULT_MAX_RENDER_PAGE_PIXELS,
        max_total_pixels=DEFAULT_MAX_RENDER_TOTAL_PIXELS,
    )
    inspection_ref = write_inspection_artifact(
        content_sha256,
        inspection,
        artifact_root=artifact_root,
    )
    inspection_run = parser_run_from_inspection(
        inspection,
        content_sha256,
        inspection_ref,
    )
    try:
        validate_inspection_for_ingestion(inspection)
    except ValueError as exc:
        raise CanonicalIngestionError(
            "pdf_preflight_failed",
            str(exc),
            parser_runs=[inspection_run],
        ) from exc

    docling_output = _run_docling_ingestion(
        source_path,
        content_sha256,
        list(range(1, inspection.page_count + 1)),
        artifact_root,
    )
    parser_runs = [
        inspection_run,
        parser_run_from_docling_output(docling_output, content_sha256),
    ]
    docling_run = parser_runs[1]
    runner_markdown = getattr(docling_output, "llm_markdown", None)
    doc_tags_simplified = (
        runner_markdown
        if isinstance(runner_markdown, str)
        else _read_service_text(docling_output.llm_markdown_ref).removesuffix("\n")
    )
    docling_spans = list(getattr(docling_output, "page_spans", ()) or ())
    docling_tables = tuple(getattr(docling_output, "table_inventory", ()) or ())
    page_mapping_verified = bool(
        getattr(docling_output, "page_mapping_verified", False)
    )
    canonical_page_mapping_verified = page_mapping_verified

    ocr_output = None
    if doc_tags_simplified.strip() and not page_mapping_verified:
        # Keep document-level text, but never invent page provenance or mix it
        # with page OCR when the installed exporter cannot prove page identity.
        fallback_pages: list[int] = []
        llm_markdown = doc_tags_simplified
        llm_spans: tuple[Any, ...] = ()
        parser_by_page = dict.fromkeys(
            range(1, inspection.page_count + 1),
            "docling_doctags",
        )
        unresolved_pages: list[int] = []
        ocr_blocks_by_page: dict[int, list[dict[str, Any]]] = {}
    else:
        fallback_pages = _pages_requiring_fallback(docling_spans, inspection)
        if fallback_pages:
            ocr_output = _run_ocr_fallback(
                source_path,
                content_sha256,
                fallback_pages,
                CANONICAL_OCR_DPI,
                str(params.get("resolved_ocr_device") or "cpu"),
                artifact_root,
            )
            parser_runs.append(parser_run_from_ocr_output(ocr_output, content_sha256))

        (
            llm_markdown,
            llm_spans,
            parser_by_page,
            unresolved_pages,
            ocr_blocks_by_page,
        ) = _merge_page_fallback_text(
            docling_spans=docling_spans,
            inspection=inspection,
            fallback_pages=fallback_pages,
            ocr_output=ocr_output,
        )
        canonical_page_mapping_verified = len(llm_spans) == inspection.page_count and {
            span.page for span in llm_spans
        } == set(range(1, inspection.page_count + 1))

    if unresolved_pages:
        page_list = ", ".join(str(page) for page in unresolved_pages)
        error_code = (
            ocr_output.error
            if ocr_output is not None and ocr_output.error
            else "canonical_page_unresolved"
        )
        raise CanonicalIngestionError(
            error_code,
            f"Canonical parsing could not resolve page(s): {page_list}.",
            parser_runs=parser_runs,
        )
    has_usable_text = (
        any(span.text.strip() for span in llm_spans)
        if canonical_page_mapping_verified
        else bool(llm_markdown.strip())
    )
    if not has_usable_text:
        raise CanonicalIngestionError(
            "canonical_text_unavailable",
            "No parser produced usable canonical document text.",
            parser_runs=parser_runs,
        )

    table_output = _run_table_extraction(
        source_path,
        content_sha256,
        {page.page: page.height_pt for page in inspection.pages},
        {page.page: page.rotation for page in inspection.pages},
        docling_tables,
    )
    parser_runs.append(parser_run_from_table_output(table_output, content_sha256))
    tables = list(table_output.tables)
    table_parser_by_page: dict[int, str] = {}
    for table in tables:
        current = table_parser_by_page.get(table.page_number)
        if current is None:
            table_parser_by_page[table.page_number] = table.source_parser or "unknown"
        elif current != table.source_parser:
            table_parser_by_page[table.page_number] = "table_reconciled"

    final_llm_markdown_ref = docling_output.llm_markdown_ref
    if llm_markdown != doc_tags_simplified:
        final_llm_markdown_ref = _write_final_llm_markdown(
            content_sha256,
            llm_markdown,
            artifact_root=artifact_root,
        )

    arbitration = _docling_arbitration(
        inspection,
        docling_run,
        parser_by_page,
        page_mapping_verified=canonical_page_mapping_verified,
        table_pages=frozenset(table.page_number for table in tables),
        table_parser_by_page=table_parser_by_page,
    )
    pages, text_views = _pages_and_views_from_llm_markdown(
        llm_markdown=llm_markdown,
        llm_spans=llm_spans,
        selected_parser=arbitration.primary_document_parser,
        inspection=inspection,
        parser_by_page=parser_by_page,
        doc_tags_simplified=doc_tags_simplified or None,
        doc_tags_spans=docling_spans,
        page_mapping_verified=canonical_page_mapping_verified,
        ocr_blocks_by_page=ocr_blocks_by_page,
    )

    submitted_url = metadata.get("submitted_url")
    source_kind = metadata.get("source_kind") or ("url" if submitted_url else "upload")
    byte_size = source_path.stat().st_size if source_path.exists() else None
    document_metadata = DocumentMetadata(
        document_id=document_id_from_hash(content_sha256),
        content_sha256=content_sha256,
        source=SourceInfo(
            kind=source_kind,
            original_filename=source_name,
            submitted_url=submitted_url,
            byte_size=byte_size,
        ),
        created_at=started_at,
        page_count=inspection.page_count,
        is_encrypted=inspection.is_encrypted,
        input_profile=InputProfile(
            has_text_layer=any(page.char_count > 0 for page in inspection.pages)
        ),
    )

    config_hash = preprocessing_config_hash(metadata)
    warnings = [
        f"{run.parser}: {run.error}" for run in parser_runs if run.status == "failed"
    ]
    for run in parser_runs:
        warnings.extend(run.warnings)
    preprocessing = PreprocessingMetadata(
        preprocess_id=preprocess_id_from_hashes(content_sha256, config_hash),
        profile=PREPROCESS_PROFILE,
        config_hash=config_hash,
        service_version=package_version("parsing_service"),
        started_at=started_at,
        finished_at=utc_now(),
        status="completed_with_warnings" if warnings else "completed",
        warnings=warnings,
    )

    canonical_path = canonical_parsed_document_path(content_sha256)
    artifacts = ArtifactManifest(
        source_ref=metadata.get("source_store_path"),
        parsed_json_ref=f"data/tasks/{task_id}/parsed_document.json",
        canonical_parsed_json_ref=service_relative_ref(canonical_path),
        raw_docling_json_ref=docling_output.raw_docling_json_ref,
        raw_doctags_ref=docling_output.raw_doctags_ref,
        llm_markdown_ref=final_llm_markdown_ref,
        debug_refs=[
            ref
            for ref in (
                inspection_ref,
                docling_output.raw_docling_json_ref,
                docling_output.raw_doctags_ref,
                docling_output.aggregate_doctags_ref,
                docling_output.llm_markdown_ref,
                final_llm_markdown_ref,
                docling_output.markdown_ref,
                docling_run.output_ref,
                getattr(ocr_output, "output_ref", None),
            )
            if ref
        ],
    )

    return ParsedDocument(
        document=document_metadata,
        preprocessing=preprocessing,
        artifacts=artifacts,
        parser_runs=parser_runs,
        arbitration=arbitration,
        text_views=text_views,
        pages=pages,
        tables=tables,
        evidence_index=EvidenceIndex(),
    )
