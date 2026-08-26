# Parsing Service agent guidance

Read the repository `AGENTS.md` first. This file records the Parsing Service
boundaries that are easy to violate while changing its small implementation.

- The service owns PDF validation and parsing only. It publishes
  `parsed_document.v2`, canonical Markdown, and one deterministic canonical
  ingestion package; model extraction belongs to Studio.
- Run exactly one FastAPI/Uvicorn process. The bounded FIFO queue and reusable
  Docling converter are intentionally in-process.
- Treat `data/` and the container's parsing volumes as processor caches. Studio
  retains the canonical package before publishing durable Project Store state.
- Keep task identifiers UUID-validated and resolve task files only through
  `TaskStorage.task_dir`.
- Cancellation is cooperative around Docling's blocking conversion. A cancelled
  conversion may finish in its worker thread, but its result must not publish.
- Preserve the parser injection seam used by contract tests; tests must not
  download Docling models.

Run backend work from this directory with the selected `uv` environment:

```bash
uv sync
uv run --no-sync python -m unittest discover -s tests
```
