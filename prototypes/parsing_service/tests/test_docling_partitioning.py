"""Integration coverage for DoclingParser's partition-scoped parse() path:
independent page-range calls, ref-prefix ID namespacing, and merging the
resulting fragments back into one validated parsed_document.v2 document."""

from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import pypdfium2 as pdfium
from docling_core.types.doc import (
    BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem, Size,
)

from app.docling_parser import DoclingParser
from app.parallel_parsing import merge_fragments


def make_multi_page_pdf(directory: Path, pages: int) -> Path:
    path = directory / "multi.pdf"
    document = pdfium.PdfDocument.new()
    for _ in range(pages):
        document.new_page(612, 792)
    document.save(path)
    return path


def page_document(page_numbers: list[int]) -> DoclingDocument:
    """A minimal DoclingDocument covering exactly `page_numbers`, one
    paragraph per page — standing in for what a real page_range conversion
    would report for that partition alone."""

    document = DoclingDocument(name="partition")
    for number in page_numbers:
        document.add_page(number, Size(width=612, height=792))
        document.add_text(
            DocItemLabel.TEXT,
            f"content on page {number}",
            prov=ProvenanceItem(
                page_no=number, charspan=(0, 20),
                bbox=BoundingBox(l=10, t=100, r=200, b=130, coord_origin=CoordOrigin.TOPLEFT),
            ),
        )
    return document


class DoclingPartitioningTests(unittest.TestCase):
    def test_two_partitions_produce_globally_unique_ids_and_merge_cleanly(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = make_multi_page_pdf(directory, pages=4)
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            context = {
                "document_id": f"sha256:{digest}", "content_sha256": digest,
                "preprocess_id": "partition-test", "source_name": source.name,
                "created_at": "2026-09-14T00:00:00+00:00",
            }

            def convert(path, **options):
                page_range = options.get("page_range", (1, 4))
                return SimpleNamespace(
                    status="success",
                    document=page_document(list(range(page_range[0], page_range[1] + 1))),
                    errors=[],
                )

            parser = DoclingParser(converter=SimpleNamespace(convert=convert))
            prepared_path, slices, owned_directory = parser.prepare(source, context)
            self.addCleanup(owned_directory.cleanup)
            self.assertEqual(slices, [])  # portrait pages: no column-split preparation

            first = parser.parse(
                source, context, page_range=(1, 2), ref_prefix="p0:",
                prepared=(prepared_path, slices),
            )
            second = parser.parse(
                source, context, page_range=(3, 4), ref_prefix="p1:",
                prepared=(prepared_path, slices),
            )

            first_block_ids = {b["block_id"] for b in first.parsed_document["content_stream"]}
            second_block_ids = {b["block_id"] for b in second.parsed_document["content_stream"]}
            self.assertTrue(first_block_ids, "fixture produced no blocks")
            self.assertEqual(first_block_ids & second_block_ids, set())

            merged, markdown = merge_fragments([
                {"parsed_document": first.parsed_document, "markdown": first.markdown},
                {"parsed_document": second.parsed_document, "markdown": second.markdown},
            ])

            self.assertEqual([p["page_number"] for p in merged["pages"]], [1, 2, 3, 4])
            all_block_ids = [b["block_id"] for b in merged["content_stream"]]
            self.assertEqual(len(all_block_ids), len(set(all_block_ids)))
            all_anchor_ids = [a["anchor_id"] for a in merged["evidence_index"]["anchors"]]
            self.assertEqual(len(all_anchor_ids), len(set(all_anchor_ids)))
            for anchor in merged["evidence_index"]["anchors"]:
                span = anchor["markdown_span"]
                self.assertLessEqual(span["end"], len(markdown.encode("utf-8")))
                self.assertEqual(
                    markdown.encode("utf-8")[span["start"]:span["end"]].decode("utf-8"),
                    next(b for b in merged["content_stream"] if b["block_id"] == anchor["block_id"])["text"],
                )


if __name__ == "__main__":
    unittest.main()
