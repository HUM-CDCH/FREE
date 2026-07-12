import hashlib
import os
import socket
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool as real_run_in_threadpool

from app.ingestion import url_fetch
from app.ingestion.url_fetch import (
    UnsafeUrlError,
    _open_prevalidated_url,
    download_file,
    validate_public_http_url,
)
from app.storage import paths

PDF_BYTES = b"%PDF-1.4\n% URL ingestion test\n"


class FakeHeaders:
    def __init__(self, content_type="application/pdf", content_length=None):
        self._content_type = content_type
        self._content_length = content_length

    def get_content_type(self):
        return self._content_type


class FakeResponse:
    def __init__(self, body, content_type="application/pdf", chunk_sizes=None):
        self._body = body
        self._index = 0
        self._chunk_sizes = list(chunk_sizes or [])
        self.headers = FakeHeaders(content_type=content_type)
        self.status = 200
        self._content_length = None

    def getheader(self, name):
        if name == "Content-Length":
            return self._content_length
        return None

    def read(self, size):
        if self._index >= len(self._body):
            return b""
        read_size = self._chunk_sizes.pop(0) if self._chunk_sizes else size
        chunk = self._body[self._index : self._index + read_size]
        self._index += len(chunk)
        return chunk

    def close(self):
        return None


class TestUrlValidation(unittest.TestCase):
    def _public_dns(self, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

    @patch("socket.getaddrinfo")
    def test_accepts_public_https_url(self, mock_dns):
        mock_dns.side_effect = self._public_dns
        self.assertEqual(
            validate_public_http_url("https://example.com/file.pdf"),
            "https://example.com/file.pdf",
        )

    def test_rejects_unsupported_schemes_and_internal_hosts(self):
        for url in [
            "file:///tmp/a.pdf",
            "ftp://example.com/a.pdf",
            "http://127.0.0.1/a.pdf",
            "http://169.254.169.254/a.pdf",
            "http://100.64.0.1/a.pdf",
            "https://user:pass@example.com/a.pdf",
            "https://example.com/" + "a" * 2048,
        ]:
            with self.subTest(url=url), self.assertRaises(UnsafeUrlError):
                validate_public_http_url(url)

    @patch("socket.create_connection")
    @patch("socket.getaddrinfo")
    def test_rejects_dns_rebinding_before_connect(self, mock_dns, mock_connect):
        mock_dns.side_effect = [
            self._public_dns(),
            [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    6,
                    "",
                    ("169.254.169.254", 443),
                )
            ],
        ]

        with self.assertRaises(UnsafeUrlError):
            _open_prevalidated_url("https://example.com/file.pdf", timeout=1)

        mock_connect.assert_not_called()

    @patch("app.ingestion.url_fetch._open_following_redirects")
    @patch("socket.getaddrinfo")
    def test_download_rejects_non_pdf_content(self, mock_dns, mock_open):
        mock_dns.side_effect = self._public_dns
        response = FakeResponse(b"not pdf", content_type="text/plain")
        mock_open.return_value = (Mock(), response, "https://example.com/file.pdf")
        with tempfile.TemporaryDirectory() as tmp_dir, self.assertRaises(ValueError):
            download_file(
                "https://example.com/file.pdf", os.path.join(tmp_dir, "file.pdf")
            )

    @patch("app.ingestion.url_fetch.time.monotonic")
    @patch("app.ingestion.url_fetch._open_following_redirects")
    @patch("socket.getaddrinfo")
    def test_download_enforces_total_deadline(
        self, mock_dns, mock_open, mock_monotonic
    ):
        mock_dns.side_effect = self._public_dns
        mock_monotonic.side_effect = [0, 0, 0, 0, 61]
        response = FakeResponse(b"%PDF-1.7\n%%EOF\n")
        mock_open.return_value = (Mock(), response, "https://example.com/file.pdf")

        with (
            tempfile.TemporaryDirectory() as tmp_dir,
            self.assertRaisesRegex(ValueError, "total time limit"),
        ):
            download_file(
                "https://example.com/file.pdf",
                os.path.join(tmp_dir, "file.pdf"),
                total_timeout=60,
            )

    @patch("app.ingestion.url_fetch.logger")
    @patch("app.ingestion.url_fetch._open_following_redirects")
    @patch("socket.getaddrinfo")
    def test_download_logs_only_the_source_host(self, mock_dns, mock_open, mock_logger):
        mock_dns.side_effect = self._public_dns
        body = b"%PDF-1.7\n%%EOF\n"
        response = FakeResponse(body)
        mock_open.return_value = (
            Mock(),
            response,
            "https://example.com/private/document.pdf",
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            download_file(
                "https://example.com/private/document.pdf?token=secret",
                os.path.join(tmp_dir, "private-task", "source.pdf"),
            )

        mock_logger.info.assert_called_once_with(
            "Downloading source document from host %s.",
            "example.com",
        )

    @patch("app.ingestion.url_fetch._open_following_redirects")
    @patch("socket.getaddrinfo")
    def test_download_accepts_fragmented_pdf_magic(self, mock_dns, mock_open):
        mock_dns.side_effect = self._public_dns
        body = b"%PDF-1.7\n%%EOF\n"
        response = FakeResponse(body, chunk_sizes=[2, 3, 1024])
        mock_open.return_value = (Mock(), response, "https://example.com/file.pdf")

        with tempfile.TemporaryDirectory() as tmp_dir:
            destination = os.path.join(tmp_dir, "file.pdf")
            download_file("https://example.com/file.pdf", destination)
            try:
                with open(destination, "rb") as output_file:
                    self.assertEqual(output_file.read(), body)
            except OSError as exc:
                self.fail(f"Could not read downloaded PDF fixture: {exc}")


class TestUrlIngestionOffload(unittest.IsolatedAsyncioTestCase):
    async def test_complete_post_download_publication_runs_off_event_loop(self):
        loop_thread = threading.get_ident()
        worker_threads: dict[str, int] = {}
        real_compute = url_fetch.compute_sha256
        real_store = url_fetch.store_source_by_hash
        real_deduplicate = url_fetch.deduplicate_task_source

        def fake_download(_source_url, destination):
            Path(destination).write_bytes(PDF_BYTES)

        def record_compute(source_path):
            worker_threads["hash"] = threading.get_ident()
            return real_compute(source_path)

        def record_store(*args, **kwargs):
            worker_threads["publication"] = threading.get_ident()
            return real_store(*args, **kwargs)

        def record_deduplicate(*args, **kwargs):
            worker_threads["deduplication"] = threading.get_ident()
            return real_deduplicate(*args, **kwargs)

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            task_dir = root / str(uuid.uuid4())
            task_dir.mkdir()
            pool = AsyncMock(wraps=real_run_in_threadpool)
            with (
                patch.object(paths, "DEFAULT_SOURCE_STORE_DIR", root / "sources"),
                patch.object(url_fetch, "download_file", side_effect=fake_download),
                patch.object(url_fetch, "compute_sha256", side_effect=record_compute),
                patch.object(
                    url_fetch, "store_source_by_hash", side_effect=record_store
                ),
                patch.object(
                    url_fetch,
                    "deduplicate_task_source",
                    side_effect=record_deduplicate,
                ),
                patch.object(url_fetch, "run_in_threadpool", pool),
            ):
                source_path, display_name, digest = await url_fetch.download_source(
                    "https://example.com/file.pdf", task_dir
                )

            self.assertEqual(source_path, task_dir / "source.pdf")
            self.assertEqual(display_name, "file.pdf")
            self.assertEqual(digest, hashlib.sha256(PDF_BYTES).hexdigest())
            self.assertEqual(pool.await_count, 2)
            self.assertIs(
                pool.await_args_list[1].args[0], url_fetch._publish_downloaded_source
            )
            self.assertEqual(
                set(worker_threads), {"hash", "publication", "deduplication"}
            )
            self.assertTrue(
                all(thread_id != loop_thread for thread_id in worker_threads.values())
            )

    async def test_publication_failure_releases_real_lease_off_event_loop(self):
        digest = hashlib.sha256(PDF_BYTES).hexdigest()
        loop_thread = threading.get_ident()
        worker_threads: dict[str, int] = {}
        lease_existed_before_failure = False
        real_release = url_fetch.release_source_lease

        def fake_download(_source_url, destination):
            Path(destination).write_bytes(PDF_BYTES)

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source_store = root / "sources"
            task_dir = root / str(uuid.uuid4())
            task_dir.mkdir()
            lease_path = source_store / ".leases" / f"{digest}.{task_dir.name}"

            def fail_deduplication(_task_source, _source_blob):
                nonlocal lease_existed_before_failure
                worker_threads["deduplication"] = threading.get_ident()
                lease_existed_before_failure = lease_path.is_file()
                raise ValueError("deduplication failed")

            def record_release(content_sha256, lease_id):
                worker_threads["cleanup"] = threading.get_ident()
                real_release(content_sha256, lease_id)

            with (
                patch.object(paths, "DEFAULT_SOURCE_STORE_DIR", source_store),
                patch.object(url_fetch, "download_file", side_effect=fake_download),
                patch.object(
                    url_fetch,
                    "deduplicate_task_source",
                    side_effect=fail_deduplication,
                ),
                patch.object(
                    url_fetch,
                    "release_source_lease",
                    side_effect=record_release,
                ),
                patch.object(
                    url_fetch,
                    "run_in_threadpool",
                    AsyncMock(wraps=real_run_in_threadpool),
                ),
                self.assertRaises(HTTPException) as raised,
            ):
                await url_fetch.download_source(
                    "https://example.com/file.pdf", task_dir
                )

            self.assertTrue(lease_existed_before_failure)
            self.assertFalse(lease_path.exists())

        self.assertEqual(raised.exception.status_code, 507)
        self.assertEqual(raised.exception.detail, "Could not store source PDF.")
        self.assertIsInstance(raised.exception.__cause__, ValueError)
        self.assertEqual(set(worker_threads), {"deduplication", "cleanup"})
        self.assertTrue(
            all(thread_id != loop_thread for thread_id in worker_threads.values())
        )

    async def test_hash_failure_escapes_without_releasing_lease(self):
        failure = OSError("hash read failed")

        def fake_download(_source_url, destination):
            Path(destination).write_bytes(PDF_BYTES)

        with tempfile.TemporaryDirectory() as tmp_dir:
            task_dir = Path(tmp_dir) / str(uuid.uuid4())
            task_dir.mkdir()
            with (
                patch.object(url_fetch, "download_file", side_effect=fake_download),
                patch.object(url_fetch, "compute_sha256", side_effect=failure),
                patch.object(url_fetch, "release_source_lease") as release,
                patch.object(
                    url_fetch,
                    "run_in_threadpool",
                    AsyncMock(wraps=real_run_in_threadpool),
                ),
                self.assertRaises(OSError) as raised,
            ):
                await url_fetch.download_source(
                    "https://example.com/file.pdf", task_dir
                )

        self.assertIs(raised.exception, failure)
        release.assert_not_called()


if __name__ == "__main__":
    unittest.main()
