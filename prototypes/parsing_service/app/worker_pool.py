"""Process-pool coordination for large-document partitioned parsing.

Each worker process lazily builds and keeps its own :class:`DoclingParser`
instance the same way :meth:`TaskManager.start` does today for the
single-worker path — just once per worker process rather than once per
service process. A loaded Docling converter holds native model state that is
not picklable, so a :class:`DoclingParser` can never itself cross a process
boundary; only plain, picklable data (paths, page ranges, the task context
mapping, and the partition's published ``parsed_document.v2`` fragment)
crosses it.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Mapping
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

from . import parallel_parsing
from .contracts import ParseResult
from .docling_parser import PARSER_NAME, DoclingParseError, DoclingParser, _PageGeometry, _validate_publication


logger = logging.getLogger(__name__)

_worker_parser: DoclingParser | None = None


def _worker_initializer() -> None:
    global _worker_parser
    _worker_parser = DoclingParser()
    logger.info("parallel_parse worker ready pid=%s", os.getpid())


def _convert_partition(
    prepared_path: Path,
    slices: list[tuple[_PageGeometry, float]],
    page_range: tuple[int, int],
    ref_prefix: str,
    context: dict[str, Any],
) -> dict[str, Any]:
    global _worker_parser
    if _worker_parser is None:
        # Falls back to per-call init when the pool has no initializer (e.g.
        # a test using a synchronous stand-in executor).
        _worker_parser = DoclingParser()
    start = time.monotonic()
    logger.info(
        "parallel_parse partition start pid=%s pages=%s-%s",
        os.getpid(),
        page_range[0],
        page_range[1],
    )
    result = _worker_parser.parse(
        prepared_path,
        context,
        page_range=page_range,
        ref_prefix=ref_prefix,
        prepared=(prepared_path, slices),
    )
    logger.info(
        "parallel_parse partition done pid=%s pages=%s-%s duration_s=%.1f",
        os.getpid(),
        page_range[0],
        page_range[1],
        time.monotonic() - start,
    )
    return {
        "parsed_document": result.parsed_document,
        "markdown": result.markdown,
        "stats": result.stats,
        "parser_runs": result.parser_runs,
        "warnings": result.warnings,
        "docling_version": result.docling_version,
    }


class PartitionWorkerPool:
    """A bounded worker-process pool for partition conversion, created once
    alongside the FastAPI lifespan and shut down with it."""

    def __init__(self, max_workers: int) -> None:
        if max_workers < 1:
            raise ValueError("max_workers must be at least 1")
        self._max_workers = max_workers
        self._executor = ProcessPoolExecutor(max_workers=max_workers, initializer=_worker_initializer)

    def convert_partitions(
        self,
        prepared_path: Path,
        slices: list[tuple[_PageGeometry, float]],
        partitions: list[tuple[int, int]],
        context: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Convert every partition concurrently, bounded by pool size, and
        return each partition's fragment in submission order. Raises (and
        cancels the remaining futures) if any partition fails, matching the
        existing single-call all-or-nothing failure behavior."""

        logger.info(
            "parallel_parse submitting partitions=%s pool_max_workers=%s",
            len(partitions),
            self._max_workers,
        )
        futures = [
            self._executor.submit(
                _convert_partition,
                prepared_path,
                slices,
                partition_range,
                f"p{index}:",
                context,
            )
            for index, partition_range in enumerate(partitions)
        ]
        try:
            return [future.result() for future in futures]
        finally:
            for future in futures:
                future.cancel()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)


def parse_large_document(
    parser: DoclingParser,
    pool: PartitionWorkerPool | None,
    source_path: Path,
    context: Mapping[str, Any],
    *,
    min_pages: int = parallel_parsing.DEFAULT_MIN_PAGES,
    target_partition_pages: int = parallel_parsing.DEFAULT_TARGET_PARTITION_PAGES,
    max_workers: int = parallel_parsing.DEFAULT_MAX_WORKERS,
    search_radius: int = parallel_parsing.DEFAULT_SPLIT_SEARCH_RADIUS,
) -> ParseResult:
    """Entry point used by the task worker in place of a direct
    ``parser.parse(...)`` call. Falls back to today's single-call path when
    no pool is configured, ``max_workers`` disables partitioning, or the
    document doesn't exceed ``min_pages`` once prepared.
    """

    if pool is None or max_workers < 2:
        return parser.parse(source_path, context)

    prepared_path, slices, directory = parser.prepare(source_path, context)
    try:
        page_count = len(slices) if slices else _prepared_page_count(prepared_path)
        try:
            is_risky = parallel_parsing.pymupdf_boundary_risk(prepared_path)
        except ImportError:
            # PyMuPDF isn't installed: skip the split-point avoidance layer.
            # Boundary-table stitching (and, failing that, the diagnostic
            # fallback) still catches a table split by an unavoidably naive
            # boundary, so partitioning stays correct without it.
            is_risky = None
        partitions = parallel_parsing.compute_partition_ranges(
            page_count,
            min_pages=min_pages,
            target_partition_pages=target_partition_pages,
            max_workers=max_workers,
            is_risky_boundary=is_risky,
            search_radius=search_radius,
        )
        if len(partitions) <= 1:
            return parser.parse(source_path, context, prepared=(prepared_path, slices))
        fragments = pool.convert_partitions(prepared_path, slices, partitions, dict(context))
    finally:
        directory.cleanup()

    merged_document, merged_markdown = parallel_parsing.merge_fragments(fragments)
    boundary_pages = [end for _, end in partitions[:-1]]
    merged_document = parallel_parsing.stitch_boundary_tables(merged_document, boundary_pages)
    merged_document = parallel_parsing.flag_boundary_text(merged_document, boundary_pages)
    _revalidate_merged_document(merged_document, merged_markdown)

    return ParseResult(
        parsed_document=merged_document,
        markdown=merged_markdown,
        stats=_aggregate_stats(fragments, merged_document, merged_markdown),
        parser_runs=tuple(merged_document["parser_runs"]),
        selected_parser=PARSER_NAME,
        warnings=tuple(merged_document["preprocessing"]["warnings"]),
        docling_version=fragments[0].get("docling_version"),
    )


def _prepared_page_count(prepared_path: Path) -> int:
    import pypdfium2 as pdfium

    with pdfium.PdfDocument(prepared_path) as pdf:
        return len(pdf)


def _revalidate_merged_document(document: dict[str, Any], markdown: str) -> None:
    pages = sorted(page["page_number"] for page in document["pages"])
    if not pages or pages != list(range(1, len(pages) + 1)):
        raise DoclingParseError(
            "v2_physical_page_mapping_unavailable",
            "Merged document does not cover physical pages 1..N contiguously",
        )
    _validate_publication(document, markdown)


def _aggregate_stats(
    fragments: list[dict[str, Any]],
    merged_document: dict[str, Any],
    merged_markdown: str,
) -> dict[str, dict[str, Any]]:
    return {
        PARSER_NAME: {
            "status": "success",
            "partition_count": len(fragments),
            "page_count": merged_document["page_count"],
            "content_block_count": len(merged_document["content_stream"]),
            "table_count": len(merged_document["tables"]),
            "table_cell_count": sum(len(table["cells"]) for table in merged_document["tables"]),
            "evidence_anchor_count": len(merged_document["evidence_index"]["anchors"]),
            "diagnostic_count": len(merged_document["diagnostics"]),
            "markdown_bytes": len(merged_markdown.encode("utf-8")),
        }
    }


__all__ = ["PartitionWorkerPool", "parse_large_document"]
