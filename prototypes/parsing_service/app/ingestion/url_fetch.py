"""Safe fetching of remote source documents (SSRF-guarded HTTP download)."""

from __future__ import annotations

import http.client
import ipaddress
import os
import socket
import ssl
import tempfile
import time
import urllib.parse
from contextlib import suppress
from pathlib import Path

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool

from app.ingestion.validation import (
    ALLOWED_PDF_CONTENT_TYPES,
    PDF_MAGIC,
    assert_pdf_file,
)
from app.storage.blobs import (
    deduplicate_task_source,
    release_source_lease,
    store_source_by_hash,
)
from app.storage.hashing import compute_sha256
from app.storage.paths import SOURCE_FILENAME, safe_display_filename

DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
MAX_REDIRECTS = 5


class UnsafeUrlError(ValueError):
    pass


def public_url_ref(url: str | None) -> str | None:
    """Return a public-safe URL reference with query/fragment stripped."""
    if not url:
        return None
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _is_forbidden_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return ip.is_multicast or not ip.is_global


def _port_for(parsed: urllib.parse.ParseResult) -> int:
    if parsed.port is not None:
        return parsed.port
    return 443 if parsed.scheme == "https" else 80


def _request_target(parsed: urllib.parse.ParseResult) -> str:
    path = parsed.path or "/"
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, connect_ip: str, timeout: float):
        super().__init__(host, port=port, timeout=timeout)
        self._connect_ip = connect_ip

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._connect_ip, self.port),
            self.timeout,
            getattr(self, "source_address", None),
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, connect_ip: str, timeout: float):
        ssl_context = ssl.create_default_context()
        super().__init__(host, port=port, timeout=timeout, context=ssl_context)
        self._connect_ip = connect_ip
        self._ssl_context = ssl_context

    def connect(self) -> None:
        raw_sock = socket.create_connection(
            (self._connect_ip, self.port),
            self.timeout,
            getattr(self, "source_address", None),
        )
        self.sock = self._ssl_context.wrap_socket(raw_sock, server_hostname=self.host)


def validate_public_http_url(url: str) -> str:
    if len(url) > 2048:
        raise UnsafeUrlError("URL exceeds the maximum supported length.")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise UnsafeUrlError("Only http and https URLs are supported.")
    if not parsed.hostname:
        raise UnsafeUrlError("URL must include a hostname.")
    if parsed.username or parsed.password:
        raise UnsafeUrlError("URL credentials are not allowed.")

    host = parsed.hostname
    try:
        if _is_forbidden_ip(host):
            raise UnsafeUrlError("URL host resolves to a private or internal address.")
    except ValueError:
        pass

    _validated_connection_ip(host, _port_for(parsed))
    return url


def _validated_connection_ip(host: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"Could not resolve URL host: {host}") from exc

    public_ips: list[str] = []
    for info in infos:
        resolved_ip = str(info[4][0])
        if _is_forbidden_ip(resolved_ip):
            raise UnsafeUrlError("URL host resolves to a private or internal address.")
        public_ips.append(resolved_ip)
    if not public_ips:
        raise UnsafeUrlError(f"Could not resolve URL host: {host}")
    return public_ips[0]


def _open_prevalidated_url(
    url: str, timeout: float
) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse, str]:
    """Open a URL using the same prevalidated IP for the actual socket.

    This prevents DNS rebinding between validation and connection, and avoids
    environment proxy settings bypassing the storage service's SSRF policy.
    """
    validate_public_http_url(url)
    parsed = urllib.parse.urlparse(url)
    assert parsed.hostname is not None
    port = _port_for(parsed)
    connect_ip = _validated_connection_ip(parsed.hostname, port)
    connection: http.client.HTTPConnection
    if parsed.scheme == "https":
        connection = _PinnedHTTPSConnection(parsed.hostname, port, connect_ip, timeout)
    else:
        connection = _PinnedHTTPConnection(parsed.hostname, port, connect_ip, timeout)
    connection.request(
        "GET",
        _request_target(parsed),
        headers={
            "User-Agent": "FREE parsing-service/1.0",
            "Accept": "application/pdf,*/*;q=0.8",
        },
    )
    return connection, connection.getresponse(), url


def _remaining_time(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError("Remote PDF download exceeded the total time limit.")
    return remaining


def _open_following_redirects(
    url: str, timeout: float, *, deadline: float | None = None
) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse, str]:
    current_url = url
    for _ in range(MAX_REDIRECTS + 1):
        connect_timeout = timeout
        if deadline is not None:
            connect_timeout = max(0.001, min(timeout, _remaining_time(deadline)))
        connection, response, opened_url = _open_prevalidated_url(
            current_url, connect_timeout
        )
        if response.status not in {301, 302, 303, 307, 308}:
            return connection, response, opened_url
        location = response.getheader("Location")
        response.close()
        connection.close()
        if not location:
            raise ValueError("Remote URL redirected without a Location header.")
        current_url = urllib.parse.urljoin(current_url, location)
        validate_public_http_url(current_url)
    raise ValueError("Remote URL redirected too many times.")


def download_file(
    url: str,
    dest_path: str,
    timeout: int = 30,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
    total_timeout: int = 60,
):
    """Safely stream a public HTTP(S) PDF to dest_path via atomic move."""
    if total_timeout <= 0:
        raise ValueError("total_timeout must be greater than zero.")
    deadline = time.monotonic() + total_timeout
    validate_public_http_url(url)
    _remaining_time(deadline)
    safe_url = public_url_ref(url) or url
    print(f"Downloading {safe_url} to {dest_path}...")

    dest = Path(dest_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{dest.name}.", suffix=".tmp", dir=str(dest.parent)
    )
    total = 0
    magic_prefix = b""
    connection: http.client.HTTPConnection | None = None
    response: http.client.HTTPResponse | None = None
    try:
        with os.fdopen(fd, "wb") as out_file:
            connection, response, _ = _open_following_redirects(
                url, timeout, deadline=deadline
            )
            _remaining_time(deadline)
            if response.status >= 400:
                raise ValueError(f"Remote URL returned HTTP {response.status}.")

            content_type = response.headers.get_content_type()
            if content_type and content_type.lower() not in ALLOWED_PDF_CONTENT_TYPES:
                raise ValueError(
                    f"Remote URL did not return PDF content: {content_type}"
                )

            content_length = response.getheader("Content-Length")
            if content_length and int(content_length) > max_bytes:
                raise ValueError("Remote PDF exceeds the maximum allowed size.")

            while True:
                remaining = _remaining_time(deadline)
                socket_handle = getattr(connection, "sock", None)
                if socket_handle is not None:
                    socket_handle.settimeout(max(0.001, min(timeout, remaining)))
                chunk = response.read(64 * 1024)
                _remaining_time(deadline)
                if not chunk:
                    break
                if len(magic_prefix) < len(PDF_MAGIC):
                    needed = len(PDF_MAGIC) - len(magic_prefix)
                    magic_prefix += chunk[:needed]
                    if (
                        len(magic_prefix) == len(PDF_MAGIC)
                        and magic_prefix != PDF_MAGIC
                    ):
                        raise ValueError("Remote URL did not return a PDF document.")
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("Remote PDF exceeds the maximum allowed size.")
                out_file.write(chunk)

            if magic_prefix != PDF_MAGIC:
                raise ValueError("Remote URL did not return a PDF document.")

        assert_pdf_file(tmp_name)
        os.replace(tmp_name, dest)
    except Exception:
        with suppress(FileNotFoundError, PermissionError):
            os.unlink(tmp_name)
        raise
    finally:
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()


def source_display_name_from_url(source_url: str) -> str:
    parsed = urllib.parse.urlparse(source_url)
    name = Path(urllib.parse.unquote(parsed.path)).name
    return safe_display_filename(
        name if name.lower().endswith(".pdf") else "source.pdf"
    )


async def download_source(source_url: str, task_dir: Path) -> tuple[Path, str, str]:
    """Download a remote source PDF into the task dir and the source store."""
    source_path = task_dir / SOURCE_FILENAME
    try:
        await run_in_threadpool(download_file, source_url, str(source_path))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Failed to download the remote source document.",
        ) from exc
    content_sha256 = compute_sha256(source_path)
    try:
        source_blob = store_source_by_hash(
            source_path,
            content_sha256,
            lease_id=task_dir.name,
        )
        deduplicate_task_source(source_path, source_blob)
    except (OSError, ValueError) as exc:
        release_source_lease(content_sha256, task_dir.name)
        raise HTTPException(
            status_code=507,
            detail="Could not store source PDF.",
        ) from exc
    return source_path, source_display_name_from_url(source_url), content_sha256
