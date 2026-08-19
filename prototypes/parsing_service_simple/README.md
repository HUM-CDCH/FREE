# Simple parsing service

This is the small Docling-backed replacement design for FREE's parsing boundary.
It lives beside the existing prototype so the two implementations can be
evaluated independently while presenting the same HTTP and package contract to
Studio.

The implementation has four main modules:

- `app.main` exposes the existing FastAPI routes.
- `app.tasks` owns the bounded FIFO queue and persisted task lifecycle.
- `app.storage` owns atomic task files and deterministic package publication.
- `app.docling_parser` owns one reusable `DocumentConverter` and publishes the
  canonical `parsed_document.v2` document and Markdown.

There is one in-process worker and at most two admitted tasks. Task metadata and
completed artifacts survive restarts; work interrupted by a restart is marked
failed instead of being recovered through a second durable queue. Cancellation
is cooperative because Docling conversion is a blocking native call: a running
conversion finishes in its worker thread, but its result is discarded.

## Run

```powershell
cd prototypes/parsing_service_simple
uv sync
uv run --no-sync python -X utf8 -m fastapi run main.py --host 127.0.0.1 --port 8000
```

The service stores processor-cache data in `data/` by default. Run exactly one
Uvicorn/FastAPI process; the queue and converter intentionally live in that
process.

## Test

```powershell
cd prototypes/parsing_service_simple
uv run --no-sync python -m unittest discover -s tests
```

Contract tests inject a lightweight parser at the same seam used by the Docling
adapter, so they do not download models.

The parser design follows Docling's official documentation for its
[architecture](https://docling-project.github.io/docling/concepts/architecture/),
[document model](https://docling-project.github.io/docling/concepts/docling_document/),
and [serialization](https://docling-project.github.io/docling/concepts/serialization/).
