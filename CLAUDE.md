# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

- Do not preserve backward compatibility. Remove obsolete paths instead of
  adding compatibility layers, fallbacks, or migrations.

- Choose the simplest implementation that fully meets the current
  requirements. Avoid speculative abstractions, configuration, and
  indirection.

- Grow the system in layers. Start from the smallest version that works
  end to end, and add each new capability on top of a product that already
  works. Never trade a working product for unfinished complexity.

- Keep components modular and concerns clearly separated.

- Prefer established, well-maintained libraries when they reduce overall
  complexity or improve reliability. Do not reimplement common
  functionality without a clear reason.

- Lean on the dependencies already in the project before writing your own
  implementation or adding packages. Do not assume a library lacks a
  capability without checking its documentation and types.

- Make architectural decisions for the long term. Do not accept a stopgap
  that only works for now and is meant to be replaced later.

## What FREE is

FREE is a document extraction and evaluation tool for **humanities researchers** (not "users"). Researchers annotate source documents, request schema suggestions from those annotations, approve an extraction schema, and validate the results. Every extracted value must be grounded in source evidence.

The workflow has five phases: Document Ingestion → Annotation → Schema Suggestion → Extraction → Validation. `CONTEXT.md` defines the domain language; `docs/architecture/` holds the LikeC4 model of the implemented runtime (`pnpm architecture:dev`); `docs/parsing-service.md` and `docs/parsing-quality.md` define the implemented parsing boundary.

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

## Persistence boundaries

FREE persists Project Context and Source Document research state in PostgreSQL
through `packages/db`. Every Article run stores one terminal Extraction against
pinned Source Representation and Schema Revisions before the server responds.
Explicit review later atomically stores that Extraction's Review Decisions.

Each Source Representation owns a portable canonical ingestion package in the
operating system's `FREE Studio` data directory. PostgreSQL stores its
content-addressed package reference; Parsing Service task storage is only a
processor cache and is never a durable Source Representation dependency.

Model configuration remains separate: non-secret Model Connections and
Capability Routes live in `model-config.json` in the OS user config directory
for `FREE Studio`, while FREE-managed credentials use the OS credential store.

Studio keeps writes narrow: the persistent rail creates, renames, and
permanently deletes a Project Context through `/api/project-contexts`,
researcher schema edits append immutable Schema Revisions through
`/api/schema-revisions`, Article operations append terminal Extractions, and
explicit review stores Review Decisions. A Batch Extraction is opened through
`/api/batch-extractions` before it runs: it pins one Schema Revision, one
Extraction Strategy, and each selected Source Document's Current Source
Representation Revision as its members, then every member's Extraction is
appended to it one at a time. Members are stored up front so a batch's progress
is counted from what is persisted, never from what the browser expects.
Deleting a Project Context deletes its whole owned relational
graph through the database cascade, then removes the canonical packages no
remaining Source Representation references. That cascade is a PostgreSQL
behaviour, so it is proven against PostgreSQL:
`PROJECT_STORE_POSTGRES_URL=<a disposable free_test_* database> pnpm --filter db
test:postgres`, which fails rather than skips when the database is missing.
Package cleanup quarantines each candidate and rechecks its reference before
unlinking it, so a concurrent content-addressed publish is restored instead of
leaving PostgreSQL pointed at a missing package. The current package writer,
`pnpm db:seed`, also reasserts the already-downloaded package after inserting its
reference; it never re-runs ingestion for this cleanup handshake.
Annotations are still passed inline with each `/api/generate_schema` request;
seeded and accepted research state reopens through `ProjectStore`.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `HUM-CDCH/FREE`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-label triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
