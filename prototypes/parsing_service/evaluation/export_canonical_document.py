"""Export one source document through the real parsing-service HTTP contract."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi.testclient import TestClient

from app.storage import paths
from app.workers import parse_worker
from main import app


@contextmanager
def isolated_storage() -> Iterator[None]:
    """Keep an evaluation run out of the developer's persistent document store."""
    with tempfile.TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
        root = Path(tmp_dir)
        original = (
            paths.DEFAULT_DATA_DIR,
            paths.DEFAULT_SOURCE_STORE_DIR,
            paths.DEFAULT_DOCUMENT_STORE_DIR,
            parse_worker.DEFAULT_DATA_DIR,
        )
        paths.DEFAULT_DATA_DIR = root / "tasks"
        paths.DEFAULT_SOURCE_STORE_DIR = root / "sources"
        paths.DEFAULT_DOCUMENT_STORE_DIR = root / "documents"
        parse_worker.DEFAULT_DATA_DIR = paths.DEFAULT_DATA_DIR
        try:
            yield
        finally:
            (
                paths.DEFAULT_DATA_DIR,
                paths.DEFAULT_SOURCE_STORE_DIR,
                paths.DEFAULT_DOCUMENT_STORE_DIR,
                parse_worker.DEFAULT_DATA_DIR,
            ) = original


def export_canonical_document(
    source: Path,
    markdown_output: Path,
    parsed_output: Path,
    *,
    timeout_seconds: float = 300,
) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Source document does not exist: {source}")

    with isolated_storage(), TestClient(app) as client:
        submitted = client.post(
            "/tasks",
            files={"file": (source.name, source.read_bytes(), "application/pdf")},
        )
        submitted.raise_for_status()
        task_id = submitted.json()["task_id"]

        deadline = time.monotonic() + timeout_seconds
        while True:
            status_response = client.get(f"/tasks/{task_id}")
            status_response.raise_for_status()
            status = status_response.json()
            if status["status"] == "completed":
                break
            if status["status"] == "failed":
                raise RuntimeError(
                    "Canonical parsing failed:\n"
                    + json.dumps(status, ensure_ascii=False, indent=2)
                )
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Canonical parsing did not complete within {timeout_seconds:g} seconds."
                )
            time.sleep(0.1)

        markdown = client.get(f"/tasks/{task_id}/markdown")
        markdown.raise_for_status()
        parsed = client.get(f"/tasks/{task_id}/parsed-document")
        parsed.raise_for_status()

    markdown_output.parent.mkdir(parents=True, exist_ok=True)
    parsed_output.parent.mkdir(parents=True, exist_ok=True)
    markdown_output.write_text(markdown.text, encoding="utf-8")
    parsed_output.write_text(
        json.dumps(parsed.json(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--markdown-output", type=Path, required=True)
    parser.add_argument("--parsed-output", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=300)
    args = parser.parse_args()
    export_canonical_document(
        args.source.resolve(),
        args.markdown_output.resolve(),
        args.parsed_output.resolve(),
        timeout_seconds=args.timeout_seconds,
    )


if __name__ == "__main__":
    main()
