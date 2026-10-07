# FREE on DBOS: durable jobs and AI execution

Status: **eighth revision, 2026-09-25; M1 done; M0R 1–4 passed 2026-09-26
(m0r,
ARM64);
M2–M6 in progress on `feat/dbos-m2-m6`.**
The eighth revision sizes kei's scheduling for the Spark (decision 14). While a
big book converts, a small document's ingestion and extraction must not wait
for it. kei's one queue becomes lanes that match its model servers: large and
small conversion, a two-slot extraction queue and a cleanup queue. Cleanup
safety moves from queue exclusion to a kei boot boundary. Measurements on the
Spark back the choice (rev-8 tests).
A per-page conversion fan-out and per-user fair sharing were reviewed and
deferred. The user settled the threshold and the variation, and moved parallel
Catalog chunks into M3.

The seventh revision folds the Model Configuration page redesign into M2
(user, 2026-09-25, decisions 12 and 13). The page follows the researcher's
work in three steps. The Single/Routes mode goes, and the NuExtract protocol is
derived instead of stored. A per-account Ingestion Model Choice picks kei's OCR
and layout models for new ingestions and reprocessing, wired through M3 and M4.
M1 is unchanged. The decision was made on a throwaway prototype kept on branch
`prototype/model-config-b1`.

The sixth revision bumps the pins to `@dbos-inc/dbos-sdk` 5.1.10,
`@dbos-inc/vercel-ai` 0.4.4 and `dbos` 3.1.0 after every review probe
reproduced on them (M0R 1, passed). It narrows the chat sanitizer to what
0.4.4 still records, uses `DBOS.stepStatus.cancelSignal` for cancellation of
Studio model calls, and splits M0R: only pre-implementation probes gate M2,
and checks that need FREE's own code are acceptance tests of M2, M4, M5 and M6.

The fifth revision applied the DBOS simplification review, PostgreSQL
experiments and Claude Code Opus 5.5 (`claude-opus-5-5`, medium) sparring
review. It replaced start-before-commit with transactional enqueue, merged
extraction admission and results, removed upload keys and selective
batch-suggestion retry, and required quiescence before deleting cancelled
history. The fourth revision's browser-held keys, per-researcher
configuration, all providers and reload recovery remain. Historical decisions
and M0 findings are retained below; the active design supersedes conflicting
historical advice. The provider half of M0R 5 is an M5 acceptance test.
Commands, scripts, results and review decisions are retained in
the evidence record.
The 2026-09-25 risk probes
validate the small corrections below; no new cross-tab synchronization is
required for tomorrow's build.
Supersedes `docs/plans/2026-09-24-procrastinate-source-ingestion.md` (not
implemented).

## Context

FREE runs three durable job mechanisms plus one non-durable long poll:

| Mechanism | Where | Verified problems |
|---|---|---|
| kei Procrastinate 3.9.0 (`convert_run`, `extract_run`) | Python, `parsing_db` | no cancel route; no idempotency; raw-SQL `doing→todo` recovery; status joins job rows |
| `ExtractionJob` lease worker | TS, Studio web process (`packages/extraction/src/job-worker.ts`) | a restart reruns from scratch and orphans kei work; cancel only stops polling; a 503 retry can admit a duplicate |
| `BatchSchemaSuggestion` pump | TS singleton (`api/_project_operations.ts`) | kicked by HTTP handlers, including GETs; never at boot |
| Source ingestion | thirty-minute polling POST (`api/source_documents.ts`) | request-owned; the key is checked only after a full parse, so a retry parses again |

Chat turns, single Schema Suggestions and schema edits are request-scoped and
store nothing on the server:
- chat history lives in React state (`src/ChatTab.tsx:40`);
- `generate_schema` returns a template, which the browser saves
  (`src/currentSchemaRevision.ts:417`);
- an edit proposal lives in `useSchemaProposalReview` state
  (`src/useSchemaProposalReview.ts:38`).

A reload loses all three.

Model configuration is one deployment-wide document. `model_config` and
`model_probe` are static API modules (`server/api-dispatcher.ts:43-48`) that
any signed-in researcher can call. So any researcher can re-point the routes
that every other researcher's documents are sent to.

## Decisions (user, 2026-09-24–25)

1. **DBOS in both apps.** The earlier rejections stand: a Procrastinate HTTP
   relay, a stateless kei, Hatchet/Temporal, Absurd, a hand-written scheduler.
2. **DBOS runs inside the Studio server process;** there is no `studio_worker`.
3. **App-owned system schemas on one PostgreSQL server:** Studio in `dbos`,
   kei in `kei_dbos`, both in database `free`. kei's role owns only its schema,
   because kei parses untrusted PDFs and must not be able to rewrite Studio's
   workflow inputs.
4. **Background and interactive model work run as DBOS workflows.** Chat
   turns, schema generation and schema edit proposals must survive a browser
   reload as well as a Studio restart; the reload matters more.
5. **Clean-slate cutover.** Nothing on the deployment host needs to survive. Reset the
   databases and research volumes once; add no data migration, compatibility
   readers or rollback import.
6. **Model configuration belongs to each Researcher Account; keys stay with
   the researcher.** Each researcher keeps their own connections, routes and
   Extraction Model Choice in PostgreSQL. A connection can be a hosted
   provider with the researcher's own key, or their own Ollama, vLLM or
   OpenAI-compatible server. The keys themselves stay in the researcher's
   browser, and Studio holds a copy only in memory while it needs one (user,
   2026-09-25). Operators still describe deployment connections in the
   environment, and every researcher can use them.
7. **All eight provider kinds stay; FREE will be open-sourced.** The Codex and
   Claude Code CLI providers serve power users who run FREE locally. They run
   on the server's own CLI login, so they become deployment connections that
   the operator enables.
8. **Live chat streaming stays.** DBOS owns stream replay and recovery.
9. **Manual batch-suggestion retry reruns every remaining source.** Completed
   source steps are reused only during recovery of the same attempt.
10. **Upload keys go.** Project/content identity handles completed replay;
    DBOS queue deduplication joins active work.
11. **Deleting a source preserves the batch proposal and draft as valid.**
    Remove the source from the selection without automatic regeneration.
12. **The Model Configuration page follows the researcher's work** (prototype
    variant B1). It has Models and Connections tabs. Models has three steps,
    reading documents, schema and chat, and extracting data, and names no
    service. The Interaction Route is labelled *Assistant model*, and Schema
    Suggestion follows it until given its own model: an unset Schema
    Suggestion Route inherits the Interaction Route. There is no Single/Routes
    mode. The NuExtract protocol is detected from the connection and model,
    never chosen.
13. **An Ingestion Model Choice picks kei's OCR and layout models.** It belongs
    to the Researcher Account, like the Extraction Model Choice, and applies to
    new ingestions and reprocessing only. Existing revisions never change.
14. **A big book must not hold up small work on the Spark.** While a book
    converts, the same or another researcher can ingest a small document and
    extract from it. kei's queues follow its model servers (*Queues*), and a
    book's OCR leaves room at the OCR server for a small document's requests.
    Pausing or preempting running work is not a goal. Two books do not share:
    the second waits. Concurrent uploads from one browser tab stay out of
    scope; another tab or researcher is not blocked.
15. **The document chat is deleted, not made durable (user, 2026-09-26).**
    `/api/chat` and `ChatTab` have had no UI since 44ce50b (2026-08-13); M5
    deletes them. The schema tab's generation (its instruction chat) and edit
    proposals ("Describe a change to the schema…") remain the durable
    interactive work. `ChatTurn`, `chatTurn`, the chat routes and
    `@dbos-inc/vercel-ai` are therefore not built, and decisions 4 and 8 apply
    to generation and edit proposals only. The chat items elsewhere in this
    plan are superseded; the M5 task plan
    lists each.

**Settled after the Spark tests (user, 2026-09-25).**
- **Small-document threshold: 30 pages** (`SMALL_DOCUMENT_PAGES`, *Queues*).
- **`SURYA_INFERENCE_PARALLEL` shipped ahead of DBOS.** `compose.gpu.yaml`
  derives it and `ocr_model`'s `--max-num-seqs` from one `OCR_MAX_NUM_SEQS`
  (default 4), and `tests/safety.test.mjs` asserts they match.
- **Output variation under concurrency is acceptable** (*Risks*). No setting
  removes it on these models: vLLM 0.29.1 refuses `VLLM_BATCH_INVARIANT` for
  their gated-delta-net layers (M0R 6).
- **Parallel Catalog chunks join M3** (*kei worker*). Running a Catalog's
  entries in four chunks was 4.1× faster and changes no prompt.

## Rules

- **DBOS is the execution authority:** scheduling, status, checkpoints,
  retries, timeouts, recovery and the temporary results of interactive work,
  such as an unreviewed edit proposal. FREE keeps outcomes with research
  meaning: Source Documents and revisions, Schema Revisions, Extractions,
  reviews, batch definitions and merged proposals, chat
  transcripts, and typed failures shown to researchers.
- **Status is derived, never mirrored.** A row records admission and its
  outcome; while it has no outcome, reads take its status from DBOS. A workflow
  cannot record its own cancellation (every DBOS call after a cancel throws),
  so the cancellation handler records the domain outcome before cancelling.
- **Workflow IDs identify attempts.** Reusing an existing ID returns the same
  execution while its history exists (M0 #1); individual steps are at-least-once
  after a crash. Row-backed replays compare stored inputs and return the stored
  outcome without re-enqueueing, even after DBOS retention. No-row operations
  compare recorded input/fingerprints while history exists. Conflicting reuse
  is 409. Ingestion instead uses completed content identity plus active dedup.
- **Domain writes are idempotent.** A stable identity or conditional terminal
  update protects every publication across the commit-to-checkpoint window.
  No new result row or revision is appended by replaying a completed write.
- **Ownership is checked in PostgreSQL.** Every start records
  `authenticatedUser` (the Researcher Account) and `workflowAttributes`
  (`projectContextId`, plus `sourceDocumentId`,
  `sourceRepresentationRevisionId` or `extractionSchemaId` where relevant).
  They let a read find a scope's workflows. Only a PostgreSQL ownership check
  authorizes a status, list, result, stream or cancel request; a workflow ID
  alone is not authorization.
- **Secrets never enter DBOS.** Workflow inputs carry connection IDs, never
  keys. A provider attempt reads the owner's key from Studio's memory only
  when it starts. DBOS records
  a step's thrown error with every enumerable property and cause
  (`serialize-error`; `ApiError.cause` is enumerable, `api/_http.ts:11`), so
  provider errors are replaced by sanitized ones inside the step boundary. For
  chat, that boundary belongs to `durableCalls`. In 0.4.4 a successful stream
  checkpoints no request body or response headers but still records provider
  metadata (version probe). So the sanitizer wraps the provider model inside
  `durableCalls`, maps its errors and strips its provider metadata.

> **Not built (decision 15, 2026-09-26):** the sentences from "For chat, that boundary belongs to `durableCalls`" to the end of the bullet describe the deleted document chat; generation and edit proposals sanitize inside their own steps.

- **A new mechanism must delete more than it adds.** No admission triggers,
  relays, reconcilers, publication fences, tombstones, credential revisions,
  cleanup-intent tables or deletion barriers.

Everything below uses features of the pins (`@dbos-inc/dbos-sdk` 5.1.10,
`@dbos-inc/vercel-ai` 0.4.4, `dbos` 3.1.0). The evidence probes re-verified
transactional enqueue, deduplication, cancellation, stream replay,
`cancelSignal` and worker concurrency on these pins on 2026-09-25:
- `enqueueInTransaction` on the domain transaction's `pg` connection;
- queue deduplication, with `return-existing` outside caller-owned transactions;
- `authenticatedUser` and `workflowAttributes` on start;
- `listWorkflows` filters on attributes (JSONB containment on an indexed
  column), status and ID prefixes, with sort, limit and loaded outputs;
- `readDurableStream` replay from offset 0 (`@dbos-inc/vercel-ai`);
- `cancelWorkflow(s)` and `deleteWorkflows`;
- `DBOS.stepStatus.cancelSignal` (5.1), which fires about 1 s after a cancel;
- scheduled workflows and `DBOS.patch()`;
- Python step `should_retry`;
- queue `worker_concurrency`.

> **Not built (decision 15, 2026-09-26):** `@dbos-inc/vercel-ai` and its `readDurableStream` served only the document chat, which M5 deleted; neither is installed or used.

## What this removes

| Removed | Replaced by |
|---|---|
| `job-worker.ts`; claim/renew/checkpoint (`postgres-persistence.ts:1075-1254`); wake wiring (`runtime.ts:43-71`); `_extraction_runtime.ts`; the development host's runtime loop | `runExtraction`, enqueued atomically with its Extraction row |
| The batch pump, its four `kick()` call sites (two are GETs), and the lease columns and methods (`packages/db/src/project-store.ts:2090-2291`) | `suggestSchemaBatch` on queue `suggest` |
| `src/kei_exp/jobs/` (1,380 lines) except `hold_slot`; Procrastinate, `parsing_db`, `parsing_migrate`; the kei tables; token JSONL and SSE; raw recovery SQL | kei DBOS workflows |
| kei HTTP submission and polling (`kei-exp.ts:253-327`, `source_documents.ts:274-387`) and their duplicated timeouts | `submitToKei` / `pollKei` steps; `workflowTimeoutMS` at kei |
| HEAD's reconciler; the later revisions' triggers, `enqueuePayload`, `StudioModelOperation`, tombstones, pins, cleanup intent, quiescence acknowledgement and barrier | transactional enqueue or workflow-first starts, derived status, reference garbage collection |
| `studio_worker` and its readiness checks | DBOS in the Studio process; a Studio client only for transactional enqueue |
| `ExtractionJob`, `BatchExtractionMember`, their joins and duplicate result fields | one Extraction row from admission through review |
| Ingestion keys, key-binding conflicts and follower workflows | project/content replay and active queue deduplication |
| Per-source suggestion statuses, definitions, failures and progress UI; selective retry | membership pins, DBOS step checkpoints and whole-batch retry |
| Worker `output.md` generation | canonical manifest/pages only; standalone CLI output stays |
| `_keyring.ts`, `ConfigFileSystem`, the reset path, the keyring packages, every server-side credential path, the in-process write barrier, the static `model_config` / `model_probe` modules, the one-CLI-connection-per-kind rule | per-researcher configuration in PostgreSQL; keys in the researcher's browser and in Studio's memory; CLI providers as deployment connections |
| Client-sent chat history and the fixed chat ID | `ChatTurn` rows |
| The page's Single/Routes mode (`configurationMode()`, `setSingleConnection`, `setSingleModel`, `setRouteModel`, `setNuextractProtocol`, the single-model editor); the stored NuExtract `protocol` and its checks; Studio's `KEI_EXP_MODEL`; kei's `/api/server` and `/api/layout-models` | one route setter; the protocol derived from connection and model ID; the per-account Ingestion Model Choice and one `GET /api/ingestion-models` listing |
| Targeted Catalog retry; extraction checkpoints and provisional UI; four tables nothing writes; the LLM inspector; ten kei routes with no production caller; legacy readers | nothing: dead today, or legacy after the reset (M1–M3) |

**What this adds.**
- One new domain table, `ChatTurn`, beside the per-researcher configuration
  table.
- An in-memory key cache.
- Six small routes: `GET` and `DELETE /api/model-operations`, `GET
  /api/chat/<revision ID>` with its `/stream`, `PUT /api/model-keys`, and
  `GET /api/ingestion-models`, which forwards kei's new listing of that name.

A transcript that survives a reload is research content, so it lives in FREE's
tables rather than in DBOS history, whose interactive retention target is 24 h.

## Target architecture

```text
db (postgres:17), database free
  public     domain rows and chat turns; per-researcher model configuration
             (no keys)
  dbos       Studio's DBOS system schema                    Studio role
  kei_dbos   kei's DBOS system schema                       kei role only

studio           web server and DBOS in one process: every Studio workflow and
                 schedule, plus clients for Studio admission and kei handoff.
                 The entrypoint
                 runs Prisma migrations and idempotent kei role/schema setup.
parsing_service  minimal read API (manifest, pages, artifacts, model catalog);
                 no database
parsing_worker   kei DBOS worker: convert on kei-convert-large/-small, extract
                 on kei-extract, deleteRuns on kei-gc; lifetime slot flock;
                 starts after Studio is healthy
volumes          source-inbox (new; studio rw, parsing_worker ro); parsing-runs,
                 studio-data and the CLI auth homes unchanged
```

`parsing_db`, the `parsing-postgres` volume and `parsing_migrate` go away.
`DBOS.launch()` migrates each system schema (the default), so no migration
service is added. `submitToKei` retries until kei has migrated `kei_dbos`.

## Workflows

| Workflow | ID | Admission | Output |
|---|---|---|---|
| `ingestSource` | `ingest:<projectContextId>:<attemptId>` | workflow-first on `studio`; active dedup by project/SHA-256 | Source Document and revision IDs, or a typed failure |
| `reprocessSource` | `reprocess:<sourceDocumentId>:<requestKey>` | workflow-first | revision ID, or a typed failure |
| `runExtraction` | `extract:<extractionId>` | same transaction as Extraction admission | outcome on the Extraction row |
| `suggestSchemaBatch` | `suggest:<batchId>:<attempt>` | same transaction as create/retry | merged proposal/draft, or a typed failure |
| `suggestSchema` | `suggestion:<operationId>` | workflow-first | `{template, raw, pages}`, or a typed failure |
| `proposeSchemaEdit` | `edit:<operationId>` | workflow-first | proposal and base revision, or a typed failure |
| `chatTurn` | `chat:<turnId>` | same transaction as the question; active dedup by source revision | answer/failure on the row; durable stream `ui` |
| `collectGarbage` | 10-minute schedule | — | — |
| kei `convert` | `kei-convert:<parent workflow ID>` | enqueued by `submitToKei` on the lane fixed at admission | manifest summary |
| kei `extract` | `kei-extract:<extractionId>` | enqueued by `submitToKei` on `kei-extract` | run/extraction IDs, artifact SHA-256, model attribution |
| kei `deleteRuns` | `kei-gc:<schedule time>` | enqueued by `collectGarbage` on `kei-gc` | deleted run/history IDs |

**Admission: one transaction.** Keep synchronous validation, ownership and
input-conflict checks. Row-backed operations insert/update domain rows and call
`DBOSClient.enqueueInTransaction` before committing on the same connection.
- **Binding.** Acquire a `pg` pool client; bind Prisma Next's public
  `postgres({contractJson, pg: client})` facade to it; use its transaction's ORM
  and pass that client to DBOS. Release it after commit/rollback without
  closing the shared pool. This was verified on Prisma Next 0.16 with DBOS
  5.0.2 and 5.1.10; no raw SQL enqueue function, datasource plugin or trigger is needed
  ([DBOS client reference](https://docs.dbos.dev/typescript/reference/client)).
- **Queues.** Extraction and chat use the unrestricted `studio` queue;
  suggestions use `suggest`. A batch's rows and all member enqueues commit
  together. Work cannot dequeue before commit. Rollback leaves neither row
  nor workflow; delete the admission wait and no-op outcome entirely.
- **Replays.** Read an existing row and compare its immutable request inputs.
  For concurrent first requests, insert the domain row before enqueue. A
  conflict on that operation's primary key rolls back, then reloads and
  applies the same comparison. Unrelated constraint errors are not replays.
  Extraction's uncertain-admission UI can keep reconciling by reading.
- **Chat exclusion.** Use deduplication ID
  `chat:<sourceRepresentationRevisionId>` with rejection policy. A different
  turn while one is active returns 409 and rolls back its question. The source
  revision is immutable, not a moving chat head. `return-existing` is not
  supported inside a caller-owned transaction in the pinned SDK.
- **No-row operations.** Ingestion, reprocess, generation and edit proposals
  use workflow-first admission. Ingestion uses nontransactional queue
  `return-existing`; it creates no follower or key-binding row.
- **Client IDs.** Keep client-minted Extraction, operation, turn and reprocess
  IDs. Unknown outcomes reuse the ID; a confirmed failure requires a new
  action/ID. Ingestion has no client key: each request either finds completed
  content, joins active work, or starts a server-minted attempt.

**Status and ownership.** Every read first checks, in PostgreSQL, that the
account owns the Project Context and that the named Source Document, Source
Representation Revision or Extraction Schema still exists. The workflow's
`authenticatedUser` and attributes locate the scope but never authorize it. A
deleted scope is therefore gone at once, even before garbage collection removes
its workflows.

An outcome on the row wins. Otherwise the DBOS status maps as follows:
- `ENQUEUED` or `DELAYED` → `QUEUED`;
- `PENDING` → `RUNNING`;
- `SUCCESS` → re-read the row (its outcome was just written); a surviving row
  still without an outcome is `FAILED/interrupted`, never perpetual running;
- `ERROR`, `CANCELLED`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, or no workflow left
  after retention → `FAILED` with code `interrupted`.

For workflow-first operations, the workflow's output is the outcome. Public
contracts keep their status fields, computed on read. List endpoints fetch
statuses in one `listWorkflows({workflowIDs})` call. A DBOS/store outage is
503 with retry semantics, not a fabricated missing workflow or failed result.

**Studio → kei handoff** (ingestion, reprocess, extraction):
- **`submitToKei`** enqueues the deterministic kei ID through the kei
  `DBOSClient`. It passes the queue, portable arguments, an explicit priority,
  `workflowTimeoutMS` and the parent's attributes. It is idempotent (M0 #1).
- **Conversion lane.** Admission counts the PDF's pages and records the lane
  in the workflow input, so recovery and replay keep it. At most
  `SMALL_DOCUMENT_PAGES` (30) pages go to `kei-convert-small`, and more go to
  `kei-convert-large`.
  - **Ingestion.** A count-only pdf.js helper reads `numPages` from the
    staged bytes and destroys the document, even when opening fails. It does
    not reuse `api/_pdf.ts`, which opens outside its error handling and
    renders every page (`_pdf.ts:71-78`).
  - **Unknown count.** A PDF that pdf.js cannot open goes to
    `kei-convert-large` rather than being rejected. kei's PDFium still
    decides readability, so the count adds no rejection path. Such a PDF
    loses the small-document promise.
  - **Reprocessing** reads the stored package page count, as
    `source_reprocess.ts:89` does today.
  - The count only picks the lane; kei's `prepare` still enforces the
    2000-page limit.
- **`pollKei`** waits in steps of at most 30 s (M0 #2). Recovery re-polls the
  same child. kei `CANCELLED`, `ERROR`, recovery exhaustion and `{ok: false}`
  become typed failures.
- **Unexpected parent failure.** A parent that fails unexpectedly after
  `submitToKei` cancels its kei child before rethrowing.
- **Contract.** Portable JSON `{ok: true, ...} | {ok: false, code, reason,
  retryable}` with ISO dates (M0 #11). Shared fixtures in
  `prototypes/parsing_service/tests/fixtures/contracts/` are checked by pytest
  and node:test. No PDF, page or artifact bytes enter workflow history.
- **Acceptance.** Studio's transaction is the acceptance boundary: lock the
  row, recheck ownership, the cancel outcome and the expected head, then
  commit. kei's fail-open post-conversion policy stays.

## Background work

**One Extraction row.** Remove `ExtractionJob` and `BatchExtractionMember`.
An admitted Extraction contains its input pins, requested models/recipe,
optional batch ID and nullable terminal outcome; result fields start empty.
- Pending Extraction rows are the batch's intended selection. Enforce
  `unique(batchExtractionId, sourceDocumentId)`, the composite source/revision
  FK, and the batch/schema/strategy FK. There is no job/member/result cycle.
- Completion updates that row; failure and cancellation use the same
  no-outcome predicate. Keep accepted evidence, diagnostics, attribution,
  review drafts and finalized reviews on their existing Extraction identity.
- Derive batch progress from surviving Extractions and their DBOS status.
  Pending rows are not reviewable results and must not displace the pinned
  latest-reviewed Extraction when reopening a document. Rerun creates a new
  batch; targeted member retry is removed.

**`runExtraction(extractionId)`** runs these steps:
1. load admitted input pins;
2. `submitToKei` on `kei-extract` with priority 1 (interactive) or 10
   (batch), and a dequeue-relative timeout of 10 min (Article) or 3 h
   (Catalog);
3. `pollKei`;
4. fetch and validate the artifact through the existing read API checks;
5. lock the Extraction and publish only if no outcome exists. Replay returns
   the accepted outcome instead of creating another result.

Typed failures use today's codes and the same conditional terminal update.
If deletion removed the row/source, exit without publication; a zero-row
update is a no-op and does not fail surviving batch members. Batch admission
uses deterministic member Extraction IDs and enqueues all members atomically.

**`suggestSchemaBatch(batchId, attempt)`** runs on queue `suggest` (global 1).
- Keep membership pins, the attempt number, merged proposal/draft, draft
  version and terminal outcome. Remove per-source execution statuses,
  definitions, failures and timestamps, their publication methods and UI.
- Admission snapshots all current member revision pins in sorted order into
  workflow input in the same transaction as enqueue. One named DBOS step per
  source generates/validates; one step merges; one conditional transaction
  publishes the final proposal and draft. Recovery reuses those checkpoints.
- All terminal writes require the current attempt and no terminal outcome.
  A step first checks whether its attempt was interrupted or its scope was
  deleted. No missing-source result can overwrite a preserved draft.
- Failures block merge, including `model_key_required`. An explicit retry
  resends browser keys, increments the attempt, clears its failure/outcome
  and enqueues a new workflow over **all surviving pins**. It is allowed only
  after a terminal attempt and before confirmation. It never reuses a prior
  attempt's source checkpoints. Retry carries `expectedAttempt`: under the
  row lock, advance it once; a replay finding exactly that successor returns
  it, and a later attempt is a conflict. This prevents an uncertain POST from
  launching another whole batch after the first retry has already finished.
  Existing confirmed schemas/batches remain immutable; another extraction run
  creates a new batch.
- Retain an existing draft while retry runs, but disable editing and Run until
  the attempt settles. A successful retry deliberately replaces the proposal
  and draft and increments draftVersion once; a failed/interrupted attempt
  preserves them. Run requires a valid draft, at least one surviving member
  and no active attempt, rather than requiring the latest attempt to have
  succeeded.
- Source deletion semantics are specified below. Selection identity and
  coverage describe the original selection/generation, not a validation of
  today's surviving membership.

**`ingestSource`** drops ingestion keys from the request, response, browser
state and Source Document storage. Keep upload validation (ownership, MIME,
magic bytes, 100 MiB) and uniqueness on `(projectContextId, contentSha256)`.
- First return a completed-content replay from the project without parsing.
- Otherwise mint an attempt ID and atomically stage verified bytes at
  `source-inbox/<projectContextId>/<attemptId>.pdf` (temporary write, rename).
  Enqueue on `studio` with deduplication ID `ingest:<projectId>:<sha256>` and
  `duplicationPolicy: 'return-existing'`. Use the returned workflow ID/result.
  If another attempt won, delete only this request's unused staging file.
  An uncertain enqueue leaves its file for GC rather than risking live input.
- Active deduplication is not permanent replay. The workflow's first step
  rechecks completed content, covering completion between the request's
  precheck and enqueue. The unique content constraint remains the publication
  backstop. A failed/cancelled attempt releases dedup, so resubmission can
  start a new attempt without a key or alias record.
- Await the returned result for the existing thirty-minute HTTP deadline.
  A 504 detaches; it does not cancel. Re-uploading after a reload rejoins the
  active attempt or returns the completed document.
  *(Superseded 2026-09-27 by server-owned Source Ingestion:
  the upload answers 202 on admission and the page lists in-flight attempts.)*
- Then `submitToKei` (the admitted conversion lane), `pollKei`, verify
  manifest and pages, translate/package, and commit under the existing
  ownership and content constraints. A replayed commit returns the same
  document/revision.
  Delete only the attempt's own staging file after use; GC handles crashes
  before enqueue and terminal failures that leave files.

**`reprocessSource`** retains its separate request key, fingerprint and
expected-head checks, before start and at commit. It shares conversion and
verification helpers, not ingestion's identity rules. A commit replay returns
its previously created revision rather than appending another revision.

## Interactive model work

A reload, a dropped connection and a Studio restart all recover the same way.
The page reads what the server holds and reattaches to what still runs. Each
user action carries a client-minted ID (Admission, above).

- **Generation (`suggestSchema`).** `generate_schema` gains an
  `operation_id` and the base Schema Revision it starts from (none for a
  first generation). One `DBOS.runStep` wraps `generateSchemaWithModel`.
  - A live tab saves the result exactly as today, through `generate()`
    (`src/currentSchemaRevision.ts:417`) and the save coordinator. Today's
    conflict rules and origins therefore stay: the save uses the tab's
    acknowledged head (`src/schemaSaveCoordinator.ts:82-104`), and editing
    during a regeneration remains allowed.
  - A reloaded page saves a finished generation only while its base is still
    the current revision, or while there is still no Extraction Schema.
    Otherwise it drops the generation, as reloading drops a conflicted save
    today, so a stale result never lands on newer work.
  - Recovery saves to an existing schema expect the base as their head.
    First-schema initialization is not serialized today; cross-tab exclusion
    is not a next-day release gate (a project-row lock sufficed in the probe).
  - A server-side save step would have to pick a head without the tab's
    acknowledgement, and would repeat after a crash between its commit and
    its checkpoint.
- **Edit proposals (`proposeSchemaEdit`).** `edit_schema` gains an
  `operation_id`. One `DBOS.runStep` wraps `proposeSchemaEdit` with its
  bounded repair. The output is the proposal and its base Schema Revision.
  Nothing is saved until the researcher applies it through the existing
  revision path.
- **Typed results.** Both steps return expected failures (today's
  `ApiError`s) as typed results instead of throwing, so the handlers
  reproduce today's status codes. DBOS revives a recorded error only as a
  plain `Error`.
- **Finding work after a reload.** `GET /api/model-operations` takes a
  Project Context and an Extraction Schema.
  - A first generation, made before any Extraction Schema exists, records
    `extractionSchemaId: null` explicitly. The route then matches it, because
    DBOS filters attributes by JSONB containment.
  - It returns the account's generation and edit operations for that scope,
    newest first, from one `listWorkflows` call: prefixes `suggestion:` and
    `edit:`, the scope attributes, `loadInput`, `loadOutput` and a limit of 20.
- **What the schema panel does on load.**
  - It shows a running operation with its instruction, and polls every 2 s
    until the operation settles.
  - It saves a finished generation whose base is still current, as above.
  - It reopens the review bar for the newest finished proposal whose base is
    the current revision, but only while the draft is clean. The restored
    proposal replays onto the base revision's nodes and keeps today's
    draft-version guard (`src/useSchemaProposalReview.ts:87-94`).
- **Discard and cancel.** `DELETE /api/model-operations/<workflow ID>`
  (owner-checked) cancels a running operation; the schema panel's cancel and
  `cancelGeneration` call it.
  - For a finished proposal, it deletes that proposal and every older finished
    proposal on the same base, so an older one cannot reappear and a newer
    one from another tab survives. That is how Discard persists. Finished
    history is settled, so the delete is safe at once.
  - Deleting a workflow also deletes its deduplication record. A retry of the
    same POST still in flight from another tab could therefore run the edit
    once more and show one more proposal. That costs one model call and
    loses nothing, so no dismissal record is kept.
  - A client abort only detaches.
> **Not built (decision 15, 2026-09-26):** the document chat was deleted in M5 instead of made durable: no `chatTurn` workflow, `ChatTurn` table, chat routes or `ChatTab`. The schema tab's durable interactive work is *Generation* and *Edit proposals* above.

- **Chat (`chatTurn`).** A transcript that must survive a reload is research
  content, so it moves into FREE's tables. Each turn is one `ChatTurn(id,
  sourceRepresentationRevisionId, question, answer, failure, createdAt)` row,
  cascading with its revision.
  - **Request.** `POST /api/chat` carries the immutable source revision, turn
    ID and new question, never client history. Insert the question and enqueue
    atomically with per-revision deduplication (Admission). Same-ID replay
    returns its stream/outcome; different content is 409. A second distinct
    active turn is 409; the browser refreshes the transcript instead of
    silently attaching the new question to another turn.

  - **Workflow.**
    - The first step loads the admitted question and earlier answered turns.
    - `streamText` then runs at workflow scope with
      `wrapLanguageModel({model, middleware: durableCalls({name: 'chat',
      durableStream: 'ui', retriesAllowed: true, maxAttempts: 3,
      timeoutMS})})` and `maxRetries: 0`
      ([integration](https://docs.dbos.dev/integrations/vercel-ai)). The fixed
      step name keeps replay valid if the route changes between attempts.
      `model` is the provider model wrapped in the sanitizer. It maps thrown
      errors and stream error parts, and drops the provider metadata that
      `durableCalls` would otherwise record (`@dbos-inc/vercel-ai`
      `src/middleware.ts:533-543`). 0.4.4 already omits the request body and
      response headers; the version probe confirms both. It runs inside
      `durableCalls`' step and stream.
    - The last step records a successful answer only if no answer/failure
      exists. On provider failure, record a sanitized typed failure, then
      throw a fresh sanitized Error without `cause`, nested errors or response
      objects. Returning a typed failure as workflow success makes the native
      stream emit an ordinary finish (verified). Partial text is never saved
      as a successful answer. Cancellation writes its outcome externally;
      deleted rows and losing terminal writes do not republish anything.
  - **Chat ID.** The Source Representation Revision ID becomes the chat ID,
    replacing the fixed `free-document-chat` (`src/ChatTab.tsx:67`).
    `POST /api/chat` returns `createUIMessageStreamResponse({stream:
    readDurableStream({workflowID, key: 'ui', messageId: turnId})})`. The
    turn ID is the assistant message's stable ID, live and on replay.
  - **Reload.**
    - `GET /api/chat/<revision ID>` returns the transcript and the newest
      unanswered turn's ID, if any. Reconnect using that exact ID through
      `GET /api/chat/<revision ID>/stream?turnId=<id>`; authorize the turn's
      membership in the owned revision on every request.
    - Serve the named workflow's stream even if it became terminal after the
      transcript read. If its history is gone, return 204. Re-read the
      transcript after 204 and every stream end, so a completed answer or
      domain failure wins over provisional text.
    - Replay from offset 0 with the stable turn ID. The integration skips
      superseded attempts for a new reader. On a dropped connection, reconnect
      this way instead of ending the turn; a Studio restart kills the socket.
    - Remove custom `data-dbos-superseded` handling. In pinned 0.4.4,
      `shouldRetry` refuses an in-process retry after content has been emitted
      (`middleware.ts:146-151`); restart recovery uses a new reader. A future
      change to this constraint must revalidate stream replay.

  - **Unanswered turns.** A question whose workflow ended without an answer
    (after a cancel, or when recovery is exhausted) shows as unanswered.
    Asking again starts a new turn.
- **What DBOS history holds.**
  - The workflows read document text from the immutable Source Representation
    Revision outside any step, so their inputs carry only IDs, questions and
    instructions.
  - `durableCalls` 0.4.4 does not checkpoint a stream's provider request
    body, which contains the document (`@dbos-inc/vercel-ai`
    `src/middleware.ts:533-543`; version probe). A chat turn's history
    therefore holds the transcript and the answer, not the document. Any
    later `@dbos-inc/vercel-ai` bump reruns the version probe.
  - Settled interactive workflows have a 24-hour history retention target. That is enough to recover
    a turn, or to return an unsaved generation or an unreviewed proposal.
    Transcripts and saved revisions live in FREE's tables. Background work
    has a 30-day target. Cancellation can extend retention until quiescence
    is established (garbage collection, below).
- **No pins.** Every attempt resolves the current route and key of the
  Project Context's owner, as every call does today. Interactive results carry
  no stored attribution, so a recovered attempt on a changed route changes no
  record.
- **Retries and timeouts.** One retry owner per path: the AI SDK's defaults in
  the JSON steps, and DBOS (`durableCalls`) for chat. Each call keeps a
  10-minute timeout, as batch calls have today.
- **Scope.** The schema panel's message log (instruction echoes, and apply or
  discard notes) stays in the page. What survives a reload is the latest
  operation: a running one, an unsaved generation or an unreviewed proposal.
  `promptOnlyRoutes`, NuExtract and schema-edit repair keep their code inside
  the steps.

## Cancellation

- **Extraction cancel** (interactive Extractions, as today). One transaction
  writes the failure `cancelled` if the Extraction has no outcome. Then
  `DBOS.cancelWorkflow('extract:<id>')` runs, and the kei client cancels
  `kei-extract:<id>`.
- **Propagation is retried.** A crash between the commit and the two cancels,
  or a `submitToKei` that finishes after the cancel, leaves a live kei child.
  `collectGarbage` cancels live Studio workflows whose domain row/attempt
  already has a terminal outcome, and live kei workflows whose Studio parent
  is terminal. Repeated cancellation must target live statuses only, so it
  does not keep advancing a cancelled workflow's timestamp.
- **kei's cooperative checks** (`jobs/tasks.py:94,98,166`, between pages and
  records) read the DBOS workflow status instead of `kei_run.cancel_requested`,
  which nothing in production sets today. A native call that is already
  running finishes first.
- **Studio model calls.** The key wrapper passes
  `AbortSignal.any([callSignal, DBOS.stepStatus.cancelSignal])` to the
  provider, so a cancelled chat, generation, proposal or suggestion call stops
  about 1 s after the cancel instead of running to completion. The signal
  reaches code inside a `durableCalls` step (version probe). Conditional
  outcomes, not the abort, still protect publication.
- **Physical capacity.**
  - Each kei queue sets its worker concurrency equal to its global limit.
    dbos 3.1.0 counts global and partition limits from `PENDING` rows, which
    a cancel changes at once. It counts worker concurrency from the in-memory
    set of active workflows (`_queue.py:740-768`, `_core.py:1056-1071`;
    `_sys_db.py:4682`). A cancelled workflow whose step still runs therefore
    keeps its lane's slot until the step returns. A rev-8 review probe
    reproduced this: with only global limits, cancelling one of four blocked
    steps let a fifth start.
  - The flock excludes a second process, so worker limits are the whole
    capacity.
  - Lanes run side by side by design; nothing excludes a conversion from an
    extraction. Cleanup no longer relies on exclusion (*Deletion*).
  - One regression test per queue covers this; no extra lock.

## Deletion and garbage collection

Project deletion cascades its owned graph. Source deletion removes the source's
revisions, Extractions and reviews, and only its membership in surviving
batches/suggestions. Use cascading source/revision FKs, including the composite
suggestion membership pin; remove the obsolete member/job Restrict cycle.
`ChatTurn` cascades with its revision. The existing Restrict failure is confirmed
by a real PostgreSQL `23503` probe, not a hypothetical fake-store gap.

**Suggestion preservation.** Lock affected suggestion rows before deleting
membership. Mark an active attempt interrupted in the deletion transaction,
without modifying its proposal, draft or draft version. Its immutable workflow
input can still name the old selection, but its conditional publication now
cannot succeed. After commit cancel the affected attempt IDs as well as the
scope's workflows in both apps. Scheduled cancellation repair covers a crash
in between. No automatic regeneration or invalid-proposal state is added.
The existing valid draft stays editable/usable with surviving sources; an
empty selection disables Run/Retry but keeps the draft. Membership changes do
not recompute the immutable original selection key or historical coverage.

After deletion commits, discard the deleted rows' canonical packages through
`discardPackagesIfUnreferenced` and return 204. Ownership checks make the scope
unreadable immediately; execution and file cleanup can finish later.

`collectGarbage` runs every 10 minutes:
- **Packages:** remove unreferenced canonical packages older than 24 h using
  the existing rename-and-recheck. Preserve every surviving revision's package.
- **kei runs and history:** Studio checks domain references and both workflow
  schemas. Check parent terminality before reading fresh domain references;
  never combine an earlier no-reference result with a later terminal status.
  A run referenced by a revision's `preprocessId`, a live kei workflow
  or a child of a live Studio parent is protected. This covers a completed
  conversion waiting for Studio publication. Pass eligible run/history IDs to
  kei `deleteRuns` on `kei-gc` (global and worker 1). It rechecks its own
  workflow statuses. kei never receives permission to query Studio's domain
  or system schema. Run directories must also be older than 24 h.
  - **kei boot boundary.** Lanes run beside cleanup, so exclusion no longer
    protects a cancelled native step. After taking the flock (the previous
    process has exited) and before `DBOS.launch()`, kei reads
    `keiBootTimestamp` from the database clock. A run whose kei workflows all
    ended `SUCCESS` or `ERROR` is eligible, because their steps returned. Any
    other terminal status is eligible only once that workflow's `updatedAt <
    keiBootTimestamp`: `CANCELLED` (explicit or deadline, both stamped from
    the database clock) and `MAX_RECOVERY_ATTEMPTS_EXCEEDED`. Until a kei
    restart, a native step may still write files or checkpoints, and no
    elapsed age proves otherwise.
  - **Late handoffs.** A cancelled Studio parent can still finish a
    `submitToKei` already under way (*Cancellation*), so an unreferenced run
    can gain a kei reader after cleanup checked it. `runExtraction` records the
    run it hands to kei as the workflow attribute `keiRunId`. A run stays
    protected while any Studio workflow with that attribute is live, or ended
    in anything but `SUCCESS` or `ERROR` at or after Studio's
    `bootTimestamp`. After that, cleanup rechecks the run's kei children
    before passing it on. Conversions write new runs and read no old ones.
- **Staged uploads:** remove attempt files older than 24 h only if their
  project/attempt workflow is absent or terminal. This includes crashes after
  staging but before enqueue and losing dedup candidates. Protect active
  attempts and their kei children; filenames never identify a shared file by
  content alone.
- **Orphaned execution:** cancel live workflows whose scope disappeared, live
  Studio workflows with a terminal domain outcome, and live kei children of
  terminal Studio parents. No workflow may publish into a deleted scope.
- **History retention:** 24 h after terminal completion for interactive work,
  30 days for background work; deleted scopes bypass age, not quiescence.
  Never delete kei history referenced by a live Studio parent. All kei history
  deletion runs through `deleteRuns`, including deleted-scope cleanup.
- **Cancelled Studio history:** capture `bootTimestamp` using the database
  clock before launch, only after the previous Studio process has terminated.
  Delete cancelled history only when `updatedAt < bootTimestamp` and its age
  or deleted-scope rule permits it. Cancellation updates this timestamp using
  the database clock (verified). Current-process cancellations wait for a
  later process restart. No in-place DBOS shutdown/relaunch is supported.
  `SUCCESS`/`ERROR` executions can use ordinary terminal retention.

A failed reference/status query deletes nothing. DBOS payload tables lack
foreign keys, so deleting history while a cancelled step can still checkpoint
would leak orphan rows. A 24-hour cancellation age does not prove that step
stopped. Cleanup of cancelled work waits for a Studio or kei restart, and
kei restarts at every deploy. Runs that ended normally are cleaned on the
usual schedule. There is no fixed 24-hour deletion guarantee. Late
unpublished files remain invisible and are collected after reference and
quiescence checks.

## Queues, deadlines and upgrades

| App | Queue | Policy | Workflows |
|---|---|---|---|
| kei | `kei-convert-large` | global 1, worker 1; FIFO | `convert` of documents over `SMALL_DOCUMENT_PAGES` |
| kei | `kei-convert-small` | global 1, worker 1; FIFO | `convert` of the rest |
| kei | `kei-extract` | global 2, worker 2; priority interactive 1, batch 10; FIFO ties | `extract` |
| kei | `kei-gc` | global 1, worker 1 | `deleteRuns` |
| studio | `studio` | unrestricted; dedup per chat source revision and per ingestion project/content | `runExtraction`, `chatTurn`, `ingestSource` |
| studio | `suggest` | global 1 | `suggestSchemaBatch` |

- **Why these lanes** (decision 14; measured on the Spark,
  rev-8 tests).
  Each vLLM server runs 4 requests (`--max-num-seqs 4`).
  - **Conversion.** Surya's client sends `SURYA_INFERENCE_PARALLEL` requests
    at once. The measured baseline is the deployment before 2026-09-25, which
    set neither that nor `VLLM_GPU_TYPE`. Surya then guessed 32 from a GPU
    table (`surya/inference/backends/vllm.py:101-113`), and a book left 28
    requests waiting in vLLM. Pinned to 4 (shipped; *kei worker*), a 40-page
    book takes the same time (250 s against 254 s). A
    3-page document added during the book's OCR then takes 40.8 s instead of
    99.8 s (32.8 s alone), and the book 275 s. vLLM serves waiting requests
    in arrival order, so the small document's requests are next once the
    book holds only 4. At 3/2/1 client threads the book takes 290/365/688 s,
    so no slot is reserved.
  - **Extraction.** A Catalog extraction sends one request at a time
    (`kie/extract/grounded.py:190-195`), using 1 of NuExtract's 4 slots. A
    small extraction beside a 200-entry Catalog took 7.75 s (8.5 s alone,
    Catalog) and 22 s (13.8 s alone, Article). The Catalog stayed at 433–443 s
    against 434 s. One slot would make a small extraction wait up to the
    Catalog's 3 h deadline.
  - **Cleanup** has its own queue, so it never takes a conversion or
    extraction slot.
- **Lane is not fairness.** Two large books run one after the other, and two
  small documents too. Per-account sharing through DBOS partitions (random
  per-poll order; `fair_queue_probe.py`) is deferred: priority would then
  apply only within one account, and a worker limit is still required.
- **`SMALL_DOCUMENT_PAGES`** is one constant in the handoff module: 30 (user,
  2026-09-25). kei registers the queues;
  Studio only picks one.

- **Other workflows start directly.** The `studio` queue provides transactional
  admission and active deduplication, not a new resource cap. It polls every
  100 ms (`minPollingIntervalMs`, M0R 3). Measure its chat
  dequeue latency in M0R. The suggestion queue limits scheduling. A cancelled
  TypeScript call stops about 1 s later through `cancelSignal`, but its slot
  is not physical exclusion; conditional outcomes protect publication.
- **Ownership.** Every `DBOSClient` sets `applicationName`: `studio` for the
  admission client, `kei` for the kei handoff client. A client without one
  creates workflows that no application owns, and any application may
  dequeue those. Only kei registers the kei queues; a client's
  `registerQueue` defaults to `always_update` and would overwrite kei's
  configuration.
- **No admission caps.** None exist today besides the 50-member batch limit,
  which stays. HEAD already dropped kei's cap of 32.
- **kei deadlines.** `workflowTimeoutMS` applies to kei `extract` (10 min
  Article, 3 h Catalog) and kei `convert` (per-page budget, M0R 4), measured from
  kei dequeue. Studio parents have no deadline; they end with their child.
  The conversion budget grows with pages. On the Spark, cutting took 2.7 s
  per page on the CPU before the first OCR request, and OCR about 2 s per
  crop (73 crops for 40 pages). A 2000-page scan would take roughly 3.5 h. So
  the budget is per page, set from the M0R 4 and M0R 6 measurements.
- **Versions.** `studio@1` and `kei@1` stay fixed. Code changes that alter a
  workflow's step sequence use `DBOS.patch()` / `deprecatePatch()` (Python:
  `patch` / `deprecate_patch`). Both SDKs require patching to be enabled in
  their configuration: `enablePatching` in TypeScript and `enable_patching` in
  Python. Bump a version only for an incompatible contract change, after
  draining.
- **Pools.** Studio domain, Studio DBOS, Studio admission client, kei client and
  kei worker; measure the total. Transactional enqueue uses the already-acquired
  domain client. Do not assume M0's old pool count still applies.

## kei worker

- **Startup.** `kei-worker worker` takes `runs/.worker-<slot>.lock` before
  `DBOS.launch()` and holds it for its lifetime (`hold_slot`,
  `jobs/worker.py:38-57`). Its executor ID is fixed at `kei-<slot>`, and a
  restart recovers pending work.
- **`convert`** has two steps.
  - `prepare` creates the run directory, copies and verifies the staged PDF,
    writes `params.json` and validates at most 2000 pages. It returns the run
    ID, which replay reuses.
  - `convert` probes, runs `ocr.resolve` and the native conversion. Remove
    worker `output.md` generation; standalone CLI output stays. It uses
    `retries_allowed=True`, `max_attempts=3` and a 5 s
    backoff (today's `RetryStrategy`), with a boolean `should_retry`
    predicate: `isinstance(classify(e), TransientBackendError)`. `classify`
    itself returns an exception, which DBOS would treat as always true.

  It returns `{ok, run_id, generation, page_count, source_sha256, page_source}`
  from the published manifest.
- **`extract`** is one step with the same retry policy: manifest success, the
  generation pin, model and recipe checks, `run.py:extract`, then idempotent
  artifact publication.
- **`classify`** moves from `jobs/tasks.py` to `kei_exp/failures.py`.
- **Queues.** The worker registers the four kei queues after `DBOS.launch()`,
  each with worker concurrency equal to its global limit (*Cancellation*).
- **OCR client width (shipped 2026-09-25).** `compose.gpu.yaml` sets
  `SURYA_INFERENCE_PARALLEL` on the parsing worker and API from the same
  `OCR_MAX_NUM_SEQS` (default 4) as `ocr_model`'s `--max-num-seqs`, so the two
  change together. The safety test asserts it. On its own it changes nothing
  until lanes run side by side.
- **Two conversions in one process.** The lanes let a large and a small
  conversion run at once. The Spark tests found no conflict, under three
  conditions:
  - Surya's `configure()` writes process-global settings (`surya.py:215`).
    Only one Surya record exists, so both conversions write the same values.
    A second Surya record needs per-call settings first; a test fails if two
    records differ in what `configure()` sets.
  - The pdfium lock covers a whole document only on the `cut=none` path
    (`surya.py:236`). Studio always sends `cut=auto`, which renders page by
    page. A small document injected while a book was being cut finished in
    33.8 s, against 32.8 s alone.
  - Each conversion has its own run directory. Two extractions of one run
    write different artifact files, and both compute the same segmentation
    before publishing it by rename (M3 test).
  - Not yet measured: memory with a 2000-page book beside a small document,
    and `page_source=ingest` spreads (M0R 6).
- **Cutting precedes OCR.** `SuryaOcr.transcribe` receives every crop of the
  document at once (`transcription/surya.py:288-296`), so a 2000-page book
  spends about 90 min cutting on the CPU and holds all crops in memory before
  its first OCR request. This is unchanged (*Risks*). Streaming crops into OCR
  is a later improvement, not part of this migration.
- **Parallel Catalog chunks** (M3; user, 2026-09-25). A Catalog extraction
  sends one request at a time, so it leaves 3 of the fields server's 4 slots
  idle. It now runs its entries in `KEI_CATALOG_CHUNKS` contiguous chunks at
  once.
  - **Setting.** Compose derives `KEI_CATALOG_CHUNKS` from the same
    `NUEXTRACT_MAX_NUM_SEQS` (default 4) as `nuextract_model`'s
    `--max-num-seqs`, as for OCR.
  - **Once for the whole document:** the segmentation, the budget checks, the
    bindings and the document-level fields. `_document` makes its one call
    when the schema has document fields (`grounded.py:684-707`), and every
    chunk's records merge the same result.
  - **Per chunk:** a thread with its own `_Run`, because `_Run.call` mutates
    run state (`grounded.py:132-155`). Every chunk keeps the full headings
    and glossary. Entries keep their document-wide index, so issues and calls
    name the right record.
  - **Merge** in entry order: records, evidence, proposals, rejections,
    competitors, calls and issues. The run is refused if any chunk refused.
    Coverage comes from the segmentation once. The artifact records the
    chunk count.
  - **Unchanged:** it is still one `extract` step, a failure retries the
    whole step, and cancellation is checked between entries as today.
    Article extraction is not chunked.
  - **Evidence** (200-entry Catalog): 106 s against 434 s. The same chunks run
    one after another gave records identical to the unsplit run. Run in
    parallel, they changed 19–21 borderline `fundart` values, against 0–1
    between two unsplit runs. The cause is vLLM batching, which the user
    accepts (*Risks*).
  - **With two extraction slots,** two chunked Catalogs send up to 8 requests
    to a 4-slot server. vLLM queues the rest in arrival order, so a small
    extraction's request waits behind those already queued, about one round.
    This is measured in M3, not assumed.
- **Per-model-call checkpoints are deferred.**
  - `_Run.call` mutates run state in place (`kie/extract/grounded.py:132-155`),
    so step boundaries there mean a refactor that deletes nothing. A crash
    repeats the whole extraction, as today.
  - Python has no transport-retry loop for DBOS to replace. Its only resend is
    the unsupported-format retry (`kie/extract/llm.py:97-99`), which stays.
- **Read API.** It keeps six routes, with their path confinement and
  manifest/page/hash checks:
  - `GET /api/models` (Compose health);
  - `/api/extraction-models`;
  - `/api/ingestion-models` (new in M2);
  - `/api/runs/{id}/result`;
  - `/api/runs/{id}/pages/{n}`;
  - `/api/runs/{id}/extractions/{xid}`.

  Replacing this API with a shared filesystem mount is deferred: catalog
  ownership and safe file reads remain real consumers, and duplicating their
  validation in TypeScript has not demonstrated a net deletion.

## Model configuration and keys

- **Ownership.** Each Researcher Account owns one configuration: its Model
  Connections, both Capability Routes, its Extraction Model Choice and its
  Ingestion Model Choice.
  - `model_config` and `model_probe` become researcher-scoped handlers instead
    of static modules (`server/api-dispatcher.ts:43-48`). A researcher reads
    and changes only their own configuration.
  - Every Studio model call, background ones included, resolves the
    configuration of the Project Context's owner; workflows carry only IDs.
    kei's parsing, OCR and extraction models stay deployment-configured
    (`KEI_*`); the Extraction and Ingestion Model Choices only select among
    them.
  - The account is mandatory, so the accountless fallbacks go, such as
    `readModelConfig()` in `operationTarget` (`api/_model.ts:87`).
  - An Extraction is still requested on the Extraction Model Choice current
    when it starts, which is now the owner's.
- **Deployment connections** stay operator-defined, read-only and shared by
  every researcher. An unset Interaction Route still falls back to the
  deployment's default route. An unset Schema Suggestion Route follows the
  Interaction Route (decision 12), so it resolves `schemaSuggestion ??
  interaction ?? defaultRoute`. Today each route resolves on its own
  (`api/_provider.ts:681-684`).
  - The vLLM servers come from `FREE_DEPLOYMENT_*`
    (`api/_deployment_models.ts`).
  - The CLI providers run on the server's own CLI login (the CLI auth homes).
    The operator enables them with `FREE_DEPLOYMENT_CLI_PROVIDERS`
    (`codex-cli`, `claude-code`), and the local development overlay enables
    both for power users who run FREE themselves.
  - Researchers can no longer define a CLI connection. Apply and Probe both
    reject one. Today a probe of an unsaved CLI connection runs without any
    check (`api/model_probe.ts:51`). An enabled CLI provider joins
    `DEPLOYMENT_IDS` and is probed only through its deployment ID. This
    deletes the one-per-kind check (`api/_model_config.ts:83-93`) and the
    personal-CLI branches.
- **Configuration storage.** `ModelConfiguration(researcherAccountId,
  document, updatedAt)`, cascading from the account.
  - The document holds the researcher's connections, routes, Extraction Model
    Choice and Ingestion Model Choice. For each connection it records only whether the connection
    uses a key (`hasKey`), never the key. Managed kinds (OpenAI, Anthropic,
    Google) always do.
  - One transaction applies a draft, serialized by a lock on the researcher's
    configuration row. This replaces the in-process write barrier
    (`api/model_config.ts:20-41`).
  - The update request loses its credential actions
    (`shared/modelConfig.contract.ts:87`), and the response loses
    `credentialStates` (`:114-117,147`).
  - There are no revisions and no pins.
- **Ingestion Model Choice** (decision 13).
  - Per role, it names the kei model a new parse runs on. `ocr` is the
    transcriber for scanned pages, a `kei_exp.models.MODELS` key. `layout` is
    the Docling detector that cuts scanned pages into regions, a
    `LAYOUT_MODELS` key (`kei_exp/cut.py:28`). A page with a text layer uses
    neither (`kie/stages/ocr.py:77-82`). An omitted role keeps kei's default. It names no Model Connection. A
    Project Context uses its owner's choice.
  - It applies to new ingestions and reprocessing only. Completed-content
    replay returns the existing parse even after the choice has changed, so
    reprocessing is how a researcher applies a new choice.
  - kei lists the options with `GET /api/ingestion-models`, shaped like
    `/api/extraction-models`: the default per role, then the models of each
    role. An OCR model is `serving` only while the OCR server has it loaded
    (`loaded_model(VLLM_URL)`), since that server loads one model; `serving`
    is what the listing observed, not a promise. Layout detectors are presets
    that run inside kei and are always selectable; each loads on first use
    (`cut.py:85-86`). Studio forwards the listing, beside
    `api/extraction_models.ts`. It replaces `/api/server` and
    `/api/layout-models`, which M1 deletes as unused.
  - A listing failure blocks neither ingestion nor other configuration edits.
    A saved choice that the listing no longer offers stays saved and shown,
    as `ExtractionModelSelect.tsx` does for extraction models today.
  - Admission freezes the owner's explicit choices into the workflow input,
    so a recovered attempt runs the models it was admitted with. kei resolves
    a role left unchosen once, in its own checkpointed step when `convert`
    starts, from the same default definition its listing reports. A recovered
    attempt reuses that step, while queued work follows the deployment's
    current default. An operator who swaps the OCR server's model also swaps
    that default, so an older default would only fail the serving check.
  - kei keeps today's checks: an unknown key is refused, and whether the OCR
    server serves the model is decided when the conversion runs. The parse
    recipe already records the transcriber and layout model
    (`result.py:59-68`).
  - Deduplication and replay keep their identities, and the models never
    enter a dedup key or fingerprint. A same-content upload joins the active
    attempt with that attempt's models, whatever the joiner's choice. A
    repeated reprocess request key compares only today's fingerprint
    (`api/source_reprocess.ts:72-74`) and reuses the admitted models; it never
    resolves the configuration again. A new request key captures the current
    choice.
- **NuExtract protocol** (decision 12). The Schema Suggestion route stores no
  `protocol`. Studio uses NuExtract's protocol exactly when the route's
  connection supports it (vLLM, `supportsNuextract`) and its model ID names
  NuExtract (`/nuextract/i`). This removes the contract field
  (`shared/modelConfig.contract.ts:36-40`), its validation
  (`api/_model_config.ts:123-130`) and the page's checkbox. The stored check in
  `api/_provider.ts:701-703` becomes the derivation.
- **Keys: bring your own, never stored by Studio.** A researcher's API keys
  stay in their browser. Studio keeps a copy only in process memory, never in
  PostgreSQL, on disk, in logs or in DBOS.
  - **Browser.**
    - The Model Configuration page keeps each key in `localStorage`, under
      the signed-in account and bound to the connection's ID and API base.
      The page reads keys from there when it needs them and keeps no other
      copy.
    - Changing a connection's base or provider, in a draft as well as on
      Apply, clears its key at once and cancels any scheduled probe. Today a
      draft keeps the typed key and probes the new base with it after 500 ms
      (`src/providerConfig/useProviderConfigDraft.ts:48-58`,
      `useProbeLifecycle.ts:60-72`).
    - Signing out clears this browser's keys and Studio's copy for the
      account. Another signed-in browser of the same account sends its own
      copy again the next time it talks to Studio. A key removed in one
      browser can likewise come back from another browser that still holds
      it.
  - **Handoff.** The page sends its keys with `PUT /api/model-keys`
    (researcher-scoped and write-only; entries merge, and a `null` removes
    one). It sends them:
    - on load;
    - after Apply;
    - before starting new model work, awaiting the handoff before its POST;
    - when a response shows a new Studio boot ID. Every API response carries
      `X-FREE-Studio-Boot`, a UUID drawn at startup. The check lives in
      `src/auth/authenticatedFetch.ts`, so every page has it: the chat
      reconnect, the schema panel's poll and the batch panel's 2 s refresh
      (`src/projectContexts/BatchExtractionsPanel.tsx:440-455`);
    - once more after a `model_key_required` response. This is a confirmed
      terminal failure: retry uses a new operation/turn ID or batch attempt,
      never the failed workflow ID.
  - **Handoff checks.**
    - The request names the account the page believes is signed in. Studio
      rejects it if the session's account differs, so a stale tab on a
      shared browser cannot file one account's keys under another.
    - Studio accepts a key only for one of the account's own connections, at
      that connection's current provider and base.
  - **Cache.** An in-memory map from account and connection to the key and
    the provider and base it was sent for.
    - A cached key is used only while the owner's configuration, read at the
      call, still has that connection at that provider and base. A stale entry
      left by a racing request is therefore harmless.
    - Entries go when the researcher removes the key, when Apply removes or
      re-addresses the connection, at sign-out (`POST /auth/logout`,
      `server/app.ts:497`) and at process exit.
    - Removal stops new calls; a call already under way finishes.
    - Studio runs in one process (Decision 2), so one map is enough.
  - **Use.**
    - A wrapper model reads the key lazily, inside each provider attempt, and
      builds the provider client per call, as the Ollama adapter already does
      (`api/_provider.ts:422-440`). Replaying a checkpointed step therefore
      never needs a key, and workflow-scope code never reads one.
    - For a `hasKey` connection with no cached key, the attempt waits up to
      60 s for a page to resend it. The wait ends early on an abort or on the
      workflow's cancellation (`DBOS.stepStatus.cancelSignal`), and no
      provider call starts after either (version probe).
    - The attempt then fails with `model_key_required`, marked
      `isRetryable: false`. So neither `durableCalls`
      (`@dbos-inc/vercel-ai` `src/internal.ts:35-48,73-79`) nor the AI SDK
      retries it.
    - With a page open, a Studio restart therefore goes unnoticed: the next
      request sees the new boot ID and resends the keys. Background work with
      no page open fails after the wait, and the researcher retries it.
    - A connection without `hasKey` calls its server anonymously, and one
      with `hasKey` never does. This replaces today's catches that turn a
      store error into an anonymous request (`api/_provider.ts:659`,
      `api/model_probe.ts:68`).
    - The NuExtract protocol has no SDK model. `generateWithNuExtract`
      (`api/_model.ts:280`) fetches vLLM directly, with an `authorization`
      string resolved together with the route (`api/_provider.ts:628-635`).
      It gets the same boundary: its target names the connection, not a
      credential, and the key read, the wait, `cancelSignal` and error
      sanitizing all happen inside the attempt.
  - **Probes** always carry the key typed or stored in the page; the server
    never looks one up for a probe.
  - **Validation errors.** `model_keys` and `model_probe` answer a malformed
    body with a fixed error and no validation details. Neither logs its body
    or a raw validation cause, because Zod issue paths and messages can echo
    a key placed under an unexpected property name
    (`api/_model_config.ts:143-146`, `api/_http.ts:88`).
  - **Trust.** Studio still sees a key while it makes a call. This protects
    keys from database dumps, backups and passive access, but not from an
    operator who changes Studio's code. The documentation says so.
  - **XSS.** A key in browser storage can be read by any script on Studio's
    origin.
    - Studio renders no raw HTML (no `dangerouslySetInnerHTML` in `src/`), but
      only the sign-in pages send a Content-Security-Policy
      (`server/app.ts:288,309`).
    - The production app shell (`server/static.ts:98-101`) therefore gains a
      strict policy. Scripts and pdf.js's worker may load only from Studio's
      own origin, inline script is refused and framing is denied.
      `index.html` has a single module script, and the worker is a bundled
      URL (`src/App.tsx:8,31`). The sign-in relay keeps its own script-hash
      policy (`server/app.ts:289`).
    - pdf.js stays patched, since it renders untrusted PDFs in that origin.
    - Accounts that share one browser profile share its storage. The
      per-account namespace keeps them apart for the app, not against a
      script.
- **The page** (decision 12; reference prototype on branch
  `prototype/model-config-b1`, `src/providerConfig/prototype/`, variant B1).
  - Models and Connections tabs share one draft and one Apply.
  - Models has three steps, and a step at its defaults is one sentence with a
    Change link. "Use defaults" removes the step's stored choice. One line per
    step says where its options come from: any of the researcher's
    connections, or the models this deployment runs.
    1. *Reading documents*: text recognition and page regions for scanned
       pages, the Ingestion Model Choice.
    2. *Schema & chat*: the *Assistant model* (the Interaction Route).
       Schema Suggestion inherits it while its route is unset. "Use a
       different model" stores its own route, which stays an override even
       when it equals the Assistant model; "Use the assistant model" unsets
       it again. The prototype inferred following from equality, and this
       plan supersedes it.
    3. *Extracting data*: field values and reasoning, the Extraction Model
       Choice.
  - There is no Single/Routes mode. A route is `{connectionId, modelId}`, or
    unset (the deployment default, or for Schema Suggestion the Assistant
    model), and one draft function, `assign(task,
    target | null)`, sets it. This deletes the mode state,
    `configurationMode()`, `setSingleConnection`, `setSingleModel`,
    `setRouteModel` and `setNuextractProtocol`
    (`src/providerConfig/useProviderConfigDraft.ts`), and the single-model
    branch of `ProviderRoutesEditor.tsx`.
  - One control picks a route's connection and model together. It groups
    models by connection, searches, and accepts an exact model ID. The page
    probes every eligible connection when it opens, instead of when a model
    list first opens (`openModelList`):
    - a deployment connection, with no credential (`api/model_probe.ts:38`);
    - a connection without `hasKey`, anonymously;
    - a `hasKey` connection only with this browser's key for that account,
      provider and base. Without one it is not probed.

    An edit or unmount supersedes scheduled probes and stale results, as
    `useProbeLifecycle.ts` does today. `ModelCombobox.tsx`, `ExtractionModelSelect.tsx` and
    `ProviderRoutesEditor.tsx` have no other user and give way to it.
  - Connections is a list with a detail pane. Deployment connections,
    including the CLI ones, are read-only. A connection's provider is fixed
    once it is added. Its key is one line: saved in this browser, with Replace
    and Remove, or an input.
- **Reset.** Validation on write keeps the stored document valid, and future
  shape changes become migrations, so the fail-closed reset path goes.
- **Deletions:**
  - `_keyring.ts`, `ConfigFileSystem` and the JSON read/write/fsync/rename
    code;
  - every server-side credential path: `credentialStates`, `requireKeyring`,
    `requireManagedCredentials`, `clearImplicitOptionalCredentials`, the
    post-commit cleanup (`api/_model_config.ts:451-459`) and the keyring
    branches of `savedCredential` and `resolvedCredential`;
  - the write barrier, the static registration of `model_config` and
    `model_probe`, the CLI singleton check and personal-CLI branches, and the
    accountless configuration fallbacks;
  - `DELETE /api/model_config` with its UI and tests;
  - the `@napi-rs/keyring` and `env-paths` dependencies;
  - apt `dbus-daemon` and `gnome-keyring` (`prototypes/studio/Dockerfile:5-9`),
    and the `XDG_RUNTIME_DIR` / `DBUS_*` settings (`Dockerfile:61-63`);
  - the entrypoint's D-Bus start and empty-password keyring unlock
    (`docker/studio-entrypoint.sh:7-8,12-21`), keeping `CODEX_HOME`.
- **Decision records.**
  - Supersede ADR 0006 with ADR 0013 (per-researcher configuration, with keys
    held by the researcher's browser). ADR 0006 assumed one researcher on
    localhost with an OS keyring, called hosted deployment unsupported, and
    allowed any researcher-supplied API base for that reason.
  - Amend ADR 0007, whose routes are machine-wide and whose Schema Suggestion
    route stores the NuExtract protocol; the protocol is now derived. Amend
    ADR 0011: the page edits the signed-in researcher's configuration in three
    steps without a Single/Routes mode, and the reset paragraph goes. ADR 0013
    also records the Ingestion Model Choice.
  - In CONTEXT.md, Model Connection, Capability Route and Extraction Model
    Choice become owned by a Researcher Account, deployment connections
    excepted. A Project Context uses its owner's configuration. Add the
    Ingestion Model Choice. The Schema Suggestion Route uses the NuExtract
    protocol when its model is NuExtract on a vLLM connection, and when
    unset follows the Interaction Route. *Assistant
    model* is the page's name for the Interaction Route.

## Cutover (clean slate)

A manual, one-time step on the deployment host. The reset tooling keeps its loopback-only
restriction. README #10 ("Production is never reset") gains a dated note naming
this pre-production reset as its only exception.

1. Build the new images while the old stack serves.
2. Stop the stack. Take one `pg_dump` of `free` and `parsing_db` for inspection;
   there is no restore path.
3. Reset the storage:
   - remove `parsing_db` and its volume;
   - drop and recreate `free`;
   - empty `parsing-runs` and `studio-data`;
   - delete the obsolete `model-config.json`.

   Keep the CLI auth homes: `studio-config`'s `codex` directory and
   `studio-claude`.
4. Start the new stack with the operator's `FREE_DEPLOYMENT_CLI_PROVIDERS`.
   The baseline, the kei role and schema, and both DBOS schemas are created
   at startup.
5. Each researcher re-enters their own connections, enters their keys in
   their browser, and re-uploads their source PDFs.
6. Smoke-test:
   - upload;
   - extraction and cancel;
   - batch suggestion;
   - chat, generation and a schema edit across a browser reload and across a
     Studio kill;
   - a second account sees none of the first's configuration, operations or
     chat;
   - project deletion followed by `collectGarbage`.

## Public contract changes

> **Not built (decision 15, 2026-09-26):** the chat-request bullet below; `/api/chat` was deleted with no alias, and the dispatcher answers it 404.

- Extraction admission/status/result use one `extractionId`; remove separate
  job/member identities and targeted-retry variants. Execution status remains
  derived, while completed evidence and review contracts retain their pins.
- Ingestion loses `ingestionKey` everywhere. Existing-content responses replay
  by project/hash. Reprocess keeps its request key and expected-head contract.
- Suggestion sources expose membership pins only; remove per-source progress,
  definitions and errors. Drop stored transient SOURCES/MERGING phases; keep
  final READY/HETEROGENEOUS meaning with the proposal outcome. Retry regenerates
  the complete remaining selection and carries `expectedAttempt` for replay.
  Valid draft readiness is independent of the latest attempt's failure.
- Chat requests carry revision/turn/question, with 409 for a different active
  turn. Transcript reads supply an exact reconnect turn ID; the stream route
  takes that ID and returns 204 when its history has expired.
- Model operations retain client IDs/base revisions, listing and owner-checked
  cancellation. Browser-key contracts remain as specified above.

- Model configuration: the account's document gains `ingestionModels:
  {ocr?, layout?}`, and `routes.schemaSuggestion` loses `protocol`. kei and
  Studio gain `GET /api/ingestion-models`. kei's `convert` input takes
  optional `model` and `layout_model` keys.

Update schemas, handlers, browser consumers and tests together; add no legacy
aliases or compatibility readers for this pre-production cutover.

## Milestones

One branch and one cutover, with no temporary execution backends. Until the
cutover, the new migration baseline is edited in place; forward migrations
resume after it. M2–M4 form one integration boundary: run component checks
between them and the full-stack gate after M4. Do not deploy the incomplete
middle state. Later milestones finish their test tier before the next.

**M0: original throwaway spike — historical, completed.** Findings are
preserved below (TS DBOS 5.0.2, Python DBOS 3.0.0, x86_64). It did not test
in-process launch, interactive durability, derived status or garbage
collection.

**M0R: pre-implementation probes, the gate before M2.** M1 only removes dead
code and does not wait for it. Items 1–5 run in a throwaway harness against
disposable loopback `free_test_*` databases and scripted model endpoints; no
live credentials or research content. Item 6 measures the Spark's own model
servers with synthetic documents. Record versions, commands and outcomes
in the evidence record. A failed probe revises this plan; it never adds a
custom scheduler or fallback. A check that needs FREE's own workflows,
handlers or pages is an acceptance test of the milestone that builds it
(listed under M2, M4, M5 and M6); no harness result replaces it.

1. **Versions: passed 2026-09-25 on x86_64.**
   - Pins: `@dbos-inc/dbos-sdk` 5.1.10, `@dbos-inc/vercel-ai` 0.4.4 (peers
     `^4.21 || ^5`, `ai ^7`; probed with Studio's `ai` 7.0.93) and `dbos` 3.1.0.
   - All five review probes reproduce their 5.0.2/0.3.7/3.0.0 results.
     `version-probe.mjs` covers the two behaviours the sixth revision relies
     on (item 5).
   - Passed on ARM64 (Spark, Node 24.21.0) 2026-09-26: all five probes match
     x86_64 (m0r-arm64).
2. **In-process lifecycle.** Passed 2026-09-26 (m0r).
   Consequences: Studio declares `@dbos-inc/dbos-sdk` and `@dbos-inc/vercel-ai`
   as its own dependencies and keeps them external (`ssr: { external: [...] }`
   in `vite.server.config.ts`); a second `DBOS.launch()` in one process is
   silently accepted, so `server/dbos.ts` guards it; unnamed workflows get
   bundler-mangled names (`job$1`), so every workflow has an explicit `name`.
   - Launch and shutdown in `host.ts`.
   - In development, a server-code change restarts the Studio process (Compose
     watch `sync+restart`) and DBOS launches once per process.
     `shutdown({deregister: true})` would not wait for running workflows, so
     relaunching in place could overlap old and recovered executions.
   - `kill -9` followed by a restart recovers a pending workflow, in the
     development host and in the production bundle (`node dist/server/index.js`
     after `vite build --config vite.server.config.ts`). DBOS cannot be
     bundled: keep `@dbos-inc/*` external to the SSR build, and give every
     workflow an explicit `name`.
3. **Admission.** Passed 2026-09-26. Default queue polling adds p50 0.4–0.6 s
   and p95 0.8 s per dequeue; `minPollingIntervalMs: 100` on `studio` gives
   p50 ~55 ms, p95 ~92 ms, so the `studio` queue sets it.
   - Rollback after domain insert/enqueue leaves neither; commit creates both.
     Kill immediately before/after commit and verify recovery.
   - Two simultaneous identical turn IDs create one question and replay once.
     Different payloads under one ID conflict. Different turns for one source
     revision admit one and reject one without an orphan question.
   - Repeat both with the admission client's `applicationName` set to
     `studio`; Studio owns and runs the admitted workflow.
   - Verify `return-existing` only outside caller-owned transactions; measure
     chat dequeue latency on the unrestricted queue.
4. **kei queues.** Passed 2026-09-26 on all four lanes. The conversion budget
   is `max(600_000, 3 × (20_000 + 6_300 × pages))` ms (6.3 s/page from the
   rev-8 numbers, factor 3, 10-min floor), provisional until the ~2000-page
   M0R 6 run.
   - On each lane, cancel right after claim and mid-step, then enqueue another
     job. It must not start until the blocked cancelled native step exits;
     the other lanes keep running.
   - `deleteRuns` leaves a run with a cancelled workflow alone until a kei
     restart, then removes it. Check that a Python-side cancel and a deadline
     both set `updatedAt` from the database clock.
   - Check priorities, FIFO ties and dequeue-relative deadlines on
     `kei-extract`, and deadlines on both conversion lanes.
   - Measure the conversion budget per page; it fixes the lanes' deadline
     (M3).
5. **Model calls.**
   - Stream one HTTP and one CLI provider through `durableCalls`.
   - Passed 2026-09-25 (version probe): a successful stream checkpoints no
     request body or response headers but does record provider metadata.
     `DBOS.stepStatus.cancelSignal` reaches a wrapper model inside the step
     and fires about 1 s after the cancel, before any provider call.
6. **Spark scheduling.** These run on the Spark's live model servers from a
   throwaway container of the parsing image, with synthetic documents only.
   They restart nothing unless the user approves.
   - Passed 2026-09-25 (rev-8 tests):
     - a book and a small document through today's `ocr.resolve` and
       `convert`, at Surya widths default, 4, 3, 2 and 1;
     - a small document injected during the book's cutting and OCR;
     - two extractions side by side;
     - Catalog chunks run in parallel and one after another.
     - The KV cache peaked at 10% with no preemptions.
     - `VLLM_BATCH_INVARIANT=1` on a separate NuExtract server (production
       untouched): vLLM 0.29.1 fails at startup with "batch_invariant mode
       is not supported for GDN_ATTN". Both extraction models are
       `Qwen3_5ForConditionalGeneration` with gated-delta-net layers
       (NuExtract 24 of 32, Qwen 48 of 64), so neither can use it.
   - Pending:
     - a book near 2000 pages (memory, cut time, deadline);
     - `page_source=ingest` spreads;
     - Studio chat and schema generation during a kei extraction on
       `extraction_model`.

**M1: dead code (no schema change) — done 2026-09-25.** Task plan:
2026-09-25-dbos-m1-dead-code.md.
- **Targeted Catalog retry, end to end.** `catalog.ts`; retry admission and
  identity (`postgres-persistence.ts:333-407`); the contract request variants;
  the executor branch (`module.ts:198`, which always throws `invalid_retry`);
  the `useExtraction.ts` and ResultsTab controls; their tests. Also the
  read-side `diagnostics.retry` and `retryOfId`. A failed Catalog attempt
  gets the generic Rerun/Retry instead (user, 2026-09-25).
- **Extraction checkpoints.** `checkpoint()` has had no caller since e88b08f.
  The provisional-results UI reads checkpoint fields that nothing writes
  (`ResultsTab.tsx:466-468,678,789-793`;
  `shared/extraction.contract.ts:383-394`). Archive the implemented OpenSpec
  change `preview-extraction-before-grounding` as superseded, without syncing
  its specs (user, 2026-09-25).
- **`extraction_in_progress`.** The code is declared but never thrown.
- **The LLM inspector** (user, 2026-09-25: supersedes its 2026-08-28 restore
  in 5187dfe; the CLI providers restored with it stay).
  - `_llm_inspector.ts`, `api/llm_inspector.ts`, `src/llmInspector/` and
    `shared/llmInspector.contract.ts`;
  - their tests and the `e2e/developer-ui.spec.ts` cases;
  - the `_model.ts` hooks, the `src/main.tsx` mount, and the
    `server/api-dispatcher.ts` / `server/app.ts` registration.
- **Parsing routes with no production caller, and their tests:**
  - `/api/server`, `/api/layout-models`, `GET /api/runs`;
  - `…/events`, `…/output.md`, `…/source.pdf`, `…/pages/{n}.png`;
  - `…/pages/{n}/boxes` and `boxes.py`;
  - `GET …/extractions` and `…/debug/{name}`.

  Point `e2e/realService.ts`'s readiness probe at `/api/models`, and adapt
  `e2e/real-service.spec.ts`. Keep the `kei_exp/jobs/` readers that M3
  deletes (`records`, `extractions_of`, `events_after`, `tokens.read_after`).
  Until M3, `kei_event` rows and `tokens.jsonl` then have no production reader.
  M2 replaces `/api/server` and `/api/layout-models` with one purpose-built
  `GET /api/ingestion-models`; M1 still deletes both.
- **Stale assertion.** Fix `result_version == 4`
  (`tests/test_service_smoke.py:248`).

**M2: platform, baseline and configuration — done 2026-09-26.** Task plan:
2026-09-26-dbos-m2-platform-configuration.md.

> Some items below moved to later milestones: the Compose removals, `source-inbox` and the worker waiting for Studio (M3/M4), `scripts/free.mjs`'s `parsing_db` and two safety tests (M3), the baseline's job, member, ingestion-key and suggestion edits (M4; `ChatTurn` was dropped by decision 15), and the key wrapper's `cancelSignal` (M4/M5). The M2 plan's deferral table lists each with its milestone.

- **Compose** (all overlays):
  - remove `parsing_db`, `parsing-postgres`, `parsing_migrate` and the parsing
    API's database environment;
  - add `source-inbox` and `FREE_DEPLOYMENT_CLI_PROVIDERS`, with both CLI
    kinds in the local development overlay;
  - make `parsing_worker` wait for Studio's healthcheck, after removing
    Studio's own `depends_on: parsing_worker` (`compose.yaml:137,142`), which
    would otherwise form a cycle;
  - in Studio's development watch, use `sync+restart` for server code (`api/`,
    `server/`, `shared/`, `packages/`) and keep `sync` for `src/`.
- **Studio entrypoint.** After `db:init`, create the kei role
  (`FREE_KEI_POSTGRES_PASSWORD`) and `kei_dbos` idempotently.
- **`packages/db` baseline.** Replace the ten migrations with one baseline.
  - It omits:
    - `SchemaSuggestion`, `SchemaSuggestionInput`, `ConversationalSchemaEdit`
      and `PromptRevision`, which no production code writes, together with
      their `SchemaRevision` columns;
    - the Catalog-retry columns;
    - `ExtractionJob` and `BatchExtractionMember`, not just their lease or
      checkpoint columns;
    - ingestion keys and their uniqueness constraint (retain project/content
      uniqueness);
    - per-source suggestion execution/result columns and transient phase
      mirrors;
    - the never-written `BatchExtraction.failure` and `finishedAt`.
  - Extraction gains admission inputs and a nullable terminal outcome; its
    result/review fields remain. Add batch/source uniqueness and preserve
    composite source and batch pins, with source deletion cascades.
  - Add suggestion `attempt` and its nullable terminal outcome, `ChatTurn`,
    the per-account configuration table and cascading suggestion membership.
    No credential table is added.
  - Delete the two historical migration tests and regenerate
    `migrations/app/refs/db.json`.
- **Configuration and keys.** Move the configuration to PostgreSQL, one per
  account, and the keys to the browser.
  - Make `model_config` and `model_probe` researcher-scoped.
  - Add the page's key store and `PUT /api/model-keys` with its account
    check, the in-memory cache and the lazy key wrapper, `hasKey` and
    `model_key_required`.
  - Add the `X-FREE-Studio-Boot` header and the resend in
    `authenticatedFetch.ts`, the draft's key clearing on a base or provider
    change, and fixed validation errors for `model_keys` and `model_probe`.
  - Drop the credential actions and `credentialStates` from the contract
    and from `useProviderConfigDraft.ts`.
  - Add the app shell's strict CSP in `server/static.ts`. The Vite dev server
    may keep a looser policy for its injected client.
  - Route resolution in `_provider.ts` takes the owner's account, and so do
    the Extraction Model Choice readers (`extractions.ts`,
    `batch_extractions.ts`, `batch_schema_suggestions.ts`).
  - Add the CLI deployment connections. The Model Configuration page lists
    them read-only and drops the CLI kinds from its "New connection" list
    (`src/providerConfig/ProviderConfigPage.tsx:250-252`).
  - Update `model_probe.ts`, `model_config.ts`, their tests and
    `e2e/model-configuration.spec.ts`, which gains a two-account case.
  - Remove the keyring packaging; update lockfiles.
- **Model Configuration page** (seventh revision). The prototype branch is a
  reference to read, not code to merge.
  - Contract: the per-account document gains `ingestionModels`, and the Schema
    Suggestion route loses `protocol` with its checks. The provider derives
    the protocol instead. The route resolver implements Schema Suggestion's
    inheritance.
  - kei's `GET /api/ingestion-models` and Studio's forwarding route.
  - The draft's single route setter replaces the mode and its setters. Write
    it together with this milestone's credential and key-clearing changes to
    `useProviderConfigDraft.ts`, so the hook is rewritten once.
  - The page as specified under *The page*.
  - Rewrite `e2e/model-configuration.spec.ts` once, for the steps and the
    two-account case.
  - The Ingestion Model Choice is stored from M2 and used from M4.
- **`scripts/free.mjs`.** Drop `parsing_db` from stop/restart.
- **`tests/safety.test.mjs`.** Cover kei's restricted URL, a parsing API
  without database access, and the app shell's CSP.
- **Acceptance** (moved from M0R, sixth revision):
  - A key sent for one API base is never used for another, and a draft base
    change never probes the new base with the old key. Sign-out and key
    removal clear the cache.
  - Opening the page sends each probe exactly the credential the rules allow,
    checked by inspecting the requests.
  - A stale tab's handoff under another signed-in account is rejected. A
    malformed key or probe request echoes nothing.
  - No account's call uses another account's key or connection. One
    account's concurrent applies serialize.
  - A `hasKey` connection with no cached key never calls its server
    anonymously.
  - Apply and Probe reject a researcher-defined CLI connection.
  - The app shell's CSP allows the PDF viewer and its worker, and refuses
    inline script.
  - kei's role is denied on `public` and `dbos`.
  - A NuExtract model on a vLLM connection runs Schema Suggestion with the
    NuExtract protocol, and no other route ever uses it. Test all four
    combinations of vLLM or not and NuExtract model ID or not.
  - An unset Schema Suggestion route follows the Assistant model. An explicit
    one stays explicit across a reload, even when it equals the Assistant
    model. "Use defaults" removes a step's stored choice.
  - The ingestion listing marks OCR models the OCR server does not serve, and
    the page cannot choose one. A saved choice it no longer lists stays
    saved, and a listing failure blocks no other edit.

**M3: kei on DBOS — done 2026-09-26 (task plan: 2026-09-26-dbos-m3-kei-on-dbos.md); Spark chunk measurement passed (m3-spark: 200-entry Catalog 105.7 s with 4 chunks vs 434.7 s unsplit).**
- **Dependencies.** Replace Procrastinate with `dbos` in `pyproject.toml` and
  `uv.lock`; `kei-worker worker` replaces `kei-jobs`.
- **New code.** `src/kei_exp/workflows/` holds the registration, the four
  queues, `convert`, `extract`, `deleteRuns` with the kei boot boundary, and
  the portable contracts. `failures.py` holds `classify`. The cooperative
  checks read the DBOS status.
- **Parallel Catalog chunks** (*kei worker*). `extract_grounded` splits into a
  document prelude, per-chunk entry work and a merge. Compose adds
  `NUEXTRACT_MAX_NUM_SEQS` for `nuextract_model` and `KEI_CATALOG_CHUNKS`,
  and the safety test asserts they match.
- **Ingestion model inputs.** `convert` takes optional `model` and
  `layout_model` keys. It resolves an omitted one in its first checkpointed
  step, from the definition the listing reports. The OCR default moves from
  Studio's `KEI_EXP_MODEL` (`compose.yaml:117`) to kei's `KEI_OCR_MODEL`,
  still `surya`, set on the parsing API and worker through one shared Compose
  anchor. The layout default stays `layout_heron_101`. A test checks that the
  listing's defaults equal the ones `convert` applies.
- **Deleted jobs code:**
  - `src/kei_exp/jobs/` except `hold_slot`, and the kei tables;
  - `POST /api/runs`, `GET /api/runs/{id}` and `POST …/extract`;
  - `DurableEmit` and `tokens.jsonl`;
  - the raw recovery SQL and worker-only `output.md` production;
  - the file-only projections in `runs.py`: `TERMINAL`, `UNRECORDED`,
    `_legacy_duration`, `summary`, `is_legacy`, `logged_events`, `replay`.
- **Deleted legacy readers:**
  - v4 manifests: `pagefile.py:228` and Studio's `_kei_exp.ts:86` union; the
    fixture `prototypes/studio/test/fixtures/kei-exp/result.json` is rewritten
    as v5;
  - the `options.model` branch (`kie/extract/run.py:58,63-68`,
    `kie/extract/models.py:109-117`), which Studio never sends.

  Extraction artifacts v1 and v2 both stay; both are produced today.
- **Tests.** Workflow, kill/restart, SIGSTOP, contract-fixture and
  publication-crash tests. Service smoke tests admit through DBOS.
  - Lanes: a large and a small conversion in one worker produce the same
    manifests as each alone. A cancelled step keeps its lane's slot, and
    only that lane's.
  - Two extractions of one run each publish their artifact, and the shared
    segmentation stays valid.
  - A test over `MODELS` fails if two Surya records would make `configure()`
    set different values.
  - Catalog chunks, with a deterministic scripted model: chunked and unsplit
    runs give the same artifact apart from call order and the chunk count.
    Covered: records, evidence, issues with document-wide record numbers,
    and document fields extracted once. A refusal in one chunk refuses the
    run; a failed chunk fails the step.
  - On the Spark (M0R 6 harness): a 200-entry Catalog finishes in about a
    quarter of the time, and a small extraction beside it finishes within
    seconds of its time alone.

**M4: Studio's background work on DBOS — done 2026-09-26.** Task plan: 2026-09-26-dbos-m4-studio-background.md.
- **`server/dbos.ts`** holds:
  - the configuration (app `studio`, schema `dbos`, version, executor);
  - one launch per process in `host.ts` and `developmentHost.ts`, replacing
    `extractionRuntime.run/close`; the development host drops its runtime
    reload (`server/developmentHost.ts:34-60`);
  - the Studio admission and kei handoff clients;
  - `studio`/`suggest` queues and schedule registration;
  - the database-clock boot timestamp used for cancelled Studio history;
  - the ownership and status-derivation helpers.
- **`packages/extraction`** gains `workflows.ts` and `kei-handoff.ts`.
  Admission inserts Extraction rows and enqueues on the same transaction.
  Add the small pool-client binding in `packages/db/src/prisma/db.ts`; keep
  PostgreSQL ownership and immutable-input replay checks in the admission.
  Completion updates the admitted Extraction; batch reads derive membership
  from those rows. Remove job/member DTOs and redundant joins.
  Delete `job-worker.ts`, claim/renew/checkpoint, the wake wiring, and the
  lease and status-mirror columns. Delete `_extraction_runtime.ts`, rehoming
  the exports used by `extraction_models.ts`, `document_reopen.ts`,
  `batch_schema_suggestions.ts`, `extractions.ts` and `batch_extractions.ts`.
- **Batch schema suggestion.** Add `suggestSchemaBatch`, atomic input snapshot
  and whole-batch retry. Delete the pump, `kick()` calls, lease methods and
  per-source execution/result state and UI. Preserve valid drafts when a
  source is deleted, with conditional attempt publication and explicit retry.
- **Ingestion and reprocess.** Add project/content replay, queue dedup and
  project/attempt staging. Delete ingestion-key requests/DTOs, browser key
  minting and all follower machinery. Keep reprocess request keys and
  expected-head checks. Share verify/translate/package functions and delete
  HTTP kei polling. Admission resolves the owner's Ingestion Model Choice into
  the workflow input and passes it to `convert`. Delete `KEI_EXP_MODEL` and
  `DEFAULT_MODEL` (`api/source_documents.ts:38,472`). Admission also counts
  pages and fixes the conversion lane (*Studio → kei handoff*).
- **Reads.** Derive execution status; revise public contracts together with
  callers, with no compatibility aliases. Keep completed result/review and
  evidence pin behavior. Extraction cancel now reaches kei.
- **Acceptance** (moved from M0R, sixth revision):
  - Kill after domain publication but before checkpoint: Extraction,
    ingestion, reprocess and batch draft writes remain idempotent.
  - Cancel racing completion has one winner. A confirmed failure uses a new
    operation ID/attempt; a row-backed replay after history GC never reruns.
  - A lost response/restart and a re-upload join active project/content work;
    a 504 preserves work. Completed-content replay happens before parsing.
  - Simultaneous same-project/same-content uploads use one active workflow.
    Identical PDFs in different projects have independent staging files.
  - Completion between precheck/enqueue is replayed by the workflow's content
    check. Failed/cancelled attempts can be retried without client keys.
  - Manual suggestion retry reruns all surviving pins; crash recovery of the
    same attempt skips checkpointed sources. No per-source progress rows.
    Repeating a retry POST with the same expected attempt returns its one
    successor, even if that successor finished before the repeated request.
  - Delete a source before, during and after suggestion publication: no FK
    error, preserved draft stays valid, surviving extraction results/reviews
    stay pinned. Late success/failure cannot overwrite an interrupted attempt.
    Empty selection retains the draft and disables Run/Retry.
  - Pending Extractions count as batch members but do not replace a previously
    reviewed result. A batch rerun creates new identities.
  - An ingestion recovered after its owner changed the Ingestion Model Choice
    runs the models it was admitted with. A re-upload of completed content
    returns the existing parse, and a reprocess uses the new choice.
  - Two same-content uploads under different choices join one attempt with
    its first admitted models. A repeated reprocess POST after the choice
    changed replays the original attempt, including after publication and
    after history retention.
  - A small document uploaded, or extracted, while a large conversion runs
    completes without waiting for it. A recovered or replayed ingestion keeps
    its admitted lane. A reprocess picks the lane from the revision's page
    count.
  - A PDF that pdf.js cannot open but PDFium can converts on
    `kei-convert-large`; one neither can open fails in kei as today.
    `runExtraction` records `keiRunId`.

**M5: interactive work on DBOS — done 2026-09-26.** Task plan: 2026-09-26-dbos-m5-interactive.md.
- **Workflows.** Add `suggestSchema`, `proposeSchemaEdit` and `chatTurn` with
  its answer write. Use `@dbos-inc/vercel-ai` for chat only, with the error
  sanitizer inside `durableCalls`.
- **Handlers.**
  - Operation and turn IDs, with a 409 on conflicting reuse.
  - Atomic question/enqueue with per-source-revision active dedup, a 409 for
    another active turn, and same-turn primary-key-conflict replay.
  - Owner checks and conditional answer/failure writes. A typed chat failure
    is followed by a sanitized throw, not a successful workflow return.
  - `GET` and `DELETE /api/model-operations`, `GET /api/chat/<revision ID>`
    and `/stream?turnId=<id>` for exact-turn reconnect.
- **Browser.**
  - `src/api.ts` repeats the same POST after a network failure or a
    502/503/504.
  - A new user action, including "try again" after a confirmed failure, mints
    a new ID. Ingestion retry sends the file again without any client key.
  - `generate_schema` carries the operation ID and the base revision. On
    load, the schema panel restores a running operation, saves a finished
    generation whose base is still current, and reopens an unreviewed
    proposal.
  - `ChatTab.tsx` loads the transcript, sends only the new question, uses the
    revision ID as its chat ID, reconnects to the returned turn ID on load
    and after a dropped stream, and rereads the transcript after 204/end.
    Delete the proposed custom superseded-chunk handler.
  - Aborts that come from a user action call the cancel route.
  - A new Studio boot ID resends the page's keys before recovery continues.
    `model_key_required` is already a terminal failure: resend, then retry
    with a new operation ID/attempt. Do not re-POST its failed ID forever.
- **Acceptance** (moved from M0R, sixth revision):
  - Kill after the chat answer write but before its checkpoint: the answer is
    written once.
  - Reload the page mid-`suggestSchema`, mid-`proposeSchemaEdit` and
    mid-`chatTurn`, and separately kill Studio at the same points. The page
    must find each operation.
  - A reloaded page saves a finished generation only onto its base, dropping
    it when newer work exists. A surviving tab keeps today's acknowledged-head
    save behavior, including edits during generation. The review bar returns.
  - The transcript returns and partial text replays once under the turn ID.
    New readers skip superseded attempts. A partial provider failure produces
    an error finish and persisted failure, never a saved partial answer or an
    in-process retry that appends replacement text.
  - An answer that finishes between the transcript read and the reconnect
    still appears, with the turn ID as its message ID.
  - A repeated POST after a dropped connection returns the same result.
    Exact-turn reconnect works across completion and returns 204 for expired
    history, followed by the authoritative transcript.
  - Change the route between attempts.
  - One HTTP and one CLI provider complete a chat turn end to end.
  - A second account can list, read, stream or cancel none of the first's
    operations or turns. Ownership holds on every reconnect, including after
    the project is deleted.
  - Plant a synthetic key in a provider error's cause chain, both in a JSON
    step and inside `durableCalls`. Plant one in a successful response's
    headers and provider metadata too. No input, output, error or stream
    record may contain the key.
  - Measure a chat turn's checkpoint size. It should hold the history and
    the answer, not the document.
  - Plant a key and run chat, generation, a batch suggestion and a probe.
    Neither a full `pg_dump` of `free`, nor the volumes, nor the logs may
    contain it.
  - Restart Studio mid-call with the page open, including between two
    polls. The new boot ID triggers the resend and the recovered call
    continues. With no page open, the call fails with `model_key_required`
    after the wait, and neither model retry owner retries it. Resending keys
    then retrying starts a new operation/turn ID or batch attempt.
  - A replayed step whose call is checkpointed never waits for a key. A
    cancel during the wait never reaches the provider, and a cancel during a
    provider call stops it about 1 s later.
  - A Schema Suggestion over the NuExtract protocol on a keyed vLLM
    connection passes the same key-wait, cancellation and no-key-in-history
    checks as the SDK models.

**M6: garbage collection, documentation, test wiring and cutover.**
- **Garbage collection.** Add the `collectGarbage` schedule and kei
  `deleteRuns` for both kei files and history. Deletion handlers also record
  interruption of affected suggestion attempts before removing membership.
  Apply the Studio boot boundary to cancelled history and repair missed
  cancellation calls; do not add tombstones, barriers or a status reconciler.
- **ADRs.**
  - Write `docs/adr/0012-one-durable-execution-layer.md`, linking this plan.
  - Write ADR 0013 (per-researcher model configuration, with keys held by the
    researcher's browser, and the Ingestion Model Choice), superseding 0006.
    Amend 0007 and 0011 as *Decision records* says.
  - Mark the Procrastinate plan and
    `prototypes/parsing_service/docs/job-backend.md` superseded.
- **README.**
  - #5: describe the unified Extraction record and remove the unimplemented
    Prompt Revision persistence promise with its unused table.
  - #7:
    - per-researcher configuration in PostgreSQL;
    - keys stay in the researcher's browser, and Studio holds them only in
      memory while a call runs;
    - deployment connections, including `FREE_DEPLOYMENT_CLI_PROVIDERS`;
    - the Ingestion Model Choice, which applies to new ingestions and
      reprocessing only;
    - no reset.
  - #8: DBOS schemas migrate at launch.
  - #10: browser-held researcher keys, no OS-keyring dependency, and the
    one-time reset note; deployment secrets remain operator-provided.
  - Extraction execution: cancellation reaches kei.
- **Other docs.**
  - CONTEXT.md's configuration terms, as *Decision records* lists them;
  - the Parsing README and CLAUDE, Studio CLAUDE and
    `docs/architecture/current.c4`;
  - the OpenSpec specs for model-connection configuration, capability-route
    resolution, source-document ingestion and schema chat edit;
  - CONTEXT.md's Model Attribution, reconciled with interactive work, which
    stores none (*No pins*). A replayed result never gains attribution
    reconstructed from today's route.
- **Operations docs.**
  - Backup set: a `free` dump, `source-inbox`, `parsing-runs`, `studio-data`
    and the CLI homes.
    No backup holds a researcher key.
  - DBOS inspection of both schemas.
  - Patch and version rules.
  - The cutover runbook.
- **Test wiring.**
  - `e2e/realService.ts`, the Playwright stack and configs, and
    `e2e/playwright.compose.yaml` start the kei worker.
  - `.github/workflows/verify.yml` and `scripts/test-ci.mjs` migrate the
    guarded test schemas.
  - `packages/db/package.json` runs `source-reprocessing.postgres.check.ts`.
- **Acceptance** (moved from M0R, sixth revision):
  - In-flight runs/packages and children of live Studio parents survive.
  - After a blocked cancelled native step exits and cleanup runs, no late
    orphan checkpoint remains.
  - A run with a cancelled kei workflow survives every sweep while that kei
    process lives, and is removed after a kei restart. Runs that ended
    normally are removed without one. A conversion running in another lane
    never loses files to a sweep.
  - Late handoff: hold an extraction's `submitToKei` enqueue, delete its
    source, let the parent be cancelled, and run GC. The run survives until
    a Studio restart, and the late kei extraction never overlaps its
    deletion.
  - Recovery exhaustion: crash the kei worker until a workflow reaches
    `MAX_RECOVERY_ATTEMPTS_EXCEEDED`. Its run survives GC in that process
    and is removed after the next kei restart.
  - Current-process cancelled Studio history survives GC regardless of age;
    a fully terminated process followed by restart permits eligible cleanup
    using the database-clock boot boundary. No in-place relaunch.
  - Cancel publication then crash before DBOS cancel; the next sweep cancels
    Studio work with terminal domain outcomes and any late kei submission.
  - Delete a project, then apply reference, retention and quiescence rules in
    both schemas. Failed reference/status queries delete nothing.
  - Stage then crash before enqueue; crash after enqueue; lose a dedup race:
    GC removes only unused/terminal files and never the active attempt's PDF.

## Verification

> **Not built (decision 15, 2026-09-26):** the chat items below (active-chat exclusion, one answer per chat turn, a reload mid-chat, chat reconnect and re-POST recovery, chat across a reload and a restart) are not verified; generation and edit proposals are. `free-document-chat` stays in the residue search.

- **Residue search.** Search production code, dependencies, generated
  contracts, tests and operational docs for Procrastinate, lease/claim/renew/
  wake, `kick()`, `checkpoint(`, `ConfigFileSystem`, keyring/D-Bus, the
  model-configuration write barrier, targeted Catalog retry, inspector hooks,
  `/events`, `cancel_requested`, `free-document-chat`, `result_version` 4,
  `options.model`, `ExtractionJob`, `BatchExtractionMember`, ingestion keys,
  follower workflows, admission waits, per-source suggestion progress,
  `configurationMode`, a stored NuExtract `protocol`, and `KEI_EXP_MODEL`.
  Historical records and evidence probes are not runtime residue.
- **Fast and safety.** `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm test:safety`.
- **PostgreSQL** (`pnpm test:postgres`):
  - atomic admission, concurrent replay, active-chat exclusion and rollback;
  - derived status and idempotent publication across checkpoint gaps;
  - cancel racing `complete`;
  - both deletions, preserved suggestion drafts and surviving batch members,
    then garbage collection under quiescence and reference guards;
  - per-account configuration isolation, and no key in any table;
  - one answer per chat turn when an answer races a cancel;
  - expected-head races, ingestion content/dedup races, whole-batch retry
    versus same-attempt checkpoint replay;
  - kei role denial.
- **Real service and E2E** (`pnpm test:e2e`, `pnpm test:service`):
  - native PDF Evidence parity;
  - Studio and kei kill/restart with no duplicate kei work;
  - priorities and deadlines;
  - lanes: a small ingestion and extraction finish while a large conversion
    runs;
  - cancelling a blocked native step;
  - a page reload mid-chat, mid-generation and mid-edit;
  - a Studio restart with the page open, where the keys are resent and the
    call continues;
  - chat reconnect and re-POST recovery;
  - the PDF viewer under the app shell's CSP.
- **Manual.** Run `pnpm dev` through upload, reprocess, extraction and cancel,
  batch retry, schema-edit acceptance, and chat across a reload and a restart,
  with two accounts. Inspect both DBOS schemas. On the GPU deployment, ingest
  a scanned PDF under a non-default OCR and layout choice and check that its
  recipe names them. Then upload a small scanned PDF while a large scan
  converts, and extract from it. The e2e real service has no OCR server
  (`e2e/realService.ts:168`), so it cannot prove either.

A compile pass or a mocked SDK call does not prove recovery, isolation or
physical exclusion.

## Risks

- **One Studio process.** A restart interrupts in-flight calls; unfinished
  steps can repeat on recovery. Chat reconnects and replays the current
  attempt. Exactly-once provider execution is not claimed.
- **Research content in DBOS history.** Settled chat/proposal history has a
  24-hour retention target and background history 30 days. Live parents and
  unquiesced cancellations can extend it; scope deletion can shorten age but
  never bypass quiescence. Dumps include this history and ChatTurn transcripts.
- **Cleanup can wait.** A hung native step blocks its lane. Cancelled Studio
  history and cancelled kei runs can remain until a later restart of their
  process. This trades a bounded deletion promise for safe cleanup without a
  new execution barrier.
- **Output varies under concurrency.** vLLM's batching changes arithmetic
  enough to flip borderline answers. On a synthetic Catalog, about 10% of
  `fundart` values (a trailing dot, or a value against null) differed when
  NuExtract served four requests at once. Serial runs differed in 0–1 of 200.
  This already happens whenever Studio and kei share a server. Two extraction
  slots make it more frequent, and parallel Catalog chunks (M3) make it
  routine. The user accepts it. vLLM's batch-invariant mode does not support
  these models (M0R 6).
- **Cutting before OCR.** A 2000-page scan spends about 90 min cutting on the
  CPU and holds all its crops in memory before OCR starts. Its budget and
  memory beside a small conversion are measured in M0R 6.
- **Lanes add no throughput.** A small document beside a book costs the book
  about 10% (250 s to 275 s) and adds about 8 s to the small one.
- **Whole-batch retry costs.** Explicit suggestion retry repeats every remaining
  source call; per-source progress/results disappear after DBOS retention.
  Only the merged research proposal, draft and membership pins persist.
- **Researcher-supplied API bases (pre-existing).** Studio connects to any base
  a researcher enters; ADR 0006 allowed that for one local researcher.
  Per-researcher configuration stops one researcher from redirecting
  another's documents. A researcher can still make Studio call hosts on its
  network, and a hosted deployment may want an allowlist (out of scope).
- **Keys in use.** Studio sees each key while it calls the provider. An
  operator who changes Studio's code could capture keys; nothing stored can
  leak them.
- **Keys in the browser.** A script injected into Studio's origin could read
  them. The CSP, React's escaping and a patched pdf.js are the defence. Keys
  are entered once per browser.
- **Personal keys across a restart.** Background work on a personal key
  fails after a Studio restart unless the researcher's page is open to resend
  it; the researcher retries it.
- **Shared CLI login.** A CLI deployment connection runs every researcher's
  calls on the operator's one login, with its billing and rate limits.
- **Coarse kei steps.** A crash repeats a whole conversion or extraction, up to
  3 h of GPU time.
- **One server, one kei worker.** No throughput gain is claimed. Studio's own
  calls to the extraction servers sit outside kei's queues, so their effect
  on kei extraction is measured, not bounded (M0R 6).
- **CLI token refresh** remains a provider risk.

## Out of scope

- Operator-provided keys for hosted providers. Deployment connections cover
  vLLM and the CLI providers.
- An allowlist for researcher-supplied API bases.
- Sharing a Project Context between researchers.
- Persisting the schema panel's message log; more than one chat thread per
  revision; carrying a transcript over to a reprocessed revision.
- Asynchronous ingestion (202, status URLs, hydration) and listing in-flight
  ingestions after a reload; re-uploading the file rejoins active content work
  instead. Parallel uploads and new retry controls. *(Brought into scope for uploads on 2026-09-27:
  server-owned Source Ingestion.)*
- Per-model-call Python checkpoints, and kei progress events or token
  streaming.
- Fair sharing between accounts, and pausing or preempting running work.
  Lanes by page count are in scope (decision 14).
- A per-page conversion fan-out. The rev-8 review rejected it:
  - page children would each call `write_result`, which starts a new
    generation and deletes other pages' files (`result.py:237`);
  - a waiting parent would hold a slot in its children's queue;
  - cancellation, deadlines and cleanup would need a tree contract.
  Streaming crops into OCR inside one job would remove the cutting delay
  without these problems. It is a later improvement.
- Chunked Article extraction, a debug dashboard, and agents/MCP/embeddings.
- Calling providers straight from the browser. That would keep keys away from
  Studio entirely, but it would take model work out of DBOS and lose reload
  recovery.

## Revision history

- **HEAD (approved).** Behaviour-preserving port, commit-then-enqueue with a
  reconciler relay, and credentials revisioned in PostgreSQL.
- **Staged and working-copy revisions (2026-09-24).** Widened the scope to
  durable interactive AI, trigger-based atomic admission, `StudioModelOperation`,
  pinned credential revisions, 202 ingestion and a deletion barrier. Three
  read-only `gpt-6-sol` checks refined them. The working copy is preserved as
  git blob `c1fcf5a6` (`git show c1fcf5a6`).
- **Third revision (2026-09-24).** Applies the user's decisions on data,
  interactive durability and credentials. After a fresh review it replaces:
  - triggers with start-before-commit and workflow-first starts;
  - the fence with workflow ownership and derived status;
  - the barrier with reference garbage collection;
  - the worker service with DBOS in the Studio process.

  It drops pinning, the reconciler, asynchronous ingestion and per-call Python
  checkpoints.
- **Fourth revision (2026-09-24, browser-key update 2026-09-25).** Applies later user decisions:
  - Interactive work survives a browser reload. It adds `ChatTurn`
    transcripts and an operation listing. The listing restores running work,
    finished generations whose base is still current, and unreviewed
    proposals.
  - Model configuration belongs to each Researcher Account. This also stops
    one researcher from re-pointing another's routes.
  - Keys stay in the researcher's browser (user, 2026-09-25). Studio holds
    them only in memory, which removes the credential table, the encryption
    and its key. An earlier draft of this revision stored them encrypted in
    PostgreSQL.
  - All providers stay for an open-source release. The CLI providers become
    operator-enabled deployment connections.

- **Fifth revision (2026-09-25).** Applies the approved simplification review:
  transactional admission; one Extraction row including batch membership;
  upload content replay/dedup without keys/followers; whole-batch suggestion
  retry; proposals preserved on source deletion; per-revision chat exclusion,
  exact-turn replay and truthful stream failures; quiescent cancellation GC;
  no worker Markdown output. Preserves the fourth revision's browser-key work.
- **Sixth revision (2026-09-25).** Bumps the pins to 5.1.10 / 0.4.4 / 3.1.0
  after all review probes reproduced on them. 0.4.4 no longer checkpoints a
  stream's request body or response headers, so the chat sanitizer maps errors
  and strips provider metadata only. The key wait and cancelled Studio model
  calls use `DBOS.stepStatus.cancelSignal`. Clients set `applicationName`.
  M0R keeps pre-implementation probes only (adding the production-bundle
  check); checks that need FREE's own code became acceptance lists of M2,
  M4, M5 and M6.
- **Seventh revision (2026-09-25).** Folds the Model Configuration page
  redesign into M2 after a throwaway prototype; the user picked variant B1
  (branch `prototype/model-config-b1`). The page has three workflow steps, no
  Single/Routes mode and one route setter. The NuExtract protocol is derived
  from connection and model. A per-account Ingestion Model Choice is wired
  through kei's `convert` input (M3) and ingestion admission (M4). M1 is
  unchanged. A Codex review then made an unset Schema Suggestion Route
  inherit the Interaction Route and froze ingestion models at admission. It
  also brought the raw NuExtract call inside the key boundary.
- **Eighth revision (2026-09-25).** Sizes kei's scheduling for the Spark
  (decision 14). The one `kei` queue becomes `kei-convert-large`,
  `kei-convert-small`, `kei-extract` (two slots) and `kei-gc`, each with a
  worker limit. Studio fixes the conversion lane at admission from the page
  count. `SURYA_INFERENCE_PARALLEL=4` stops a book from flooding the OCR
  server. `deleteRuns` gets a kei boot boundary instead of queue exclusion.
  Rejected on the way: a per-page conversion fan-out, and per-account fair
  sharing through DBOS partitions. Parallel Catalog chunks join M3 once the
  user accepted the output variation. Spark measurements back every number.

## M0 findings (2026-09-24)

The spike ran on x86_64 against a throwaway `postgres:17`. It used
`@dbos-inc/dbos-sdk@5.0.2` (Node 24.21) and `dbos==3.0.0` (Python 3.13). The
code stays in the session scratchpad and is not kept. These are historical
observations, not the active design: M0 #6's Prisma limitation was disproved
by the fifth-revision client-binding probe; M0 #2's reconciler reference is
superseded by explicit cancellation and scheduled cancellation repair.

| # | Result | Evidence |
|---|---|---|
| 1 | Pass | The TS client enqueues portable Python workflows, both positional and keyword-only (`enqueuePortable(opts, [], {tag})`). **Re-enqueueing an existing id is a no-op in every state:** SUCCESS and ERROR are not rerun, PENDING and ENQUEUED run once, and CANCELLED stays cancelled. So retries need attempt-scoped ids, as planned. |
| 2 | Pass | A Studio workflow awaits kei through bounded `pollKei` steps. After a Studio cancel, no poll ran later than 1.5 s. The cancel does **not** cascade to the kei workflow, which stayed PENDING; this confirms the explicit cancel and the reconciler. Killing Studio mid-poll resumes it, and kei executes once. |
| 3 | Pass | Killing kei mid-step, then restarting it, re-executes that step (2 executions, `recovery_attempts=2`) and the workflow succeeds. A second process gets `SLOT_TAKEN` from the flock. |
| 4 | Pass | `dbos_system_schema: "kei_dbos"` works. The `kei` role migrates and owns only its schema. |
| 5 | Pass | A step whose side effect ran before its checkpoint is re-executed after a kill, so steps are at-least-once. |
| 6 | **Partial** | `dbos.enqueue_workflow` exists in both schemas. In a plain `pg` transaction, a rollback leaves nothing, a commit enqueues (priority, timeout, `portable_json`), and a duplicate id is idempotent. **But Prisma Next 0.16's `raw` tag only builds typed expressions** (`raw\`…\`.returns(codec)`). I found no public way to run this statement inside `database.transaction`. |
| 7 | Pass | Priority 1 runs before 10, and FIFO ties hold after a restart. The TS option is **`workflowTimeoutMS`**; `timeoutMS` is silently ignored. The timeout starts at dequeue and is enforced at the next step boundary (4 s → cancelled at +5.0 s with 1 s steps). The **absolute deadline survives a restart** (cancelled at +4.9 s); a recovered workflow returns to ENQUEUED. |
| 8 | Pass | No kei rows appear in `free.dbos`, and the Studio process never ran kei work. |
| 9 | Pass | The `kei` role is denied (42501) on `public` tables, on `dbos.workflow_status` and on `CREATE` in `public`. |
| 10 | Pass (no built-in) | The CLI has no retention command and `garbage_collect` is internal. The retention workflow uses the public `listWorkflows` (terminal, older than the cutoff) and `deleteWorkflows` on both schemas. |
| 11 | Pass | A 5 MiB result with nulls round-trips in about 1 s. **A Python `datetime` arrives as an ISO string**, so the contract declares ISO strings. |
| 12 | Pass | A `kei@1` workflow stays ENQUEUED under a `kei@2` worker. A worker with `run_migrations: false` refuses to start on an unmigrated schema ("requires 114"). |
| 13 | Pass | Connections per process: the kei worker holds 4, and the Studio worker 3 plus 1 per client pool. |
| ARM64 | Packaging only | The TS SDK is pure JS. `greenlet`, `sqlalchemy`, `psycopg-binary` and `pyyaml` have `cp313` aarch64 manylinux wheels. The runtime check on Spark happens at deploy. |

## Review log

Earlier entries record decisions at that time; conflicting advice is
superseded by the fifth revision and its evidence record. In particular,
start-before-commit, upload-key followers, encrypted server credentials and
age-only cancellation cleanup are not implementation instructions.

- **2026-09-24, Codex `gpt-6-astra` read-only review of the first draft:** 1 P0, 12 P1, 1 P2.
  - **P0 (kei's DML on a shared `dbos` schema could rewrite Studio checkpoints):** resolved by the user's decision for app-owned schemas on one server.
  - **Accepted:**
    - the reconciler, and terminal outcomes written by the web and the reconciler;
    - a minimal `SourceIngestion` row;
    - attempt-scoped ids;
    - fingerprint conflicts;
    - deterministic run ids with one-step convert/extract (no stale probe checkpoint);
    - Studio's commit as the acceptance boundary, keeping kei's fail-open gate;
    - `studio-extract` at concurrency 1 with priority, and a FIFO kei queue;
    - late success as an explicit change, with the full status matrix;
    - deletion and sweeper rules;
    - credential revisions;
    - the cutover fence and rollback;
    - the missing importers, callers, tests, lockfiles, Playwright stack, worker environment and launcher;
    - 13 M0 questions.
  - **Answered rather than changed:**
    - "one server does not require one schema" (adopted);
    - the throughput gain (none claimed);
    - atomicity limits (stated);
    - the backup wording (fixed).
- **2026-09-24, fresh review of the expanded revision (Claude; Codex `gpt-6-astra` read-only, independent brief):** both reviews agreed on the four largest cuts.
  - **Accepted:**
    - workflow-first starts, or starts after commit, instead of admission triggers;
    - derived status instead of status mirrors and the reconciler;
    - reference garbage collection instead of the deletion barrier;
    - DBOS in the Studio process;
    - no credential revisions or pins;
    - queues cut to real resource limits;
    - deletion of the targeted Catalog retry, the LLM inspector and the unused kei routes;
    - coarse Python steps;
    - a clean-slate cutover (user decision).
  - **Changed by the user's decisions:** interactive work stays durable, built from DBOS primitives instead of a fence table: operation IDs, `authenticatedUser`, and `durableCalls` for chat.
  - **Corrections to the expanded revision:**
    - Python has no transport-retry loop for DBOS to replace (`llm.py:97-99` is format negotiation);
    - nothing in production sets `cancel_requested`;
    - `/events` has no consumer;
    - four tables have no production writer;
    - Studio has no admission caps to preserve.
  - **Kept against the review:**
    - the separate kei schema, because kei parses untrusted PDFs;
    - bounded 30 s cross-schema polls.
- **2026-09-24, Codex `gpt-6-astra` read-only adversarial review of the third revision:** 9 P1 and 3 P2, no P0. The foreign-key, middleware, `classify` and extraction-UI claims were checked against source; all 12 were accepted.
  - **Workflow history:**
    - delete only settled history, because the payload tables lost their foreign keys in migration 109 and a late checkpoint would be orphaned;
    - protect the kei children of live Studio parents from GC.
  - **Cancel propagation:** retry it by cancelling live kei work whose parent is terminal.
  - **Retries and admission:**
    - a retry after a confirmed failure mints a new key;
    - start before commit, since the extraction UI reconciles by reading, not by re-posting;
    - content-addressed staging, with a post-start `sha256` comparison.
  - **Batches:** a checkpointed source list per batch attempt, attempt-guarded publications, and retry only from terminal states.
  - **Ownership:** checked in PostgreSQL on every access.
  - **Development:** a process restart instead of an in-place DBOS relaunch.
  - **Smaller fixes (P2):**
    - chat checkpoints include the document text, so interactive history is kept 24 h;
    - a boolean `should_retry`;
    - patching flags.
- **2026-09-24, Codex `gpt-6-astra` read-only adversarial review of the fourth revision:** 7 P1 and 4 P2, no P0. The error-serialization, store-replay, probe and save-coordinator claims were checked against source; all 11 were accepted, two with a simpler fix than proposed.
  - **Secrets:**
    - sanitize provider errors inside the step boundary, which for chat lies inside `durableCalls`, because DBOS serializes enumerable causes;
    - read a connection and its ciphertext in one snapshot;
    - fail closed for optional-key providers too.
  - **Generation:** keep the browser's save and bind it to the operation ID (`SchemaRevision.operationId`). That preserves today's conflict rules and editing during regeneration. Codex proposed a conflict-checked server-side save; the tab's acknowledged head and the commit-to-checkpoint replay window make that harder.
  - **Chat:**
    - commit the question before starting the turn;
    - reconnect to the newest unanswered turn, running or just finished, and re-read after a 204;
    - use the turn ID as the message ID.
  - **Ingestion:** a same-bytes upload under a new key starts its own follower workflow (`DBOS.getResult`), so every key stays bound; Codex proposed a key-binding record. Staged files are left to garbage collection, which also fixes a same-bytes staging race in the third revision.
  - **CLI:** Apply and Probe reject researcher-defined CLI connections.
  - **Smaller fixes (P2):**
    - an explicit `extractionSchemaId: null` scope for first generations;
    - a proposal is restored only onto a clean draft;
    - Discard deletes every finished proposal on the same base.
  - **Deletions it found:** the accountless configuration fallbacks and the personal-CLI branches.
- **2026-09-24, Codex `gpt-6-astra` read-only check of those fixes:** 3 P1 and 5 P2, no P0. The accumulator, save-coordinator and awaited-cancel claims were checked against source. Seven were accepted; one was answered.
  - **Generation:** an unsaved generation carries its base revision and is saved after a reload only while that base is still current, since it could otherwise overwrite newer work. The expected-head check then prevents a double save, so the `SchemaRevision.operationId` binding from the previous round goes. It could not follow the coordinator's coalesced saves anyway.
  - **Secrets:** the chat sanitizer also drops the request body, response headers and provider metadata that `durableCalls` checkpoints on success. As a side effect, a chat turn's DBOS history no longer holds the document.
  - **Chat:** back to start-before-commit, because a crash between commit and start stranded the question.
  - **Ingestion:**
    - staging is per content and key (`<sha256>.<ingestion key>.pdf`), so no two workflows share a file, reuse cannot race garbage collection, and each workflow deletes its own file again;
    - a failed or cancelled leader becomes the follower's typed failure.
  - **Discard:** deletes the discarded proposal and older ones on the same base, never a newer one. A retry in flight across a Discard may rerun one edit; that is accepted rather than adding a dismissal record.
  - **Answered:** an existing-content replay leaves its key unbound, and a follower's binding lasts 30 days. Today's replay path behaves the same, and keys are minted per upload.
- **2026-09-25, keys kept out of Studio's storage (user decision), then a Codex `gpt-6-astra` read-only check of that design:** 4 P1 and 2 P2, no P0. The draft-probe, retry-classification and cancel claims were checked against source, and all 6 were accepted.
  - **Draft probes:** changing a draft's base or provider clears its key and cancels the scheduled probe. Today the typed key is probed against the new base after 500 ms.
  - **Waiting for a key:**
    - the key is read lazily inside each provider attempt, so replaying a checkpointed step never needs one;
    - the wait is 60 s, ends on cancellation, and fails with `isRetryable: false`, so `durableCalls` does not retry it.
  - **Resending keys:** every response carries `X-FREE-Studio-Boot`, and `authenticatedFetch` resends keys when it changes. That covers a restart between two polls. The Chat tab also reconnects after a dropped stream.
  - **Races:** a cached key is used only while the connection still has that base, so stale entries are harmless without a lock. Removal stops new calls only.
  - **Accounts (P2):** the handoff names its account and a mismatch is rejected. Sign-out semantics across browsers are stated.
  - **Echo (P2):** the key and probe endpoints return fixed validation errors and log nothing.

- **2026-09-25, DBOS simplification review with Claude Code Opus 5.5, medium:**
  focused PostgreSQL/SDK experiments reproduced poisoned admission, chat error
  serialization/finish defects and the source-deletion FK failure. Transactional
  enqueue through Prisma Next, active dedup, concurrent question admission and
  cancelled-step queue exclusion passed. The user retained streaming, chose
  whole-batch retry, dropped upload keys, and kept proposals valid after source
  deletion. See commands, results and sparring decisions.
  The full browser/provider/ARM64/deployment gate remains pending.
- **2026-09-25, DBOS prompting pages and agent skills against the pins (user
  request), then the M0R 1 rerun:** the pages describe TS 5.1 and Python 3.1,
  released 2026-09-24, one release past the fifth revision's pins. Accepted:
  bump the pins; narrow the sanitizer to what 0.4.4 records; use
  `cancelSignal` for the key wait and Studio calls; keep DBOS external to
  Studio's Vite SSR build; set `applicationName` on every client; register
  `kei` only from kei. Not adopted: pasting the prompts into `CLAUDE.md`,
  whose generic rules (one file, jest, always `DBOS.runStep`) conflict with
  FREE; the installed project skills are loaded on demand instead. All five
  review probes and the new `version-probe.mjs` passed on the new pins; see
  the evidence record.
- **2026-09-25, Model Configuration prototype (user request):** the user found
  the page too complicated. A throwaway prototype, on branch
  `prototype/model-config-b1`, put today's page beside six redesigns against an
  in-memory fake server.
  - The Single/Routes mode was the main source of complexity. `ModelConfig`
    has no mode, so it existed only in the page, doubled the route setters and
    warned when the routes differed.
  - User decisions: variant B1; the label *Assistant model*; NuExtract
    auto-detection; ingestion models on the page, for new ingestions and
    reprocessing only.
  - Rejected: B2's split by where models run, because deployment servers are
    routable connections too. The assistant could run on "Deployment
    NuExtract" while it was listed under "From your connections".
- **2026-09-25, Codex `gpt-6-astra` read-only review of the seventh
  revision:** 5 P1 and 3 P2, no P0. Every claim was checked against source.
  All 8 were accepted, one with a different fix.
  - **Defaults (P1, different fix):** Codex had Studio write kei's defaults
    into the admission input. Instead, explicit choices are frozen at
    admission, and kei resolves an omitted role in a checkpointed first step
    of `convert`. Admission then never depends on the listing, and queued work
    follows an operator's OCR swap.
  - **Replay (P1):** same-content joiners take the active attempt's models.
    Reprocess replay reuses the admitted models, and its fingerprint stays
    unchanged.
  - **Inheritance (P1):** an unset Schema Suggestion Route inherits the
    Interaction Route. The prototype inferred it from equality, which could
    not keep an explicit override equal to the Assistant model.
  - **NuExtract keys (P1, predates this revision):** the raw NuExtract fetch
    carried a pre-resolved `authorization`. It now shares the attempt's key
    boundary.
  - **Compose (P1):** the sixth revision's worker-waits-for-Studio edge would
    have formed a cycle with Studio's `depends_on: parsing_worker`.
    `KEI_OCR_MODEL` is wired to both parsing processes.
  - **P2:**
    - the listing's availability wording, and the fact that layout only
      reaches scanned pages;
    - probe eligibility when the page opens;
    - the read-route count and the recipe citation;
    - a manual OCR-selection check;
    - Model Attribution in CONTEXT.md.
- **2026-09-25, the workload goal (user):** the user asked whether DBOS can
  use Redis and whether it fits prioritising, pausing, retrying and resuming
  work on the Spark. Redis cannot be a DBOS system database (PostgreSQL or
  SQLite only). Priority does not preempt. The seventh revision's single
  `kei` queue made a small extraction wait for a book's conversion, even
  though the two use different vLLM servers. A first proposal (A–D) added a
  queue per server, a per-page conversion fan-out, a client-width rule and
  per-account partitions (`fair_queue_probe.py`). Hatchet and Temporal
  (whose fairness keys became generally available in May 2026) were
  reconsidered for fairness and rejected again: DBOS runs in-process, and
  admission enqueues inside the domain transaction.
- **2026-09-25, Codex `gpt-6-astra` read-only review of A–D**
  (brief,
  run by the user in T3): 4 P1, 6 P2, 1 P3. Claude checked each claim against
  source; all 11 were accepted.
  - **`deleteRuns` (P1):** its safety came from queue exclusion. It now uses
    a kei boot boundary.
  - **Worker limit (P1):** global and partition limits count `PENDING` rows,
    so every kei queue also sets a worker limit.
  - **Fan-out (2 P1, 1 P2):** per-page children would each run `write_result`
    and delete each other's pages, a parent would hold its children's slot,
    and the tree needs a deadline and cancel contract. The fan-out was
    dropped.
  - **Partitions (P2):** they give random sharing and lose cross-account
    priority. Fairness is deferred.
  - **Claims withdrawn:**
    - text-layer routing is per document (P2);
    - Surya's width is a GPU-table guess of 32, not the server's 4 (P2);
    - `resume_workflow(queue_name=)` exists in 3.1.0 (P3).
  - **Same-tab uploads (P2):** the browser uploads one file at a time. The
    user kept this out of scope.
  - **Probe (P2):** its metrics were flawed. The Spark measurements replace
    it.
- **2026-09-25, Codex `gpt-6-astra` read-only sparring round on the lane
  plan:** it kept the lanes and rejected any fixed wait bound, which the
  measurements now replace. All four points below were accepted.
  - Classify before enqueue, including reprocessing: pages are counted at
    admission (pdf.js), and the lane is kept in the workflow input.
  - Check shared state. Surya's `configure()` is safe with one record. The
    pdfium lock covers a whole document only for `cut=none`.
  - One extraction slot would block short work, so `kei-extract` gets two.
  - Keep routine cleanup of runs that ended normally, and defer only
    cancelled ones to a restart.
- **2026-09-25, Spark measurements (user-approved):** run on production
  model servers from throwaway containers, with synthetic documents. Nothing
  was restarted. Results, harness and raw data are in
  rev8-tests;
  the numbers are quoted under *Queues*, *kei worker* and *Risks*. The user
  noted that chunking Article extraction is harder, and that Catalog
  chunking needed testing first. It works, and is deferred behind the
  output-variation decision.
- **2026-09-25, batch-invariant test (user-approved):** the user accepted
  the output variation, set the small-document threshold to 30 pages and
  shipped `SURYA_INFERENCE_PARALLEL` in Compose. `VLLM_BATCH_INVARIANT=1` was
  tried on a second NuExtract server beside production, from the same image
  and arguments. vLLM 0.29.1 refused it for gated-delta-net attention, and
  both extraction models use it. The test server was removed.
- **2026-09-25, Codex `gpt-6-astra` read-only review of the eighth
  revision:** 1 P1, 2 P2, 1 P3. Claude checked each against source; all 4
  were accepted.
  - **Late handoff (P1, new with the lanes):** a cancelled extraction parent
    can finish `submitToKei` after cleanup checked its run. The single queue
    used to order that extraction behind `deleteRuns`; the lanes let the two
    overlap. Runs are now protected through a `keiRunId` attribute and
    Studio's boot boundary.
  - **Page count (P2):** `api/_pdf.ts` opens outside its error handling and
    renders every page. A count-only helper replaces it, and a PDF pdf.js
    cannot open goes to the large lane instead of being rejected.
  - **Recovery exhaustion (P2):** `MAX_RECOVERY_ATTEMPTS_EXCEEDED` fell
    outside both cleanup rules. Every status other than `SUCCESS` or `ERROR`
    now waits for a kei restart.
  - **Wording (P3):** the Surya numbers are labelled as the pre-change
    baseline.
  - Confirmed correct:
    - cancel and deadline stamps come from the database clock;
    - worker limits hold on all four queues, including after recovery;
    - Compose renders at widths 4 and 2, with no dangling anchor;
    - the plan's numbers match the evidence.
- **2026-09-25, parallel Catalog chunks into M3 (user):** after the
  batch-invariant test, the user put chunking into M3. Two things the test
  harness got wrong are fixed in the M3 design: document-level fields are
  extracted once, not once per chunk, and entries keep document-wide
  numbering. The chunk count follows NuExtract's `--max-num-seqs` through
  Compose, as the OCR width does.
