"""One Docling conversion boundary and the ``parsed_document.v2`` publisher.

The rest of the service only sees :class:`ParseResult`.  Docling objects stay in
this module, which deliberately uses the public ``DoclingDocument`` model and
Markdown serializer instead of an intermediate parser model.
"""

from __future__ import annotations

import hashlib
import math
import re
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .contracts import ParseResult


PARSER_NAME = "docling"
SCHEMA_VERSION = "parsed_document.v2"
PAGE_MARKER = "<!-- FREE:PAGE {page} -->"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MISSING = object()


class DoclingParseError(RuntimeError):
    """A bounded parser/publication failure suitable for task error reporting."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class _Context:
    document_id: str
    content_sha256: str
    preprocess_id: str
    source_name: str
    created_at: str
    service_version: str | None
    started_at: str
    max_num_pages: int | None
    max_file_size: int | None

    @classmethod
    def from_value(cls, value: Mapping[str, Any] | object) -> _Context:
        document_id = _required_text(value, "document_id")
        content_sha256 = _required_text(value, "content_sha256")
        if not _SHA256_RE.fullmatch(content_sha256):
            raise DoclingParseError(
                "invalid_task_context",
                "content_sha256 must be a lowercase SHA-256 digest",
            )
        if document_id != f"sha256:{content_sha256}":
            raise DoclingParseError(
                "invalid_task_context",
                "document_id must identify content_sha256",
            )
        return cls(
            document_id=document_id,
            content_sha256=content_sha256,
            preprocess_id=_required_text(value, "preprocess_id"),
            source_name=_required_text(value, "source_name"),
            created_at=_timestamp(_context_value(value, "created_at")),
            service_version=_optional_text(
                _context_value(value, "service_version", None)
            ),
            started_at=_timestamp(
                _context_value(value, "started_at", _utc_now())
            ),
            max_num_pages=_optional_positive_int(
                value, "max_num_pages"
            ),
            max_file_size=_optional_positive_int(
                value, "max_file_size"
            ),
        )


@dataclass(frozen=True, slots=True)
class _PageGeometry:
    page_number: int
    width: float
    height: float


@dataclass(frozen=True, slots=True)
class _Provenance:
    index: int
    page_number: int
    bbox: dict[str, float]


@dataclass(frozen=True, slots=True)
class _Markdown:
    text: str
    page_spans: dict[int, dict[str, int]]
    ref_spans: dict[str, dict[str, int]]


class DoclingParser:
    """Reusable, PDF-only Docling converter.

    Construct one instance during FastAPI lifespan and call :meth:`initialize`
    there.  ``parse`` also initializes lazily so the class remains convenient in
    focused tests.  An injected converter and serializer factory keep publication
    tests independent of model downloads.
    """

    def __init__(
        self,
        converter: Any | None = None,
        serializer_factory: Callable[[Any], Any] | None = None,
    ) -> None:
        self._converter = converter
        self._serializer_factory = serializer_factory or _new_markdown_serializer
        if converter is None:
            self.initialize()

    def initialize(self) -> DoclingParser:
        """Initialize the standard PDF pipeline once and retain its model cache."""

        if self._converter is None:
            from docling.datamodel.base_models import InputFormat
            from docling.document_converter import DocumentConverter

            converter = DocumentConverter(allowed_formats=[InputFormat.PDF])
            converter.initialize_pipeline(InputFormat.PDF)
            self._converter = converter
        return self

    def parse(
        self,
        source_path: Path,
        context: Mapping[str, Any] | object,
    ) -> ParseResult:
        """Convert one PDF and publish its canonical package payloads."""

        task = _Context.from_value(context)
        source = Path(source_path)
        if not source.is_file():
            raise DoclingParseError("source_not_found", "Source PDF was not found")

        self.initialize()
        assert self._converter is not None
        convert_options: dict[str, Any] = {"raises_on_error": False}
        if task.max_num_pages is not None:
            convert_options["max_num_pages"] = task.max_num_pages
        if task.max_file_size is not None:
            convert_options["max_file_size"] = task.max_file_size

        started = time.perf_counter()
        with TemporaryDirectory(prefix="free-docling-") as temporary:
            prepared, slices = _prepare_scanned_columns(source, Path(temporary), task)
            if slices:
                # Admission limits apply to physical pages and original bytes.
                convert_options["max_num_pages"] = len(slices)
                convert_options["max_file_size"] = prepared.stat().st_size
            result = self._converter.convert(prepared, **convert_options)
        duration_ms = max(0, round((time.perf_counter() - started) * 1000))
        status = _conversion_status(result)
        error_messages = _conversion_errors(result)
        if status not in {"success", "partial_success"}:
            detail = "; ".join(error_messages) or f"Docling returned {status}"
            raise DoclingParseError("docling_conversion_failed", detail)

        document = getattr(result, "document", None)
        if document is None:
            raise DoclingParseError(
                "docling_conversion_failed", "Docling returned no document"
            )

        if slices:
            _restore_physical_pages(document, slices)
        parser_version = _docling_version(result)
        conversion_warnings = (
            [f"Docling partial conversion: {message}" for message in error_messages]
            if status == "partial_success"
            else []
        )
        conversion_diagnostics = [
            _diagnostic(
                "docling_partial_success",
                reason="conversion_error",
                detail=message,
            )
            for message in error_messages
        ]
        if slices:
            split_pages = [number for number in document.pages
                           if sum(page.page_number == number for page, _ in slices) > 1]
            conversion_diagnostics.extend(_diagnostic(
                "scanned_columns_separated", page_number=number,
                reason="clear_vertical_gutters",
                detail="Parsed four columns separately and restored original PDF coordinates.",
            ) for number in split_pages)
        publisher = _Publisher(
            document=document,
            context=task,
            source_path=source,
            parser_version=parser_version,
            serializer_factory=self._serializer_factory,
            initial_diagnostics=conversion_diagnostics,
        )
        parsed_document, markdown, warnings = publisher.publish(
            conversion_warnings,
            finished_at=_utc_now(),
        )
        parser_runs = tuple(parsed_document["parser_runs"])
        stats = {
            PARSER_NAME: {
                "status": status,
                "duration_ms": duration_ms,
                "page_count": parsed_document["page_count"],
                "content_block_count": len(parsed_document["content_stream"]),
                "table_count": len(parsed_document["tables"]),
                "table_cell_count": sum(
                    len(table["cells"]) for table in parsed_document["tables"]
                ),
                "evidence_anchor_count": len(
                    parsed_document["evidence_index"]["anchors"]
                ),
                "diagnostic_count": len(parsed_document["diagnostics"]),
                "markdown_bytes": len(markdown.encode("utf-8")),
            }
        }
        return ParseResult(
            parsed_document=parsed_document,
            markdown=markdown,
            stats=stats,
            parser_runs=parser_runs,
            selected_parser=PARSER_NAME,
            warnings=tuple(warnings),
            docling_version=parser_version,
        )


class _Publisher:
    def __init__(
        self,
        *,
        document: Any,
        context: _Context,
        source_path: Path,
        parser_version: str | None,
        serializer_factory: Callable[[Any], Any],
        initial_diagnostics: Sequence[dict[str, Any]],
    ) -> None:
        self.document = document
        self.context = context
        self.source_path = source_path
        self.parser_version = parser_version
        self.serializer_factory = serializer_factory
        self.diagnostics = list(initial_diagnostics)

    def publish(
        self,
        conversion_warnings: Sequence[str],
        *,
        finished_at: str,
    ) -> tuple[dict[str, Any], str, list[str]]:
        pages = self._physical_pages()
        items = self._ordered_items(pages)
        serializer = self.serializer_factory(self.document)
        markdown = self._render_markdown(serializer, pages, items)
        blocks, tables, anchors, ordered = self._content(pages, markdown, items)

        warnings = list(conversion_warnings)
        if self.diagnostics:
            warnings.append(
                f"Publication recorded {len(self.diagnostics)} diagnostic(s); "
                "see parsed_document diagnostics."
            )
        warnings = _unique_strings(warnings)
        parser_run = {
            "parser": PARSER_NAME,
            "version": self.parser_version,
            "status": "success",
            "warnings": warnings,
            "error": None,
        }
        public_pages = [
            {
                "page_number": page.page_number,
                "width_pt": page.width,
                "height_pt": page.height,
                "rotation": 0,
                "ordered_content": ordered[page.page_number],
                "unplaced_content": [],
                "markdown_span": markdown.page_spans[page.page_number],
            }
            for page in pages.values()
        ]
        parsed: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "document": {
                "document_id": self.context.document_id,
                "content_sha256": self.context.content_sha256,
                "source": {
                    "kind": "upload",
                    "original_filename": self.context.source_name,
                    "media_type": "application/pdf",
                    "byte_size": _file_size(self.source_path),
                },
                "created_at": self.context.created_at,
                "page_count": len(pages),
                "language_hints": [],
                "is_encrypted": None,
                "input_profile": {
                    "file_kind": "pdf",
                    "detected_mime": "application/pdf",
                    "pdf_version": None,
                    "has_text_layer": None,
                    "has_images": None,
                },
            },
            "preprocessing": {
                "preprocess_id": self.context.preprocess_id,
                "profile": "production_default",
                "service_version": self.context.service_version,
                "started_at": self.context.started_at,
                "finished_at": finished_at,
                "status": "completed_with_warnings" if warnings else "completed",
                "warnings": warnings,
            },
            "page_count": len(pages),
            "page_mapping_verified": True,
            "artifacts": {
                "source_ref": "source.pdf",
                "parsed_json_ref": "parsed_document.json",
                "markdown_ref": "artifacts/document.llm.md",
            },
            "parser_runs": [parser_run],
            "arbitration": {
                "primary_document_parser": PARSER_NAME,
                "strategy": "docling_default",
                "page_decisions": [
                    {
                        "page_number": page_number,
                        "selected_text_parser": PARSER_NAME,
                        "selected_layout_parser": PARSER_NAME,
                        "selected_table_parser": PARSER_NAME,
                        "fallback_used": False,
                        "reason": "docling_default",
                        "scores": {PARSER_NAME: 1.0},
                    }
                    for page_number in pages
                ],
            },
            "diagnostics": self.diagnostics,
            "content_stream": blocks,
            "pages": public_pages,
            "tables": tables,
            "evidence_index": {"anchors": anchors},
        }
        _validate_publication(parsed, markdown.text)
        return parsed, markdown.text, warnings

    def _physical_pages(self) -> dict[int, _PageGeometry]:
        source_pages = getattr(self.document, "pages", None)
        if not isinstance(source_pages, Mapping) or not source_pages:
            raise DoclingParseError(
                "v2_physical_page_mapping_unavailable",
                "Docling did not provide physical pages",
            )
        pages: dict[int, _PageGeometry] = {}
        for key, item in source_pages.items():
            page_number = _int_value(getattr(item, "page_no", key))
            size = getattr(item, "size", None)
            width = _finite_positive(getattr(size, "width", None))
            height = _finite_positive(getattr(size, "height", None))
            if page_number is None or width is None or height is None:
                raise DoclingParseError(
                    "v2_evidence_geometry_unavailable",
                    "Docling page geometry is missing or invalid",
                )
            if page_number in pages:
                raise DoclingParseError(
                    "v2_physical_page_mapping_unavailable",
                    f"Docling returned duplicate page {page_number}",
                )
            pages[page_number] = _PageGeometry(page_number, width, height)
        expected = list(range(1, max(pages) + 1))
        if sorted(pages) != expected:
            raise DoclingParseError(
                "v2_physical_page_mapping_unavailable",
                "Docling pages do not cover the physical PDF contiguously",
            )
        return dict(sorted(pages.items()))

    def _ordered_items(self, pages: Mapping[int, _PageGeometry]) -> list[Any]:
        iterator = getattr(self.document, "iterate_items", None)
        if not callable(iterator):
            raise DoclingParseError(
                "docling_document_invalid",
                "DoclingDocument does not expose reading-order iteration",
            )
        by_page: dict[int, list[tuple[Any, dict[str, float]]]] = {n: [] for n in pages}
        unplaced: list[Any] = []
        for pair in iterator(with_groups=False):
            item = pair[0] if isinstance(pair, tuple) else pair
            if not self._is_body_item(item):
                continue
            prov = next(iter(getattr(item, "prov", ()) or ()), None)
            page = pages.get(getattr(prov, "page_no", None))
            bbox = _top_left_bbox(getattr(prov, "bbox", None), page) if page else None
            if page and bbox:
                by_page[page.page_number].append((item, bbox))
            else:
                unplaced.append(item)
        ordered: list[Any] = []
        for number, entries in by_page.items():
            corrected, has_columns = _column_order(entries, pages[number].width)
            if has_columns and [id(item) for item, _ in corrected] != [id(item) for item, _ in entries]:
                self.diagnostics.append(_diagnostic(
                    "column_reading_order_corrected", page_number=number,
                    reason="separated_columns", detail="Read each column from top to bottom, left to right.",
                ))
                entries = corrected
            ordered.extend(item for item, _ in entries)
        return ordered + unplaced

    def _render_markdown(
        self,
        serializer: Any,
        pages: Mapping[int, _PageGeometry],
        items: Sequence[Any],
    ) -> _Markdown:
        chunks: list[bytes] = []
        page_spans: dict[int, dict[str, int]] = {}
        ref_spans: dict[str, dict[str, int]] = {}
        cursor = 0

        def append(text: str) -> tuple[int, int]:
            nonlocal cursor
            encoded = _normalise_lf(text).encode("utf-8")
            start = cursor
            chunks.append(encoded)
            cursor += len(encoded)
            return start, cursor

        for page_number in pages:
            if chunks:
                append("\n\n")
            append(PAGE_MARKER.format(page=page_number) + "\n")
            page_start = cursor
            parts = self._serializer_parts(serializer, page_number, items)
            rendered_count = 0
            for part in parts:
                text = _normalise_lf(str(getattr(part, "text", "")))
                if not text:
                    continue
                if "<!-- FREE:PAGE " in text:
                    raise DoclingParseError(
                        "reserved_page_marker_collision",
                        "Docling output contains the reserved FREE page marker",
                    )
                if rendered_count:
                    append("\n\n")
                start, end = append(text)
                rendered_count += 1
                for span in getattr(part, "spans", ()) or ():
                    ref = _self_ref(getattr(span, "item", None))
                    if ref:
                        ref_spans.setdefault(ref, {"start": start, "end": end})
            page_spans[page_number] = {"start": page_start, "end": cursor}
        return _Markdown(b"".join(chunks).decode("utf-8"), page_spans, ref_spans)

    @staticmethod
    def _serializer_parts(serializer: Any, page_number: int, items: Sequence[Any]) -> Sequence[Any]:
        # Serialize each ordered item separately: a list group may span columns,
        # and its combined span cannot serve as exact evidence for each entry.
        serialize = getattr(serializer, "serialize", None)
        if callable(serialize):
            visited: set[str] = set()
            parts = []
            for item in items:
                prov = next(iter(getattr(item, "prov", ()) or ()), None)
                if getattr(prov, "page_no", None) != page_number or _self_ref(item) in visited:
                    continue
                parts.append(serialize(item=item, pages={page_number}, visited=visited))
            return parts
        raise DoclingParseError(
            "markdown_serialization_failed",
            "Markdown serializer does not expose serialize",
        )

    def _content(
        self,
        pages: Mapping[int, _PageGeometry],
        markdown: _Markdown,
        items: Sequence[Any],
    ) -> tuple[
        list[dict[str, Any]],
        list[dict[str, Any]],
        list[dict[str, Any]],
        dict[int, list[str]],
    ]:
        blocks: list[dict[str, Any]] = []
        tables: list[dict[str, Any]] = []
        anchors: list[dict[str, Any]] = []
        ordered = {page_number: [] for page_number in pages}
        for ordinal, item in enumerate(items):
            ref = _self_ref(item) or f"reading-order:{ordinal}"
            provenance = self._item_provenance(item, ref, pages)
            if not provenance:
                self.diagnostics.append(
                    _diagnostic(
                        "ungrounded_item_omitted",
                        reason="missing_valid_provenance",
                        detail=ref,
                    )
                )
                continue
            page_number = provenance[0].page_number
            label = _label(item)
            if self._is_table(item, label):
                table, table_anchors = self._table(item, ref, provenance, pages)
                table_id = table["table_id"]
                tables.append(table)
                anchors.extend(table_anchors)
                block_id = _deterministic_id(
                    "block", self.context, f"{ref}:table-block"
                )
                block = {
                    "block_id": block_id,
                    "page_number": page_number,
                    "parser": PARSER_NAME,
                    "bbox": provenance[0].bbox,
                    "markdown_span": markdown.ref_spans.get(ref),
                    "kind": "table",
                    "table_id": table_id,
                }
                blocks.append(block)
                ordered[page_number].append(block_id)
                continue

            text = str(getattr(item, "text", ""))
            marker = str(getattr(item, "marker", "") or "").strip()
            if marker and not text.startswith(marker + " "):
                text = f"{marker} {text}"
            if not text.strip():
                if label not in {"picture", "form", "key_value_region"}:
                    self.diagnostics.append(
                        _diagnostic(
                            "empty_item_omitted",
                            reason=label or "unknown_label",
                            detail=ref,
                            page_number=page_number,
                        )
                    )
                continue
            span = markdown.ref_spans.get(ref)
            if span is None:
                self.diagnostics.append(
                    _diagnostic(
                        "unserialized_item_omitted",
                        reason=label or "unknown_label",
                        detail=ref,
                        page_number=page_number,
                    )
                )
                continue
            block_id = _deterministic_id("block", self.context, f"{ref}:block")
            block = self._text_block(
                item=item,
                label=label,
                block_id=block_id,
                page_number=page_number,
                bbox=provenance[0].bbox,
                markdown_span=span,
                text=text,
            )
            blocks.append(block)
            ordered[page_number].append(block_id)
            anchors.append(self._text_anchor(block_id, span, provenance, ref))
        return blocks, tables, anchors, ordered

    @staticmethod
    def _is_body_item(item: Any) -> bool:
        layer = _enum_text(getattr(item, "content_layer", None))
        return not layer or layer == "body"

    @staticmethod
    def _is_table(item: Any, label: str) -> bool:
        data = getattr(item, "data", None)
        return label in {"table", "document_index"} or hasattr(
            data, "table_cells"
        )

    def _item_provenance(
        self,
        item: Any,
        ref: str,
        pages: Mapping[int, _PageGeometry],
    ) -> list[_Provenance]:
        records: list[_Provenance] = []
        for index, source in enumerate(getattr(item, "prov", ()) or ()):
            page_number = _int_value(getattr(source, "page_no", None))
            page = pages.get(page_number or 0)
            bbox = _top_left_bbox(
                getattr(source, "bbox", None), page
            ) if page else None
            if page is None or bbox is None:
                self.diagnostics.append(
                    _diagnostic(
                        "invalid_provenance_omitted",
                        reason="missing_page_or_bbox",
                        detail=ref,
                        page_number=page_number,
                    )
                )
                continue
            records.append(_Provenance(index, page.page_number, bbox))
        return records

    def _text_block(
        self,
        *,
        item: Any,
        label: str,
        block_id: str,
        page_number: int,
        bbox: dict[str, float],
        markdown_span: dict[str, int],
        text: str,
    ) -> dict[str, Any]:
        common: dict[str, Any] = {
            "block_id": block_id,
            "page_number": page_number,
            "parser": PARSER_NAME,
            "bbox": bbox,
            "markdown_span": markdown_span,
        }
        if label in {"title", "section_header"}:
            source_level = _int_value(getattr(item, "level", None)) or 0
            level = 1 if label == "title" else min(6, max(1, source_level + 1))
            return {**common, "kind": "heading", "text": text, "level": level}
        if label == "list_item":
            return {
                **common,
                "kind": "list",
                "ordered": bool(getattr(item, "enumerated", False)),
                "items": [text],
            }
        if label == "code":
            language = _optional_text(getattr(item, "code_language", None))
            return {
                **common,
                "kind": "code",
                "text": text,
                "language": language,
            }
        if label == "formula":
            return {**common, "kind": "formula", "text": text}
        if label in {"caption", "footnote"}:
            return {**common, "kind": "caption", "text": text}
        if label in {"text", "paragraph"}:
            return {**common, "kind": "paragraph", "text": text}
        return {**common, "kind": "text", "text": text}

    def _text_anchor(
        self,
        block_id: str,
        markdown_span: dict[str, int],
        provenance: Sequence[_Provenance],
        producer_ref: str,
    ) -> dict[str, Any]:
        anchor_id = _deterministic_id(
            "anchor", self.context, f"{block_id}:text"
        )
        return {
            "kind": "text",
            "anchor_id": anchor_id,
            "content_sha256": self.context.content_sha256,
            "preprocess_id": self.context.preprocess_id,
            "block_id": block_id,
            "markdown_span": markdown_span,
            "producer_observations": [
                {
                    "occurrence_id": _deterministic_id(
                        "occurrence",
                        self.context,
                        f"{anchor_id}:{record.index}:{record.page_number}",
                    ),
                    "page_number": record.page_number,
                    "producer_ref": producer_ref,
                    "bbox": record.bbox,
                }
                for record in provenance
            ],
        }

    def _table(
        self,
        item: Any,
        producer_ref: str,
        provenance: Sequence[_Provenance],
        pages: Mapping[int, _PageGeometry],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        table_id = _deterministic_id("table", self.context, producer_ref)
        data = getattr(item, "data", None)
        source_cells = list(getattr(data, "table_cells", ()) or ())
        raw_rows = _nonnegative_int(getattr(data, "num_rows", None)) or 0
        raw_cols = _nonnegative_int(getattr(data, "num_cols", None)) or 0
        page_spans = []
        seen_pages: set[int] = set()
        for record in provenance:
            if record.page_number in seen_pages:
                continue
            seen_pages.add(record.page_number)
            page_spans.append(record.page_number)

        candidates: list[tuple[int, int, int, int, int, Any]] = []
        for ordinal, cell in enumerate(source_cells):
            row = _nonnegative_int(getattr(cell, "start_row_offset_idx", None))
            column = _nonnegative_int(
                getattr(cell, "start_col_offset_idx", None)
            )
            if row is None or column is None:
                self.diagnostics.append(
                    _diagnostic(
                        "table_cell_omitted",
                        reason="invalid_cell_offsets",
                        detail=f"{producer_ref}:cell:{ordinal}",
                        page_number=provenance[0].page_number,
                    )
                )
                continue
            rowspan = _cell_span(cell, "row", row)
            colspan = _cell_span(cell, "col", column)
            candidates.append((row, column, rowspan, colspan, ordinal, cell))
        candidates.sort(key=lambda value: value[:5])

        rows = max(
            [raw_rows, *(row + rowspan for row, _, rowspan, _, _, _ in candidates)]
        )
        cols = max(
            [raw_cols, *(column + colspan for _, column, _, colspan, _, _ in candidates)]
        )
        cells: list[dict[str, Any]] = []
        anchors: list[dict[str, Any]] = []
        occupied_origins: set[tuple[int, int]] = set()
        for row, column, rowspan, colspan, ordinal, cell in candidates:
            if (row, column) in occupied_origins:
                self.diagnostics.append(
                    _diagnostic(
                        "table_cell_omitted",
                        reason="duplicate_cell_origin",
                        detail=f"{producer_ref}:r{row}:c{column}",
                        page_number=provenance[0].page_number,
                    )
                )
                continue
            occupied_origins.add((row, column))
            cell_page, bbox = self._cell_geometry(
                cell, provenance[0].page_number, pages
            )
            if bbox is None or cell_page not in seen_pages:
                self.diagnostics.append(
                    _diagnostic(
                        "table_cell_omitted",
                        reason="missing_valid_geometry",
                        detail=f"{producer_ref}:r{row}:c{column}",
                        page_number=cell_page,
                    )
                )
                continue
            cell_id = _deterministic_id(
                "cell",
                self.context,
                f"{table_id}:r{row}:c{column}:rs{rowspan}:cs{colspan}:n{ordinal}",
            )
            anchor_id = _deterministic_id(
                "anchor", self.context, f"{cell_id}:table-cell"
            )
            role = _cell_role(cell)
            cells.append(
                {
                    "cell_id": cell_id,
                    "row": row,
                    "column": column,
                    "text": str(getattr(cell, "text", "")),
                    "role": role,
                    "rowspan": rowspan,
                    "colspan": colspan,
                    "bbox": bbox,
                    "evidence_anchor_id": anchor_id,
                }
            )
            anchors.append(
                {
                    "kind": "table_cell",
                    "anchor_id": anchor_id,
                    "content_sha256": self.context.content_sha256,
                    "preprocess_id": self.context.preprocess_id,
                    "logical_table_id": table_id,
                    "cell_id": cell_id,
                    "canonical_row": row,
                    "canonical_column": column,
                    "producer_observations": [
                        {
                            "occurrence_id": _deterministic_id(
                                "occurrence",
                                self.context,
                                f"{anchor_id}:{cell_page}:{row}:{column}",
                            ),
                            "page_number": cell_page,
                            "producer_ref": producer_ref,
                            "row_offset": row,
                            "column_offset": column,
                            "row_span": rowspan,
                            "column_span": colspan,
                            "bbox": bbox,
                        }
                    ],
                }
            )
        attribution = {"parser": PARSER_NAME, "version": self.parser_version}
        table = {
            "table_id": table_id,
            "rows": rows,
            "cols": cols,
            "cells": cells,
            "spans": [
                {
                    "page_number": page_number,
                    "producer_table_ref": producer_ref,
                    "page_local_row_start": 0,
                    "page_local_row_end": rows - 1 if rows else None,
                    "page_local_col_count": cols,
                }
                for page_number in page_spans
            ],
            "parser_attribution": {
                "content_parser": attribution,
                "structure_parser": attribution,
                "geometry_parser": attribution,
            },
            "continuation": (
                "derived_continuation" if len(page_spans) > 1 else "page_local"
            ),
        }
        return table, anchors

    def _cell_geometry(
        self,
        cell: Any,
        default_page: int,
        pages: Mapping[int, _PageGeometry],
    ) -> tuple[int, dict[str, float] | None]:
        reference = getattr(cell, "ref", None)
        resolve = getattr(reference, "resolve", None)
        if callable(resolve):
            try:
                resolved = resolve(self.document)
            except (LookupError, TypeError, ValueError):
                resolved = None
            if resolved is not None:
                records = self._item_provenance(
                    resolved, _self_ref(resolved) or "table-cell-ref", pages
                )
                if records:
                    return records[0].page_number, records[0].bbox
        page = pages[default_page]
        return default_page, _top_left_bbox(getattr(cell, "bbox", None), page)


def _prepare_scanned_columns(
    source: Path, directory: Path, task: _Context,
) -> tuple[Path, list[tuple[_PageGeometry, float]]]:
    import pypdfium2 as pdfium

    if task.max_file_size is not None and source.stat().st_size > task.max_file_size:
        raise DoclingParseError("docling_conversion_failed", "PDF exceeds the file size limit")
    with pdfium.PdfDocument(source) as pdf:
        if task.max_num_pages is not None and len(pdf) > task.max_num_pages:
            raise DoclingParseError("docling_conversion_failed", "PDF exceeds the physical page limit")
        page_cuts = []
        for index in range(len(pdf)):
            with closing(pdf[index]) as page:
                width, height = page.get_size()
                cuts = []
                if width >= height * 1.25 and page.get_rotation() == 0:
                    with closing(page.get_textpage()) as text:
                        scanned = text.count_chars() == 0
                    if scanned:
                        with closing(page.render(scale=min(1, 1600 / width))) as bitmap:
                            cuts = _scanned_column_cuts(bitmap.to_pil(), width)
                page_cuts.append((_PageGeometry(index + 1, width, height), cuts))
        if not any(cuts for _, cuts in page_cuts):
            return source, []
        slices = []
        prepared = directory / "columns.pdf"
        with pdfium.PdfDocument.new() as output:
            for geometry, cuts in page_cuts:
                bounds = [0, *cuts, geometry.width]
                for left, right in zip(bounds, bounds[1:]):
                    output.import_pages(pdf, [geometry.page_number - 1])
                    if cuts:
                        with closing(output[len(output) - 1]) as page:
                            page.set_mediabox(left, 0, right, geometry.height)
                            page.set_cropbox(left, 0, right, geometry.height)
                    slices.append((geometry, left))
            output.save(prepared)
    return prepared, slices


def _scanned_column_cuts(image: Any, page_width: float) -> list[float]:
    import numpy as np

    # ponytail: only four-column scanned spreads with clear gutters; mixed layouts
    # stay with Docling. Use region segmentation if that wider need is demonstrated.
    pixels = np.asarray(image.convert("L"))
    height, width = pixels.shape
    ink = (pixels[round(height * .1):round(height * .9)] < 160).mean(axis=0)
    cuts = []
    for start, end in ((.2, .35), (.45, .55), (.7, .8)):
        first, last = round(start * width), round(end * width)
        runs = []
        left = None
        for x in range(first, last + 1):
            if x < last and ink[x] < .005:
                if left is None:
                    left = x
            elif left is not None:
                runs.append((left, x))
                left = None
        gap = max(runs, key=lambda run: run[1] - run[0], default=None)
        if gap is None or (gap[1] - gap[0]) * page_width / width < 4:
            return []
        cuts.append((gap[0] + gap[1]) / 2 * page_width / width)
    return cuts


def _restore_physical_pages(document: Any, slices: Sequence[tuple[_PageGeometry, float]]) -> None:
    from docling_core.types.doc import ContentLayer, DocItemLabel, PageItem, Size

    if set(document.pages) != set(range(1, len(slices) + 1)):
        raise DoclingParseError("v2_physical_page_mapping_unavailable", "Docling omitted a prepared PDF page")
    for item, _ in document.iterate_items(with_groups=False, included_content_layers=set(ContentLayer)):
        # Cropping can make a numbered entry look like a running page header.
        # Preserve its OCR text; plain page numbers remain furniture.
        if _label(item) in {"page_header", "page_footer"} and re.match(
            r"^[a-z]?\s*\d+[.,)]\s*[^\W\d_]", getattr(item, "text", ""), re.IGNORECASE,
        ):
            item.content_layer = ContentLayer.BODY
            item.label = DocItemLabel.TEXT
        provenance = list(getattr(item, "prov", ()))
        if provenance:
            _, offset = slices[provenance[0].page_no - 1]
            for cell in getattr(getattr(item, "data", None), "table_cells", ()):
                if cell.bbox is not None:
                    cell.bbox.l += offset
                    cell.bbox.r += offset
        for prov in provenance:
            geometry, offset = slices[prov.page_no - 1]
            prov.page_no = geometry.page_number
            prov.bbox.l += offset
            prov.bbox.r += offset
    document.pages = {geometry.page_number: PageItem(
        page_no=geometry.page_number, size=Size(width=geometry.width, height=geometry.height),
    ) for geometry, _ in slices}


def _column_order(
    entries: list[tuple[Any, dict[str, float]]], page_width: float,
) -> tuple[list[tuple[Any, dict[str, float]]], bool]:
    # ponytail: whitespace cuts handle separated columns; overlapping/irregular
    # layouts keep Docling's order unless a clear column split can be found.
    for axis in ("x", "y"):
        groups: list[list[tuple[Any, dict[str, float]]]] = []
        end = -math.inf
        for entry in sorted(entries, key=lambda pair: pair[1][axis + "0"]):
            bbox = entry[1]
            # Small OCR overhangs must not join otherwise separate columns.
            margin = min(page_width * 0.005, (bbox[axis + "1"] - bbox[axis + "0"]) / 4) if axis == "x" else 0
            if bbox[axis + "0"] + margin > end:
                groups.append([])
            groups[-1].append(entry)
            end = max(end, bbox[axis + "1"] - margin)
        if len(groups) > 1:
            ordered: list[tuple[Any, dict[str, float]]] = []
            has_columns = axis == "x"
            for group in groups:
                children, child_columns = _column_order(group, page_width)
                ordered.extend(children)
                has_columns |= child_columns
            return ordered, has_columns
    return sorted(entries, key=lambda pair: (pair[1]["y0"], pair[1]["x0"])), False


def _new_markdown_serializer(document: Any) -> Any:
    from docling_core.transforms.serializer.markdown import (
        MarkdownDocSerializer, MarkdownParams, OrigListItemMarkerMode,
    )

    return MarkdownDocSerializer(doc=document, params=MarkdownParams(
        orig_list_item_marker_mode=OrigListItemMarkerMode.ALWAYS,
        ensure_valid_list_item_marker=False,
    ))


def _context_value(
    value: Mapping[str, Any] | object,
    name: str,
    default: Any = _MISSING,
) -> Any:
    if isinstance(value, Mapping) and name in value:
        return value[name]
    if hasattr(value, name):
        return getattr(value, name)
    if default is not _MISSING:
        return default
    raise DoclingParseError("invalid_task_context", f"Missing context field: {name}")


def _required_text(value: Mapping[str, Any] | object, name: str) -> str:
    result = _context_value(value, name)
    if not isinstance(result, str) or not result:
        raise DoclingParseError(
            "invalid_task_context", f"Context field {name} must be a non-empty string"
        )
    return result


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    enum_value = getattr(value, "value", None)
    return str(enum_value if enum_value is not None else value)


def _optional_positive_int(
    value: Mapping[str, Any] | object,
    name: str,
) -> int | None:
    result = _context_value(value, name, None)
    if result is None:
        return None
    if isinstance(result, bool) or not isinstance(result, int) or result < 1:
        raise DoclingParseError(
            "invalid_task_context", f"Context field {name} must be a positive integer"
        )
    return result


def _timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str) and value:
        return value
    raise DoclingParseError("invalid_task_context", "Timestamp context is invalid")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def _conversion_status(result: Any) -> str:
    status = getattr(result, "status", "failure")
    value = getattr(status, "value", status)
    return str(value).rsplit(".", 1)[-1].lower()


def _conversion_errors(result: Any) -> list[str]:
    messages: list[str] = []
    for error in getattr(result, "errors", ()) or ():
        message = (
            getattr(error, "error_message", None)
            or getattr(error, "message", None)
            or str(error)
        )
        text = str(message).strip()
        if text:
            messages.append(text)
    return _unique_strings(messages)


def _docling_version(result: Any) -> str | None:
    try:
        return version("docling")
    except PackageNotFoundError:
        result_version = getattr(result, "version", None)
        for name in ("docling_version", "version"):
            value = getattr(result_version, name, None)
            if value:
                return str(value)
        return None


def _normalise_lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _label(item: Any) -> str:
    return _enum_text(getattr(item, "label", None))


def _enum_text(value: Any) -> str:
    if value is None:
        return ""
    raw = getattr(value, "value", value)
    return str(raw).rsplit(".", 1)[-1].lower()


def _self_ref(item: Any) -> str | None:
    value = getattr(item, "self_ref", None)
    return value if isinstance(value, str) and value else None


def _int_value(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _nonnegative_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _finite_positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) and result > 0 else None


def _top_left_bbox(
    bbox: Any,
    page: _PageGeometry | None,
) -> dict[str, float] | None:
    if bbox is None or page is None:
        return None
    convert = getattr(bbox, "to_top_left_origin", None)
    if callable(convert):
        try:
            bbox = convert(page.height)
        except (TypeError, ValueError):
            return None
    try:
        left = float(getattr(bbox, "l"))
        top = float(getattr(bbox, "t"))
        right = float(getattr(bbox, "r"))
        bottom = float(getattr(bbox, "b"))
    except (AttributeError, TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in (left, top, right, bottom)):
        return None
    x0, x1 = sorted((left, right))
    y0, y1 = sorted((top, bottom))
    tolerance = 1e-3
    if (
        x0 < -tolerance
        or y0 < -tolerance
        or x1 > page.width + tolerance
        or y1 > page.height + tolerance
    ):
        return None
    x0 = max(0.0, x0)
    y0 = max(0.0, y0)
    x1 = min(page.width, x1)
    y1 = min(page.height, y1)
    if x0 >= x1 or y0 >= y1:
        return None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _cell_span(cell: Any, axis: str, start: int) -> int:
    direct = _int_value(getattr(cell, f"{axis}_span", None)) or 1
    end = _nonnegative_int(getattr(cell, f"end_{axis}_offset_idx", None))
    derived = end - start if end is not None and end > start else 1
    return max(direct, derived)


def _cell_role(cell: Any) -> str | None:
    if bool(getattr(cell, "column_header", False)):
        return "column_header"
    if bool(getattr(cell, "row_header", False)):
        return "row_header"
    if bool(getattr(cell, "row_section", False)):
        return "row_section"
    return None


def _deterministic_id(kind: str, context: _Context, identity: str) -> str:
    payload = "\0".join(
        (
            SCHEMA_VERSION,
            kind,
            context.content_sha256,
            context.preprocess_id,
            identity,
        )
    )
    return f"{kind}_{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"


def _diagnostic(
    code: str,
    *,
    reason: str | None = None,
    detail: str | None = None,
    page_number: int | None = None,
) -> dict[str, Any]:
    return {
        "code": code,
        "reason": reason,
        "detail": detail,
        "page_number": page_number,
    }


def _unique_strings(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _validate_publication(document: Mapping[str, Any], markdown: str) -> None:
    """Validate the cross-references that Studio relies on before persistence."""

    try:
        page_count = document["page_count"]
        pages = {page["page_number"]: page for page in document["pages"]}
        blocks = {block["block_id"]: block for block in document["content_stream"]}
        tables = {table["table_id"]: table for table in document["tables"]}
        anchors = {
            anchor["anchor_id"]: anchor
            for anchor in document["evidence_index"]["anchors"]
        }
        if len(pages) != page_count or set(pages) != set(range(1, page_count + 1)):
            raise ValueError("physical pages are incomplete")
        if len(blocks) != len(document["content_stream"]):
            raise ValueError("content block IDs are not unique")
        if len(tables) != len(document["tables"]):
            raise ValueError("table IDs are not unique")
        if len(anchors) != len(document["evidence_index"]["anchors"]):
            raise ValueError("anchor IDs are not unique")

        placed_tables: set[str] = set()
        placed_blocks: set[str] = set()
        for page_number, page in pages.items():
            for block_id in page["ordered_content"]:
                block = blocks.get(block_id)
                if block is None or block["page_number"] != page_number:
                    raise ValueError("ordered content reference is invalid")
                if block_id in placed_blocks:
                    raise ValueError("content block is placed more than once")
                placed_blocks.add(block_id)
                if block["kind"] == "table":
                    if block["table_id"] not in tables:
                        raise ValueError("table block reference is invalid")
                    placed_tables.add(block["table_id"])
        if placed_blocks != set(blocks):
            raise ValueError("every block must be placed")
        if placed_tables != set(tables):
            raise ValueError("every table must be placed")

        markdown_size = len(markdown.encode("utf-8"))
        occurrence_ids: set[str] = set()
        for anchor in anchors.values():
            if (
                anchor["content_sha256"] != document["document"]["content_sha256"]
                or anchor["preprocess_id"]
                != document["preprocessing"]["preprocess_id"]
            ):
                raise ValueError("anchor identity does not match the document")
            for observation in anchor["producer_observations"]:
                occurrence_id = observation["occurrence_id"]
                if occurrence_id in occurrence_ids:
                    raise ValueError("occurrence IDs are not unique")
                occurrence_ids.add(occurrence_id)
                page = pages[observation["page_number"]]
                bbox = observation["bbox"]
                if not (
                    0 <= bbox["x0"] < bbox["x1"] <= page["width_pt"]
                    and 0 <= bbox["y0"] < bbox["y1"] <= page["height_pt"]
                ):
                    raise ValueError("evidence bbox is outside its page")
            if anchor["kind"] == "text":
                block = blocks[anchor["block_id"]]
                if block["markdown_span"] != anchor["markdown_span"]:
                    raise ValueError("text anchor span does not match its block")
                if block["bbox"] != anchor["producer_observations"][0]["bbox"]:
                    raise ValueError("text anchor bbox does not match its block")
            else:
                table = tables[anchor["logical_table_id"]]
                cell = next(
                    item for item in table["cells"] if item["cell_id"] == anchor["cell_id"]
                )
                if cell["evidence_anchor_id"] != anchor["anchor_id"]:
                    raise ValueError("table cell anchor is inconsistent")
        for table in tables.values():
            for cell in table["cells"]:
                if anchors.get(cell["evidence_anchor_id"], {}).get("kind") != "table_cell":
                    raise ValueError("table cell is missing its evidence anchor")
        for page in pages.values():
            _validate_byte_span(page["markdown_span"], markdown_size)
        for block in blocks.values():
            if block["markdown_span"] is not None:
                _validate_byte_span(block["markdown_span"], markdown_size)
    except (KeyError, StopIteration, TypeError, ValueError) as exc:
        raise DoclingParseError(
            "parsed_document_publication_failed", str(exc)
        ) from exc


def _validate_byte_span(span: Mapping[str, Any], size: int) -> None:
    start = span["start"]
    end = span["end"]
    if (
        isinstance(start, bool)
        or isinstance(end, bool)
        or not isinstance(start, int)
        or not isinstance(end, int)
        or start < 0
        or end < start
        or end > size
    ):
        raise ValueError("Markdown byte span is invalid")


__all__ = ["DoclingParseError", "DoclingParser", "PARSER_NAME"]
