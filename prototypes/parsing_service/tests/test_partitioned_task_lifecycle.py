"""End-to-end task-lifecycle coverage for the partitioned parsing path,
through the same HTTP surface `test_task_lifecycle.py` exercises for the
single-call path. Uses an in-process fake pool (see `FakePool` in
`test_worker_pool.py`) so this stays fast and independent of real Docling
models or process spawn — `PartitionWorkerPool` itself only adds process-pool
plumbing around the same `DoclingParser.parse()` calls exercised here and in
`test_worker_pool.py`.
"""

from __future__ import annotations

import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
import unittest

from fastapi.testclient import TestClient

from app.docling_parser import DoclingParser
from app.main import create_app
from support import submit_pdf, wait_for_status
from test_docling_partitioning import make_multi_page_pdf, page_document


class FakePool:
    """Runs each partition synchronously, in-process, through the same
    `DoclingParser.parse()` used by the real worker-process pool — no real
    subprocess or model loading."""

    def __init__(self, parser: DoclingParser) -> None:
        self.parser = parser
        self.dispatched_ranges: list[tuple[int, int]] = []
        self.block_until = threading.Event()
        self.blocking = False

    def convert_partitions(self, prepared_path, slices, partitions, context):
        if self.blocking:
            self.block_until.wait(timeout=10)
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

    def shutdown(self) -> None:
        pass


def _fake_converter():
    def convert(path, **options):
        page_range = options.get("page_range", (1, 6))
        return SimpleNamespace(
            status="success",
            document=page_document(list(range(page_range[0], page_range[1] + 1))),
            errors=[],
        )
    return SimpleNamespace(convert=convert)


class PartitionedTaskLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_root = Path(self.temporary.name)
        self.pdf_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.pdf_directory.cleanup)
        self.large_pdf = make_multi_page_pdf(Path(self.pdf_directory.name), pages=6).read_bytes()

    def test_task_over_threshold_completes_with_a_merged_document(self) -> None:
        parser = DoclingParser(converter=_fake_converter())
        pool = FakePool(parser)
        app = create_app(
            parser=parser,
            data_root=self.data_root,
            pool=pool,
            parallel_min_pages=3,
            parallel_target_partition_pages=3,
            parallel_max_workers=2,
        )
        with TestClient(app) as client:
            response = submit_pdf(client, filename="large.pdf", pdf=self.large_pdf)
            self.assertEqual(response.status_code, 202, response.text)
            task_id = response.json()["task_id"]

            status = wait_for_status(client, task_id, "completed")
            self.assertEqual(status["selected_parser"], "docling")
            self.assertEqual(pool.dispatched_ranges, [(1, 3), (4, 6)])

            document = client.get(f"/tasks/{task_id}/document").json()
            self.assertEqual([p["page_number"] for p in document["pages"]], [1, 2, 3, 4, 5, 6])
            block_ids = [b["block_id"] for b in document["content_stream"]]
            self.assertEqual(len(block_ids), len(set(block_ids)))

    def test_cancelling_a_partitioned_task_in_flight_discards_its_output(self) -> None:
        parser = DoclingParser(converter=_fake_converter())
        pool = FakePool(parser)
        pool.blocking = True
        self.addCleanup(pool.block_until.set)
        app = create_app(
            parser=parser,
            data_root=self.data_root,
            pool=pool,
            parallel_min_pages=3,
            parallel_target_partition_pages=3,
            parallel_max_workers=2,
        )
        with TestClient(app) as client:
            response = submit_pdf(client, filename="large.pdf", pdf=self.large_pdf)
            task_id = response.json()["task_id"]
            wait_for_status(client, task_id, "running")

            cancel = client.post(f"/tasks/{task_id}/cancel")
            self.assertEqual(cancel.status_code, 200, cancel.text)
            self.assertEqual(cancel.json()["status"], "cancelling")

            pool.block_until.set()
            status = wait_for_status(client, task_id, "cancelled")
            self.assertIsNone(status["error"])

            document_response = client.get(f"/tasks/{task_id}/document")
            self.assertEqual(document_response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
