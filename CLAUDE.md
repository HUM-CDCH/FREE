# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What FREE is

FREE is a document extraction and evaluation tool for **humanities researchers** (not "users"). Researchers annotate source documents, request schema suggestions from those annotations, approve an extraction schema, and validate the results. Every extracted value must be grounded in source evidence.

The target workflow has five phases: Document Ingestion → Annotation → Schema Suggestion → Extraction → Validation. See `docs/architecture-new.md` for the full sequence diagram and `docs/user_stories.md` for acceptance criteria per phase.

## Language

Use the terminology in `CONTEXT.md` precisely. Key terms:

| Use | Avoid |
| ----- | ------- |
| Humanities Researcher | user, analyst |
| Source Document | file, PDF, upload |
| Annotation | highlight, passage, selection |
| Schema Suggestion | recommendation, prediction |
| Extraction Schema | template, extraction target |
| Extraction Result | output, response |
| Review Decision | status, vote |
| Evidence | citation, source, provenance |

## Workspace

The prototypes under `prototypes/` are self-contained but orchestrated with **pnpm workspaces**. Prefer root commands (`pnpm dev`, `pnpm test`, `pnpm build`) for normal work; `pnpm start` is an alias for `pnpm dev`.

Python services opt into the root install with an `install:python` script; the root `postinstall` discovers them with `pnpm --recursive --if-present install:python`. So `pnpm install` at the root also runs `uv sync` for Python services.

VS Code tasks and launches should call pnpm workspace scripts from the repository root. Keep the backend debug launch direct through `debugpy`, but keep dev tasks on `pnpm --filter ...` so package scripts remain the source of truth.

Per-prototype guidance loads with the directory: `prototypes/parsing_service/CLAUDE.md` and `prototypes/studio/CLAUDE.md`.

## What the prototype does not yet have

FREE persists only model configuration: non-secret Model Connections and
Capability Routes as `model-config.json` in the OS user config directory for
`FREE Studio`, and FREE-managed credentials in the OS credential store.

Nothing else persists. There are no `/annotations`, `/validations`, or
`/documents/prepare` endpoints. Annotations are passed inline with each
`/api/generate_schema` request. Adding a thin in-memory store (or SQLite) with
these three endpoints is the next backend task.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `HUM-CDCH/FREE`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-label triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
