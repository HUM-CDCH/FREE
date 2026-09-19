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

## Large-document parallel parsing (opt-in)

A single large PDF can be converted as several independent page-range
partitions, run concurrently across a bounded pool of worker *processes*,
then merged back into one `parsed_document.v2` document. This parallelizes
the work behind *one* task — it does not change the one-worker, two-task
admission model above. It is off by default and controlled by env vars:

- `PARALLEL_PARSE_MIN_PAGES` — a document partitions only once its prepared
  page count exceeds this. Defaults high enough that partitioning never
  triggers until an operator explicitly lowers it.
- `PARALLEL_PARSE_MAX_WORKERS` — bounds the worker-process pool. Each worker
  process loads its own copy of Docling's layout/OCR/table models (and
  competes for GPU memory when `DOCLING_DEVICE` uses a GPU), so memory and
  GPU usage scale with this value — size it deliberately, not just for
  parallelism.
- `PARALLEL_PARSE_TARGET_PARTITION_PAGES` — target page count per partition.
- `PARALLEL_PARSE_SPLIT_SEARCH_RADIUS` — how many pages a partition boundary
  may shift to avoid landing inside a detected table.

A table or paragraph that ends up split across a partition boundary anyway
is either stitched back into one logical table (when the geometry lines up)
or published as two separate items with a diagnostic marking the boundary —
never silently dropped or guessed at. See the `parallelize-large-document-parsing`
OpenSpec change for the full design and rationale.

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
The service defaults to Docling's `DOCLING_DEVICE=auto`: CUDA when available,
otherwise another supported accelerator or CPU. Both launchers probe Docker
GPU access with `ubuntu:24.04 nvidia-smi -L` (pulling that small image on first
use), then add `compose.gpu.yaml` only if the probe succeeds. Without GPU
access the stack starts on CPU. Set `DOCLING_DEVICE=cpu` to skip the probe,
or `cuda` to require GPU access. Direct Compose invocations need
`-f compose.gpu.yaml` to expose GPUs. Follow the production
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
