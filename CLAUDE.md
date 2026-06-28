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

Each prototype is self-contained, but orchestrated using **pnpm workspaces**. Prefer root commands for normal work:

```bash
pnpm install   # installs JS deps and runs uv sync for Python services
pnpm start     # alias for pnpm dev
pnpm dev       # backend + frontend
pnpm test
pnpm build
```

Python services opt into root install with an `install:python` script; the root `postinstall` discovers them with `pnpm --recursive --if-present install:python`.

## Backend (`prototypes/parsing_service`)

**Stack:** FastAPI · httpx · pypdfium2 · Pillow · pydantic-settings · Python 3.13+  
**Package manager:** uv

```bash
cd prototypes/parsing_service
uv sync
uv run python -X utf8 -m fastapi dev main.py --host 127.0.0.1 --port 8000
uv run fastapi run main.py        # production
```

The package script `pnpm --filter parsing-service dev` is the preferred dev entry point. It uses Python UTF-8 mode for Windows and binds the backend to `http://127.0.0.1:8000`, which is what the studio frontend expects.

**Endpoints:**

- `GET /status` — Health and environment status for the parsing service.
- `POST /tasks` — Start source document parsing and return a task id.
- `GET /tasks/{task_id}` — Poll parsing status.
- `GET /tasks/{task_id}/markdown` — Fetch parsed Markdown for a completed task.
- `GET /tasks/{task_id}/report` and `GET /tasks/{task_id}/download` — Fetch parsing reports and generated artifacts.

The parsing service does not own model extraction endpoints. Studio serves model
routes from same-origin `/api`.

`GET /` serves a small local prototype control page for nontechnical testing of
the parsing service. It is not the researcher-facing FREE interface; Studio
remains the product UI for humanities researchers.

## Frontend (`prototypes/studio`)

**Stack:** React 19 · TypeScript · Vite · Tailwind CSS v4 · pdfjs-dist 6 · pnpm

```bash
cd prototypes/studio
pnpm install
pnpm dev          # dev server on :5173
pnpm build        # tsc + vite build
pnpm lint         # eslint
```

Studio model endpoints are served from same-origin `/api`. Set `VITE_PARSING_SERVICE_URL`
to override the parsing service URL (default `http://127.0.0.1:8000`).

VS Code tasks and launches should call pnpm workspace scripts from the repository root. Keep backend debug launch direct through `debugpy`, but keep dev tasks on `pnpm --filter ...` so package scripts remain the source of truth.

**Key architecture points:**

- The PDF viewer uses `pdfjs-dist`'s `PDFViewer` component with `AnnotationEditorType.HIGHLIGHT`. Only text-selection highlights are allowed; free rectangular highlights are blocked by intercepting `pointerdown` during capture phase.
- `pdf.js` has no public event for editor add/remove. `App.tsx` monkey-patches `uiManager.addEditor` / `removeEditor` to keep the annotation sidebar in sync.
- `api.ts` contains browser communication with Studio model routes and the parsing service. Model routes are `/api/chat`, `/api/generate_schema`, and `/api/extract`; parsing routes stay under `VITE_PARSING_SERVICE_URL`.
- `AnnotationSidebar` shows the current annotation set (highlighted passages + page numbers). `SchemaPanel` shows the generated schema and controls annotation mode (`hints` vs `fields`).
- The hardcoded source document is `examples/Beretning_Ellekilde_8_13.pdf` (a Danish archaeological site report).

**Annotation modes** (sent to `/api/generate_schema`):
- `hints` — model designs schema from the whole document, but every highlighted passage must be covered.
- `fields` — model derives schema primarily from the highlighted passages.

## NuExtract prompting (raw prompts to Ollama)

NuExtract3 is driven with a **hand-built raw prompt**, not OpenAI-style
`chat_template_kwargs`. Historical control-channel evidence archived under
`openspec/changes/archive/2026-06-17-select-nuextract-control-channel/`
found the **Ollama** OpenAI-compatible endpoint silently ignores
`chat_template_kwargs` (`mode`, `template`, `enable_thinking`) — kwargs-only
requests come back as plain text. So `prototypes/studio/api/_model.ts` posts to Ollama's
`/api/generate` with `raw: true` and reconstructs the NuExtract control tokens
itself (`【task】`, `【template_start】`, `【document_start】…【document_end】`, trailing
`<think>` block), mirroring `nuextract.template.jinja`. Consequences when editing
schema/extraction prompts:

- **No `【instructions】` slot outside `structured` mode** (jinja only emits it for
  extraction). `template-generation` and `markdown` carry all guidance inline in
  the message body, so schema-suggestion guidance must *lead* the document parts —
  it's just message text, not a privileged slot.
- **Thinking is `structured`/`content` only.** The jinja forbids `enable_thinking`
  for `template-generation`/`markdown`; those always render the empty
  `<think></think>` (non-thinking) prompt.
- **Temperature:** NuExtract recommends `0.2` non-thinking / `0.6` thinking. We send
  `0.2` by default (`NON_THINKING_TEMPERATURE`); leaving it unset lets Ollama apply
  ~0.8, which produced noisy, instance-enumerated templates.

Docker Model Runner and vLLM *do* honor `chat_template_kwargs` — see the probe doc
for the per-provider channel if NuExtract is ever served that way.

## What the prototype does not yet have

FREE has no persistence layer. There are no `/annotations`, `/validations`, or
`/documents/prepare` endpoints. Annotations are passed inline with each
`/api/generate_schema` request. Adding a thin in-memory store (or SQLite) with
these three endpoints is the next backend task.
