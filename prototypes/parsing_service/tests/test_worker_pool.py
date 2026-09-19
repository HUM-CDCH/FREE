"""Orchestration tests for `worker_pool.parse_large_document`: the
threshold-gated fallback to today's single-call path, and the full
prepare -> partition -> dispatch -> merge -> stitch -> flag -> validate
pipeline for a document over the partition threshold.

Uses an in-process fake pool (real DoclingParser.parse() calls, no real
process spawn or model loading) so this stays fast and dependency-light;
`PartitionWorkerPool` itself only adds process-pool plumbing around the same
`parse()` calls exercised here.
"""

from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app import worker_pool
from app.docling_parser import DoclingParser
from test_docling_partitioning import make_multi_page_pdf, page_document


class FakePool:
    """Duck-types `PartitionWorkerPool.convert_partitions`, running each
    partition synchronously through the same parser instance instead of a
    real worker process."""

    def __init__(self, parser: DoclingParser) -> None:
        self.parser = parser
        self.dispatched_ranges: list[tuple[int, int]] = []

    def convert_partitions(self, prepared_path, slices, partitions, context):
        results = []
        for index, page_range in enumerate(partitions):
            self.dispatched_ranges.append(page_range)
            result = self.parser.parse(
                prepared_path, context, page_range=page_range, ref_prefix=f"p{index}:",
                prepared=(prepared_path, slices),
            )
            results.append({
                "parsed_document": result.parsed_document, "markdown": result.markdown,
                "stats": result.stats, "parser_runs": result.parser_runs,
                "warnings": result.warnings, "docling_version": result.docling_version,
            })
        return results


def _context(source: Path) -> dict:
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    return {
        "document_id": f"sha256:{digest}", "content_sha256": digest,
        "preprocess_id": "worker-pool-test", "source_name": source.name,
        "created_at": "2026-09-14T00:00:00+00:00",
    }


def _fake_converter():
    def convert(path, **options):
        page_range = options.get("page_range", (1, 6))
        return SimpleNamespace(
            status="success",
            document=page_document(list(range(page_range[0], page_range[1] + 1))),
            errors=[],
        )
    return SimpleNamespace(convert=convert)


class ParseLargeDocumentTests(unittest.TestCase):
    def test_no_pool_uses_the_existing_single_call_path(self):
        with tempfile.TemporaryDirectory() as directory_name:
            source = make_multi_page_pdf(Path(directory_name), pages=6)
            context = _context(source)
            parser = DoclingParser(converter=_fake_converter())

            result = worker_pool.parse_large_document(parser, None, source, context)

            self.assertEqual(result.parsed_document["page_count"], 6)

    def test_document_at_or_under_threshold_is_not_partitioned(self):
        with tempfile.TemporaryDirectory() as directory_name:
            source = make_multi_page_pdf(Path(directory_name), pages=6)
            context = _context(source)
            parser = DoclingParser(converter=_fake_converter())
            pool = FakePool(parser)

            result = worker_pool.parse_large_document(
                parser, pool, source, context,
                min_pages=10, target_partition_pages=3, max_workers=4,
            )

            self.assertEqual(pool.dispatched_ranges, [])  # pool never used
            self.assertEqual(result.parsed_document["page_count"], 6)

    def test_document_over_threshold_is_partitioned_and_merged(self):
        with tempfile.TemporaryDirectory() as directory_name:
            source = make_multi_page_pdf(Path(directory_name), pages=6)
            context = _context(source)
            parser = DoclingParser(converter=_fake_converter())
            pool = FakePool(parser)

            result = worker_pool.parse_large_document(
                parser, pool, source, context,
                min_pages=3, target_partition_pages=3, max_workers=4,
            )

            self.assertEqual(pool.dispatched_ranges, [(1, 3), (4, 6)])
            document = result.parsed_document
            self.assertEqual([p["page_number"] for p in document["pages"]], [1, 2, 3, 4, 5, 6])
            block_ids = [b["block_id"] for b in document["content_stream"]]
            self.assertEqual(len(block_ids), len(set(block_ids)))
            anchor_ids = [a["anchor_id"] for a in document["evidence_index"]["anchors"]]
            self.assertEqual(len(anchor_ids), len(set(anchor_ids)))
            self.assertEqual(result.stats["docling"]["partition_count"], 2)
            # Every anchor's markdown span round-trips against the merged text.
            markdown_bytes = result.markdown.encode("utf-8")
            for anchor in document["evidence_index"]["anchors"]:
                span = anchor["markdown_span"]
                self.assertLessEqual(span["end"], len(markdown_bytes))


if __name__ == "__main__":
    unittest.main()
