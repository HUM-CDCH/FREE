## Context

The browser currently loads the PDF, invokes value extraction, invokes grounding, and sends the resulting values, Evidence links, attribution, and review decisions to `ProjectStore` only when the researcher accepts. The canonical resolution instead makes one server operation authoritative from pinned inputs through terminal persistence, while preserving the existing tolerant generated-output parser and strict `parsed_document.v2` Evidence identity.

The active prototype is a Vite-served React application with TypeScript API modules, `ProjectStore` over Prisma Postgres, a generated `contract.prisma`, and provider-neutral model routing. This slice must replace obsolete Article paths directly and must not add Catalog execution.

## Goals / Non-Goals

**Goals:**

- Persist every Article run as one append-only terminal attempt before its HTTP response.
- Make UUID identity safe for concurrent identical requests, mismatched reuse, cancellation, and restart replay.
- Keep result, canonical grounding, route attribution, diagnostics, review finalization, and reopen pins server-owned.
- Enforce terminal outcome shapes and pin ownership in PostgreSQL and at TypeScript boundaries.
- Keep the browser responsible only for creating an operation UUID, presenting the returned attempt, cancelling, and finalizing review.

**Non-Goals:**

- Catalog execution, chunking, merge policy, Catalog UI, or a shared strategy abstraction.
- Retry orchestration, compatibility endpoints, feature flags, migrations preserving prototype Extraction rows, or mutable attempt repair.
- Replacing the tolerant model-output parser with strict schema rejection.

## Decisions

### One Article orchestrator owns the lifecycle

`POST /api/extractions` resolves an Article operation from `{ id, sourceRepresentationRevisionId, schemaRevisionId, strategy: "ARTICLE" }`. One server module loads the pinned schema and canonical package, resolves the saved capability route once, performs the whole-source value call, grounds populated paths, and persists `COMPLETED`, `FAILED`, or `CANCELLED` before returning.

The existing model gateway, schema helpers, canonical grounding algorithm, and `ProjectStore` are reused. Grounding and anchored-document construction move to `shared/` so the server is not coupled to browser modules. No general extraction-strategy framework is introduced.

### Operation UUID is the idempotency key

A process-local map holds `{ identity, AbortController, promise }` for active operations. An identical concurrent request receives the same promise. Reuse with different pins or strategy returns `409`. After an operation leaves the map, the server checks PostgreSQL first and replays the stored terminal DTO or returns `409` for a mismatch. Persistence handles an insert race by re-reading the unique ID and applying the same identity comparison.

`DELETE /api/extractions/:id` aborts only an active matching operation. No durable running row exists, so an unknown or already-terminal ID returns `404` and does not mutate PostgreSQL. Once terminal persistence begins, cancellation is ignored until the write completes.

### Terminal rows are append-only; review is the only later mutation

The Extraction row stores strategy, outcome, completeness, failure, result, Evidence links, route attribution, bounded diagnostics, pins, retry parent, timestamps, and nullable `reviewedAt`; raw model output is removed. `SUCCEEDED` requires result, Evidence links, attribution, and completeness. `FAILED` and `CANCELLED` forbid result and Evidence links. PostgreSQL checks enforce these shapes and JSON container types. A composite self-reference keeps a retry on the same Source Representation Revision, Schema Revision, and strategy, and a check forbids self-parenting.

Review finalization accepts only decisions for the stored Extraction ID. It re-derives populated content paths from the immutable stored result and pinned schema, requires exact Evidence-path and referenced-anchor coverage, validates occurrence ownership against the pinned canonical package, then claims one append-only review gate in the transaction before inserting decisions and setting `reviewedAt`. A concurrent loser compares the stored normalized decision digest: the same decisions replay successfully and different decisions return `409`.

### Grounding completeness derives from the result

Every populated scalar path is document-derived and requires a canonical Evidence link. Reviewability is computed by the server from exact path coverage; the browser cannot claim it. Grounding uses only published `parsed_document.v2` anchors and exact Evidence Anchor labels, never text matching.

### Truncation is durable, incomplete output

Raw NuExtract sends Ollama `num_ctx: 32768` and `num_predict: 8192`. Provider metadata is retained through the model gateway. `done_reason: "length"`, failed grounding units, or grounding issues mark a usable result `complete: false`; any usable object recovered by the existing tolerant parser remains visible and groundable. Unusable output produces a terminal failure. One resolved route attribution is stored separately from bounded per-call grounding-batch diagnostics; neither diagnostics nor attribution stores prompts, credentials, or raw output. Codex has no native output-cap requirement in this slice.

### Reopen selects two independent attempts

Source Document reopen returns `latestAttempt` ordered by `createdAt DESC, id DESC` and `latestReviewed` ordered by `reviewedAt DESC, createdAt DESC, id DESC`, across the document's Source Representation Revisions. Each DTO carries its own schema and source-representation pins and resource descriptor. A newer unreviewed attempt therefore cannot retarget the latest reviewed Extraction.

## Risks / Trade-offs

- [Process-local cancellation does not cross server processes] → The prototype runs one Vite API process; PostgreSQL remains the durable idempotency backstop after restart.
- [Provider abort can race terminal persistence] → Check the signal between phases, then stop honoring cancellation when the terminal transaction starts.
- [Prototype schema replacement is destructive] → Generate the direct replacement migration and exercise it only against disposable databases; do not reset the research database.
- [A tolerant truncated result can be incomplete] → Persist `complete: false`, show it for inspection, and make reviewability depend on actual canonical grounding coverage.

## Migration Plan

1. Replace the generated contract and create a destructive prototype migration that drops obsolete Extraction data and constraints before installing the new shape.
2. Validate that migration on a disposable PostgreSQL database only.
3. Replace the old reviewed-extraction API and browser orchestration in the same change, so no compatibility period exists.
4. If rollout fails, revert the uncommitted code and disposable database; the existing research database is not touched during this work.

## Open Questions

None. Slice boundaries and lifecycle semantics are settled by the canonical Wayfinder resolution.
