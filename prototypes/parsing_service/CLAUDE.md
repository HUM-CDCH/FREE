# Parsing service

Package manager: **uv**. See `pyproject.toml` for the dependency set and `package.json` for the scripts.

## Running it

```bash
uv sync --extra ocr-cpu  # use ocr-gpu instead on CUDA hosts
```

`pnpm --filter parsing-service dev` is the preferred dev entry point. Runtime scripts use `uv run --no-sync`, which preserves whichever **mutually exclusive** CPU/GPU OCR profile was explicitly installed — a bare `uv run` would resolve the other one back in. The dev script uses Python UTF-8 mode for Windows and binds to `http://127.0.0.1:8000`, which is what the studio frontend expects.

## Contracts that are not visible from the route signatures

- Task source PDFs are stored internally as `source.pdf`, copied into a SHA-256 content-addressed source store, and exposed with only a sanitized display filename in metadata.
- Task route IDs must be UUIDs.
- `GET /tasks/{task_id}/document` and `GET /tasks/{task_id}/source` both return the versioned `ParsedDocument` JSON, carrying parser provenance, page markers, and the exact offsets extraction depends on.
- The parsing service does **not** own model extraction endpoints. Studio serves model routes from same-origin `/api`.
- `GET /` serves a small local prototype control page for nontechnical testing. It is not the researcher-facing FREE interface; Studio remains the product UI for humanities researchers.
