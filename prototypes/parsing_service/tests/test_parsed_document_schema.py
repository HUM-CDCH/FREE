# ruff: noqa: I001

import math
import unittest

from pydantic import ValidationError

from app.models.parsed_document import (
    ArbitrationResult,
    BoundingBox,
    ArtifactManifest,
    CharSpan,
    DocumentMetadata,
    PageDecision,
    ParsedDocument,
    ParsedPage,
    ParserRun,
    PageQuality,
    PreprocessingMetadata,
    SourceInfo,
    TableCell,
    TextViews,
)
from app.storage.hashing import (
    compute_config_hash,
    compute_sha256,
    document_id_from_hash,
    preprocess_id_from_hashes,
)

CONTENT_HASH = "a" * 64


def minimal_document(**overrides) -> dict:
    payload = {
        "schema_version": "parsed_document.v1",
        "document": {
            "document_id": f"sha256:{CONTENT_HASH}",
            "content_sha256": CONTENT_HASH,
            "source": {"kind": "upload", "original_filename": "report.pdf"},
            "created_at": "2026-01-01T00:00:00Z",
            "page_count": 1,
        },
        "preprocessing": {
            "preprocess_id": "sha256:" + "b" * 64,
            "config_hash": "c" * 64,
            "status": "completed",
        },
        "artifacts": {},
        "parser_runs": [{"parser": "docling_pdf", "status": "success"}],
        "arbitration": {
            "primary_document_parser": "docling_pdf",
            "strategy": "document_primary_page_fallback",
            "page_decisions": [
                {"page": 1, "selected_text_parser": "docling_pdf", "reason": "ok"}
            ],
        },
        "text_views": {
            "plain_text": "Body",
            "page_marked_text": "[PAGE 1]\nBody",
            "llm_markdown": "Body",
            "doc_tags_simplified": "Body",
        },
        "pages": [{"page": 1, "text": "Body"}],
    }
    payload.update(overrides)
    return payload


class TestParsedDocumentSchema(unittest.TestCase):
    def test_minimal_document_validates(self):
        document = ParsedDocument.model_validate(minimal_document())
        self.assertEqual(document.schema_version, "parsed_document.v1")
        self.assertEqual(document.document.content_sha256, CONTENT_HASH)

    def test_schema_version_is_pinned(self):
        with self.assertRaises(ValidationError):
            ParsedDocument.model_validate(
                minimal_document(schema_version="parsed_document.v2")
            )

    def test_round_trip(self):
        document = ParsedDocument(
            document=DocumentMetadata(
                document_id=f"sha256:{CONTENT_HASH}",
                content_sha256=CONTENT_HASH,
                source=SourceInfo(kind="upload", original_filename="report.pdf"),
                created_at="2026-01-01T00:00:00Z",
                page_count=1,
            ),
            preprocessing=PreprocessingMetadata(
                preprocess_id=preprocess_id_from_hashes(CONTENT_HASH, "c" * 64),
                config_hash="c" * 64,
                status="completed",
            ),
            artifacts=ArtifactManifest(
                source_ref=f"data/sources/{CONTENT_HASH}.pdf",
                raw_docling_json_ref=f"data/documents/{CONTENT_HASH}/artifacts/docling/document.docling.json",
                raw_doctags_ref=f"data/documents/{CONTENT_HASH}/artifacts/docling/document.doctags",
                llm_markdown_ref=f"data/documents/{CONTENT_HASH}/artifacts/docling/document.llm.md",
            ),
            parser_runs=[
                ParserRun(
                    parser="docling_pdf",
                    status="success",
                    output_ref="output/source/docling_pdf/document.md",
                    metrics={"char_count": 4},
                )
            ],
            arbitration=ArbitrationResult(
                primary_document_parser="docling_pdf",
                strategy="document_primary_page_fallback",
                page_decisions=[
                    PageDecision(
                        page=1,
                        selected_text_parser="docling_pdf",
                        reason="docling_pdf_text_sufficient",
                        scores={"docling_pdf": 1.0},
                    )
                ],
            ),
            text_views=TextViews(
                plain_text="Body",
                page_marked_text="[PAGE 1]\nBody",
                llm_markdown="Body",
                doc_tags_simplified="Body",
            ),
            pages=[
                ParsedPage(
                    page=1,
                    text="Body",
                    char_span=CharSpan(
                        plain_text_start=0,
                        plain_text_end=4,
                        page_marked_text_start=9,
                        page_marked_text_end=13,
                        llm_markdown_start=0,
                        llm_markdown_end=4,
                        doc_tags_simplified_start=0,
                        doc_tags_simplified_end=4,
                    ),
                )
            ],
        )
        dumped = document.model_dump(mode="json")
        self.assertEqual(dumped["schema_version"], "parsed_document.v1")
        self.assertEqual(ParsedDocument.model_validate(dumped), document)

    def test_round_trip_with_tables_and_ocr_blocks(self):
        payload = minimal_document(
            tables=[
                {
                    "table_id": "p01_t01",
                    "page_number": 1,
                    "source_parser": "camelot_stream",
                    "bbox": {"x0": 10.0, "y0": 12.0, "x1": 200.0, "y1": 192.0},
                    "rows": 2,
                    "cols": 2,
                    "cells": [
                        {"row": 0, "col": 0, "text": "Name", "role": "header"},
                        {
                            "row": 1,
                            "col": 0,
                            "text": "Ada",
                            "role": "data",
                            "rowspan": 1,
                            "colspan": 2,
                            "bbox": {"x0": 10.0, "y0": 72.0, "x1": 50.0, "y1": 92.0},
                        },
                    ],
                    "markdown_view": "| Name |\n| --- |\n| Ada |",
                }
            ],
            pages=[
                {
                    "page": 1,
                    "text": "Body",
                    "quality": {"char_count": 4, "ocr_confidence": 0.87},
                    "blocks": [
                        {
                            "type": "ocr_line",
                            "text": "Body",
                            "confidence": 0.87,
                            "bbox": [10.0, 20.0, 90.0, 30.0],
                        }
                    ],
                }
            ],
        )
        document = ParsedDocument.model_validate(payload)
        self.assertEqual(document.tables[0].cells[1].colspan, 2)
        self.assertEqual(document.pages[0].quality.ocr_confidence, 0.87)
        dumped = document.model_dump(mode="json")
        self.assertEqual(ParsedDocument.model_validate(dumped), document)

    def test_geometry_and_confidence_reject_invalid_numbers(self):
        for payload in (
            {"x0": 10, "y0": 20, "x1": 1, "y1": 2},
            {"x0": math.nan, "y0": 0, "x1": 1, "y1": 1},
        ):
            try:
                BoundingBox.model_validate(payload)
            except ValidationError:
                pass
            else:
                self.fail("invalid bounding box was accepted")
        for value in (-0.1, 1.1, math.nan, math.inf):
            try:
                PageQuality(ocr_confidence=value)
            except ValidationError:
                pass
            else:
                self.fail("invalid page OCR confidence was accepted")
            try:
                TableCell(row=0, col=0, confidence=value)
            except ValidationError:
                pass
            else:
                self.fail("invalid cell confidence was accepted")

    def test_failed_parser_run_preserves_error(self):
        document = ParsedDocument.model_validate(
            minimal_document(
                parser_runs=[
                    {"parser": "docling_pdf", "status": "success"},
                    {
                        "parser": "paddleocr",
                        "status": "failed",
                        "error": "Failed: boom",
                    },
                ]
            )
        )
        failed = document.parser_runs[1]
        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.error, "Failed: boom")


class TestHashing(unittest.TestCase):
    def test_same_content_gives_same_document_id(self):
        content = b"%PDF-1.4 fixture"
        self.assertEqual(
            document_id_from_hash(compute_sha256(content)),
            document_id_from_hash(compute_sha256(content)),
        )
        self.assertTrue(compute_sha256(content).isalnum())
        self.assertEqual(len(compute_sha256(content)), 64)

    def test_same_content_and_config_gives_same_preprocess_id(self):
        content_hash = compute_sha256(b"%PDF-1.4 fixture")
        config = {"dpi": 150, "pipeline": "docling_pdf", "device": "cpu"}
        first = preprocess_id_from_hashes(content_hash, compute_config_hash(config))
        second = preprocess_id_from_hashes(
            content_hash, compute_config_hash(dict(config))
        )
        self.assertEqual(first, second)

    def test_config_change_changes_preprocess_id(self):
        content_hash = compute_sha256(b"%PDF-1.4 fixture")
        base = compute_config_hash({"dpi": 150})
        other = compute_config_hash({"dpi": 300})
        self.assertNotEqual(
            preprocess_id_from_hashes(content_hash, base),
            preprocess_id_from_hashes(content_hash, other),
        )


if __name__ == "__main__":
    unittest.main()
