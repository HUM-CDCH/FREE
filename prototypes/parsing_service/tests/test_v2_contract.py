from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from pydantic import ValidationError

from app.models.parsed_document import ParsedDocument
from app.models.parsed_document_v2 import (
    CanonicalTableCell,
    LogicalTable,
    LogicalTablePageSpan,
    ParagraphBlock,
    ParsedPageV2,
    ParserAttribution,
    TableCellEvidenceAnchor,
    TableParserAttribution,
)
from app.parsing.v2_publication import render_canonical_markdown
from app.storage.canonical_package import assemble_package, validate_package
from app.workers._task_state import validate_current_task_metadata


FIXTURE = Path(__file__).parent / "fixtures" / "producer_review_observations.json"


def _document(source: bytes = b"%PDF-1.7\n") -> ParsedDocument:
    digest = hashlib.sha256(source).hexdigest()
    return ParsedDocument.model_validate(
        {
            "schema_version": "parsed_document.v2",
            "document": {
                "document_id": f"sha256:{digest}",
                "content_sha256": digest,
                "source": {
                    "kind": "upload",
                    "original_filename": "source.pdf",
                    "media_type": "application/pdf",
                    "byte_size": len(source),
                },
                "created_at": "2026-01-01T00:00:00Z",
                "page_count": 1,
                "language_hints": [],
                "is_encrypted": False,
                "input_profile": {
                    "file_kind": "pdf",
                    "detected_mime": "application/pdf",
                    "pdf_version": "1.7",
                    "has_text_layer": True,
                    "has_images": False,
                },
            },
            "preprocessing": {
                "preprocess_id": "sha256:policy",
                "profile": "production_default",
                "service_version": "test",
                "started_at": None,
                "finished_at": None,
                "status": "completed",
                "warnings": [],
            },
            "page_count": 1,
            "page_mapping_verified": True,
            "artifacts": {
                "source_ref": "source.pdf",
                "parsed_json_ref": "parsed_document.json",
                "markdown_ref": "artifacts/document.llm.md",
            },
            "parser_runs": [],
            "arbitration": None,
            "diagnostics": [],
            "content_stream": [
                {
                    "kind": "paragraph",
                    "block_id": "block-1",
                    "page_number": 1,
                    "parser": "fixture",
                    "bbox": None,
                    "markdown_span": {"start": 21, "end": 25},
                    "text": "Body",
                }
            ],
            "pages": [
                {
                    "page_number": 1,
                    "width_pt": None,
                    "height_pt": None,
                    "rotation": 0,
                    "ordered_content": ["block-1"],
                    "unplaced_content": [],
                    "markdown_span": {"start": 21, "end": 25},
                }
            ],
            "tables": [],
            "evidence_index": {
                "anchors": [
                    {
                        "kind": "text",
                        "anchor_id": "anchor-1",
                        "occurrence_id": "occurrence-1",
                        "content_sha256": digest,
                        "preprocess_id": "sha256:policy",
                        "block_id": "block-1",
                        "page_number": 1,
                        "markdown_span": {"start": 21, "end": 25},
                        "bbox": None,
                    }
                ]
            },
        }
    )


class ParsedDocumentV2ContractTests(unittest.TestCase):
    def test_public_model_is_canonical_and_rejects_v1_aliases(self) -> None:
        document = _document()
        self.assertIs(ParsedDocument, type(document))
        payload = document.model_dump(mode="json")
        self.assertEqual(payload["schema_version"], "parsed_document.v2")
        with self.assertRaises(ValidationError):
            ParsedDocument.model_validate({**payload, "schema_version": "parsed_document.v1"})
        with self.assertRaises(ValidationError):
            ParsedDocument.model_validate({**payload, "blocks": payload["content_stream"]})
        with self.assertRaises(ValidationError):
            ParsedDocument.model_validate(
                {
                    **payload,
                    "content_stream": [
                        {**payload["content_stream"][0], "char_span": {"start": 0, "end": 1}}
                    ],
                }
            )

    def test_utf8_byte_spans_cover_non_ascii_and_non_bmp_text(self) -> None:
        text = "Smørrebrød 🐟"
        rendered = render_canonical_markdown(
            [ParsedPageV2(page_number=1, ordered_content=["b"])],
            [ParagraphBlock(block_id="b", page_number=1, parser="fixture", text=text)],
            page_count=1,
        )
        span = rendered.block_spans["b"]
        self.assertEqual(rendered.slice(span), text)
        self.assertEqual(span.end - span.start, len(text.encode("utf-8")))

    def test_occurrence_identity_has_one_anchor_owner(self) -> None:
        payload = _document().model_dump(mode="json")
        payload["evidence_index"]["anchors"].append(
            {
                **payload["evidence_index"]["anchors"][0],
                "anchor_id": "anchor-2",
            }
        )
        with self.assertRaisesRegex(ValidationError, "occurrence IDs must be unique"):
            ParsedDocument.model_validate(payload)

    def test_table_cell_has_one_anchor_with_owned_occurrences(self) -> None:
        sha = "a" * 64
        preprocess = "sha256:" + "b" * 64
        cell = CanonicalTableCell(
            cell_id="cell-1",
            row=0,
            column=0,
            text="Value",
            role="data",
            evidence_anchor_id="anchor-1",
        )
        table = LogicalTable(
            table_id="table-1",
            rows=1,
            cols=1,
            cells=[cell],
            spans=[LogicalTablePageSpan(page_number=1, producer_table_ref="#/tables/1", page_local_row_end=0)],
            parser_attribution=TableParserAttribution(
                content_parser=ParserAttribution(parser="docling_table"),
                structure_parser=ParserAttribution(parser="docling_table"),
            ),
        )
        anchor = TableCellEvidenceAnchor(
            anchor_id="anchor-1",
            content_sha256=sha,
            preprocess_id=preprocess,
            logical_table_id=table.table_id,
            cell_id=cell.cell_id,
            canonical_row=0,
            canonical_column=0,
            producer_observations=[
                {
                    "occurrence_id": "occurrence-1",
                    "page_number": 1,
                    "producer_ref": "#/tables/1",
                    "row_offset": 0,
                    "column_offset": 0,
                    "row_span": 1,
                    "column_span": 1,
                    "bbox": None,
                }
            ],
        )
        self.assertNotIn("evidence", cell.model_dump())
        self.assertNotIn("evidence_anchor_ids", table.spans[0].model_dump())
        self.assertEqual(anchor.producer_observations[0].page_number, 1)

    def test_reviewed_continuation_has_fail_closed_negative_cases(self) -> None:
        from app.parsing import continuation as review

        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cases = {case["name"]: case for case in fixture["cases"]}

        def evaluate(name: str):
            case = cases[name]
            boundary = case["boundary"]
            return review.evaluate_reviewed_continuation(
                fixture["record_sets"][case["_fixture_record_set"]],
                boundary={
                    "doctags": copy.deepcopy(boundary["_fixture_doctags"]),
                    "interstitial": copy.deepcopy(boundary["_fixture_interstitial"]),
                    "following_content": copy.deepcopy(boundary["following_content"]),
                },
            )

        self.assertTrue(evaluate("positive_6_to_7").continue_table)
        for name in ("narrative_interstitial", "new_table_header_row", "caption_interstitial", "failed_continuation_evidence"):
            self.assertFalse(evaluate(name).continue_table)

    def test_package_is_deterministic_and_contains_only_four_entries(self) -> None:
        source = b"%PDF-1.7\n"
        document = _document(source)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "source.pdf"
            source_path.write_bytes(source)
            first = root / "first.zip"
            second = root / "second.zip"
            assemble_package(source_path, document, "<!-- FREE:PAGE 1 -->\nBody", first)
            assemble_package(source_path, document, "<!-- FREE:PAGE 1 -->\nBody", second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(
                zipfile.ZipFile(first).namelist(),
                ["manifest.json", "source.pdf", "parsed_document.json", "artifacts/document.llm.md"],
            )
            self.assertEqual(validate_package(first)["parsed_document_schema_version"], "parsed_document.v2")

    def test_startup_reconciliation_rejects_legacy_task_shape(self) -> None:
        with self.assertRaisesRegex(ValueError, "task_metadata_not_current"):
            validate_current_task_metadata("task-1", {"task_id": "task-1", "status": "pending"})


if __name__ == "__main__":
    unittest.main()
