# FREE product and safety contract

The normative contract for authentication, persistence, deployment, database
lifecycle and verification. The [README](../README.md) is the short
getting-started guide; the [deployment](operations/deployment.md) and
[local development](operations/local-development.md) runbooks cover running
FREE.

FREE lets an authenticated humanities researcher turn source documents into
structured, evidence-grounded extraction results and review them.

## Product contract

FREE's normative product and safety contract is:

1. **Authenticated ownership.** Every Project Context, source document,
   schema, extraction, evidence link, and review decision belongs to an
   authenticated Researcher Account. Reads and writes are scoped to that
   researcher. Static assets, health endpoints, and the OIDC
   login/callback/signed-out endpoints may be public.
2. **Real authentication paths.** Local development uses an isolated mock OIDC
   provider through the same authorization-code, session, and ownership path
   used with Microsoft Entra. Production uses a single-tenant Entra
   registration; the local mock cannot be enabled there.
3. **Schema-guided extraction.** A researcher creates a Project Context,
   ingests PDFs, defines and approves an extraction schema, and runs the
   canonical extraction path over the Project Context's source documents.
   Schema suggestion feeds this path; it is not a competing extraction mode.
4. **Evidence and review.** Every populated extraction value is paired with
   locatable source evidence or visibly marked ungrounded. Evidence doubts (the
   value is not found in the linked passage, or it also appears in other
   passages) are hints for the reviewer, not decisions: FREE derives no
   confidence score from them, and only a researcher's decision approves a
   value. Approve, reject and typed edit decisions are revisioned corrections
   of stable saved values, saved in numbered Project decision versions; a
   concurrent write reports a conflict instead of overwriting a newer
   decision. Review is finalized only by an explicit action on one named
   result snapshot and decision version, never by saving a correction, and
   finalizing never freezes the Extraction.
5. **Durable, versioned state.** Project Contexts, source documents and their
   representation revisions, schema revisions, extractions, and review decisions
   survive ordinary restarts. One Extraction record carries a run from admission
   to its outcome and on to its reviews; it stays pinned to the
   source-representation and schema revisions it used, and to the extraction
   method it was admitted with (its Extraction Model Choice and Extraction
   Method Settings), so newer revisions can make it stale without rewriting its
   history. Work in progress survives too: the durable coordination head
   ([ADR 0017](adr/0017-durable-extraction-control-and-call-checkpoints.md)) owns
   an Extraction's lifecycle, saved values and control intent, while DBOS
   workflows dispatch linked attempts, retain call checkpoints and recover
   unfinished work after a restart. Other background workflow status is
   derived from DBOS.
6. **Project lifecycle.** A researcher can create, list, rename, and
   permanently delete a Project Context. Deletion removes its owned database
   graph and removes filesystem artifacts only when no remaining Project
   Context references them.
7. **Model-provider surface.** Each Researcher Account owns its model
   configuration, stored in PostgreSQL: its Model Connections, the Assistant
   model (the Interaction Route) and the Schema Suggestion Route, the Extraction
   Model Choice and the Ingestion Model Choice. It also holds the account's
   Extraction Method Settings: per Extraction Strategy, how future Extractions
   run (the Model Configuration page's Advanced tab). Unset settings keep the
   Parsing Service's defaults; saved settings never edit an Extraction Schema
   and never hold a key. A Project Context uses its owner's configuration. The
   Model Configuration page supports Ollama, OpenAI, Anthropic, Google, vLLM
   and OpenAI-compatible connections. A researcher's API keys stay in their
   own browser; Studio holds a copy only in memory while it needs one, and
   never in PostgreSQL, on disk, in logs or in workflow history. The
   deployment's own model servers are read-only deployment connections that
   every researcher can use: its vLLM servers with the GPU overlay, and the
   Codex CLI and Claude Code providers when the operator enables them with
   `FREE_DEPLOYMENT_CLI_PROVIDERS`; those run on the server's own CLI login. An
   unset Assistant model runs on the deployment's instruction model, and an
   unset Schema Suggestion Route follows the Assistant model. The Ingestion
   Model Choice picks the Parsing Service's OCR and layout models for new
   ingestions and reprocessing only; existing revisions never change.
   Extraction execution is delegated to the included Parsing Service; FREE
   uses the configured provider directly for Schema Suggestion and Interaction.
   Their output format needs no setting: FREE uses the adapter's output
   support, falls back to prompt-only generation only after an explicit
   unsupported-format response, keeps that route prompt-only until Studio
   restarts, and still validates what returns. The configuration is validated
   whenever it is saved, so there is no reset.
8. **Safe startup.** Authored forward migrations finish before Studio becomes
   ready, both for a fresh database and an already-migrated one. Studio's
   entrypoint then creates the Parsing Service's restricted database role and
   schema, and each process migrates its own DBOS system schema (`dbos`,
   `kei_dbos`) when it launches. Normal startup never resets the database or
   seeds an account, Project Context, provider, route, or credential.
9. **Proxy parity.** Production runs behind the host-managed nginx or the
   bundled nginx container; local uses containerized nginx. All render the
   same version-controlled proxy fragment for `/free` routing, forwarded
   headers, auth callbacks, security headers, upload limits, and timeouts.
10. **Secrets and destructive limits.** Deployment secrets — the session
    secret, database passwords, the Entra certificate, a CLI login — enter
    through the environment or mounted files, never committed files.
    Researchers' model keys never reach the server's storage, and FREE needs no
    operating-system secret store. Forward migration replay may target the
    configured deployment database. Reset is limited to `postgres` on loopback
    port 5432 database `free`. Disposable PostgreSQL checks are limited to
    `postgres` on loopback port 5432 databases named `free_test_*`. Production
    is never reset.

Out of scope: backward compatibility with historical API shapes, competing
deployment paths, and speculative extensibility.

## Safety boundaries

- Production nginx is the host-managed nginx or, with `FREE_NGINX=container`,
  the bundled nginx container (`compose.nginx.yaml`). Both render their
  fragment from the same template local nginx consumes.
- `packages/db` enforces the reset and disposable-test target restrictions
  before opening an administrative connection.
- Session cookies are signed; API writes are origin-checked; uploads are
  validated (`application/pdf`, magic bytes, 100 MiB cap).

## Verification

`pnpm test` is the fast tier: it needs no running stack, PostgreSQL, browser
or model. A tier that mutates data touches only disposable targets: the
guarded `free_test_*` databases, or a stack it creates and removes itself.
GitHub's `verify` workflow runs `pnpm test:ci` on pull requests into and
pushes to `main` with `FREE_SKIP_PYTHON=1`, because the Parsing Service's CUDA PyTorch
wheels do not fit the hosted runner. CI therefore skips the Parsing Service
tiers, `test:service` and the Python-backed durable lifecycle and recovery
checks, which full-host verification (`pnpm test:all`) must run;
`test:live-model` and `test:system` stay outside both. The
[local development runbook](operations/local-development.md#verification)
lists every tier with its prerequisites.

## Extraction execution

Every Extraction is durable
([ADR 0017](adr/0017-durable-extraction-control-and-call-checkpoints.md)):
there is one execution, review and export path. Admission commits the
Extraction row, its durable coordination head and its workflow enqueue in one
transaction, or none of them. The Parsing Service's worker runs each attempt
(`extractDurableV1`) on the Extraction's current pinned input selection and
calls only the deployment's extraction models; Model Connections, Capability
Routes and researchers' keys never reach it. An Extraction has no overall
deadline; each chat model call times out after waiting `KEI_EXTRACT_TIMEOUT`
seconds for its reply, or for the next piece of a streamed discovery reply.

Admission pins the method the start view showed
([ADR 0015](adr/0015-extraction-method-pinned-at-admission.md)). It starts
nothing and answers 409 for a method the account has changed since
(`method_changed`), a Schema Revision with no Record Scope
(`record_scope_required`), or a strategy that contradicts it
(`record_scope_mismatch`). A repeated request replays what it admitted; the
same identity with a different request is a conflict. The Parsing Service
refuses a document-scope result that is not exactly one record.

Pause drains admitted calls and saves their output before the Extraction
becomes Paused; Stop is terminal and keeps saved values and corrections; Retry
continues a failed Extraction with its saved work. Revised inputs are saved as
a separate selection and adopted only at a drained boundary. A Resume
requested while the Extraction is pausing runs once it has drained, unless a
later edit cancels it.

A researcher's active edits can guide the Project's later admitted calls other
than record-boundary discovery, wherever their field keeps its meaning, with
optional Evidence from the correction's own source. An incompatible correction
stays saved but never enters the consuming target's context, and FREE
classifies no guidance conflicts automatically. Each Batch Extraction member
is its own Extraction, with its own result snapshots and finalized reviews;
it stays openable and exportable when paused, failed or stopped, and there is
no batch-wide review grid.

## Pipeline reference

The Parsing Service's
[pipeline map](../apps/parsing_service/docs/extraction-experiments.md#pipeline-map)
traces how an Extraction runs and lists every model call purpose; the
[Studio README](../apps/studio/README.md#schema-suggestion-and-editing) covers
Schema Suggestion and editing.
Neither model keys nor document content enter Studio's workflow inputs.

Schemas pass different validation boundaries, not equivalent validators:
[`parseSchemaDefinition`](../packages/extraction/src/schema.ts) accepts an
editable TypeScript tree (including zero fields); batch suggestions
additionally use `parseBatchSuggestionDefinition` to forbid repeated sibling
field names. At execution, Python
[`Schema`](../apps/parsing_service/src/kei_exp/kie/extract/schema.py) requires
at least one field and unique sibling names and builds strict call schemas;
[`durableValueSchema`](../packages/extraction/src/durable-contract.ts)
validates each saved value and its producer Evidence. Historical Schema
Revisions remain pinned, readable research records, not retroactively
revalidated or rewritten to match a later executable-input rule.
