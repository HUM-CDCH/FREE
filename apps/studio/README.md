# FREE Studio

FREE Studio is a React client with same-origin TypeScript API handlers under
`api/`. Vite serves it during development; the built production client and API
run from the Node host in `server/`.

## Commands

Run FREE from the repository root with `pnpm dev`, which serves Studio at
<https://localhost:8443/free>. This folder has `pnpm dev`, `pnpm test`,
`pnpm test:e2e`, `pnpm lint` and `pnpm build`. Its `pnpm dev` runs Vite alone
at `http://127.0.0.1:5173`. It needs PostgreSQL at startup (start it first with
`pnpm --filter db db:start`, which needs `DATABASE_URL` and `FREE_SESSION_SECRET`;
see [Database operations](../../docs/operations/local-development.md#database-operations))
and `FREE_ENTRA_MOCK_ISSUER` naming a running mock OIDC issuer, or the real
Entra values with `FREE_ENTRA_REAL=1`.
See [local development](../../docs/operations/local-development.md) for the rest.

## Source Documents

An upload is Studio's once it is admitted (`202 { workflowId }`). The Parsing
Service parses it; Studio translates the result into a strict
`parsed_document.v2` document and its canonical Markdown, kept as the Source
Representation. The Project page lists the upload as a Source Ingestion
(queued, parsing or failed) across reloads, tabs and Studio restarts until it
becomes a Source Document. A failure can be dismissed or uploaded again. Files
the browser has not sent yet are still only in the tab. A PDF the project
already holds returns its Source Document without a new parse.

The rail's **Evidence** tab is a developer view, shown only when
`VITE_SHOW_DEVELOPER_UI=true` (the root `pnpm dev` stack sets it; production
builds do not): the parsed document's text and table-cell Evidence by page.

Use **Reprocess** in a Source Document menu and select single pages or two-page
spreads. The Parsing Service parses the retained PDF again, and Studio publishes
the next Source Representation Revision once the complete canonical package is
retained. The request pins the expected current revision, so a concurrent
change returns a conflict. Reprocessing is a durable workflow: closing the
browser does not stop it, and repeating the request with the same request key
rejoins it or returns its published revision.

Existing Extractions, Review Decisions and Annotations keep their original
source revision. Opening the document without an Extraction selects its current
revision; opening a historical Extraction uses its original source. A new
Extraction runs only on the current revision: the historical view offers no
run, and the server refuses a superseded one with 409
`source_representation_superseded`. Runs started from a Schema Suggestion are
the one exception: they keep the revisions saved with the suggestion.

## Schema Suggestion and editing

Schema Suggestion cuts the source Markdown into gap-free windows of at most
48,000 characters and suggests a schema per window through the Schema
Suggestion Route. Only the windows get the researcher's instruction: read again
at the combining step, a document-scope exclusion ("exclude the bibliography")
also removes per-entry fields. Combining works level by level:
the union of one source's windows, and in a Batch Schema Suggestion the
intersection of the sources' suggestions. The DBOS patches
`schema-suggestion-windows` and `batch-schema-suggestion-windows` gate these
steps. Each step checkpoints the model's output, never the source text; a
failed one checkpoints a stable code and FREE's own message, never the
provider's error, body or headers. A suggestion too large to combine in one
request fails with `merge_input_too_large` rather than being left out; one
stopped for length fails with `model_output_truncated`. A Batch Schema
Suggestion keeps the first code only for its merge: a failed source fails it
with `source_suggestion_failed` (a missing key with `model_key_required`), and
a merge stopped for length with `unexpected_failure`. Ollama connections get
`truncate: false`, so an over-long prompt fails instead of being cut. Schema
editing proposals come from the Interaction Route and never change the pinned
Schema Revision.
