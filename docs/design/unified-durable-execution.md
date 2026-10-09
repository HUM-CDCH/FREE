# FREE on DBOS: durable jobs and AI execution

FREE runs its background and interactive work as DBOS workflows. Studio runs
DBOS inside its server process; kei, the Parsing Service's worker (package
`kei_exp`), runs its own DBOS application. The pins are `@dbos-inc/dbos-sdk`
5.1.10 and `dbos` 3.1.0. Decisions:
[ADR 0012](../adr/0012-one-durable-execution-layer.md),
[ADR 0014](../adr/0014-server-owned-source-ingestion.md) (uploads) and
[ADR 0017](../adr/0017-durable-extraction-control-and-call-checkpoints.md)
(durable Extractions). Code comments cite this document as `(spec, *Label*)`.

## Decisions

1. **DBOS in both apps.** Rejected: a Procrastinate HTTP relay, a stateless
   kei, Hatchet/Temporal, Absurd, a hand-written scheduler.
2. **DBOS runs inside the Studio server process;** there is no `studio_worker`.
3. **App-owned system schemas in database `free`:** Studio's `dbos` and kei's
   `kei_dbos`. kei parses untrusted PDFs, so its role owns only its schema and
   cannot rewrite Studio's workflow inputs.
4. **Background and interactive model work run as DBOS workflows.** Schema
   generation and edit proposals survive a browser reload and a Studio restart.
5. **No compatibility layer.** No data migration, compatibility reader or
   rollback import exists for job stores older than DBOS.
6. **Model configuration belongs to each Researcher Account; keys stay with
   the researcher**, in their browser; Studio holds a copy only in memory.
7. **All eight provider kinds stay.** The Codex and Claude Code CLI providers
   run on the server's own login, as operator-enabled deployment connections.
8. **Withdrawn:** live chat streaming with DBOS stream replay (decision 15).
9. **Manual batch-suggestion retry reruns every remaining source.** Completed
   source steps are reused only during recovery of the same attempt.
10. **No upload keys.** Project/content identity handles completed replay;
    DBOS queue deduplication joins active work.
11. **Deleting a source preserves the batch proposal and draft as valid.** The
    source leaves the selection without automatic regeneration.
12. **The Model Configuration page follows the researcher's work.** An unset
    Schema Suggestion Route inherits the Interaction Route (the *Assistant
    model*), and an explicit one stays explicit even when equal. There is no
    Single/Routes mode; the NuExtract protocol is detected from connection and
    model, never chosen.
13. **An Ingestion Model Choice picks kei's OCR and layout models.** It belongs
    to the Researcher Account and applies to new ingestions and reprocessing
    only; existing revisions never change.
    - Admission freezes the owner's explicit choices into the workflow input.
      kei resolves a role left unchosen once, in `convert`'s `resolve_models`
      step, so a recovered attempt keeps its models and queued work follows
      the deployment's current default.
    - A same-content upload joins the active attempt with that attempt's
      models, whatever the joiner's choice.
    - Completed-content replay returns the existing parse even after the
      choice changes, so reprocessing is how a new choice applies.
    - The models never enter a deduplication key or the reprocess fingerprint;
      a repeated reprocess request key reuses the admitted models.
14. **A big book must not hold up small work.** While a book converts, a small
    document can still be ingested and extracted: kei's queues follow its model
    servers (*Queues, deadlines and upgrades*). A second book waits.
15. **The document chat is deleted, not made durable.** Schema generation and
    edit proposals are the durable interactive work.

## Rules

- **DBOS is the execution authority:** scheduling, status, checkpoints,
  retries, timeouts, recovery and the temporary results of interactive work,
  such as an unreviewed edit proposal. FREE keeps outcomes with research
  meaning: Source Documents and revisions, Schema Revisions, Extractions,
  reviews, batch definitions and merged proposals, and typed failures.
- **Status is derived, never mirrored.** A row records admission and its
  outcome; while it has no outcome, reads take its status from DBOS. A workflow
  cannot record its own cancellation (every DBOS call after a cancel throws),
  so the cancellation handler records the domain outcome before cancelling.
  Durable Extractions are the exception: their coordination head owns the
  visible lifecycle (ADR 0017).
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
  They locate a scope's workflows. Only a PostgreSQL ownership check
  authorizes a status, list, result or cancel request; a workflow ID alone
  never does.
- **Secrets never enter DBOS.** Workflow inputs carry connection IDs, never
  keys. DBOS records a step's thrown error with every enumerable property and
  cause (`serialize-error`; `ApiError.cause` is enumerable), so provider errors
  are replaced by sanitized ones inside the step boundary.
- **A new mechanism must delete more than it adds.** No admission triggers,
  relays, credential revisions, cleanup-intent tables or deletion barriers.
  DBOS status cannot express a Paused Extraction whose attempt succeeded, or
  the saved context each call captured, so ADR 0017 adds a coordination
  schema with a dispatch outbox, fences and tombstones.

## Target architecture

```text
db (postgres:17), database free
  public              domain rows; per-researcher model configuration (no keys)
  extraction_runtime  durable Extraction coordination; Studio-owned, the kei
                      role has USAGE and EXECUTE on named routines only
  dbos                Studio's DBOS system schema               Studio role
  kei_dbos            kei's DBOS system schema                  kei role only

studio           web server and DBOS in one process: every Studio workflow and
                 schedule on queues studio, suggest and gc, plus clients for
                 Studio admission and kei handoff. The entrypoint runs the
                 database migrations and the idempotent kei role/schema setup.
parsing_service  read-only HTTP API (manifests, pages, model listings); no
                 database
parsing_worker   kei DBOS worker: convert on kei-convert-large/-small, durable
                 Extraction attempts on kei-extract, deleteRuns and durable
                 history cleanup on kei-gc; lifetime slot flock; starts after
                 Studio is healthy
volumes          source-inbox (studio rw, parsing_worker ro); parsing-runs,
                 studio-data and the CLI auth homes
```

`DBOS.launch()` migrates each system schema (the default), so no migration
service is added. `submitToKei` retries until kei has migrated `kei_dbos`.

## Workflows

| Workflow | ID | Admission | Output |
|---|---|---|---|
| `ingestSource` | `ingest:<projectContextId>:<attemptId>` | workflow-first on `studio`; active dedup by project/SHA-256 | Source Document and revision IDs, or a typed failure |
| `reprocessSource` | `reprocess:<sourceDocumentId>:<requestKey>` | workflow-first on `studio` | revision ID, or a typed failure |
| `reconcileDurableExtractions` | `durable-dispatch:<extractionId>` at admission; `studio:durable-reconcile:<extractionId>:<controlVersion>` after a control; a schedule every minute | same transaction as Extraction admission, on `studio` | — (enqueues durable attempts and history cleanup) |
| `suggestSchemaBatch` | `suggest:<batchId>:<attempt>` | same transaction as create/retry, on `suggest` | merged proposal/draft, or a typed failure |
| `suggestSchema` | `suggestion:<operationId>` | workflow-first on `studio` | template and base revision, or a typed failure |
| `proposeSchemaEdit` | `edit:<operationId>` | workflow-first on `studio` | proposal and base revision, or a typed failure |
| `collectGarbage` | 10-minute schedule on `gc` | — | sweep summary |
| kei `convert` | `kei-convert:<parent workflow ID>` | enqueued by `submitToKei` on the lane fixed at admission | manifest summary |
| kei `extractDurableV1` | `kei-durable:<extractionId>:<attemptId>` | enqueued by the reconciler on `kei-extract`, priority 1 (interactive) or 10 (batch) | the attempt's acknowledgement |
| kei `extractionCallV1` | `kei-call:<attemptId>:<captureId>` | started by its attempt, one per provider call | whether the attempt can go on; the output itself is committed to `extraction_runtime` |
| kei `deleteRuns` | `kei-gc:<schedule time>` | enqueued by `collectGarbage` on `kei-gc` | deleted run/history IDs |
| kei `deleteDurableHistoryV1` | `kei-gc:durable:<extractionId>:<fence>:<minute>` | enqueued by the reconciler on `kei-gc` | whether the history went |

**Admission: one transaction.** Admission keeps synchronous validation,
ownership and input-conflict checks. Row-backed operations insert or update
domain rows and call `DBOSClient.enqueueInTransaction` before committing on the
same connection. An Extraction commits its row, its coordination head and its
`durable-dispatch` reconciliation together.
- **Binding.** Acquire a `pg` pool client; bind Prisma Next's public
  `postgres({contractJson, pg: client})` facade to it; use its transaction's ORM
  and pass that client to DBOS. Release it after commit/rollback without
  closing the shared pool. This was verified on Prisma Next 0.16 with DBOS
  5.0.2 and 5.1.10; no raw SQL enqueue function, datasource plugin or trigger is needed
  ([DBOS client reference](https://docs.dbos.dev/typescript/reference/client)).
- **Queues.** Extraction dispatch uses the unrestricted `studio` queue; batch
  suggestions use `suggest`. A batch's rows and all member enqueues commit
  together. Work cannot dequeue before commit, and rollback leaves neither row
  nor workflow.
- **Replays.** Read an existing row and compare its immutable request inputs.
  For concurrent first requests, insert the domain row before enqueue. A
  conflict on that operation's primary key rolls back, then reloads and
  applies the same comparison. Unrelated constraint errors are not replays.
  Extraction's uncertain-admission UI can keep reconciling by reading.
- **No-row operations.** Ingestion, reprocess, generation and edit proposals
  use workflow-first admission: they enqueue by name on `studio`. Ingestion
  enqueues outside any domain transaction with queue deduplication
  `return-existing`, because the pinned SDK supports `return-existing` only
  outside a caller-owned transaction. It creates no follower or key-binding
  row.
- **Client IDs.** Extraction, operation and reprocess IDs are client-minted.
  Unknown outcomes reuse the ID; a confirmed failure requires a new action/ID.
  Ingestion has no client key: each request either finds completed content,
  joins active work, or starts a server-minted attempt.

**Status and ownership.** Every read first checks, in PostgreSQL, that the
account owns the Project Context and that the named Source Document, Source
Representation Revision or Extraction Schema still exists. The workflow's
`authenticatedUser` and attributes locate the scope but never authorize it. A
deleted scope is therefore gone at once, even before garbage collection removes
its workflows.

A durable Extraction's status comes from its coordination head (ADR 0017). For
other row-backed work an outcome on the row wins. Otherwise the DBOS status
maps as follows:
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

**Studio → kei handoff** (ingestion and reprocessing):
- **`submitToKei`** enqueues the deterministic kei ID through the kei
  `DBOSClient`. It passes the queue, portable arguments, an explicit priority,
  `workflowTimeoutMS` and the parent's attributes. It is idempotent (M0 #1).
- **Conversion lane.** Admission counts the PDF's pages and records the lane
  in the workflow input, so recovery and replay keep it. At most
  `SMALL_DOCUMENT_PAGES` (30) pages go to `kei-convert-small`, and more go to
  `kei-convert-large`. Ingestion counts with pdf.js in a worker thread under a
  deadline; reprocessing reads the stored package page count. The count only
  picks the lane; kei's `prepare_run` enforces the 2000-page limit.
  - **Unknown count.** A PDF that pdf.js cannot open, or not in time, goes to
    `kei-convert-large` rather than being rejected. kei's PDFium still
    decides readability, so the count adds no rejection path. Such a PDF
    loses the small-document promise.
- **`pollKei`** waits in steps of at most 30 s (M0 #2). Recovery re-polls the
  same child. kei `CANCELLED`, `ERROR`, recovery exhaustion and `{ok: false}`
  become typed failures. A parent that fails unexpectedly after `submitToKei`
  cancels its kei child before rethrowing.
- **Contract.** Portable JSON `{ok: true, ...} | {ok: false, code, reason,
  retryable}` with ISO dates (M0 #11). Shared fixtures in
  `apps/parsing_service/tests/fixtures/contracts/` are checked by pytest
  and node:test. No PDF, page or artifact bytes enter workflow history.

## Background work

**Extractions** are admitted durably (*Admission: one transaction*). The
reconciler enqueues kei's `extractDurableV1` attempt on `kei-extract` with
priority 1 (interactive) or 10 (batch). Status and outcome live on the
coordination head and its attempts, not on the public row; Pause, Resume,
Retry and Stop act through the head (ADR 0017). Pending Extraction rows are a
batch's intended selection, under `unique(batchExtractionId,
sourceDocumentId)` and the composite source/revision and batch/schema/strategy
FKs. There is no job or member table.

**`suggestSchemaBatch(batchId, attempt)`** runs on queue `suggest` (global 1).
- A suggestion keeps its membership pins, the attempt number, merged
  proposal/draft, draft version and terminal outcome; no per-source execution
  state.
- Admission snapshots all current member revision pins in sorted order into
  workflow input in the same transaction as enqueue. Past patch
  `batch-schema-suggestion-windows`, each source is suggested one window per
  step (`suggestSource:<id>:window:<n>`) and its window suggestions are
  combined in `suggestSource:<id>:reduce:<level>:<group>` steps; the merge
  then intersects the sources level by level in `merge:reduce:<level>:<group>`
  steps. Before the patch, one `suggestSource:<id>` step per source and one
  `merge` step. One conditional transaction publishes the final proposal and
  draft. Recovery reuses those checkpoints.
- All terminal writes require the current attempt and no terminal outcome.
  A step first checks whether its attempt was interrupted or its scope was
  deleted. No missing-source result can overwrite a preserved draft.
- The first failure ends the attempt, and failures block the merge, including
  `model_key_required`. An explicit retry resends browser keys, increments the
  attempt and enqueues a new workflow over **all surviving pins**, never
  reusing a prior attempt's source checkpoints. It is allowed only after a
  terminal attempt and before confirmation. Retry carries `expectedAttempt`:
  under the row lock it advances once; a replay finding exactly that successor
  returns it, and a later attempt is a conflict, so an uncertain POST cannot
  launch another whole batch.
- An existing draft is kept while retry runs, with editing and Run disabled
  until the attempt settles. A successful retry replaces the proposal and
  draft and increments draftVersion once; a failed/interrupted attempt
  preserves them. Run requires a valid draft, at least one surviving member
  and no active attempt.

**`ingestSource`** has no ingestion key. Upload validation checks ownership,
MIME type, magic bytes and the 100 MiB limit, and `(projectContextId,
contentSha256)` is unique.
- Completed content in the project replays without parsing: `201` with its
  Source Document.
- Otherwise the request mints an attempt ID, stages the verified bytes at
  `source-inbox/<projectContextId>/<attemptId>.pdf` (temporary write, rename)
  and enqueues on `studio` with deduplication ID
  `ingest:<projectContextId>:<sha256>` and `duplicationPolicy:
  'return-existing'`. It answers `202 {workflowId}` with the returned ID. If
  another attempt won, it deletes only this request's unused staging file. An
  uncertain enqueue leaves its file for GC rather than risking live input.
- Active deduplication is not permanent replay. The workflow's first step
  rechecks completed content, covering completion between the request's
  precheck and enqueue. The unique content constraint remains the publication
  backstop. A failed/cancelled attempt releases dedup, so resubmission can
  start a new attempt without a key or alias record.
- `GET …/source-ingestions` lists the attempts from DBOS, so a reload, another
  tab or a Studio restart finds uploads in flight (ADR 0014).
- Then `submitToKei` (the admitted conversion lane), `pollKei`, verify
  manifest and pages, translate/package, and commit under the ownership and
  content constraints. A replayed commit returns the same document/revision.
  The workflow deletes its own staging file; GC handles the rest.

**`reprocessSource`** keeps its separate request key, fingerprint and
expected-head checks, before start and at commit. It shares conversion and
verification helpers, not ingestion's identity rules. A commit replay returns
its previously created revision. The request waits up to thirty minutes; its
504 detaches and does not cancel.

## Interactive model work

A reload, a dropped connection and a Studio restart all recover the same way.
The page reads what the server holds and reattaches to what still runs. Each
user action carries a client-minted ID (*Client IDs*).

- **Generation (`suggestSchema`).** `generate_schema` takes an
  `operation_id` and the base Schema Revision it starts from (none for a
  first generation). Past patch `schema-suggestion-windows`, each window of
  the source is suggested in its own step (`suggestWindow:<n>`), and the
  window suggestions are combined level by level in `reduce:<level>:<group>`
  steps. Before the patch, one `generateSchema` step wraps
  `generateSchemaWithModel`.
  - A live tab saves the result through `generate()` and the save
    coordinator, so the usual conflict rules apply: the save uses the tab's
    acknowledged head, and editing during a regeneration is allowed.
  - A reloaded page saves a finished generation only while its base is still
    the current revision, or while there is still no Extraction Schema.
    Otherwise it drops the generation, as a reload drops a conflicted save,
    so a stale result never lands on newer work.
  - Recovery saves to an existing schema expect the base as their head.
  - No server-side step saves: it would have to pick a head without the tab's
    acknowledgement, and would repeat after a crash between its commit and
    its checkpoint.
- **Edit proposals (`proposeSchemaEdit`).** `edit_schema` takes an
  `operation_id`. One step wraps `proposeSchemaEdit` with its bounded repair.
  The output is the proposal and its base Schema Revision. Nothing is saved
  until the researcher applies it through the revision path.
- **Typed results.** Model steps return expected failures (`ApiError`s) as
  typed results instead of throwing, so the handlers answer with the same
  status codes. DBOS revives a recorded error only as a plain `Error`.
- **Finding work after a reload.** `GET /api/model-operations` returns the
  account's generation and edit operations for a Project Context and an
  Extraction Schema, newest first, from one `listWorkflows` call (prefixes
  `suggestion:` and `edit:`, the scope attributes, a limit of 20). A first
  generation records `extractionSchemaId: null` explicitly, which DBOS's JSONB
  containment then matches.
- **What the schema panel does on load.**
  - It shows a running operation with its instruction, and polls every 2 s
    until the operation settles.
  - It saves a finished generation whose base is still current, as above.
  - It reopens the review bar for the newest finished proposal whose base is
    the current revision, but only while the draft is clean. The restored
    proposal replays onto the base revision's nodes and keeps the
    draft-version guard.
- **Discard and cancel.** `DELETE /api/model-operations/<workflow ID>`
  (owner-checked) cancels a running operation; the schema panel's cancel and
  `cancelGeneration` call it.
  - For a finished proposal, it deletes that proposal and every older finished
    proposal on the same base, so an older one cannot reappear and a newer
    one from another tab survives. That is how Discard persists.
  - Deleting a workflow also deletes its deduplication record. A retry of the
    same POST still in flight from another tab could therefore run the edit
    once more and show one more proposal. That costs one model call and
    loses nothing, so no dismissal record is kept.
  - A client abort only detaches.
- **Browser.** `src/api.ts` repeats a POST that starts model work after a
  network failure, or a 502/503/504 that is not one of Studio's confirmed
  failures, at most three more times, 1, 2 and 4 s apart. The keys go first
  each time.
  - A new user action, including "try again" after a confirmed failure, mints
    a new ID. Ingestion retry sends the file again without any client key.
  - On load, the schema panel restores a running operation, saves a finished
    generation whose base is still current, and reopens an unreviewed
    proposal.
  - Aborts that come from a user action call the cancel route.
  - A new Studio boot ID resends the page's keys before recovery continues.
    `model_key_required` is a terminal failure: resend, then retry with a new
    operation ID or attempt, never the failed ID.
- **What DBOS history holds.**
  - The workflows read document text from the immutable Source Representation
    Revision outside any step, so their inputs carry only IDs and
    instructions.
  - Settled interactive workflows have a 24-hour history retention target,
    enough to return an unsaved generation or an unreviewed proposal; saved
    revisions live in FREE's tables. Background work has a 30-day target.
    Cancellation can extend retention until quiescence is established
    (*Deletion and garbage collection*).
- **No pins.** Every attempt resolves the current route and key of the
  Project Context's owner. Interactive results carry no stored attribution,
  so a recovered attempt on a changed route changes no record.
- **Retries and timeouts.** The AI SDK's defaults are the one retry owner for
  model calls; a step returns a model failure rather than throwing it, so DBOS
  step retries repeat only store work. Each call keeps a 10-minute timeout.
- **Scope.** The schema panel's message log stays in the page. What survives
  a reload is the latest operation: a running one, an unsaved generation or an
  unreviewed proposal.

## Cancellation

- **Extractions** have no cancel. Pause and Stop set the coordination head's
  intent: an attempt starts no new provider call after that, lets calls under
  way finish and save, and exits at its next lease boundary. A DBOS
  cancellation alone never proves a native call quiescent (ADR 0017).
- **Propagation is retried.** A crash between a deletion's commit and its
  cancels, or a `submitToKei` that finishes after its parent was cancelled,
  leaves live work behind. `collectGarbage` cancels live Studio workflows
  whose scope is gone or whose suggestion attempt is settled, and live kei
  conversions whose Studio parent is terminal. Repeated cancellation must
  target live statuses only, so it does not keep advancing a cancelled
  workflow's timestamp.
- **kei's cooperative checks** (`CancelCheck`, `kei_exp/workflows/cancel.py`)
  read the DBOS workflow status between pages and phases of a conversion. A
  native call that is already running finishes first. The checks fail open: a
  status read that fails is not a cancel, so the conversion goes on and reads
  again at its next check.
- **Studio model calls.** The key wrapper passes
  `AbortSignal.any([callSignal, DBOS.stepStatus.cancelSignal])` to the
  provider, so a cancelled generation, proposal or suggestion call stops
  about 1 s after the cancel instead of running to completion. Conditional
  outcomes, not the abort, still protect publication.
- **Physical capacity.**
  - Each kei queue sets its worker concurrency equal to its global limit.
    dbos 3.1.0 counts global and partition limits from `PENDING` rows, which
    a cancel changes at once. It counts worker concurrency from the in-memory
    set of active workflows. A cancelled workflow whose step still runs
    therefore keeps its lane's slot until the step returns. With only global
    limits, cancelling one of four blocked steps let a fifth start.
  - The flock excludes a second process, so worker limits are the whole
    capacity.
  - Lanes run side by side by design; nothing excludes a conversion from an
    extraction. Cleanup does not rely on exclusion (*kei boot boundary*).
  - One regression test per queue covers this; no extra lock.

## Deletion and garbage collection

Project deletion cascades its owned graph. Source deletion removes the source's
revisions, Extractions and reviews, and only its membership in surviving
batches/suggestions, through cascading source/revision FKs, including the
composite suggestion membership pin. Deleting an Extraction tombstones its
coordination head in the same transaction: a trigger marks it deleted and sets
its intent to `STOP`.

**Suggestion preservation.** Deletion locks the affected suggestion rows and
marks an active attempt interrupted in the same transaction, without touching
its proposal, draft or draft version, so the attempt's conditional publication
cannot succeed. After commit Studio cancels those attempts and the scope's
workflows in both apps; scheduled cancellation repair covers a crash in
between. The draft stays valid with the surviving sources; an empty selection
disables Run/Retry but keeps it. The original selection key and coverage are
not recomputed.

After deletion commits, Studio discards the deleted rows' canonical packages
through `discardPackagesIfUnreferenced` and answers 204. Ownership checks make
the scope unreadable immediately; execution and file cleanup can finish later.

`collectGarbage` runs every 10 minutes on queue `gc`:
- **Packages:** remove unreferenced canonical packages older than 24 h using
  the rename-and-recheck. Preserve every surviving revision's package.
- **kei runs and history:** Studio checks domain references and both workflow
  schemas. Check parent terminality before reading fresh domain references;
  never combine an earlier no-reference result with a later terminal status.
  A run stays while a surviving revision's `preprocessId` or any durable
  head's pinned source names it, tombstoned heads included, and while its
  conversion's Studio parent may still run. Studio names conversions
  (`kei-convert:*`) and other kei history, never runs, to kei `deleteRuns` on
  `kei-gc` (global and worker 1). kei derives each run from its conversion,
  rechecks its own workflow statuses and deletes a conversion's history only
  after its run. kei never receives permission to query Studio's domain or
  system schema. Run directories must also be older than 24 h. OCR result
  reuse copies what it takes from another run, so it needs no rule here.
  - **kei boot boundary.** Lanes run beside cleanup, so exclusion does not
    protect a cancelled native step. After taking the flock (the previous
    process has exited) and before `DBOS.launch()`, kei reads its boot
    timestamp from the database clock. A run whose kei workflows all ended
    `SUCCESS` or `ERROR` is eligible, because their steps returned. Any other
    terminal status is eligible only once that workflow's `updatedAt` is
    before the boot timestamp: `CANCELLED` (explicit or deadline, both stamped
    from the database clock) and `MAX_RECOVERY_ATTEMPTS_EXCEEDED`. Until a kei
    restart, a native step may still write files or checkpoints, and no
    elapsed age proves otherwise.
  - **Durable Extraction graphs.** Attempts only read runs. For a tombstoned
    graph the reconciler cancels its queued attempts and calls, waits until
    none is live, then enqueues `deleteDurableHistoryV1` on `kei-gc`. kei
    deletes the graph's history (attempts and their `kei-call` children) only
    when every one of those workflows is quiescent by the kei boot boundary;
    Studio then deletes the coordination graph.
- **Staged uploads:** remove attempt files older than 24 h only if their
  project/attempt workflow is absent or terminal. This includes crashes after
  staging but before enqueue and losing dedup candidates. Protect active
  attempts and their kei children; filenames never identify a shared file by
  content alone.
- **Orphaned execution:** cancel live workflows whose scope disappeared, live
  Studio workflows with a terminal domain outcome, and live kei children of
  terminal Studio parents. No workflow may publish into a deleted scope.
- **History retention:** 24 h after terminal completion for interactive work
  and for maintenance runs (sweeps, durable dispatch and reconciliation, kei
  cleanup), 30 days for background work; deleted scopes bypass age, not
  quiescence. Never delete kei history referenced by a live Studio parent.
  kei history goes through `deleteRuns`, and a deleted durable graph's through
  `deleteDurableHistoryV1`. A durable Extraction's kei history has no age
  limit.
- **Cancelled Studio history:** capture `bootTimestamp` using the database
  clock before launch, only after the previous Studio process has terminated.
  Delete cancelled history only when `updatedAt < bootTimestamp` and its age
  or deleted-scope rule permits it. Cancellation updates this timestamp using
  the database clock. Current-process cancellations wait for a later process
  restart. No in-place DBOS shutdown/relaunch is supported.
  `SUCCESS`/`ERROR` executions can use ordinary terminal retention.

A failed reference/status query deletes nothing. DBOS payload tables lack
foreign keys, so deleting history while a cancelled step can still checkpoint
would leak orphan rows, and no cancellation age proves the step stopped. So
cleanup of cancelled work waits for a Studio or kei restart (kei restarts at
every deploy), and there is no fixed deletion deadline. Runs that ended
normally are cleaned on the usual schedule.

## Queues, deadlines and upgrades

| App | Queue | Policy | Workflows |
|---|---|---|---|
| kei | `kei-convert-large` | global 1, worker 1; FIFO | `convert` of documents over `SMALL_DOCUMENT_PAGES` |
| kei | `kei-convert-small` | global 1, worker 1; FIFO | `convert` of the rest |
| kei | `kei-extract` | global 2, worker 2; priority interactive 1, batch 10; FIFO ties | `extractDurableV1` |
| kei | `kei-gc` | global 1, worker 1 | `deleteRuns`, `deleteDurableHistoryV1` |
| studio | `studio` | unrestricted; polls every 100 ms; dedup per ingestion project/content | `ingestSource`, `reprocessSource`, `suggestSchema`, `proposeSchemaEdit`, `reconcileDurableExtractions` |
| studio | `suggest` | global 1 | `suggestSchemaBatch` |
| studio | `gc` | global 1 | `collectGarbage` |

An attempt starts its `extractionCallV1` children directly, not through a
queue.

- **Why these lanes** (decision 14; measured with synthetic documents on the
  deployment's DGX Spark GPU host, where each vLLM server runs 4 requests).
  - **Conversion.** Surya's client sends `SURYA_INFERENCE_PARALLEL` requests
    at once; unset, it guesses 32 from a GPU table, and a book leaves 28
    requests queued in vLLM. At 4 (*kei worker*) the book is no slower, and a
    3-page document added during its OCR takes 40.8 s instead of 99.8 s
    (32.8 s alone), because vLLM serves waiting requests in arrival order.
    Fewer client threads slow the book (290/365/688 s at 3/2/1 against
    250 s), so no slot is reserved.
  - **Extraction.** Attempts have no deadline, so with one slot a small
    extraction would wait for a whole Catalog. With two, a small extraction
    beside a 200-entry Catalog sending one request at a time took 7.75 s
    (Catalog; 8.5 s alone) or 22 s (Article; 13.8 s alone), and the Catalog's
    own time did not change. Beside a chunked Catalog its requests wait about
    one round (*Parallel Catalog chunks*).
  - **Cleanup** has its own queue, so it never takes a conversion or
    extraction slot.
- **Lane is not fairness.** Two large books run one after the other, and two
  small documents too. DBOS partitions would share per account in random
  order, apply priority only within an account and still need a worker limit,
  so they are not used.
- **`SMALL_DOCUMENT_PAGES`** is one constant in the handoff module: 30. kei
  registers the queues; Studio only picks one.
- **Studio queues.** `studio` provides transactional admission and active
  deduplication, not a resource cap; it polls every 100 ms
  (`minPollingIntervalMs`, M0R 3). `suggest` and `gc` run one workflow at a
  time. A cancelled TypeScript call stops about 1 s later through
  `cancelSignal`, but its slot is not physical exclusion; conditional outcomes
  protect publication. The only admission cap is the 50-member batch limit.
- **Ownership.** Every `DBOSClient` sets `applicationName`: `studio` for the
  admission client, `kei` for the kei handoff client. A client without one
  creates workflows that no application owns, and any application may
  dequeue those. Only kei registers the kei queues; a client's
  `registerQueue` defaults to `always_update` and would overwrite kei's
  configuration.
- **kei deadlines.** `workflowTimeoutMS` applies to kei `convert` only,
  measured from kei dequeue: `max(10 min, 60 s + 18.9 s × pages)` (M0R 4),
  counting 2000 pages for a PDF that pdf.js could not count. The budget is per
  page because cutting (2.7 s per page on the CPU) and OCR (about 2 s per
  crop) grow with the document: a 2000-page scan takes roughly 3.5 h. Studio
  parents have no deadline; they end with their child. A durable Extraction
  attempt has none either; each provider call keeps its own timeout
  (`KEI_EXTRACT_TIMEOUT`).
- **Versions.** `studio@1` and `kei@1` stay fixed. Code changes that alter a
  workflow's step sequence use `DBOS.patch()` / `deprecatePatch()` (Python:
  `patch` / `deprecate_patch`). Both SDKs require patching to be enabled in
  their configuration: `enablePatching` in TypeScript and `enable_patching` in
  Python. Bump a version only for an incompatible contract change, after
  draining.
- **Pools.** One Studio process opens at most 21 connections: the domain pool
  (10), DBOS's system pool (5), the admission client (2) and the kei client
  (4), plus a short-lived read of the boot clock. Transactional enqueue uses
  the already-acquired domain client.

## kei worker

- **Startup.** `kei-worker worker` takes `.worker-<slot>.lock` in the runs
  directory (`hold_slot`, `workflows/slot.py`) and holds it for its lifetime.
  Then, before `DBOS.launch()`, it registers the workflows, configures the
  `extraction_runtime` coordination pool and reads its boot timestamp; it
  registers the queues after launch. Its executor ID is fixed at
  `kei-<slot>`, and a restart recovers pending work.
- **`convert`** has three steps: `resolve_models` (decision 13);
  `prepare_run`, which creates the run directory, copies and verifies the
  staged PDF, writes `params.json` and validates at most 2000 pages; and
  `convert_run`, which converts natively or by OCR, or adopts another run's
  verified result of the same recipe. `convert_run` allows 3 attempts, 5 s
  then 10 s apart, with a boolean `should_retry` predicate:
  `isinstance(classify(e), TransientBackendError)`. `classify`
  (`kei_exp/failures.py`) itself returns an exception, which DBOS would treat
  as always true. The workflow returns `{ok, run_id, generation, page_count,
  source_sha256, page_source}` from the published manifest; it writes no
  `output.md`.
- **Durable Extraction attempts** (ADR 0017). `extractDurableV1` takes only
  `{protocol, extraction_id, attempt_id}` and reads the rest from the
  coordination schema. `planExtractionCallsV1` plans from committed call
  outputs; each call still needed runs as an `extractionCallV1` child whose
  one step makes the provider request under the attempt's lease and commits
  the output. A complete plan goes to `publishExtractionResultV1`, and
  `acknowledgeExtractionV1` records the outcome on the head. At a Pause or
  Stop boundary the attempt acknowledges and exits.
- **Queues.** The worker registers the four kei queues after `DBOS.launch()`,
  each with worker concurrency equal to its global limit (*Cancellation*).
- **OCR client width.** `compose.gpu.yaml` sets `SURYA_INFERENCE_PARALLEL` on
  the parsing worker and API from the same `OCR_MAX_NUM_SEQS` (default 4) as
  `ocr_model`'s `--max-num-seqs`; the safety test asserts they match.
- **Two conversions in one process.** The lanes let a large and a small
  conversion run at once. Tests found no conflict, under three conditions:
  - Surya's `configure()` writes process-global settings. Only one Surya
    record exists, so both conversions write the same values. A second Surya
    record needs per-call settings first; a test fails if two records differ
    in what `configure()` sets.
  - The pdfium lock covers a whole document only on the `cut=none` path.
    Studio always sends `cut=auto`, which renders page by page. A small
    document injected while a book was being cut finished in 33.8 s, against
    32.8 s alone.
  - Each conversion has its own run directory.
- **Parallel Catalog chunks.** A recipe Catalog extraction sending one request
  at a time would leave 3 of the fields server's 4 slots idle, so it runs its
  entries in `KEI_CATALOG_CHUNKS` contiguous chunks at once.
  - **Setting.** Compose derives `KEI_CATALOG_CHUNKS` from the same
    `NUEXTRACT_MAX_NUM_SEQS` (default 4) as `nuextract_model`'s
    `--max-num-seqs`, as for OCR.
  - **Once for the whole document:** the segmentation, the budget checks, the
    bindings and the document-level fields. `_document` makes its one call
    when the schema has document fields, and every chunk's records merge the
    same result.
  - **Per chunk:** a thread with its own `_Run`, because `_Run.call` mutates
    run state. Every chunk keeps the full headings and glossary. Entries keep
    their document-wide index, so issues and calls name the right record.
  - **Merge** in entry order: records, evidence, proposals, rejections,
    competitors, calls and issues. The run is refused if any chunk refused.
    Coverage comes from the segmentation once. The result records the chunk
    count.
  - **Calls.** Chunking runs inside the durable planner, so each chunk's
    provider requests are captured and run as `extractionCallV1` children
    like any other call; Pause and Stop act at lease boundaries. Article and
    generic Catalog extraction are not chunked.
  - **Evidence** (200-entry Catalog): 106 s against 434 s. The same chunks run
    one after another gave records identical to the unsplit run. Run in
    parallel, they changed 19–21 borderline `fundart` values, against 0–1
    between two unsplit runs. The cause is vLLM batching (*Risks*).
  - **With two extraction slots,** two chunked Catalogs send up to 8 requests
    to a 4-slot server. vLLM queues the rest in arrival order, so a small
    extraction's request waits behind those already queued, about one round.
  - **Unified Catalog** (`FREE_CATALOG_METHOD=unified`) uses
    `KEI_CATALOG_CHUNKS` without contiguous chunks: it bounds how many of its
    calls wait at once. Entries are read nearest the start page first and
    assembled in source order.
    - **Defaults 1 and 2.** Discovery asks its windows that many at a time,
      so a planning round yields at most that many discovery calls; the
      entries are read once discovery has ended.
    - **Defaults 3 (pipelined).** Discovery keeps that many windows asked, a
      failed window's halves at once. Meanwhile each round reads the entries
      that the windows already read decide, lists them under
      `unified-prefix:<attempt>:<count>` and shows their candidates;
      verification waits until discovery has ended, so the reasoning model
      reads discovery's windows first.
    - **Durable planning reads in turn.** A planning round never waits on a
      model: each call replays its saved reply or is captured and raises
      `NeedsCall`. So the round reads windows and entries one after another
      and stops once that many of them wait; the workflow runs the captured
      calls, up to that many per role at once. A run that is not durable
      waits on every call, so it reads that many windows and entries at once
      on threads.
- **Read API.** Five routes, with their path confinement and manifest, page
  and hash checks. Saved Extraction values are never served here.
  - `GET /api/models` (Compose health);
  - `/api/extraction-models`;
  - `/api/ingestion-models`;
  - `/api/runs/{id}/result`;
  - `/api/runs/{id}/pages/{n}`.

  A shared filesystem mount does not replace this API: catalog ownership and
  safe file reads remain real consumers, and duplicating their validation in
  TypeScript would delete nothing.

## Model configuration and keys

[ADR 0013](../adr/0013-per-researcher-model-configuration.md) records the
per-account configuration, the deployment connections and the browser-held
keys, with their risks. What touches execution:

- **Keys.** A researcher's API keys stay in their browser. Studio keeps a copy
  only in process memory, never in PostgreSQL, on disk, in logs or in DBOS. A
  wrapper model reads the key inside each provider attempt, so replaying a
  checkpointed step never needs one; the raw NuExtract fetch has the same
  boundary.
- **Waiting for a key.** For a keyed connection with no cached key, the
  attempt waits up to 60 s for a page to resend it; an abort or the workflow's
  `cancelSignal` ends the wait, and no provider call starts after either. The
  attempt then fails with `model_key_required`, marked `isRetryable: false`,
  so the AI SDK does not retry it.
- **Resending.** Every API response carries `X-FREE-Studio-Boot`, a UUID drawn
  at startup. When it changes, `authenticatedFetch` resends the page's keys
  with `PUT /api/model-keys`, so a Studio restart goes unnoticed while a page
  is open. Background work with no page open fails after the wait, and the
  researcher retries it.
- **Keys in the browser.** The page keeps each key in `localStorage`, under
  the signed-in account and bound to the connection's ID, provider and API
  base. Signing out clears this browser's keys and Studio's copy. Another
  signed-in browser of the same account sends its own copy again the next
  time it talks to Studio, so a key removed in one browser can come back from
  another that still holds it.
- **XSS.** A key in browser storage can be read by any script on Studio's
  origin.
  - Studio renders no raw HTML (no `dangerouslySetInnerHTML` in `src/`).
  - The app shell sends a strict Content-Security-Policy. Scripts and pdf.js's
    worker load only from Studio's own origin (workers also from `blob:` URLs,
    which only script already running in Studio can mint), inline script is
    refused and framing is denied. The sign-in relay keeps its own
    script-hash policy.
  - pdf.js stays patched, since it renders untrusted PDFs in that origin.
  - Accounts that share one browser profile share its storage. The
    per-account namespace keeps them apart for the app, not against a script.

## Risks

- **One Studio process.** A restart interrupts in-flight calls, and unfinished
  steps can repeat on recovery. Exactly-once provider execution is not claimed.
- **Coarse conversion steps.** A crash repeats a running `convert_run` step,
  so a large scan can lose hours of GPU time.
- **Cutting before OCR.** `SuryaOcr.transcribe` receives every crop at once,
  so a 2000-page scan spends about 90 min cutting on the CPU and holds all its
  crops in memory before OCR starts.
- **Research content in DBOS history** for 24 h (interactive) or 30 days
  (background), longer while cancellations are unquiesced; a durable
  Extraction's kei history (its planner result and progress events) stays
  until the Extraction is deleted. Database dumps include it.
- **Cleanup can wait.** A hung native step blocks its lane, and cancelled
  history and runs remain until their process restarts.
- **Output varies under concurrency.** vLLM's batching flips borderline
  answers: on a synthetic Catalog, about 10% of `fundart` values differed when
  NuExtract served four requests at once, against 0–1 of 200 between serial
  runs. Two extraction slots and parallel Catalog chunks make it routine. It
  is accepted, since vLLM's batch-invariant mode does not support these models
  (M0R 6).
- **Lanes add no throughput.** A small document beside a book costs the book
  about 10% (250 s to 275 s) and adds about 8 s to the small one.
- **Studio's own model calls** to the deployment's extraction servers sit
  outside kei's queues, so lane limits do not bound those servers' load.
- **Whole-batch retry** repeats every remaining source call.
- **CLI token refresh** remains a provider risk.

Not goals:
- preempting running work, and fair sharing between accounts;
- a per-page conversion fan-out: page children would each call
  `write_result`, which starts a new generation and deletes other pages'
  files, and a waiting parent would hold a slot in its children's queue.
  Streaming crops into OCR would remove the cutting delay without that;
- operator-provided keys for hosted providers, and an allowlist for
  researcher-supplied API bases;
- calling providers straight from the browser, which would take model work out
  of DBOS and lose reload recovery.

## Milestones

Code comments name the milestones the design was built in:

- **M0R:** probes before the build (*Evidence*).
- **M1:** dead-code deletion; no section.
- **M2:** platform, database setup and model configuration (*Target
  architecture*, *Model configuration and keys*).
- **M3:** kei on DBOS (*kei worker*).
- **M4:** Studio's background work (*Workflows*, *Background work*).
- **M5:** interactive model work (*Interactive model work*).
- **M6:** garbage collection (*Deletion and garbage collection*).

## Evidence

M0 was a throwaway spike on x86_64 with `@dbos-inc/dbos-sdk` 5.0.2 and `dbos`
3.0.0. M0R reran the earlier DBOS probes, transactional enqueue among them,
on the pins, on x86_64 and ARM64, and measured scheduling on the GPU host with
synthetic documents.

**M0 findings.**

| # | Result |
|---|---|
| 1 | The TS client enqueues portable Python workflows. **Re-enqueueing an existing ID is a no-op in every state:** SUCCESS and ERROR are not rerun, PENDING and ENQUEUED run once, CANCELLED stays cancelled. So retries need attempt-scoped IDs. |
| 2 | A Studio workflow awaits kei through bounded `pollKei` steps; after a Studio cancel, no poll ran later than 1.5 s. The cancel does **not** cascade to the kei workflow, so a cancelled parent's kei child is cancelled explicitly (*Propagation is retried*). Killing Studio mid-poll resumes it, and kei executes once. |
| 3 | Killing kei mid-step re-executes that step after a restart, and the workflow succeeds. A second process gets `SLOT_TAKEN` from the flock. |
| 4 | `dbos_system_schema: "kei_dbos"` works; the `kei` role migrates and owns only its schema. |
| 5 | A step whose side effect ran before its checkpoint is re-executed after a kill: steps are at-least-once. |
| 6 | In a plain `pg` transaction, a rollback leaves no enqueued workflow, a commit enqueues, and a duplicate ID is idempotent. |
| 7 | Priority 1 runs before 10, and FIFO ties hold after a restart. The TS option is **`workflowTimeoutMS`**; `timeoutMS` is silently ignored. The timeout starts at dequeue, is enforced at the next step boundary, and its absolute deadline survives a restart. |
| 8 | No kei rows appear in `free.dbos`, and the Studio process never runs kei work. |
| 9 | The `kei` role is denied (42501) on `public` tables, on `dbos.workflow_status` and on `CREATE` in `public`. |
| 10 | DBOS has no public retention command, so retention uses `listWorkflows` and `deleteWorkflows` on both schemas. |
| 11 | A 5 MiB result round-trips in about 1 s. **A Python `datetime` arrives as an ISO string**, so the contract declares ISO strings. |
| 12 | A `kei@1` workflow stays ENQUEUED under a `kei@2` worker. A worker with `run_migrations: false` refuses an unmigrated schema. |
| 13 | Connection counts per process; *Pools* has Studio's current count. |

**M0R probes.**

1. **Versions.** The earlier DBOS probes reproduce on the pins, on x86_64 and
   ARM64.
2. **In-process lifecycle.** A second `DBOS.launch()` in one process resolves
   silently and ignores its configuration, and a workflow registered after
   launch throws, so `server/dbos.ts` is the only launcher. Unnamed workflows
   get bundler-mangled names (`job$1`), so every workflow has an explicit
   `name`. DBOS cannot be bundled, so `@dbos-inc/dbos-sdk` stays external to
   the SSR build. Recovery takes `PENDING` rows of the same executor and
   application version only. `kill -9` and a restart recover a pending
   workflow, in the development host and in the production bundle. The `tsx`
   CLI forks a child that a SIGKILL of the CLI would leave running, so crash
   tests start `node --import tsx`. `shutdown({deregister: true})` does not
   wait for running workflows, so development restarts the Studio process
   instead of relaunching DBOS in place.
3. **Admission.** Default queue polling adds p50 0.4–0.6 s per dequeue;
   `minPollingIntervalMs: 100` gives p50 ~55 ms, so the `studio` queue sets
   it. Rollback after a domain insert and enqueue leaves neither; commit
   creates both. A client without `applicationName` creates workflows any
   application may dequeue. `return-existing` deduplication works only outside
   caller-owned transactions.
4. **kei queues.** On each lane, a workflow cancelled right after its claim or
   mid-step keeps the lane's slot until its blocked native step exits; the
   other lanes keep running. Python-side cancels and deadlines stamp
   `updated_at` from the database clock, and a repeated cancel of a cancelled
   workflow moves its `updated_at` again. `deleteRuns` leaves a run with a
   cancelled workflow alone until a kei restart. Priorities, FIFO ties and
   dequeue-relative deadlines hold. The conversion budget is
   `max(600_000, 3 × (20_000 + 6_300 × pages))` ms (6.3 s per page measured, a
   factor of 3, a 10-minute floor), provisional until a run near 2000 pages.
5. **Model calls.** `DBOS.stepStatus.cancelSignal` reaches a wrapper model
   inside a step and fires about 1 s after the cancel, before any provider
   call.
6. **GPU-host scheduling.** Books and small documents at several Surya
   widths, a small document injected during a book's cutting and OCR, two
   extractions side by side, and Catalog chunks in parallel and in sequence:
   the KV cache peaked at 10% with no preemptions. vLLM 0.29.1 refuses
   `VLLM_BATCH_INVARIANT=1` for both extraction models
   (`Qwen3_5ForConditionalGeneration`, gated-delta-net layers). Not measured:
   a book near 2000 pages, and `page_source=ingest` spreads.
