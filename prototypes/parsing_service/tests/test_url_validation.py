import os
import socket
import tempfile
import unittest
from unittest.mock import Mock, patch

from app.ingestion.url_fetch import (
    UnsafeUrlError,
    _open_prevalidated_url,
    download_file,
    validate_public_http_url,
)


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


if __name__ == "__main__":
    unittest.main()
