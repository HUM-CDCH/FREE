import unittest
import uuid
import zipfile
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

from app.api.routes_artifacts import _write_task_archive
from app.models.parsed_document import ParsedDocument, ParsedTable, TableCell
from app.parsing.adapters.pymupdf_inspect import (
    PdfInspection,
    PdfPageInspection,
    inspect_pdf,
)
from app.parsing.docling_runner import DoclingRunnerOutput
from app.parsing.doctags_to_markdown import (
    DocTagsMarkdownResult,
    compose_page_markdown,
    convert_doctags_to_markdown,
)
from app.parsing.ocr_fallback import OcrFallbackOutput
from app.parsing.orchestrator import (
    CanonicalIngestionError,
    _merge_page_fallback_text,
    _pages_and_views_from_llm_markdown,
    _pages_requiring_fallback,
    build_parsed_document,
    validate_inspection_for_ingestion,
)
from app.parsing.table_extraction import TableExtractionOutput, extract_tables
from app.storage import paths
from app.storage.manifests import (
    preprocessing_config_hash,
    rebind_parsed_document_for_task,
    save_task_metadata,
    write_parsed_document,
)
from app.workers.parse_worker import _cached_document_matches_task
from tests.storage_test_support import isolated_storage

NOW = "2026-07-09T00:00:00+00:00"
CONTENT_HASH = "a" * 64


@contextmanager
def _canonical_task(
    metadata: dict[str, Any], *, source_bytes: bytes = b"%PDF-1.4\n"
) -> Iterator[tuple[str, Path]]:
    with isolated_storage():
        task_id = str(uuid.uuid4())
        task_dir = paths.task_dir_for(task_id)
        task_dir.mkdir(parents=True)
        (task_dir / "source.pdf").write_bytes(source_bytes)
        save_task_metadata(task_dir, metadata)
        yield task_id, task_dir


def _successful_docling(
    result: DocTagsMarkdownResult,
    *,
    ref: str,
    page_mapping_verified: bool = True,
) -> DoclingRunnerOutput:
    return DoclingRunnerOutput(
        parser="docling_doctags",
        status="success",
        started_at=NOW,
        finished_at=NOW,
        duration_ms=1,
        llm_markdown_ref=ref,
        llm_markdown=result.markdown,
        char_count=len(result.markdown),
        page_spans=result.page_spans,
        page_mapping_verified=page_mapping_verified,
    )


def _inspection(*native_texts: str) -> PdfInspection:
    return PdfInspection(
        status="completed",
        started_at=NOW,
        finished_at=NOW,
        duration_ms=1,
        page_count=len(native_texts),
        pages=[
            PdfPageInspection(
                page=index,
                width_pt=100,
                height_pt=200,
                rotation=0,
                native_text=text,
                char_count=len(text),
                word_count=len(text.split()),
                image_count=0,
                drawing_count=0,
            )
            for index, text in enumerate(native_texts, start=1)
        ],
    )


def _canonical_document() -> ParsedDocument:
    return ParsedDocument.model_validate(
        {
            "document": {
                "document_id": f"sha256:{CONTENT_HASH}",
                "content_sha256": CONTENT_HASH,
                "source": {
                    "kind": "url",
                    "original_filename": "first.pdf",
                    "submitted_url": "https://example.com/first.pdf?secret=one",
                },
                "created_at": "2026-01-01T00:00:00+00:00",
                "page_count": 1,
            },
            "preprocessing": {
                "preprocess_id": "sha256:" + "b" * 64,
                "config_hash": "c" * 64,
                "status": "completed",
            },
            "artifacts": {"parsed_json_ref": "data/tasks/first/parsed_document.json"},
            "parser_runs": [{"parser": "docling_doctags", "status": "success"}],
            "arbitration": {
                "primary_document_parser": "docling_doctags",
                "strategy": "docling_primary_ocr_page_fallback",
            },
            "text_views": {
                "plain_text": "Body",
                "page_marked_text": "[PAGE 1]\nBody",
                "llm_markdown": "Body",
                "doc_tags_simplified": "Body",
            },
        }
    )


class TestCanonicalIngestion(unittest.TestCase):
    def test_inspection_page_limit_short_circuits_text_extraction(self):
        class OversizedDocument:
            page_count = 101
            is_encrypted = False

            def load_page(self, index):
                raise AssertionError(f"page {index} must not be loaded")

            def close(self):
                return None

        with patch(
            "app.parsing.adapters.pymupdf_inspect.fitz.open",
            return_value=OversizedDocument(),
        ):
            inspection = inspect_pdf(Path("source.pdf"), max_pages=100)

        self.assertEqual(inspection.status, "completed")
        self.assertEqual(inspection.page_count, 101)
        self.assertEqual(inspection.pages, [])

    def test_render_budget_short_circuits_text_extraction(self):
        class HugePage:
            rect = type("Rect", (), {"width": 10_000, "height": 10_000})()
            rotation = 0

            def get_text(self, kind):
                raise AssertionError(f"text extraction must not run: {kind}")

        class HugeDocument:
            page_count = 1
            is_encrypted = False

            def load_page(self, index):
                self.asserted_index = index
                return HugePage()

            def close(self):
                return None

        with patch(
            "app.parsing.adapters.pymupdf_inspect.fitz.open",
            return_value=HugeDocument(),
        ):
            inspection = inspect_pdf(
                Path("source.pdf"),
                render_dpi=150,
                max_page_pixels=1,
            )

        self.assertEqual(inspection.status, "failed")
        self.assertEqual(inspection.error, "pdf_page_render_budget_exceeded:1")

    def test_preflight_rejects_encrypted_and_oversized_documents(self):
        encrypted = _inspection("Body").model_copy(update={"is_encrypted": True})
        with self.assertRaisesRegex(ValueError, "Encrypted"):
            validate_inspection_for_ingestion(encrypted)

        too_many_pages = _inspection("Body").model_copy(update={"page_count": 101})
        with self.assertRaisesRegex(ValueError, "too many pages"):
            validate_inspection_for_ingestion(too_many_pages)

    def test_cached_document_is_rebound_to_each_task(self):
        canonical = _canonical_document()
        with isolated_storage() as root:
            task_dir = root / str(uuid.uuid4())
            task_dir.mkdir()
            (task_dir / "source.pdf").write_bytes(b"%PDF-1.4\n")
            metadata = {
                "content_sha256": CONTENT_HASH,
                "source_path": "source.pdf",
                "source_store_path": f"data/sources/{CONTENT_HASH}.pdf",
                "source_kind": "url",
                "submitted_url": "https://example.com/second.pdf?secret=two#part",
                "created_at": NOW,
                "params": {
                    "dpi": 300,
                    "device": "cpu",
                    "source_name": "second.pdf",
                },
            }

            rebound = rebind_parsed_document_for_task(task_dir, metadata, canonical)

            self.assertEqual(rebound.document.source.original_filename, "second.pdf")
            self.assertEqual(
                rebound.document.source.submitted_url,
                "https://example.com/second.pdf",
            )
            self.assertEqual(rebound.document.created_at, NOW)
            self.assertIn(task_dir.name, rebound.artifacts.parsed_json_ref or "")
            self.assertEqual(
                rebound.preprocessing.config_hash,
                canonical.preprocessing.config_hash,
            )

            self.assertFalse(_cached_document_matches_task(canonical, metadata))
            matching = canonical.model_copy(
                update={
                    "preprocessing": canonical.preprocessing.model_copy(
                        update={"config_hash": preprocessing_config_hash(metadata)}
                    )
                }
            )
            self.assertTrue(_cached_document_matches_task(matching, metadata))
            poisoned = matching.model_copy(
                update={
                    "document": matching.document.model_copy(
                        update={
                            "document_id": f"sha256:{'d' * 64}",
                            "content_sha256": "d" * 64,
                        }
                    )
                }
            )
            self.assertFalse(_cached_document_matches_task(poisoned, metadata))
            self.assertEqual(
                preprocessing_config_hash(metadata),
                preprocessing_config_hash({"params": {"dpi": 72, "device": "gpu:0"}}),
            )

    def test_download_archive_includes_canonical_artifacts(self):
        with isolated_storage() as root:
            task_dir = root / "tasks" / str(uuid.uuid4())
            task_dir.mkdir(parents=True)
            artifact_path = (
                paths.document_artifacts_dir(CONTENT_HASH)
                / "docling"
                / "document.doctags"
            )
            artifact_path.parent.mkdir(parents=True, exist_ok=True)
            artifact_path.write_text("<doctag>Body</doctag>", encoding="utf-8")
            artifact_ref = paths.service_relative_ref(artifact_path)
            canonical = _canonical_document()
            canonical = canonical.model_copy(
                update={
                    "artifacts": canonical.artifacts.model_copy(
                        update={"raw_doctags_ref": artifact_ref}
                    )
                }
            )
            write_parsed_document(task_dir, canonical)
            archive_path = task_dir / "result.zip"

            _write_task_archive(task_dir, archive_path)

            with zipfile.ZipFile(archive_path) as archive:
                names = set(archive.namelist())
            self.assertIn("parsed_document.json", names)
            self.assertIn("canonical/artifacts/docling/document.doctags", names)

            archive_path.unlink()
            with ThreadPoolExecutor(max_workers=2) as executor:
                list(
                    executor.map(
                        lambda _: _write_task_archive(task_dir, archive_path),
                        range(2),
                    )
                )
            with zipfile.ZipFile(archive_path) as archive:
                self.assertIsNone(archive.testzip())

    def test_split_table_page_metadata_prevents_spurious_ocr(self):
        conversion = convert_doctags_to_markdown(
            "<otsl><ched>Name<ched>Age<nl><fcel>Ada<fcel>37</otsl>"
            "<page_break><otsl><fcel>Bob<fcel>41</otsl>"
        )
        with _canonical_task(
            {
                "content_sha256": CONTENT_HASH,
                "source_kind": "upload",
                "created_at": NOW,
                "params": {"source_name": "source.pdf"},
            }
        ) as (task_id, task_dir):
            docling = _successful_docling(
                conversion,
                ref="data/documents/table.llm.md",
            )
            with (
                patch(
                    "app.parsing.orchestrator.inspect_pdf",
                    return_value=_inspection("Native one", "Native two"),
                ),
                patch(
                    "app.parsing.orchestrator._run_docling_ingestion",
                    return_value=docling,
                ),
                patch(
                    "app.parsing.orchestrator._read_service_text",
                    return_value=conversion.markdown,
                ),
                patch("app.parsing.orchestrator._run_ocr_fallback") as mock_ocr,
                patch(
                    "app.parsing.orchestrator._run_table_extraction",
                    return_value=TableExtractionOutput(
                        status="success",
                        tables=[
                            ParsedTable(
                                table_id="p01_t01",
                                page_number=1,
                                source_parser="camelot_stream",
                                rows=2,
                                cols=2,
                                cells=[
                                    TableCell(row=0, col=0, text="Name", role="header")
                                ],
                            )
                        ],
                        metrics={"tables_found": 1, "tables_kept": 1},
                    ),
                ),
            ):
                document = build_parsed_document(task_id)

            mock_ocr.assert_not_called()
            self.assertEqual(len(document.pages), 2)
            self.assertIn("Ada", document.pages[0].text)
            self.assertIn("Bob", document.pages[1].text)
            self.assertEqual(document.tables[0].table_id, "p01_t01")
            self.assertIn(
                "camelot_stream", [run.parser for run in document.parser_runs]
            )
            self.assertEqual(
                document.arbitration.page_decisions[0].selected_table_parser,
                "camelot_stream",
            )
            self.assertEqual(
                document.arbitration.page_decisions[1].selected_table_parser,
                "docling_doctags",
            )

    def test_successful_empty_table_result_does_not_add_document_warning(self):
        camelot = Mock()
        camelot.read_pdf.return_value = []
        with patch(
            "app.parsing.table_extraction.importlib.import_module",
            return_value=camelot,
        ):
            empty_tables = extract_tables(
                source_pdf=Path("source.pdf"),
                content_sha256=CONTENT_HASH,
                page_heights_pt={1: 200.0},
            )

        body = "Canonical body text."
        conversion = compose_page_markdown([body])
        with _canonical_task(
            {
                "content_sha256": CONTENT_HASH,
                "source_kind": "upload",
                "created_at": NOW,
                "params": {"source_name": "source.pdf"},
            }
        ) as (task_id, task_dir):
            docling = _successful_docling(
                conversion,
                ref="data/documents/empty-table.llm.md",
            )
            with (
                patch(
                    "app.parsing.orchestrator.inspect_pdf",
                    return_value=_inspection(body),
                ),
                patch(
                    "app.parsing.orchestrator._run_docling_ingestion",
                    return_value=docling,
                ),
                patch(
                    "app.parsing.orchestrator._run_table_extraction",
                    return_value=empty_tables,
                ),
            ):
                document = build_parsed_document(task_id)

            self.assertEqual(document.tables, [])
            self.assertEqual(document.preprocessing.status, "completed")
            self.assertEqual(document.preprocessing.warnings, [])
            table_run = next(
                run for run in document.parser_runs if run.parser == "camelot_stream"
            )
            self.assertEqual(table_run.status, "success")
            self.assertEqual(table_run.metrics["tables_found"], 0)
            self.assertEqual(table_run.metrics["tables_kept"], 0)

    def test_partial_doctags_uses_page_level_ocr_with_correct_provenance(self):
        with _canonical_task(
            {
                "content_sha256": CONTENT_HASH,
                "source_path": "source.pdf",
                "source_kind": "upload",
                "created_at": NOW,
                "params": {
                    "dpi": 150,
                    "device": "cpu",
                    "source_name": "source.pdf",
                },
            }
        ) as (task_id, task_dir):
            partial = compose_page_markdown(["Docling one", ""])
            docling = _successful_docling(
                partial,
                ref="data/documents/source.llm.md",
            )
            ocr = OcrFallbackOutput(
                status="success",
                started_at=NOW,
                finished_at=NOW,
                duration_ms=1,
                pages={2: "OCR page two"},
                page_lines={
                    2: [
                        {
                            "type": "ocr_line",
                            "text": "OCR page two",
                            "confidence": 0.9,
                            "bbox": [10.0, 20.0, 90.0, 30.0],
                        }
                    ]
                },
            )
            with (
                patch(
                    "app.parsing.orchestrator.inspect_pdf",
                    return_value=_inspection("Native one", "Native two"),
                ),
                patch(
                    "app.parsing.orchestrator._run_docling_ingestion",
                    return_value=docling,
                ),
                patch(
                    "app.parsing.orchestrator._read_service_text",
                    return_value="Docling one\n\n---\n\n",
                ),
                patch(
                    "app.parsing.orchestrator._run_ocr_fallback",
                    return_value=ocr,
                ) as mock_ocr,
                patch(
                    "app.parsing.orchestrator._run_table_extraction",
                    return_value=TableExtractionOutput(),
                ),
            ):
                document = build_parsed_document(task_id)

            mock_ocr.assert_called_once()
            self.assertEqual(mock_ocr.call_args.args[2], [2])
            self.assertEqual(document.pages[0].selected_parser, "docling_doctags")
            self.assertEqual(document.pages[1].selected_parser, "paddleocr_fallback")
            self.assertEqual(document.pages[1].text, "OCR page two")
            self.assertEqual(document.tables, [])
            self.assertEqual(document.pages[1].quality.ocr_confidence, 0.9)
            self.assertEqual(document.pages[1].blocks[0]["type"], "ocr_line")
            self.assertEqual(
                document.pages[1].blocks[0]["bbox"], [10.0, 20.0, 90.0, 30.0]
            )
            self.assertEqual(document.pages[0].blocks, [])
            self.assertIsNone(document.pages[0].quality.ocr_confidence)
            self.assertEqual(
                document.arbitration.page_decisions[1].selected_text_parser,
                "paddleocr_fallback",
            )
            self.assertEqual(
                document.text_views.doc_tags_simplified,
                partial.markdown,
            )
            self.assertIn("OCR page two", document.text_views.llm_markdown or "")
            inspection_ref = document.parser_runs[0].output_ref or ""
            self.assertIn(f"documents/{CONTENT_HASH}/artifacts/", inspection_ref)
            self.assertNotIn("/output/", inspection_ref)

    def test_unverified_doctags_remain_document_level_without_page_offsets(self):
        pages, views = _pages_and_views_from_llm_markdown(
            llm_markdown="One\n\n---\n\nThree",
            llm_spans=(),
            selected_parser="docling_doctags",
            inspection=_inspection("Native one", "", "Native three"),
            parser_by_page={},
            doc_tags_simplified="One\n\n---\n\nThree",
            page_mapping_verified=False,
        )

        self.assertEqual(views.page_marked_text, "[DOCUMENT]\nOne\n\n---\n\nThree")
        self.assertTrue(all(page.char_span is None for page in pages))
        self.assertTrue(all(page.text == "" for page in pages))

    def test_ocr_only_document_preserves_verified_page_mapping(self):
        with _canonical_task(
            {
                "content_sha256": CONTENT_HASH,
                "source_path": "source.pdf",
                "source_kind": "upload",
                "created_at": NOW,
                "params": {"source_name": "source.pdf"},
            }
        ) as (task_id, task_dir):
            inspected = _inspection("")
            inspected = inspected.model_copy(
                update={
                    "pages": [inspected.pages[0].model_copy(update={"image_count": 1})]
                }
            )
            docling = DoclingRunnerOutput(
                parser="docling_doctags",
                status="success",
                started_at=NOW,
                finished_at=NOW,
                duration_ms=1,
                llm_markdown_ref="data/documents/source.llm.md",
                llm_markdown="",
                page_spans=(),
                page_mapping_verified=False,
            )
            ocr = OcrFallbackOutput(
                status="success",
                started_at=NOW,
                finished_at=NOW,
                duration_ms=1,
                pages={1: "OCR only"},
            )
            with (
                patch(
                    "app.parsing.orchestrator.inspect_pdf",
                    return_value=inspected,
                ),
                patch(
                    "app.parsing.orchestrator._run_docling_ingestion",
                    return_value=docling,
                ),
                patch(
                    "app.parsing.orchestrator._run_ocr_fallback",
                    return_value=ocr,
                ) as mock_ocr,
                patch(
                    "app.parsing.orchestrator._run_table_extraction",
                    return_value=TableExtractionOutput(),
                ),
            ):
                document = build_parsed_document(task_id)

            mock_ocr.assert_called_once()
            self.assertEqual(document.pages[0].text, "OCR only")
            self.assertIsNotNone(document.pages[0].char_span)
            self.assertEqual(
                document.pages[0].selected_parser,
                "paddleocr_fallback",
            )
            self.assertEqual(
                document.arbitration.strategy,
                "docling_primary_ocr_page_fallback",
            )

    def test_verified_blank_page_does_not_require_ocr(self):
        inspection = _inspection("Body", "")
        docling = compose_page_markdown(["Body", ""])

        self.assertEqual(
            _pages_requiring_fallback(docling.page_spans, inspection),
            [],
        )

        scanned_pages = list(inspection.pages)
        scanned_pages[1] = scanned_pages[1].model_copy(update={"image_count": 1})
        scanned = inspection.model_copy(update={"pages": scanned_pages})
        self.assertEqual(
            _pages_requiring_fallback(docling.page_spans, scanned),
            [2],
        )

    def test_unknown_drawing_inventory_still_requires_ocr(self):
        inspection = _inspection("Body", "")
        docling = compose_page_markdown(["Body", ""])

        unknown_pages = list(inspection.pages)
        unknown_pages[1] = unknown_pages[1].model_copy(
            update={"drawing_count": None}
        )
        unknown = inspection.model_copy(update={"pages": unknown_pages})
        self.assertEqual(
            _pages_requiring_fallback(docling.page_spans, unknown),
            [2],
        )

    def test_trailing_blank_page_offsets_slice_published_doctags_view(self):
        composed = compose_page_markdown(["One", ""])
        pages, views = _pages_and_views_from_llm_markdown(
            llm_markdown=composed.markdown,
            llm_spans=composed.page_spans,
            selected_parser="docling_doctags",
            inspection=_inspection("One", ""),
            parser_by_page={1: "docling_doctags", 2: "docling_doctags"},
            doc_tags_simplified=composed.markdown,
            doc_tags_spans=composed.page_spans,
            page_mapping_verified=True,
        )

        self.assertEqual(views.doc_tags_simplified, composed.markdown)
        for page in pages:
            span = page.char_span
            self.assertIsNotNone(span)
            self.assertLessEqual(
                span.doc_tags_simplified_end or 0,
                len(views.doc_tags_simplified or ""),
            )
            self.assertEqual(
                (views.doc_tags_simplified or "")[
                    span.doc_tags_simplified_start : span.doc_tags_simplified_end
                ],
                page.text,
            )

    def test_successful_empty_ocr_confirms_blank_page(self):
        inspection = _inspection("Body", "")
        docling = compose_page_markdown(["Body", ""])
        ocr = OcrFallbackOutput(status="success", pages={2: ""})

        markdown, spans, parser_by_page, unresolved, _ = _merge_page_fallback_text(
            docling_spans=docling.page_spans,
            inspection=inspection,
            fallback_pages=[2],
            ocr_output=ocr,
        )

        self.assertEqual(unresolved, [])
        self.assertEqual(parser_by_page[2], "paddleocr_fallback")
        self.assertEqual(spans[1].text, "")
        self.assertEqual(
            markdown[spans[1].llm_markdown_start : spans[1].llm_markdown_end], ""
        )

    def test_failed_ocr_retains_usable_docling_text(self):
        inspection = _inspection("Native text " * 30)
        docling = compose_page_markdown(["Short but usable"])
        ocr = OcrFallbackOutput(status="failed", error="ocr_fallback_unavailable")

        markdown, spans, parser_by_page, unresolved, _ = _merge_page_fallback_text(
            docling_spans=docling.page_spans,
            inspection=inspection,
            fallback_pages=[1],
            ocr_output=ocr,
        )

        self.assertEqual(markdown, "Short but usable")
        self.assertEqual(spans[0].text, "Short but usable")
        self.assertEqual(parser_by_page, {1: "docling_doctags"})
        self.assertEqual(unresolved, [])

    def test_failed_ocr_does_not_promote_pymupdf_native_text(self):
        inspection = _inspection("Native text that must remain diagnostic only")
        docling = compose_page_markdown([""])
        ocr = OcrFallbackOutput(status="failed", error="ocr_fallback_unavailable")

        markdown, _, parser_by_page, unresolved, _ = _merge_page_fallback_text(
            docling_spans=docling.page_spans,
            inspection=inspection,
            fallback_pages=[1],
            ocr_output=ocr,
        )

        self.assertEqual(markdown, "")
        self.assertEqual(parser_by_page, {1: "docling_doctags"})
        self.assertEqual(unresolved, [1])

    def test_successful_ocr_missing_requested_page_is_unresolved(self):
        inspection = _inspection("", "")
        docling = compose_page_markdown(["", ""])
        ocr = OcrFallbackOutput(status="success", pages={1: "Recovered"})

        _, _, _, unresolved, _ = _merge_page_fallback_text(
            docling_spans=docling.page_spans,
            inspection=inspection,
            fallback_pages=[1, 2],
            ocr_output=ocr,
        )

        self.assertEqual(unresolved, [2])

    def test_build_fails_when_no_parser_produces_text(self):
        with _canonical_task(
            {
                "content_sha256": CONTENT_HASH,
                "source_path": "source.pdf",
                "source_kind": "upload",
                "created_at": NOW,
                "params": {"dpi": 150, "device": "cpu"},
            },
            source_bytes=b"%PDF-invalid",
        ) as (task_id, task_dir):
            failed_inspection = PdfInspection(
                status="failed",
                started_at=NOW,
                finished_at=NOW,
                duration_ms=1,
                error="invalid PDF",
            )
            failed_docling = DoclingRunnerOutput(
                parser="docling_doctags",
                status="failed",
                started_at=NOW,
                finished_at=NOW,
                duration_ms=1,
                error="invalid PDF",
            )
            with (
                patch(
                    "app.parsing.orchestrator.inspect_pdf",
                    return_value=failed_inspection,
                ),
                patch(
                    "app.parsing.orchestrator._run_docling_ingestion",
                    return_value=failed_docling,
                ),
                self.assertRaisesRegex(
                    CanonicalIngestionError,
                    "PDF inspection failed",
                ),
            ):
                build_parsed_document(task_id)


if __name__ == "__main__":
    unittest.main()
