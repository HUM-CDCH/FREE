# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What FREE is

FREE is a document extraction and evaluation tool for **humanities researchers** (not "users"). Researchers annotate source documents, request schema suggestions from those annotations, approve an extraction schema, and validate the results. Every extracted value must be grounded in source evidence.

The target workflow has five phases: Document Ingestion → Annotation → Schema Suggestion → Extraction → Validation. See `docs/architecture-new.md` for the full sequence diagram and `docs/user_stories.md` for acceptance criteria per phase.

## Language

Use the terminology in `CONTEXT.md` precisely. Key terms:

| Use | Avoid |
|-----|-------|
| Humanities Researcher | user, analyst |
| Source Document | file, PDF, upload |
| Annotation | highlight, passage, selection |
| Schema Suggestion | recommendation, prediction |
| Extraction Schema | template, extraction target |
| Extraction Result | output, response |
| Review Decision | status, vote |
| Evidence | citation, source, provenance |

## Repository layout

```
docs/                   vision, architecture, user stories, evaluation notes
examples/               sample source documents
prototypes/
  parsing_service/      FastAPI server (Python, uv)
  studio/               React + Vite frontend (pnpm)
```

Each prototype is self-contained, but orchestrated using **pnpm workspaces**. You can run commands (`pnpm dev`, `pnpm test`, `pnpm build`) from the root directory.

## Backend (`prototypes/parsing_service`)

**Stack:** FastAPI · httpx · pypdfium2 · Pillow · pydantic-settings · Python 3.14+  
**Package manager:** uv

```bash
cd prototypes/parsing_service
uv run fastapi dev main.py        # dev server on :8000
uv run fastapi run main.py        # production
```

**Model dependency:** The backend proxies to a local NuExtract3 model endpoint. Start it with Docker Model Runner:

```bash
cd prototypes/parsing_service
docker compose up                 # provisions hf.co/numind/NuExtract3-GGUF:mmproj
```

Configuration is via environment variables prefixed `NUEXTRACT3_` (or a `.env` file):

| Variable | Default |
|----------|---------|
| `NUEXTRACT3_BASE_URL` | `http://127.0.0.1:12434/engines/v1` |
| `NUEXTRACT3_MODEL` | `hf.co/numind/NuExtract3-GGUF:mmproj` |
| `NUEXTRACT3_PDF_DPI` | `64` |

**Endpoints:**

- `POST /extract` — Upload a PDF or pass plain text + a JSON template; returns structured extraction results.
- `POST /generate-template` — Upload a PDF + optional annotations; returns an inferred extraction schema. This is the Phase 3 (Schema Suggestion) endpoint.
- `POST /markdown` — PDF → per-page Markdown via vision model.

All endpoints stream **JSON Lines** (`application/jsonl`). Each line is `{"event": "delta"|"done"|"error", "data": {...}}`. The terminal `done` event carries the final result. Clients that send `Accept: application/json` receive a buffered array instead.

**PDF handling:** PDFs are rasterised page-by-page with pypdfium2 at `pdf_dpi` (default 64) and sent to the model as base64 JPEG images. The model is vision-based, not text-extraction-based.

**Reasoning support:** `ThinkSplitter` handles both llama.cpp-style `reasoning_content` deltas and inline `<think>…</think>` blocks, routing them to separate `think` / `output` channels in delta events.

## Frontend (`prototypes/studio`)

**Stack:** React 19 · TypeScript · Vite · Tailwind CSS v4 · pdfjs-dist 6 · pnpm

```bash
cd prototypes/studio
pnpm install
pnpm dev          # dev server on :5173
pnpm build        # tsc + vite build
pnpm lint         # eslint
```

Set `VITE_API_BASE` to override the backend URL (default `http://127.0.0.1:8000`).

**Key architecture points:**

- The PDF viewer uses `pdfjs-dist`'s `PDFViewer` component with `AnnotationEditorType.HIGHLIGHT`. Only text-selection highlights are allowed; free rectangular highlights are blocked by intercepting `pointerdown` during capture phase.
- `pdf.js` has no public event for editor add/remove. `App.tsx` monkey-patches `uiManager.addEditor` / `removeEditor` to keep the annotation sidebar in sync.
- `api.ts` contains all backend communication. `requestTemplate` streams JSONL from `/generate-template` and calls an `onDelta` callback for incremental UI updates.
- `AnnotationSidebar` shows the current annotation set (highlighted passages + page numbers). `SchemaPanel` shows the generated schema and controls annotation mode (`hints` vs `fields`).
- The hardcoded source document is `src/assets/Beretning_Ellekilde_8_13.pdf` (a Danish archaeological site report).

**Annotation modes** (sent to `/generate-template`):
- `hints` — model designs schema from the whole document, but every highlighted passage must be covered.
- `fields` — model derives schema primarily from the highlighted passages.

## What the prototype does not yet have

The backend has no persistence layer. There are no `/annotations`, `/validations`, or `/documents/prepare` endpoints. Annotations are passed inline with each `/generate-template` request. Adding a thin in-memory store (or SQLite) with these three endpoints is the next backend task.
