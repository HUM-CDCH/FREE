# Parsing service

The small Docling-backed service that owns FREE's parsing boundary: it turns an
uploaded PDF Source Document into one `parsed_document.v2` document, canonical
Markdown, and a deterministic canonical ingestion package for Studio.

The implementation has four main modules:

- `app.main` exposes the FastAPI routes.
- `app.tasks` owns the bounded FIFO queue and persisted task lifecycle.
- `app.storage` owns atomic task files and deterministic package publication.
- `app.docling_parser` owns one reusable `DocumentConverter` and publishes the
  canonical `parsed_document.v2` document and Markdown.

For image-only landscape spreads with four columns and three clear vertical
gutters, the adapter parses lossless column crops and maps every observation
back to its original PDF page and coordinates. Other layouts use Docling
directly. The uploaded PDF bytes remain unchanged, and the page/file limits
apply to that original PDF. Column order and original list numbers are preserved
in both canonical text and evidence spans.

There is one in-process worker and at most two admitted tasks. Task metadata and
completed artifacts survive restarts; work interrupted by a restart is marked
failed instead of being recovered through a second durable queue. Cancellation
is cooperative because Docling conversion is a blocking native call: a running
conversion finishes in its worker thread, but its result is discarded.

## Run

From the repository root:

```bash
pnpm --filter parsing-service dev
```

Or directly:

```powershell
cd prototypes/parsing_service
uv sync
uv run --no-sync python -X utf8 -m fastapi run main.py --host 127.0.0.1 --port 8055
```

The service stores processor-cache data in `data/` by default. Run exactly one
Uvicorn/FastAPI process; the queue and converter intentionally live in that
process.

## Run in Docker

The service is one of the three containers in the repository-root
`compose.yaml`:

```bash
docker compose up --build parsing_service
```

The image leaves Docling's layout and table models out of its layers. They are
downloaded into `HOME=/models` on the first conversion and kept in the
`parsing-models` volume; `/app/data` holds the task directory. Both are
processor caches, never a durable Source Representation dependency, so removing
either volume is safe.

The container runs a single Uvicorn process for the same reason the host command
does: the FIFO queue and the reusable `DocumentConverter` are in-process state.
The root Compose service defaults to `DOCLING_DEVICE=cpu` so the local stack
works without GPU passthrough. The production overlay selects
`DOCLING_DEVICE=cuda` and an all-GPU NVIDIA device reservation for DGX
Spark. Follow the production
[DGX Spark GPU procedure](../../docs/operations/deployment.md#nvidia-dgx-spark-gpu)
to verify host GPU access and ARM64/PyTorch kernel compatibility.

The first build is long and the image is large because `uv.lock` resolves the
CUDA build of torch: `uv sync --frozen` downloads the whole `nvidia-*` wheel set.

## Test

```powershell
cd prototypes/parsing_service
uv run --no-sync python -m unittest discover -s tests
```

Contract tests inject a lightweight parser at the same seam used by the Docling
adapter, so they do not download models.

The parser design follows Docling's official documentation for its
[architecture](https://docling-project.github.io/docling/concepts/architecture/),
[document model](https://docling-project.github.io/docling/concepts/docling_document/),
and [serialization](https://docling-project.github.io/docling/concepts/serialization/).
