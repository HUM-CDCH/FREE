# DBOS M5: Interactive Work on DBOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **not started (plan written 2026-09-26 against `feat/dbos-m2-m6` at bf80322, with M4 Task 1 committed and M4 Task 2 in the working tree; assumes the M4 plan is complete — its Task 14 recorded — before Task 1 starts).**

**Goal:** Deliver milestone M5 of the DBOS plan on `feat/dbos-m2-m6`: Schema Suggestion (`suggestSchema`), schema edit proposals (`proposeSchemaEdit`) and document chat (`chatTurn`, streamed through `@dbos-inc/vercel-ai`'s `durableCalls`) run as named DBOS workflows that survive a browser reload and a Studio restart; chat transcripts live in a new `ChatTurn` table; `GET`/`DELETE /api/model-operations`, `GET /api/chat/<revision ID>` and its `/stream` let a reloaded page find, reattach to, cancel or discard its work; no key, provider error body, provider metadata or document text enters DBOS history; every tier ends green.

**Architecture:** Generation and edit proposals are workflow-first: the handler owner-checks in PostgreSQL, enqueues `suggestion:<operationId>` / `edit:<operationId>` by name on the `studio` queue through the admission client, compares the recorded input on reuse (409 on conflict), then waits for the workflow's typed result and answers exactly as today, so a live tab keeps saving through `generate()` and the save coordinator. Chat is row-backed: one transaction inserts the `ChatTurn` question and `enqueueInTransaction`s `chat:<turnId>` with deduplication ID `chat:<sourceRepresentationRevisionId>` (rejection policy); the workflow loads the turn, runs `streamText` at workflow scope over `wrapLanguageModel({ model: sanitizedChatModel(ownerModel), middleware: durableCalls({ name: 'chat', durableStream: 'ui', … }) })`, then writes the answer, or records a typed failure and throws a fresh sanitized error. Every route answers from `readDurableStream` (turn ID as the message ID) or 204. The model boundary composes `DBOS.stepStatus.cancelSignal` into every provider attempt, so a cancel ends a key wait or a provider call about 1 s later. The schema panel restores running operations (2 s poll), unsaved generations onto their base and unreviewed proposals onto a clean draft; the Chat tab reloads its transcript and reconnects to the exact turn.

**Tech Stack:** Studio (TypeScript, React 19, Vite 8, Hono, Zod 4, Vitest 4, Playwright, AI SDK `ai` 7.0.93), `@dbos-inc/dbos-sdk` 5.1.10, `@dbos-inc/vercel-ai` 0.4.4 (new here), `packages/db` (Prisma Next 0.16, `pg` 8.22.0, `tsx --test`), Docker Compose (Playwright stacks only).

**Spec:** [docs/plans/2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md). Read *Decisions* (4, 6, 8), *Rules* (all: secrets, status derivation, workflow IDs, ownership), *Workflows → Admission* (Binding, Queues, Replays, Chat exclusion, No-row operations, Client IDs) and *Status and ownership*, *Interactive model work* (all of it), *Cancellation → Studio model calls*, *Queues, deadlines and upgrades* (the `studio` row, *Other workflows start directly*, *Ownership*, *Versions*), *Model configuration and keys → Keys* (Handoff, Cache, Use), *Public contract changes* (chat and model-operation bullets), *Milestones → M5* (Workflows, Handlers, Browser, Acceptance), *Verification* and *Risks* (one Studio process; research content in DBOS history). Evidence this plan builds on: [evidence README](2026-09-24-unified-durable-execution-evidence/README.md) — [stream-probe.mjs](2026-09-24-unified-durable-execution-evidence/stream-probe.mjs) (an outer sanitized return still leaves the secret in the recorded step error; a workflow that returns a typed failure makes the stream end with an ordinary `finish`), [version-probe.mjs](2026-09-24-unified-durable-execution-evidence/version-probe.mjs) (0.4.4 checkpoints no request body or response headers but does record provider metadata; `cancelSignal` reaches a wrapper model inside a `durableCalls` step and fires ≈1001 ms after `cancelWorkflow`, with no provider call after it), [admission-races.mjs](2026-09-24-unified-durable-execution-evidence/admission-races.mjs) (same turn: one created, one replayed; different turns on one revision: one created, one `DBOSQueueDuplicatedError`, one question persisted; a cancel clears the dedup record) and [m0r/README.md](2026-09-24-unified-durable-execution-evidence/m0r/README.md) (items 2–3: explicit names, one launch, `minPollingIntervalMs: 100`, `return-existing` only outside caller transactions). The M4 plan ([2026-09-26-dbos-m4-studio-background.md](2026-09-26-dbos-m4-studio-background.md)) owns every piece of infrastructure named below as "(M4)".

## Rulings (controller, 2026-09-26)

1. **Ruling: `@dbos-inc/vercel-ai@0.4.4` is installed in Studio in M5 (Task 1)**, exact, as a direct `dependency` (M0R PLAN IMPACT 1). `vite.server.config.ts` already lists it in `ssr.external` (M4 Task 1). — *Why:* M4 deliberately deferred it to its first user. — *Cost if wrong:* a transitive copy is bundled or a second DBOS singleton appears.
2. **Ruling: `DBOS.stepStatus.cancelSignal` is composed inside the model boundary, never by the caller.** Under `durableCalls` the library calls the model, so no caller can add it. `requireModelKey` (`api/_model_keys.ts`, whose comment already says so) composes it into the key wait; a step-cancellation middleware composes it into every provider call, keyed or not (Task 1). M4's Ruling 9 put the composition in the key wrapper while its Task 8 code composes at the caller (`modelSignal(steps.cancelSignal())`); the caller-side composition stays and is now redundant, and deployment vLLM and CLI connections — which never pass through `keyedModel` — become cancellable too. — *Why:* spec *Cancellation → Studio model calls*. — *Cost if wrong:* a cancelled chat keeps its provider call (and its bill) running to the end.
3. **Ruling: the chat sanitizer lives inside `durableCalls`** (it wraps the provider model; `durableCalls` wraps it). It replaces **every** thrown error and every stream `error` part — not only `APICallError` — with a fresh `ChatModelFailure` that has no `cause`, response, request, headers or body, and it strips `providerMetadata` from every part. A typed chat failure is recorded on the `ChatTurn` row, then a fresh sanitized `Error` is thrown; the workflow never returns a typed failure as success. — *Why:* stream-probe (sanitizing outside the step leaves the secret in `operation_outputs`) and version-probe (provider metadata is recorded). — *Cost if wrong:* a key or a provider body sits in `dbos.operation_outputs` for 24 h and in every dump.
4. **Ruling: every `streamText`/`streamObject` call passes an explicit `onError`**, through one shared helper `modelStreamOnError` (Task 1), and a source-scan test fails when a call site does not (M2 fix, `api/_model.ts:124-132`). — *Why:* the SDK's default logs the whole error, including provider bodies and `Bearer <key>` runtime messages.
5. **Ruling: a `model_key_required` inside a 200 stream triggers exactly one key resend per turn** (M2 ruling: M5 wires the explicit chat resend). `authenticatedFetch`'s 409 hook never sees a stream. The Chat tab calls `requestModelKeyResend()` (exported by M4 Task 9) when the re-read transcript shows the newest turn failed with `model_key_required`, once per turn ID (Task 11); the schema panel does the same for a restored operation (Task 10). The stale comment at `api/_model.ts:137` ("the page resends its keys") is corrected in Task 1 and deleted with `streamChatWithModel` in Task 8.
6. **Ruling: "Change the route between attempts" and "one HTTP and one CLI provider complete a chat turn end to end" are tested without live providers.** HTTP: a scripted OpenAI-compatible server (`test/support/scriptedModelServer.ts`) behind the real `@ai-sdk/openai-compatible` provider, the real route resolver and the real key cache. CLI: a stand-in model registered through the route resolver's `modelFactories['claude-code']` seam for a `FREE_DEPLOYMENT_CLI_PROVIDERS=claude-code` deployment connection, so resolution, the keyless path, the sanitizer, `durableCalls` and the stream are FREE's own code; only the CLI subprocess is replaced. Route change: a crash scenario kills Studio mid-stream on route A, re-points the owner's Interaction Route to server B and restarts. Left to the live check (Task 14, recorded, never claimed as passed on a host that cannot run it): one real CLI chat turn on the operator's Codex or Claude Code login, and one real hosted or Spark vLLM chat turn, through `pnpm dev` across a reload and a Studio restart.
7. **Ruling: the generation rule is the spec's, verbatim.** A live tab saves exactly as today, through `generate()` (`src/currentSchemaRevision.ts:417`) and the save coordinator (acknowledged head, editing during a regeneration allowed). A reloaded page saves a finished generation only while its base is still the current revision (clean draft), or while there is still no Extraction Schema; otherwise it drops it. The schema panel restores running operations (2 s poll), unsaved generations and unreviewed proposals; Discard deletes that proposal and every older finished proposal on the same base.
8. **Ruling: key acceptance is tested by planting.** A synthetic key `FREE_SYNTHETIC_KEY_<hex>` is put in Studio's cache for a `hasKey` connection; stand-in models and the scripted server echo it into an error's cause chain (`APICallError` `requestBodyValues`, `responseHeaders`, `responseBody`, `cause`), into a successful response's headers and into provider metadata. Detection is a text scan of every row of every table in the test's DBOS schema and `public` (Studio PostgreSQL tier, Tasks 3 and 7), and — for the full-stack bullet — `pg_dump` of the Playwright database, a recursive scan of Studio's data directories and a scan of Studio's captured log (Task 13).
9. **Ruling: the baseline is edited in place again** (`packages/db/migrations/app/*_baseline`): Task 6 adds `ChatTurn(id, sourceRepresentationRevisionId, question, answer, failure, createdAt)` cascading with its revision. In a checkout without the gitignored ref snapshots run `npx prisma-next ref delete db --no-interactive` before `migration plan`.
10. **Ruling: M5 ends with every tier green** — unit, typecheck, lint, safety, all PostgreSQL tiers, `pnpm test:e2e` (both Playwright configs, Task 13 adds the second), base-path e2e and `pnpm test:service` (unchanged by M5, rerun in Task 14).

## Code facts this plan relies on (verified at bf80322 and the M4 working tree)

- **Model calls today** (`prototypes/studio/api/_model.ts`): `streamChatWithModel(caller, messages, documentMarkdown, temperature?, signal?, target?, dependencies?)` (101-144) streams at request scope with `onError` logging class and status only (124-132) and a `toUIMessageStream` `onError` that names only `ModelKeyRequiredError` (136-139, stale comment at 137). `generateSchemaWithModel(caller, { document, instruction, temperature, signal }, target?, dependencies?)` (146-194). `generateWithNuExtract` reads the key inside the attempt (`target.key(input.signal)`, 289-298) and fetches with `signal: input.signal` (316). `generateSchemaEditJson(caller, prompt, temperature?, signal?, target?, dependencies?)` (370-398). `operationTarget` resolves the caller's account (87-99).
- **Keys** (`api/_model_keys.ts`): `MODEL_KEY_WAIT_MS = 60_000`; `ModelKeyRequiredError` (409 `model_key_required`, `isRetryable = false`); `ModelKeyCache.wait(accountId, connection, signal, waitMs)`; `requireModelKey(cache, accountId, connection, signal, waitMs)` (133-144, comment 127-132 says the keyed wrapper must compose `cancelSignal`); `studioProcess = { bootId, keys }` (150-153).
- **Provider seam** (`api/_provider.ts`): private `providerModel` (558); `keyedModel(createModel, connection, modelId, key)` (570-591) reads the key from `params.abortSignal` per attempt; `resolveCapabilityRoute(operation, { temperature }, dependencies)` (698-760): `key = (signal) => requireModelKey(keys, researcherAccountId, connection, signal, keyWaitMs)` (729-730), NuExtract target with `key` (737-740), `model = connection.hasKey ? keyedModel(…) : createModel(…)` (751); `RouteResolverDependencies` has `keys`, `keyWaitMs`, `modelFactories`, `deployment`, `readConfig`. Keyless connections (deployment vLLM, CLI, keyless Ollama/OpenAI-compatible) never pass through `keyedModel`.
- **Handlers today:** `api/generate_schema.ts` (form `project_context_id`, `source_representation_revision_id`, `instruction`, `temperature`; `createPostGenerateSchema(store, reader, generate)` at 36); `api/edit_schema.ts` (form adds `extraction_schema_id`, `schema_revision_id`; `createPostEditSchema(store, reader, propose)` at 37); `api/chat.ts` (JSON `{ projectContextId, sourceRepresentationRevisionId, messages, temperature? }`, `createPostChat(store, reader, stream)` at 41). Owner loaders `loadOwnedSourceMarkdown`, `loadOwnedSchemaRevision`, `loadOwnedSchemaModelContext`, `formContextIdentity` and `proposeSchemaEdit(nodes, instruction, documentMarkdown, { caller, temperature, signal, target, generate })` are in `api/_schema_edit.ts` (76-243). `getSourceRepresentation` returns only `{ artifactReference, artifactSha256 }` (`packages/db/src/project-store.ts:125-164`).
- **Dispatcher** (`server/api-dispatcher.ts`): `PARAMETERIZED` routes (16-42); `/api/chat` is matched by the generic `API_ROUTE` (8) today; every `api/[a-z]*.ts` is eagerly imported (65-72), so no module registers a workflow or opens a connection at import. `STUDIO_BOOT_HEADER` is stamped on every `/api` response (`server/app.ts:391,394`).
- **Browser:** `src/ChatTab.tsx` keeps history in React state (45), uses the fixed chat ID `free-document-chat` (72) and a module `DefaultChatTransport` whose `fetch` awaits `ensureModelKeysSent()` (13-27). **`ChatTab` is mounted nowhere**: the Chat rail tab was retired in 44ce50b (2026-08-13); `src/RightRail.tsx:3-5,181-191` says so, and only `src/ChatTab.test.tsx` imports it. `RailTab = 'evidence' | 'schema' | 'results'` (`RightRail.tsx:19`). `requestSchema` / `requestSchemaEdit` post forms after `ensureModelKeysSent()` (`src/api.ts:83-100,264-281`). `App.handleGenerate` calls `schema.generate((signal) => requestSchema(…))` (`src/App.tsx:444-464`). The schema panel's edit flow is `sendChatMessage` / `cancelChat` (`src/SchemaPanel.tsx:931-1015`); `useSchemaProposalReview.start(proposal, original, originalDraftVersion, originalSchemaRevisionId)` and its draft-version guard (`src/useSchemaProposalReview.ts:59-94`); `deriveSchemaProposal(original, response)` (`shared/schemaChanges.ts:129`). `SchemaPanel` is also rendered on the Batch prepare screen over a durable schema without a source revision (`src/projectContexts/BatchExtractionsPanel.tsx:1277-1310`). A document workspace opens the project's newest Extraction Schema (`project-store.ts:1330-1341`), so an Extraction Schema is project-scoped. `requestModelKeyResend` is module-private today (`src/auth/authenticatedFetch.ts:35`); M4 Task 9 exports it.
- **AI SDK 7.0.93** (`node_modules/.pnpm/ai@7.0.93_zod@4.4.3/node_modules/ai/dist/index.d.ts`): `streamText` has `maxRetries` (default 2) and `streamRetries` (omitted → no stream retries, 3441); an `onError` that returns `{ retry: true }` requests a stream retry (3360-3380); `consumeStream({ onError })` (2618-2620, 2829); `DefaultChatTransport.reconnectToStream` GETs `${api}/${chatId}/stream` (or `prepareReconnectToStreamRequest`'s `api`) and returns `null` on 204 (`index.js:18799-18828`).
- **`@dbos-inc/vercel-ai` 0.4.4** (read from `src/`): `durableCalls({ name, durableStream, retriesAllowed, maxAttempts, timeoutMS, … })` runs each `doStream` in one `DBOS.runStep`, writes content parts to the durable stream from inside the step, refuses a retry once any content part streamed live (`middleware.ts:146-151`), classifies `name` `AbortError`/`TimeoutError` and `isRetryable === false` as terminal (`internal.ts:28-48`), throws a stream `error` part as the step error (`middleware.ts:174-178`), outside a workflow calls the model directly (103-105), and records the accumulated `providerMetadata` (`middleware.ts:474-478,533-543`). `readDurableStream({ workflowID, key, messageId, client, onError })` replays from offset 0, skips superseded attempts of a step for a new reader (`durable-stream.ts:200-218`), ends from the workflow status when no end record exists (CANCELLED → `abort`; ERROR → `error` chunk with `onError(error)` then `finish` `error`, 226-238), and **throws `DBOSNonExistentWorkflowError` for a workflow that does not exist** (DBOS `streams.js:175-177`), so a 204 needs an existence check first. Peers: `@dbos-inc/dbos-sdk ^4.21 || ^5`, `ai ^7`.
- **DBOS 5.1.10:** `listWorkflows({ workflow_id_prefix: string | string[], attributes, authenticatedUser, status, loadInput, loadOutput, limit, sortDesc })`; `attributes` filters by JSONB `@>` (`system_database.js:3252-3256`), so `{ extractionSchemaId: null }` matches only rows that recorded the key with `null`; `WorkflowStatus.input` is the argument array, `createdAt` epoch ms. `DBOSClient.getWorkflow(id)` loads input, output and attributes (it lists by ID with `loadInput`/`loadOutput` defaulting to true, `system_database.js:1154-1158,3159-3160`), `cancelWorkflow`, `deleteWorkflows(ids)`; `enqueue` with a reused `workflowID` returns the existing workflow; `enqueueInTransaction` with a taken `deduplicationID` throws `DBOSQueueDuplicatedError` (reject is the default policy). `DBOS.stepStatus?.cancelSignal` (`context.d.ts:3-18`) is aborted with **a `DBOSWorkflowCancelledError` as its reason, not an `AbortError`** (`system_database.js:2157-2167`), so a key wait or `fetch` ended by a cancel rejects with that error.
- **M4 (plan names; Task 2 present in the working tree):** `withPoolClientTransaction`, `TransactionalEnqueue`, `AdmittedWorkflow { workflowName, workflowID, queueName, authenticatedUser, attributes }` — **no `deduplicationID`** — and `isUniqueViolation` (`packages/db/src/pool-client-transaction.ts`); `WorkflowStatuses`, `executionOf`, `LIVE_WORKFLOW_STATUSES`, `INTERRUPTED_FAILURE` (`packages/db/src/execution-status.ts`); `createResearcherProjectStore(account, database?, { workflowStatuses, enqueue })` with the Studio adapter in `server/app.ts` (M4 Task 9); `createInternalProjectWorkerStore()` with `readRevisionMarkdown` and `projectContextOwner` (M4 Task 9); `WorkflowSteps`, `dbosSteps`, `isWorkflowCancellation` (`extraction/workflows`, M4 Task 5); `server/dbos.ts` (`studioDbos()`, `STUDIO_QUEUE`, `awaitWorkflowOutcome`, `launchStudioDbos({ …, schema, keiSchema, executorId, register })`); `server/workflows.ts` (`STUDIO_WORKFLOW_NAMES`, `registerStudioWorkflows`); the Studio PostgreSQL tier (`vitest.postgres.config.ts`, `test/support/postgres.ts`: `disposableDatabaseUrl`, `testSchemas`, `dropSchemas`) and crash harness (`test/support/crash.ts` `runWorkflowChild(scenario, env)`, `workflowChild.ts`, scenarios in `test/support/scenarios/`); `cancelScopeWork` cancels live workflows by `sourceDocumentId`/`projectContextId` attribute after a deletion (M4 Task 12).

## Global Constraints

- **Worktree and branch:** `/home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6` on `feat/dbos-m2-m6`. Other agents write under `docs/plans/2026-09-24-unified-durable-execution-evidence/m0r*/`: never touch, stage or commit anything there. Stage explicit paths, never `git add -A .` at the root.
- **Preconditions:** M4 is complete (its Task 14 recorded; the DBOS plan carries its "done" line). Verify: `grep -c "M4: Studio's background work on DBOS — done" docs/plans/2026-09-24-unified-durable-execution.md` prints 1; `grep -n "export function registerStudioWorkflows\|STUDIO_WORKFLOW_NAMES" prototypes/studio/server/workflows.ts` lists M4's four names; `grep -n "export function requestModelKeyResend" prototypes/studio/src/auth/authenticatedFetch.ts` finds it; `grep -n "readRevisionMarkdown" packages/db/src/project-store.ts` finds it. If any fails, stop and report to the controller.
- **Pins:** `@dbos-inc/vercel-ai` exactly `0.4.4` (no caret) in `prototypes/studio` `dependencies`. After the install `pnpm why @dbos-inc/dbos-sdk` lists one version (5.1.10) and `pnpm why ai` lists one `ai` 7.0.93: a second copy of either breaks the singleton or the middleware types. Install with `FREE_SKIP_PYTHON=1 pnpm --filter studio add --save-exact @dbos-inc/vercel-ai@0.4.4`.
- **Names (fixed):** workflows `suggestSchema` (`suggestion:<operationId>`), `proposeSchemaEdit` (`edit:<operationId>`), `chatTurn` (`chat:<turnId>`), all on queue `studio`, all registered only by `registerStudioWorkflows()` with an explicit `name`; chat deduplication ID `chat:<sourceRepresentationRevisionId>`; durable stream key `ui`; `durableCalls` step name `chat`. Operation and turn IDs are client-minted canonical lowercase UUIDs; workflow IDs are matched with full-match expressions (`^…$`, no `m` flag).
- **Workflow attributes (fixed):** generation `{ projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId: string | null }` (explicit `null` before the first schema); edit `{ projectContextId, extractionSchemaId, sourceDocumentId?, sourceRepresentationRevisionId? }` (the source keys only for a document-grounded edit); chat `{ projectContextId, sourceDocumentId, sourceRepresentationRevisionId }`. `authenticatedUser` is always the Project Context owner.
- **Secrets:** workflow inputs carry IDs, questions and instructions only — never a key, never document text. No test or script prints a database URL with its password or a synthetic key. Model steps return typed results whose failure is `{ status, code, message }` with FREE's own copy; nothing a provider returned (body, headers, metadata, error message) is stored except the model's generated text.
- **No compatibility aliases** (spec, *Public contract changes*): the chat request loses `messages` and `temperature`; `free-document-chat` goes; no custom `data-dbos-superseded` handling is added anywhere.
- **Deletions:** implementer subagents may not run `git rm` without the user's authorization. Run plain `rm`, then `git add -A <those exact paths>`.
- **Test tiers (exact commands):**
  - Studio: `pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test`; one file: `pnpm --filter studio exec vitest run <path>`; browser tests start with `// @vitest-environment jsdom`.
  - Studio PostgreSQL: `pnpm --filter studio test:postgres` with `DATABASE_URL` and `EXTRACTION_TEST_DATABASE_URL` exported and equal; one file: `pnpm --filter studio exec vitest run --config vitest.postgres.config.ts <path>`.
  - db: `pnpm --filter db typecheck && pnpm --filter db test`; `pnpm --filter db test:postgres` with `PROJECT_STORE_POSTGRES_URL` exported (fresh databases).
  - E2E: `pnpm --filter studio test:e2e` (from Task 13 it runs `playwright.config.ts` then `playwright.recovery.config.ts`); one spec: `pnpm --filter studio exec playwright test e2e/<name>.spec.ts` (default config) or `pnpm --filter studio exec playwright test --config playwright.recovery.config.ts`; base path `pnpm --filter studio test:e2e:base-path`.
  - Real service: `pnpm test:service`. Safety and scripts: `pnpm test:safety`, `node --test scripts/free.test.mjs scripts/test-ci.test.mjs`.
  - Whole repository: `pnpm typecheck && pnpm lint && pnpm test:unit:node && pnpm test:safety && pnpm test:postgres:node && pnpm test:e2e && pnpm test:service`.
- **Disposable databases only** (README #10): user `postgres`, loopback, explicit port 5432, databases `free_test_*`; the guards refuse anything else. Reuse the M1–M4 container; never stop it or any other service. Every task that edits `contract.prisma` recreates its databases:
  ```bash
  docker ps --filter name=free-m1-pg --format '{{.Names}}'   # prints free-m1-pg when it is running
  # Only if it is not running and port 5432 is free (never stop another service to free it):
  docker run --rm -d --name free-m1-pg --mount type=tmpfs,destination=/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=m1-disposable-only \
    -e POSTGRES_DB=free_test_parsing postgres:17
  for name in free_test_m5_store free_test_m5_extraction; do
    docker exec free-m1-pg dropdb -U postgres --if-exists --force "$name"
    docker exec free-m1-pg createdb -U postgres "$name"
  done
  export PROJECT_STORE_POSTGRES_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m5_store
  export EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m5_extraction
  export DATABASE_URL=$EXTRACTION_TEST_DATABASE_URL          # the Studio PostgreSQL tier requires DATABASE_URL === EXTRACTION_TEST_DATABASE_URL
  DATABASE_URL=$PROJECT_STORE_POSTGRES_URL pnpm --filter db db:init
  pnpm --filter db db:init
  ```
  If `free-m1-pg` was started with another password, ask the controller rather than restarting it. `project-store.postgres.check.ts` requires an empty database, so recreate both before each `pnpm --filter db test:postgres` run. DBOS-backed tests create their own system schemas (`dbos_t_<hex>`, `kei_dbos_t_<hex>`) and drop them in `afterAll`.
- **Baseline regeneration (Task 6):**
  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6/packages/db
  export CONTRACT_URL=postgresql://contract:emit@127.0.0.1:5432/free       # never dialled
  DATABASE_URL=$CONTRACT_URL pnpm contract:emit
  rm -r migrations/app/*_baseline
  DATABASE_URL=$CONTRACT_URL npx prisma-next ref delete db --no-interactive   # required when refs/*.contract.* are absent; harmless otherwise
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration plan --name baseline --no-interactive
  cat migrations/app/*_baseline/migration.json                              # note the "to" hash; "from" must be null
  DATABASE_URL=$CONTRACT_URL npx prisma-next ref set db <the "to" hash> --no-interactive
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration check --no-interactive # prints "All checks passed"
  ```
  `src/prisma/contract.{d.ts,json}` and `migrations/app/refs/*.contract.*` are generated and gitignored; commit the baseline directory and `migrations/app/refs/db.json`.
- **Development database:** after Task 6 an existing `pnpm dev` stack's `postgres-data` volume carries M4's baseline and `db:init` refuses it. Do not reset it yourself; tell the controller that the developer must recreate it once.
- **Commits:** one per task, conventional prefix, message ending with the session's attribution line. Never `git stash`, `reset` or `commit --amend` another task's work.

## Test tiers at the M5 seam

| Tier | Tasks 1–5 | Task 6 on | Task 8 on | Task 13 on |
|---|---|---|---|---|
| Studio, db unit; typecheck; lint | green | green | green | green |
| db, extraction, Studio PostgreSQL | green | green (fresh databases) | green | green |
| `pnpm test:e2e` (default config) | green | green | green | green |
| `pnpm test:e2e` recovery config | — | — | — | green |
| `pnpm test:safety`, scripts, `pnpm test:service` | green | green | green | green |
| `pnpm dev` generation / edit across a reload | live tab only (Task 3/4); restore from Task 10 | same | same | works |
| `pnpm dev` document chat | unreachable (ChatTab unmounted) | same | API only | reachable from Task 11 |

## Plan decisions (not settled by the spec; settled here — the ones marked ★ need the controller's confirmation)

1. ★ **The Chat tab comes back.** `ChatTab` has been unmounted since 44ce50b, yet decisions 4 and 8, the M5 *Browser* text, its acceptance ("reload the page mid-`chatTurn`") and the cutover smoke test all assume a reachable chat. Task 11 adds a `chat` `RailTab` labelled "Chat" between Schema and Results, kept mounted while hidden (as the other rail panels are) so it reconnects on load. *Cost if wrong:* one tab to remove again; the server side is unaffected. The alternative — keep it unmounted and test the tab only as a component — leaves every chat acceptance bullet provable only through the API.
2. ★ **Chat cancellation goes through `DELETE /api/model-operations/chat:<turnId>`, and the Chat tab gains a Stop button.** The spec lists no chat cancel route but requires "aborts that come from a user action call the cancel route" and, under *Verification*, "one answer per chat turn when an answer races a cancel". The route writes `failure { code: 'cancelled', message: 'You stopped this answer.' }` under the conditional predicate, then cancels `chat:<turnId>` if live (spec *Rules*: the cancellation handler records the domain outcome). The listing stays generation and edit only. *Cost if wrong:* one route branch and one button.
3. **Workflow-first operations are enqueued by name on the `studio` queue through the admission client** (as M4 plan decision 2 does for reprocessing), with `authenticatedUser` and the fixed attributes; a reused operation ID returns the existing workflow and the handler compares its recorded input with `isDeepStrictEqual` (409 `operation_conflict` on any difference, including `workflowName`). No deduplication ID: the operation ID is the identity.
4. **Generation and edit handlers wait for the workflow** (`awaitWorkflowOutcome`, 250 ms interval, at most 25 min: two 10-minute calls for an edit's repair plus the 60 s key wait) and answer exactly today's success body and status codes. A client abort ends the wait only; the workflow runs on. A wait that times out answers 504 `operation_pending`; a cancelled workflow answers 409 `operation_cancelled`; `ERROR`/`MAX_RECOVERY_ATTEMPTS_EXCEEDED`/missing answers 500 `interrupted` with `INTERRUPTED_FAILURE.message`.
5. **Model steps return typed results** `{ ok: true, … } | { ok: false, status, code, message }` (spec *Typed results*): every error a step catches becomes `operationFailureOf(error)` — an `ApiError`'s own status, code and message (FREE's copy), anything else 500 `unexpected_failure`. Nothing is rethrown from inside a JSON step, so a provider error's cause never reaches DBOS's error serializer.
6. **Document text is read at workflow scope** (spec *What DBOS history holds*): the three workflows read the immutable revision's canonical Markdown (and an edit's base schema tree) with a plain call outside any step, pass it to the step closure, and never return it. A missing revision or schema revision ends a JSON workflow with a typed 404 and a chat workflow with no write.
7. **The model-operation DTO** (`shared/modelOperation.contract.ts`): `{ workflowId, operationId, kind: 'generation' | 'proposal', status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED', instruction, baseSchemaRevisionId, createdAt, template | response | null, failure | null }`. `SUCCEEDED` means the workflow returned `ok: true`; `FAILED` covers `ok: false` and every stopped status (with `INTERRUPTED_FAILURE` for a stop).
8. **`DELETE /api/model-operations/<workflow ID>`:** a live `suggestion:`/`edit:` workflow is cancelled (204); a finished `edit:` proposal is deleted together with every older finished `edit:` workflow in the same scope whose input names the same `baseSchemaRevisionId` (204); any other settled operation answers 204 and deletes nothing; `chat:` follows decision 2. Ownership: the workflow's recorded `projectContextId` (and `extractionSchemaId`) must pass the PostgreSQL scope check for the session's account and its `authenticatedUser` must be that account; otherwise 404, never 403.
9. **The transcript** (`GET /api/chat/<revision ID>`): turns in `createdAt, id` order with a derived `status` (`ANSWERED`, `FAILED` — failure written —, `QUEUED`/`RUNNING` — live —, `UNANSWERED` — no outcome and the workflow stopped or is gone) and `reconnectTurnId`, the newest turn whose status is `QUEUED` or `RUNNING` (at most one exists: the revision's deduplication record).
10. **The browser repeats a model-work POST** (`repeatableModelPost`, Task 9) after a network error or a 502/503/504 whose body is not a Studio error, or whose code is `persistence_unavailable` or `operation_pending` — at most three more times (1, 2 and 4 s apart), resending the keys before each attempt, never after an abort. A confirmed Studio failure (any other code, any 4xx) is never repeated. Extraction admission keeps its read-based reconciliation (spec *Replays*) and is not repeated.
11. **`AdmittedWorkflow` gains `deduplicationID?: string`**, and `packages/db` gains `DuplicateActiveWorkflowError`; Studio's enqueue adapter (M4, `server/app.ts`) maps `DBOSQueueDuplicatedError` to it, so `packages/db` still imports no DBOS runtime.
12. **The chat request drops `temperature`** (no browser sends one) and **history** (spec *Request*); the earlier answered turns come from `ChatTurn` rows (all of them, in order).
13. **A reloaded page acts only on operations it found at load** (and polls only those that were running then); operations this tab starts afterwards follow the live path. Of the finished operations whose base is the current revision, only the newest acts: a generation is saved, or a proposal reopened — never both, because saving moves the base.
14. **The listing is scoped to Project Context and Extraction Schema, as the spec says.** A first generation (`extractionSchemaId: null`) can therefore be restored in any document workspace of its project before the project has a schema; the project has one schema, so that is where the generation would have landed anyway.
15. **The Studio-restart and planted-key browser tests run in their own Playwright stack** (`playwright.recovery.config.ts`, one worker) whose web-server wrapper respawns Vite after a SIGKILL and tees its output to a log file; restarting the shared default stack would break parallel specs.

## Review Focus

1. **A key or provider body reaches storage or logs through a path the sanitizer does not see** — a `doStream()` rejection versus a stream-read rejection versus an `error` part; a key echoed in response headers, provider metadata, a `TypeError` message or a Zod issue; a JSON step that rethrows; DBOS or the AI SDK logging a step error. Expected: no table, stream, dump, data file or log line contains the key. Pinned by Task 2 `every failure path yields a ChatModelFailure that holds none of the planted key`, Task 3 `a key planted in a provider error in a JSON step reaches no DBOS or public table and no log`, Task 7 `a key planted in the error cause chain, response headers and provider metadata of a chat call reaches no table, stream record or log` and Task 13 `a planted key reaches no pg_dump, data volume or Studio log after chat, generation, a batch suggestion and a probe`.
2. **A recovered or retried chat call appends replacement text** — the AI SDK's `streamRetries`, an `onError` that returns `{ retry: true }`, `maxRetries`, or a `durableCalls` retry after content streamed. Expected: after a partial failure the stream ends with an error finish, the row holds a failure, and no answer is saved. Pinned by Task 7 `a partial provider failure ends the stream with an error finish, records the failure and saves no answer; the provider was called once` and `the chat's streamText sets maxRetries 0, no streamRetries, and an onError that returns nothing`.
3. **A stale generation lands on newer work after a reload** — a dirty or session-recovered draft, another tab that already saved it, a base that moved while the poll ran, or a first generation arriving after another tab created the schema. Expected: dropped silently, as a reloaded conflicted save is today. Pinned by Task 10 `planRecovery` cases, `restoreGeneration saves onto a clean base and drops on a conflict without an error`, and Task 12 `a reloaded page drops a finished generation when newer work exists`.
4. **A workflow ID alone authorizes a read, stream or cancel** — another account's `edit:`/`chat:` ID, a turn ID under another revision, a project deleted between two reconnects. Expected: 404 with no DBOS call beyond locating the scope. Pinned by Task 5 `a second account can neither list nor cancel nor discard the first account's operations` and Task 8 `a second account can neither read, stream nor cancel the first account's turns; after the project is deleted every reconnect is 404`.
5. **Recovery loops or storms** — `model_key_required` resent forever, a repeated POST re-running a confirmed failure, a poll that never stops. Expected: one resend per operation or turn, at most three repeats per POST, polling ends when every watched operation settled or the panel unmounts. Pinned by Task 9 `a confirmed failure is never repeated; an uncertain one at most three times` and `a model POST is repeated with the same body after a network failure or a proxy 502/503/504, keys first each time`, Task 10 `polls every 2 s only while a watched operation runs, and stops on unmount` and Task 11 `a model_key_required turn resends the keys once and asking again mints a new turn`.

---

### Task 1: The model boundary: `@dbos-inc/vercel-ai`, DBOS's cancel signal inside every provider attempt, one stream `onError`

**Files:**
- Modify: `prototypes/studio/package.json` (dependency `"@dbos-inc/vercel-ai": "0.4.4"`), `pnpm-lock.yaml`
- Modify: `prototypes/studio/api/_model_keys.ts` (`withStepCancellation`; `requireModelKey` composes it; comment 127-132), `prototypes/studio/api/_model_keys.test.ts`
- Modify: `prototypes/studio/api/_provider.ts` (export `providerModel`; add `stepCancellable`; `resolveCapabilityRoute` wraps every general model, 751), `prototypes/studio/api/_provider.test.ts`
- Modify: `prototypes/studio/api/_model.ts` (`modelStreamOnError`; `streamChatWithModel` uses it; NuExtract's signal; the stale comment at 137), `prototypes/studio/api/_model.transport.test.ts`
- Create: `prototypes/studio/api/_model_stream_calls.test.ts`

**Interfaces:**
- Consumes: nothing from earlier M5 tasks.
- Produces:
  ```ts
  // api/_model_keys.ts
  export function withStepCancellation(signal: AbortSignal | undefined, cancel?: AbortSignal | undefined): AbortSignal | undefined
  // api/_provider.ts
  export function providerModel(model: LanguageModel): LanguageModelV4   // the existing private helper, now exported
  export function stepCancellable(model: LanguageModel): LanguageModel
  // api/_model.ts
  export function modelStreamOnError(operation: string, capture?: (error: unknown) => void): (event: { error: unknown }) => void
  ```

- [ ] **Step 1: Install and pin `@dbos-inc/vercel-ai`**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  FREE_SKIP_PYTHON=1 pnpm --filter studio add --save-exact @dbos-inc/vercel-ai@0.4.4
  pnpm why @dbos-inc/vercel-ai     # one version: 0.4.4
  pnpm why @dbos-inc/dbos-sdk      # one version: 5.1.10
  pnpm --filter studio why ai      # one version: 7.0.93
  ```
  `vite.server.config.ts` already keeps it external; do not edit it.

- [ ] **Step 2: Write the failing tests**

  `api/_model_keys.test.ts` (the first case passes the cancel signal explicitly; the second mocks DBOS):
  - `withStepCancellation returns the call signal unchanged outside a step, the step's cancel signal alone without a call signal, and both composed inside a step` — `withStepCancellation(undefined, undefined) === undefined`; `withStepCancellation(call, undefined) === call`; `withStepCancellation(undefined, cancel) === cancel`; with both, aborting either aborts the result and leaves the other untouched.
  - `requireModelKey ends the wait when the step's cancel signal fires, and returns no key after it` — `vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { get stepStatus() { return stepStatus.current } } }))` with `const stepStatus = vi.hoisted(() => ({ current: undefined as undefined | { cancelSignal: AbortSignal } }))`; set `stepStatus.current = { cancelSignal: controller.signal }`; start `requireModelKey(cache, 'acct', connection, undefined, 60_000)`; abort the controller; the promise rejects with the controller's reason; a key put afterwards changes nothing.
  `api/_provider.test.ts` (same hoisted mock):
  - `every general model's provider call receives the step's cancel signal, keyed or keyless` — resolve a route twice, once for a `hasKey` OpenAI-compatible connection (key in the cache) and once for a keyless one, with `modelFactories['openai-compatible']` returning a stand-in whose `doGenerate` records `params.abortSignal`; with `stepStatus.current` set, call `generateText({ model: target.model, prompt: 'x' })`; abort the cancel controller; both recorded signals report `aborted === true`.
  - `a keyed model's key wait ends on the step's cancel signal and never calls the provider` — no key in the cache; the stand-in counts calls; aborting the cancel controller rejects the call and the count stays 0.
  `api/_model.transport.test.ts`:
  - `NuExtract's key wait and fetch receive the step's cancel signal` — the NuExtract target from the existing fixtures with a recording `fetch`; the recorded `init.signal` aborts when the cancel controller aborts.
  - `modelStreamOnError logs only the class and status, and nothing for a missing key` — `console.error` spy: an `APICallError` whose `responseBody` and `requestBodyValues` hold `FREE_SYNTHETIC_KEY_1` logs `['chat_failed:', { error: 'APICallError', statusCode: 500 }]` and no argument holds the key; a `ModelKeyRequiredError` logs nothing; `capture` receives the original error; the callback returns `undefined`.
  `api/_model_stream_calls.test.ts`:
  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { expect, it } from 'vitest'

  // Rule 4: the SDK's default onError logs provider bodies and `Bearer <key>` messages, so every stream call names ours.
  it('every streamText and streamObject call in server code passes modelStreamOnError', () => {
    for (const directory of ['api', 'server']) {
      const root = join(import.meta.dirname, '..', directory)
      for (const file of readdirSync(root).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
        const source = readFileSync(join(root, file), 'utf8')
        const calls = source.match(/\b(?:streamText|streamObject)\(/g)?.length ?? 0
        const handled = source.match(/onError:\s*modelStreamOnError\(/g)?.length ?? 0
        expect({ file, handled }).toEqual({ file, handled: calls })
      }
    }
  })
  ```
  (Doc comments must not contain an opening parenthesis right after `streamText` or `streamObject`: write "streamText calls".)

  Run: `pnpm --filter studio exec vitest run api/_model_keys.test.ts api/_provider.test.ts api/_model.transport.test.ts api/_model_stream_calls.test.ts`. Expected: FAIL (missing exports; the source scan fails on `_model.ts`).

- [ ] **Step 3: Implement**

  `api/_model_keys.ts` (add `import { DBOS } from '@dbos-inc/dbos-sdk'`; importing it runs no query and registers nothing):
  ```ts
  /**
   * The provider attempt's signal with DBOS's `cancelSignal` added when the attempt runs inside a step, so a cancelled
   * workflow ends a key wait or a provider call about 1 s later (spec, *Cancellation → Studio model calls*). It is
   * composed here, at the model boundary, because under `durableCalls` the library — not FREE — calls the model, so no
   * caller can add it. Outside a step it returns `signal` unchanged.
   */
  export function withStepCancellation(
    signal: AbortSignal | undefined,
    cancel: AbortSignal | undefined = DBOS.stepStatus?.cancelSignal,
  ): AbortSignal | undefined {
    if (!cancel || cancel === signal) return signal
    return signal ? AbortSignal.any([signal, cancel]) : cancel
  }
  ```
  `requireModelKey` becomes:
  ```ts
  /**
   * The key for one provider attempt: from the cache, or after waiting up to `waitMs` for a page to resend it. The wait
   * ends early when `signal` aborts or, inside a DBOS step, when the workflow is cancelled; nothing after either runs.
   */
  export async function requireModelKey(cache: ModelKeyCache, accountId: string, connection: KeyedConnection,
    signal: AbortSignal | undefined, waitMs = MODEL_KEY_WAIT_MS): Promise<string> {
    const bounded = withStepCancellation(signal)
    const key = await cache.wait(accountId, connection, bounded, waitMs)
    if (key === null) throw new ModelKeyRequiredError()
    bounded?.throwIfAborted()
    return key
  }
  ```
  Update the `ModelKeyRequiredError.isRetryable` comment to "neither the AI SDK nor `durableCalls` may retry it" (drop "(M5)").

  `api/_provider.ts`: export `providerModel` unchanged, and add after `keyedModel`:
  ```ts
  /**
   * A route's general model as every call uses it: the provider attempt runs with the step's cancel signal composed
   * into `abortSignal` (withStepCancellation), keyed or keyless — deployment vLLM and CLI connections never pass through
   * keyedModel — so a cancelled workflow stops the call about 1 s later. The keyed wrapper inside it waits for its key
   * with that same signal.
   */
  export function stepCancellable(model: LanguageModel): LanguageModel {
    return wrapLanguageModel({
      model: providerModel(model),
      middleware: {
        specificationVersion: 'v4',
        transformParams: async ({ params }) => ({ ...params, abortSignal: withStepCancellation(params.abortSignal) }),
      },
    })
  }
  ```
  and at 751: `model = stepCancellable(connection.hasKey ? keyedModel(createModel, connection, route.modelId, key) : createModel(connection, route.modelId, null))`.

  `api/_model.ts`:
  ```ts
  /**
   * The `onError` of every streamText and streamObject call. The SDK's default logs the whole error: the provider's
   * response body, the request and, for a key that is no valid header value, a runtime message quoting `Bearer <key>`.
   * This logs only the error's class and HTTP status, and nothing for a missing key (the page resends it). It returns
   * nothing: an `onError` that returns `{ retry: true }` would make the SDK retry the stream in-process and append
   * replacement text.
   */
  export function modelStreamOnError(operation: string, capture?: (error: unknown) => void) {
    return ({ error }: { error: unknown }): void => {
      capture?.(error)
      if (error instanceof ModelKeyRequiredError || (error as { code?: unknown } | null)?.code === 'model_key_required') return
      const status = (error as { statusCode?: unknown } | null)?.statusCode
      console.error(`${operation}_failed:`, {
        error: error instanceof Error ? error.constructor.name : typeof error,
        statusCode: APICallError.isInstance(error) ? error.statusCode ?? null : typeof status === 'number' ? status : null,
      })
    }
  }
  ```
  In `streamChatWithModel`, replace the inline `onError` (124-132) with `onError: modelStreamOnError('chat')`, and the comment at 137 with `// Only a missing key is named. It arrives inside a 200, which authenticatedFetch's 409 hook never sees, so no key resend follows it here; the Chat tab resends from the transcript (M5 Task 11).` In `generateWithNuExtract`, start with `const signal = withStepCancellation(input.signal)` and use `signal` for `target.key(signal)`, `signal?.throwIfAborted()` and the `fetch`.

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter studio exec vitest run api/_model_keys.test.ts api/_provider.test.ts api/_model.transport.test.ts api/_model_stream_calls.test.ts
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add pnpm-lock.yaml prototypes/studio/package.json prototypes/studio/api/_model_keys.ts prototypes/studio/api/_model_keys.test.ts \
    prototypes/studio/api/_provider.ts prototypes/studio/api/_provider.test.ts prototypes/studio/api/_model.ts \
    prototypes/studio/api/_model.transport.test.ts prototypes/studio/api/_model_stream_calls.test.ts
  git commit -m "feat(studio): stop every model call on DBOS's cancel signal at the model boundary and pin durable chat's library"
  ```

### Task 2: The chat sanitizer inside `durableCalls`

Nothing is registered or wired here; Task 7 wraps the resolved chat model with it.

**Files:**
- Create: `prototypes/studio/api/_chat_sanitizer.ts`, `prototypes/studio/api/_chat_sanitizer.test.ts`, `prototypes/studio/test/support/plantedKey.ts`

**Interfaces:**
- Consumes: Task 1's `providerModel`.
- Produces:
  ```ts
  export type ChatFailureCode = 'model_key_required' | 'invalid_model_config' | 'model_operation_failed' | 'cancelled'
  export type ChatTurnFailure = Readonly<{ code: ChatFailureCode; message: string }>
  export const CHAT_FAILED: ChatTurnFailure         // { code: 'model_operation_failed', message: 'Chat failed.' }
  export const CHAT_CANCELLED: ChatTurnFailure      // { code: 'cancelled', message: 'You stopped this answer.' }
  export class ChatModelFailure extends Error { readonly code: ChatFailureCode; readonly isRetryable: boolean; readonly statusCode: number | null }
  export function sanitizeChatError(error: unknown): ChatModelFailure
  export function sanitizedChatModel(model: LanguageModel): ReturnType<typeof wrapLanguageModel>
  export function chatFailureOf(error: unknown): ChatTurnFailure
  export function chatTurnFailed(failure: ChatTurnFailure): Error
  export function chatStreamErrorText(error: unknown): string
  // test/support/plantedKey.ts
  export function plantedKey(): string                                   // FREE_SYNTHETIC_KEY_<16 hex>
  export function holdsKey(value: unknown, key: string): boolean         // own properties (enumerable or not), causes, arrays, maps, strings
  export function plantingModel(key: string, behaviour: 'throw' | 'read-reject' | 'error-part' | 'success' | 'key-missing' | 'abort'): LanguageModelV4
  ```

- [ ] **Step 1: The test helpers** (`test/support/plantedKey.ts`)

  `plantedKey()` is `` `FREE_SYNTHETIC_KEY_${randomBytes(8).toString('hex')}` ``. `holdsKey` walks a value depth-first with a `seen` set over `Object.getOwnPropertyNames` (so the non-enumerable `message`, `stack` and `cause` count), `Map`/`Set` entries and array items, and tests every string with `includes(key)`. `plantingModel` returns a `specificationVersion: 'v4'` model (provider `synthetic`, model ID `synthetic`, `supportedUrls: {}`, `doGenerate` throwing `unused`) whose `doStream`:
  - `'throw'` rejects with `new APICallError({ message: \`401 for Bearer ${key}\`, url: 'http://127.0.0.1:1/v1/chat/completions', requestBodyValues: { authorization: \`Bearer ${key}\` }, statusCode: 401, responseHeaders: { 'x-echo': key }, responseBody: \`{"error":"${key}"}\`, cause: new Error(key), isRetryable: false })`;
  - `'read-reject'` returns a stream that enqueues `stream-start` and a `text-delta`, then errors with `new TypeError(\`socket closed after ${key}\`)`;
  - `'error-part'` enqueues `stream-start`, `text-start`, a `text-delta` `partial`, then `{ type: 'error', error: <the APICallError above> }`, and closes;
  - `'success'` returns `{ request: { body: { prompt: key } }, response: { headers: { 'x-echo': key } }, stream }` whose `text-start`/`text-delta`/`text-end` and `finish` parts carry `providerMetadata: { synthetic: { marker: key } }`, with a `{ type: 'raw', rawValue: key }` part among them and `answer` as the text;
  - `'key-missing'` rejects with `new ModelKeyRequiredError()`;
  - `'abort'` rejects with `new DOMException('aborted', 'AbortError')`.

- [ ] **Step 2: Write the failing tests** (`api/_chat_sanitizer.test.ts`)

  A helper `consume(model)` calls `model.doStream({ prompt: [] })` and reads every part, returning `{ result, parts, error }` (a rejection of `doStream` or of a read is `error`; an `error` part stays in `parts`).
  - `every failure path yields a ChatModelFailure that holds none of the planted key` — for `'throw'`, `'read-reject'` and `'error-part'`: the error (or the `error` part's `error`) is a `ChatModelFailure`; `holdsKey(it, key) === false`; `it.cause === undefined`; `Object.keys(it)` is a subset of `['code', 'isRetryable', 'statusCode']`.
  - `a successful stream keeps its text and drops provider metadata, raw chunks, request and response` — the `text-delta`s join to `answer`; no part has `providerMetadata`; no `raw` part; `Object.keys(result)` is `['stream']`; `holdsKey(parts, key) === false`.
  - `a missing key, an abort and a DBOS cancellation stay terminal; a provider's own retry flag is kept` — `'key-missing'` → `{ code: 'model_key_required', isRetryable: false }` with `ModelKeyRequiredError`'s message; `'abort'` → `name === 'AbortError'`, `isRetryable === false`; `new DBOSErrors.DBOSWorkflowCancelledError('chat:x')` (the cancel signal's reason) → `name === 'AbortError'`, `isRetryable === false`, so `durableCalls` never spends its three attempts on a cancelled turn; an `APICallError` 429 with `isRetryable: true` → `isRetryable === true`, `statusCode === 429`; a plain `TypeError` → `isRetryable === true`; `new ApiError(409, 'invalid_model_config', 'No model is configured for the Assistant model route.')` → that code and message, `isRetryable === false`.
  - `durableCalls outside a workflow passes the sanitized stream through` — `wrapLanguageModel({ model: sanitizedChatModel(plantingModel(key, 'success')), middleware: durableCalls({ name: 'chat' }) })` streams `answer` (outside a workflow `durableCalls` calls the model directly, `middleware.ts:103-105`); this pins the composition order Task 7 uses.
  - `chatFailureOf finds the sanitized failure behind a wrapper and in an error revived from a checkpoint, and says Chat failed. otherwise` — a `ChatModelFailure`; `{ lastError: failure }`; `Object.assign(new Error('Studio does not hold …'), { code: 'model_key_required' })` (how DBOS revives a recorded error: a plain `Error` with its enumerable properties) → that code and message; `new Error('boom')` → `CHAT_FAILED`.
  - `chatTurnFailed is a fresh error with the failure's code and message and no cause`; `chatStreamErrorText names only failures chatTurn threw` (`chatTurnFailed(CHAT_CANCELLED)` → its message; `new Error('SQL text')` → `Chat failed.`).

  Run: `pnpm --filter studio exec vitest run api/_chat_sanitizer.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `api/_chat_sanitizer.ts`**

  ```ts
  import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk'
  import { APICallError, wrapLanguageModel, type LanguageModel } from 'ai'
  import { ApiError } from './_http.js'
  import { ModelKeyRequiredError } from './_model_keys.js'
  import { providerModel } from './_provider.js'

  type ChatModel = ReturnType<typeof wrapLanguageModel>
  type StreamResult = Awaited<ReturnType<ChatModel['doStream']>>
  type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

  /** Chat failures a researcher can see, in FREE's own words: nothing here ever comes from a provider. */
  export type ChatFailureCode = 'model_key_required' | 'invalid_model_config' | 'model_operation_failed' | 'cancelled'
  export type ChatTurnFailure = Readonly<{ code: ChatFailureCode; message: string }>
  export const CHAT_FAILED: ChatTurnFailure = { code: 'model_operation_failed', message: 'Chat failed.' }
  export const CHAT_CANCELLED: ChatTurnFailure = { code: 'cancelled', message: 'You stopped this answer.' }
  const CHAT_STOPPED: ChatTurnFailure = { code: 'model_operation_failed', message: 'Chat stopped before it finished.' }
  const CODES: ReadonlySet<string> = new Set(['model_key_required', 'invalid_model_config', 'model_operation_failed', 'cancelled'])

  /** Reads a property of something a provider threw without letting a hostile getter replace the real error. */
  function read<T>(get: () => T): T | undefined {
    try {
      return get()
    } catch {
      return undefined
    }
  }

  /**
   * What durableCalls may record of a failed chat call. DBOS serializes a step's thrown error with every enumerable
   * property and its cause (spec, *Rules*), so this is a fresh Error holding FREE's copy and the retry classification
   * only: no cause, response, request, headers or body. `name` and `isRetryable` keep durableCalls' classification
   * (`internal.ts:28-48`): an abort and a missing key are terminal; a provider's own flag is kept.
   */
  export class ChatModelFailure extends Error {
    readonly code: ChatFailureCode
    readonly isRetryable: boolean
    readonly statusCode: number | null
    constructor(failure: ChatTurnFailure, isRetryable: boolean, statusCode: number | null, name = 'ChatModelFailure') {
      super(failure.message)
      this.name = name
      this.code = failure.code
      this.isRetryable = isRetryable
      this.statusCode = statusCode
    }
  }

  /** Replaces every error a chat call can raise — not only APICallError — with a ChatModelFailure. */
  export function sanitizeChatError(error: unknown): ChatModelFailure {
    if (error instanceof ChatModelFailure) return error
    // The step's cancelSignal aborts with a DBOSWorkflowCancelledError (not an AbortError), so a key wait or a provider
    // fetch ended by a cancel rejects with it; name it AbortError so durableCalls classifies it as terminal.
    if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return new ChatModelFailure(CHAT_STOPPED, false, null, 'AbortError')
    const name = read(() => (error as { name?: unknown } | null)?.name)
    if (name === 'AbortError' || name === 'TimeoutError') return new ChatModelFailure(CHAT_STOPPED, false, null, name)
    if (error instanceof ModelKeyRequiredError)
      return new ChatModelFailure({ code: 'model_key_required', message: error.message }, false, null)
    if (error instanceof ApiError && error.code === 'invalid_model_config')
      return new ChatModelFailure({ code: 'invalid_model_config', message: error.message.slice(0, 512) }, false, null)
    const flag = read(() => (error as { isRetryable?: unknown } | null)?.isRetryable)
    const statusCode = read(() => (APICallError.isInstance(error) ? error.statusCode ?? null : null)) ?? null
    return new ChatModelFailure(CHAT_FAILED, typeof flag === 'boolean' ? flag : !(error instanceof ApiError), statusCode)
  }

  function withoutProviderMetadata(part: StreamPart): StreamPart {
    if (!('providerMetadata' in part)) return part
    const { providerMetadata: _dropped, ...rest } = part as StreamPart & { providerMetadata?: unknown }
    return rest as StreamPart
  }

  /**
   * The provider model as durableCalls may record it (spec, *Rules → Secrets never enter DBOS*). durableCalls wraps this
   * model, so it runs inside durableCalls' step: every doStream rejection, stream-read failure and `error` part becomes a
   * ChatModelFailure, and provider metadata goes from every part, because durableCalls 0.4.4 checkpoints the accumulated
   * provider metadata (not the request body or the response headers: version probe). Raw chunks are dropped and only
   * the stream is returned, never the provider's request or response. Chat only streams, so generate calls pass through.
   */
  export function sanitizedChatModel(model: LanguageModel): ChatModel {
    return wrapLanguageModel({
      model: providerModel(model),
      middleware: {
        specificationVersion: 'v4',
        wrapStream: async ({ doStream }) => {
          let upstream: StreamResult
          try {
            upstream = await doStream()
          } catch (error) {
            throw sanitizeChatError(error)
          }
          const reader = upstream.stream.getReader()
          return {
            stream: new ReadableStream<StreamPart>({
              async pull(controller) {
                for (;;) {
                  let next: ReadableStreamReadResult<StreamPart>
                  try {
                    next = await reader.read()
                  } catch (error) {
                    controller.error(sanitizeChatError(error))
                    return
                  }
                  if (next.done) return controller.close()
                  if (next.value.type === 'raw') continue
                  controller.enqueue(next.value.type === 'error'
                    ? { type: 'error', error: sanitizeChatError(next.value.error) }
                    : withoutProviderMetadata(next.value))
                  return
                }
              },
              cancel: (reason) => reader.cancel(reason),
            }),
          }
        },
      },
    })
  }

  /** The typed failure of a turn from whatever streamText reported: the sanitized failure (live), a wrapper around it,
   *  or the plain Error DBOS revives from a checkpoint; anything else is Chat failed. Reads no provider property. */
  export function chatFailureOf(error: unknown): ChatTurnFailure {
    for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
      const code = read(() => (current as { code?: unknown }).code)
      const message = read(() => (current instanceof Error ? current.message : undefined))
      if (typeof code === 'string' && CODES.has(code) && typeof message === 'string')
        return { code: code as ChatFailureCode, message: message.slice(0, 512) }
      current = read(() => (current as { lastError?: unknown }).lastError ?? (current as { cause?: unknown }).cause)
    }
    const sanitized = sanitizeChatError(error)
    return { code: sanitized.code, message: sanitized.message }
  }

  /** Thrown by chatTurn after it recorded `failure`: a fresh Error, so the workflow ends ERROR and readDurableStream ends
   *  the stream with an error finish. Returning a typed failure as success would end it with an ordinary finish (stream
   *  probe). */
  export function chatTurnFailed(failure: ChatTurnFailure): Error {
    return Object.assign(new Error(failure.message), { name: 'ChatTurnFailed', code: failure.code })
  }

  /** readDurableStream's onError: the recorded workflow error's message only when chatTurn threw it. */
  export function chatStreamErrorText(error: unknown): string {
    const code = read(() => (error as { code?: unknown } | null)?.code)
    const message = read(() => (error instanceof Error ? error.message : undefined))
    return typeof code === 'string' && CODES.has(code) && typeof message === 'string' ? message.slice(0, 512) : CHAT_FAILED.message
  }
  ```
  Only sanitized errors reach durableCalls' record, so an error revived from a checkpoint always carries a valid `code`.

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter studio exec vitest run api/_chat_sanitizer.test.ts
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api/_chat_sanitizer.ts prototypes/studio/api/_chat_sanitizer.test.ts prototypes/studio/test/support/plantedKey.ts
  git commit -m "feat(studio): replace every chat provider error with FREE's own and strip provider metadata inside durableCalls"
  ```

### Task 3: `suggestSchema` on DBOS: operation IDs, typed results, the waiting handler; keys and cancellation proven on PostgreSQL

The largest task: it also builds the operation helper and the PostgreSQL-tier support (scripted model server, seeding, key scans) that Tasks 4–8 reuse. Use a high-effort implementer.

**Files:**
- Create: `prototypes/studio/api/_model_operation.ts` (+ `_model_operation.test.ts`), `prototypes/studio/api/_schema_generation_workflow.ts` (+ `_schema_generation_workflow.test.ts`), `prototypes/studio/api/generate_schema.test.ts`
- Modify: `prototypes/studio/api/generate_schema.ts`, `prototypes/studio/api/_schema_edit.ts` (add `ownedSourceScope`, `optionalSchemaBase`), `prototypes/studio/server/workflows.ts` (+ `workflows.test.ts`), `prototypes/studio/server/researcher-project-ownership.test.ts` (the `generate_schema` cases send `operation_id` and fake the operation client)
- Modify: `packages/db/src/project-store.ts` (`ownedSourceRepresentationDescriptor` 125-164 also selects `sourceDocumentId`; `getSourceRepresentation` returns it), `packages/db/src/project-store.test.ts`
- Modify: `prototypes/studio/src/api.ts` (`requestSchema` sends `operation_id` and the base), `prototypes/studio/src/App.tsx` (`handleGenerate`, 444-464), `prototypes/studio/src/api.test.ts`, `prototypes/studio/src/apiEndpoints.test.ts` (where it lists form fields)
- Create (Studio PostgreSQL tier): `prototypes/studio/test/support/scriptedModelServer.ts`, `prototypes/studio/test/support/interactive.ts`, `prototypes/studio/api/schema_generation.postgres.test.ts`, `prototypes/studio/test/support/scenarios/generation-recover.ts`, `prototypes/studio/test/support/scenarios/generation-replay.ts`

**Interfaces:**
- Consumes: M4's `studioDbos`, `STUDIO_QUEUE`, `awaitWorkflowOutcome`, `dbosSteps`, `WorkflowSteps`, `createInternalProjectWorkerStore().readRevisionMarkdown`, `INTERRUPTED_FAILURE`, the Studio PostgreSQL tier and crash harness; Task 1's model boundary; Task 2's `plantedKey`.
- Produces:
  ```ts
  // api/_model_operation.ts
  export const MODEL_OPERATION_TIMEOUT_MS = 600_000          // one model call (spec: each call keeps a 10-minute timeout)
  export const OPERATION_WAIT_MS = 25 * 60_000               // an edit's two calls plus the 60 s key wait
  export type OperationFailure = Readonly<{ status: number; code: string; message: string }>
  export type OperationResult<T extends object> = ({ ok: true } & T) | ({ ok: false } & OperationFailure)
  export type ModelOperationClient = Pick<DBOSClient, 'enqueue' | 'getWorkflow' | 'listWorkflows' | 'cancelWorkflow' | 'deleteWorkflows'>
  export type OperationStart<I> = Readonly<{ workflowName: string; workflowID: string; owner: string; attributes: Readonly<Record<string, string | null>>; input: I }>
  export function operationFailureOf(error: unknown): OperationFailure
  export function startOrJoinOperation<I>(client: ModelOperationClient, start: OperationStart<I>): Promise<void>
  export function awaitOperation<T extends object>(client: ModelOperationClient, workflowID: string, signal: AbortSignal | undefined, waitMs?: number): Promise<OperationResult<T>>
  // api/_schema_generation_workflow.ts
  export const SUGGEST_SCHEMA = 'suggestSchema'
  export type SchemaGenerationInput = Readonly<{ operationId: string; owner: string; projectContextId: string; sourceRepresentationRevisionId: string; extractionSchemaId: string | null; baseSchemaRevisionId: string | null; instruction: string; temperature: number | null }>
  export type SchemaGenerated = { template: Record<string, unknown>; raw: string; pages: number | null; baseSchemaRevisionId: string | null }
  export type SchemaGenerationPorts = Readonly<{ steps: WorkflowSteps; readMarkdown(sourceRepresentationRevisionId: string): Promise<string | null>; generate: typeof generateSchemaWithModel }>
  export function suggestSchemaWorkflow(input: SchemaGenerationInput, ports: SchemaGenerationPorts): Promise<OperationResult<SchemaGenerated>>
  export function registerSchemaGenerationWorkflow(ports: () => SchemaGenerationPorts): void
  // api/_schema_edit.ts
  export function ownedSourceScope(store: Pick<ResearcherProjectStore, 'getSourceRepresentation'>, projectContextId: string, sourceRepresentationRevisionId: string): Promise<{ sourceDocumentId: string }>   // 404 / 503
  export function optionalSchemaBase(form: FormData): { extractionSchemaId: string; schemaRevisionId: string } | null     // both or neither, else 422
  // src/api.ts
  export type SchemaBase = { extractionSchemaId: string; schemaRevisionId: string }
  export function requestSchema(context: SourceModelContext, signal: AbortSignal | undefined, options: { instruction?: string; operationId: string; base: SchemaBase | null }): Promise<unknown>
  // test/support/scriptedModelServer.ts
  export type ScriptedReply = { text: string; hold?: boolean } | { text: string; dropAfterFirstChunk: true } | { status: number; body: string; headers?: Readonly<Record<string, string>> }
  export type ScriptedCall = Readonly<{ authorization: string | null; stream: boolean; body: unknown; receivedAt: number; closedAt: number | null }>
  export function startScriptedModelServer(): Promise<{ baseUrl: string; reply(...replies: ScriptedReply[]): void; calls(): readonly ScriptedCall[]; waitForCall(count: number, timeoutMs?: number): Promise<ScriptedCall>; release(): void; close(): Promise<void> }>
  // test/support/interactive.ts
  export function seedInteractiveScope(): Promise<{ accountId: string; projectContextId: string; sourceDocumentId: string; sourceRepresentationRevisionId: string }>
  export function configureOwnerRoute(accountId: string, route: { provider: 'openai-compatible' | 'vllm'; baseUrl: string; modelId: string; hasKey: boolean; routes?: ReadonlyArray<'interaction' | 'schemaSuggestion'> }): Promise<{ connectionId: string }>
  export function databaseHolds(url: string, needle: string, schemas: readonly string[]): Promise<readonly string[]>   // "<schema>.<table>" whose rows hold it
  export function captureOutput(): { text(): string; restore(): void }                                               // console.* and process.std{out,err}.write
  ```

- [ ] **Step 1: The PostgreSQL-tier support**

  `test/support/scriptedModelServer.ts`: a `node:http` server on `127.0.0.1:0` answering `POST /v1/chat/completions` (and `GET /v1/models` with one model, `scripted`). Replies are taken FIFO from `reply(...)`; with none queued it answers `{ text: 'scripted answer' }`. Each call records `authorization` (the request header or null), `stream` (the body's `stream === true`), the parsed body, `receivedAt` and `closedAt` (from `res.on('close')`). A text reply answers a streaming request with SSE — one chunk `data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"scripted","choices":[{"index":0,"delta":{"role":"assistant","content":<text>},"finish_reason":null}]}`, then one with `"delta":{}`, `"finish_reason":"stop"` and `"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}`, then `data: [DONE]` — and a non-streaming one with one `chat.completion` JSON (`choices[0].message.content` is the text; the same `usage`). `hold: true` withholds the reply (SSE: after the first chunk; JSON: entirely) until `release()`. `dropAfterFirstChunk` destroys the socket after the first SSE chunk. An error reply writes its status, headers and body; the token `{{authorization}}` in the body is replaced by the request's `authorization` header (how a provider echoes a key into an error). `waitForCall(n)` resolves when the n-th call arrived (default timeout 10 s).

  `test/support/interactive.ts`: `seedInteractiveScope()` creates with the post-M4 ORM (`db.orm.public`) a `ResearcherAccount` (random tenant and object IDs), a `ProjectContext`, a `SourceDocument` and one `SourceRepresentationRevision` with placeholder artifact fields (the workflows' ports read Markdown from a test double, never from the package store); copy the column list from M4's Studio PostgreSQL seeding (for example `api/source_ingestion.postgres.test.ts`) if it has a helper, otherwise fill every NOT NULL column of the post-M4 contract. `configureOwnerRoute` calls `applyAccountModelConfig(accountId, update)` (`api/_model_config.ts:191`) with one researcher connection (`id: randomUUID()`) and the given routes (default `['interaction', 'schemaSuggestion']`). `databaseHolds` lists `information_schema.tables` (`BASE TABLE`) of the given schemas and runs per table `SELECT count(*)::int AS n FROM "<schema>"."<table>" AS x WHERE x::text LIKE $1` with `'%' + needle + '%'`. `captureOutput` wraps `console.log/info/warn/error` and `process.stdout.write`/`process.stderr.write` (DBOS's logger writes there).

- [ ] **Step 2: Write the failing unit tests**

  `api/_model_operation.test.ts` (a fake client recording calls; `getWorkflow` and `listWorkflows` scripted):
  - `a new operation is enqueued by name on the studio queue with its owner and attributes` (`enqueue` receives `{ queueName: 'studio', workflowName, workflowID, authenticatedUser: owner, attributes }` and the input).
  - `a reused operation ID with the same input joins it; any other input or workflow name is 409 operation_conflict` (`getWorkflow` returns `{ workflowName, input: [recorded] }`).
  - `a DBOS outage while starting or reading is 503 persistence_unavailable`.
  - `awaitOperation returns a finished workflow's typed output; a cancel is 409 operation_cancelled, an error or a missing workflow 500 interrupted, a timeout 504 operation_pending`.
  - `operationFailureOf keeps an ApiError's status, code and message and turns anything else into 500 unexpected_failure without its message`.
  `api/_schema_generation_workflow.test.ts` (fake `steps` that run at once and record names; scripted `generate`):
  - `reads the document outside the step, generates in one step named generateSchema, and returns the template with its base` (`readMarkdown` runs before the step; `generate` runs only inside it; the output carries `baseSchemaRevisionId`).
  - `every call resolves the owner's account and gets a ten-minute signal` (`generate`'s caller is `{ researcherAccountId: input.owner }`; spy `AbortSignal.timeout`: called with `600_000`, and its signal is the one passed).
  - `an expected failure is returned as a typed result, never thrown` (`new ApiError(502, 'invalid_model_output', 'x')` → `{ ok: false, status: 502, code: 'invalid_model_output', message: 'x' }`; `ModelKeyRequiredError` → status 409, code `model_key_required`).
  - `a deleted revision ends with a typed 404 and no step`.
  `api/generate_schema.test.ts` (fake store; fake operation client whose `listWorkflows` reports `SUCCESS` with a scripted output):
  - `starts suggestion:<operation_id> for the owner with the scope attributes, and answers today's body` (`{ template, raw, pages }`, 200; attributes `{ projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId: null }` without a base).
  - `a base names its Extraction Schema and revision; one without the other is 422; a base outside the project is 404`.
  - `a missing or non-canonical operation_id is 422`; `a typed failure answers its own status, code and message`; `a source outside the account is 404 and starts nothing`.
  `src/api.test.ts`: `requestSchema posts the operation ID and the base it starts from` (the form holds `operation_id`, `extraction_schema_id`, `base_schema_revision_id`; neither base field for a first generation); keep `requestSchema and requestSchemaEdit hand the keys to Studio before their POST` passing.
  `server/workflows.test.ts`: the recorded names now end with `suggestSchema`.

  Run the five files. Expected: FAIL.

- [ ] **Step 3: Implement the helper and the workflow**

  `api/_model_operation.ts`:
  ```ts
  import { isDeepStrictEqual } from 'node:util'
  import type { DBOSClient } from '@dbos-inc/dbos-sdk'
  import { INTERRUPTED_FAILURE } from 'db'
  import { awaitWorkflowOutcome, STUDIO_QUEUE } from '../server/dbos.js'
  import { ApiError, persistenceUnavailable } from './_http.js'

  export const MODEL_OPERATION_TIMEOUT_MS = 600_000
  export const OPERATION_WAIT_MS = 25 * 60_000
  export type OperationFailure = Readonly<{ status: number; code: string; message: string }>
  export type OperationResult<T extends object> = ({ ok: true } & T) | ({ ok: false } & OperationFailure)
  export type ModelOperationClient = Pick<DBOSClient, 'enqueue' | 'getWorkflow' | 'listWorkflows' | 'cancelWorkflow' | 'deleteWorkflows'>
  export type OperationStart<I> = Readonly<{
    workflowName: string
    workflowID: string
    /** The Project Context owner: recorded as authenticatedUser, which locates the scope but never authorizes it. */
    owner: string
    attributes: Readonly<Record<string, string | null>>
    input: I
  }>

  /** What a model step returns instead of throwing (spec, *Typed results*): an ApiError's own status, code and copy —
   *  FREE's words — and nothing else. A step that rethrew would hand a provider error's cause to DBOS's serializer. */
  export function operationFailureOf(error: unknown): OperationFailure {
    if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message.slice(0, 512) }
    return { status: 500, code: 'unexpected_failure', message: 'An unexpected failure occurred.' }
  }

  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Model operations are unavailable.')

  /**
   * Workflow-first admission (spec, *No-row operations*): enqueue by name on the studio queue. A reused workflow ID
   * returns the existing workflow (DBOS's default reuse policy), so the recorded input decides: the same request joins
   * it, anything else is 409 — a confirmed failure needs a new operation ID (spec, *Client IDs*).
   */
  export async function startOrJoinOperation<I>(client: ModelOperationClient, start: OperationStart<I>): Promise<void> {
    let recorded: Awaited<ReturnType<ModelOperationClient['getWorkflow']>>
    try {
      await client.enqueue({
        queueName: STUDIO_QUEUE,
        workflowName: start.workflowName,
        workflowID: start.workflowID,
        authenticatedUser: start.owner,
        attributes: { ...start.attributes },
      }, start.input)
      recorded = await client.getWorkflow(start.workflowID)
    } catch (cause) {
      throw unavailable(cause)
    }
    if (!recorded || recorded.workflowName !== start.workflowName || !isDeepStrictEqual(recorded.input?.[0], start.input))
      throw new ApiError(409, 'operation_conflict', 'This operation ID was already used for a different request. Start a new one.')
  }

  /** Waits for the operation's typed result without ClientHandle.getResult, which cannot time out. A client abort ends
   *  the wait only: the workflow runs on and a reloaded page finds it (spec, *A client abort only detaches*). */
  export async function awaitOperation<T extends object>(client: ModelOperationClient, workflowID: string,
    signal: AbortSignal | undefined, waitMs = OPERATION_WAIT_MS): Promise<OperationResult<T>> {
    let awaited
    try {
      awaited = await awaitWorkflowOutcome<OperationResult<T>>(client, workflowID, { timeoutMs: waitMs, signal, intervalMs: 250 })
    } catch (cause) {
      if (signal?.aborted) throw cause
      throw unavailable(cause)
    }
    if (awaited.state === 'finished') return awaited.output
    if (awaited.state === 'timed-out')
      return { ok: false, status: 504, code: 'operation_pending', message: 'The operation is still running. Reload the page to see it when it finishes.' }
    if (awaited.status === 'CANCELLED') return { ok: false, status: 409, code: 'operation_cancelled', message: 'The operation was stopped.' }
    return { ok: false, status: 500, ...INTERRUPTED_FAILURE }
  }
  ```

  `api/_schema_generation_workflow.ts`:
  ```ts
  import { DBOS } from '@dbos-inc/dbos-sdk'
  import type { WorkflowSteps } from 'extraction/workflows'
  import type { generateSchemaWithModel } from './_model.js'
  import { MODEL_OPERATION_TIMEOUT_MS, operationFailureOf, type OperationResult } from './_model_operation.js'

  export const SUGGEST_SCHEMA = 'suggestSchema'
  /** IDs, the instruction and the temperature only: never the document, never a key (spec, *What DBOS history holds*). */
  export type SchemaGenerationInput = Readonly<{
    operationId: string
    owner: string
    projectContextId: string
    sourceRepresentationRevisionId: string
    /** Null before the Project Context has an Extraction Schema (a first generation). */
    extractionSchemaId: string | null
    /** The acknowledged revision the tab generated from; a reloaded page saves only onto it (spec, *Generation*). */
    baseSchemaRevisionId: string | null
    instruction: string
    temperature: number | null
  }>
  export type SchemaGenerated = { template: Record<string, unknown>; raw: string; pages: number | null; baseSchemaRevisionId: string | null }
  export type SchemaGenerationPorts = Readonly<{
    steps: WorkflowSteps
    readMarkdown(sourceRepresentationRevisionId: string): Promise<string | null>
    generate: typeof generateSchemaWithModel
  }>

  /** `suggestSchema(input)`: one step wraps generateSchemaWithModel; its typed result is the operation's outcome. */
  export async function suggestSchemaWorkflow(input: SchemaGenerationInput, ports: SchemaGenerationPorts): Promise<OperationResult<SchemaGenerated>> {
    // Read at workflow scope from the immutable revision: a replay reads it again, and neither the input nor any step's
    // output holds it.
    const markdown = await ports.readMarkdown(input.sourceRepresentationRevisionId)
    if (markdown === null) return { ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' }
    return ports.steps.step('generateSchema', async (): Promise<OperationResult<SchemaGenerated>> => {
      try {
        const generated = await ports.generate({ researcherAccountId: input.owner }, {
          document: { file: null, pages: null, markdown },
          instruction: input.instruction,
          ...(input.temperature === null ? {} : { temperature: input.temperature }),
          // The model boundary adds the step's cancel signal (Task 1).
          signal: AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS),
        })
        return { ok: true, template: generated.template, raw: generated.raw, pages: generated.pages, baseSchemaRevisionId: input.baseSchemaRevisionId }
      } catch (error) {
        return { ok: false, ...operationFailureOf(error) }
      }
    })
  }

  export function registerSchemaGenerationWorkflow(ports: () => SchemaGenerationPorts): void {
    DBOS.registerWorkflow(async (input: SchemaGenerationInput) => suggestSchemaWorkflow(input, ports()), { name: SUGGEST_SCHEMA })
  }
  ```
  `server/workflows.ts`: append `SUGGEST_SCHEMA` to `STUDIO_WORKFLOW_NAMES` and, in `registerStudioWorkflows`,
  ```ts
  registerSchemaGenerationWorkflow(() => {
    const worker = createInternalProjectWorkerStore()
    return { steps: dbosSteps, readMarkdown: (id) => worker.readRevisionMarkdown(id), generate: generateSchemaWithModel }
  })
  ```

- [ ] **Step 4: The handler, the store and the browser**

  `packages/db`: `ownedSourceRepresentationDescriptor` also selects `sourceDocumentId: fields.sourceRepresentationRevision.sourceDocumentId`; `getSourceRepresentation`'s declared return becomes `Promise<(CanonicalPackageDescriptor & { sourceDocumentId: string }) | null>` (callers that hand it to the package store keep working).
  `api/_schema_edit.ts`: `ownedSourceScope` wraps `store.getSourceRepresentation` as `loadOwnedSourceMarkdown` does (503 through `persistenceUnavailable`, 404 `Project model context was not found.`) and returns `{ sourceDocumentId }` without reading the package; `optionalSchemaBase(form)` reads `extraction_schema_id` and `base_schema_revision_id` with `formContextIdentity` when present and throws `ApiError(422, 'invalid_request', 'extraction_schema_id and base_schema_revision_id go together.')` when only one is.
  `api/generate_schema.ts`:
  ```ts
  const FIELDS = ['project_context_id', 'source_representation_revision_id', 'extraction_schema_id', 'base_schema_revision_id',
    'operation_id', 'instruction', 'temperature'] as const

  export function createPostGenerateSchema(
    store: GenerateSchemaStore,
    operations: () => ModelOperationClient = () => studioDbos().admission,
  ) {
    return async function POST(request: Request): Promise<Response> {
      try {
        const form = await parseFormRequest(request)
        assertFormFields(form, FIELDS)
        const projectContextId = formContextIdentity(form, 'project_context_id')
        const sourceRepresentationRevisionId = formContextIdentity(form, 'source_representation_revision_id')
        const operationId = formContextIdentity(form, 'operation_id')
        const base = optionalSchemaBase(form)
        const instruction = parseInstruction(form.get('instruction'))
        const temperature = parseTemperature(form.get('temperature')) ?? null
        const { sourceDocumentId } = await ownedSourceScope(store, projectContextId, sourceRepresentationRevisionId)
        if (base) await loadOwnedSchemaRevision(store, projectContextId, base.extractionSchemaId, base.schemaRevisionId)
        const input: SchemaGenerationInput = {
          operationId, owner: store.researcherAccountId, projectContextId, sourceRepresentationRevisionId,
          extractionSchemaId: base?.extractionSchemaId ?? null, baseSchemaRevisionId: base?.schemaRevisionId ?? null,
          instruction, temperature,
        }
        const workflowID = `suggestion:${operationId}`
        await startOrJoinOperation(operations(), {
          workflowName: SUGGEST_SCHEMA, workflowID, owner: input.owner, input,
          // extractionSchemaId is recorded even when null, so the listing finds a first generation (JSONB containment).
          attributes: { projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId: input.extractionSchemaId },
        })
        const result = await awaitOperation<SchemaGenerated>(operations(), workflowID, request.signal)
        if (!result.ok) throw new ApiError(result.status, result.code, result.message)
        return json({ template: result.template, raw: result.raw, pages: result.pages })
      } catch (error) {
        return apiErrorResponse(error)
      }
    }
  }
  ```
  (`createResearcherApiHandlers` keeps `{ POST: createPostGenerateSchema(store) }`; the package-reader and `generate` parameters go.)
  `src/api.ts`: `requestSchema(context, signal, { instruction, operationId, base })` appends `operation_id`, and `extraction_schema_id` + `base_schema_revision_id` when `base` is not null. `src/App.tsx` `handleGenerate`:
  ```ts
  // The tab's acknowledged head is the base: a reloaded page saves this generation only while it is still current.
  const acknowledged = schema.snapshot().save?.acknowledged ?? null
  const operationId = crypto.randomUUID()        // a new user action, a new ID (spec, *Client IDs*)
  await schema.generate((signal) => requestSchema(
    { projectContextId, sourceRepresentationRevisionId: sourceRepresentationId },
    signal,
    { instruction, operationId, base: acknowledged && { extractionSchemaId: acknowledged.extractionSchemaId, schemaRevisionId: acknowledged.schemaRevisionId } },
  ))
  ```

- [ ] **Step 5: Write the PostgreSQL tests** (`api/schema_generation.postgres.test.ts`)

  Setup per file: `disposableDatabaseUrl()`, `testSchemas()`, `startScriptedModelServer()`, `seedInteractiveScope()`, `configureOwnerRoute(...)` pointing at the server, a fresh `createModelKeyCache()` whose `wait` calls are counted, and ports whose `generate` is `(caller, input) => generateSchemaWithModel(caller, input, undefined, { keys, keyWaitMs: 400, deployment: deploymentModels({}) })` and whose `readMarkdown` returns a fixed synthetic register. `launchStudioDbos({ databaseUrl, ...schemas, register: () => registerSchemaGenerationWorkflow(() => ports) })`; the handler under test is `createPostGenerateSchema(store, () => studioDbos().admission)` with `store = createResearcherProjectStore(accountId, undefined, { workflowStatuses, enqueue })` built as `server/app.ts` builds it. `afterAll`: `shutdownStudioDbos()`, `dropSchemas`, `server.close()`.
  - `a generation runs as suggestion:<operationId> for the owner, and a repeated POST returns the same result without a second model call` (A6: POST twice with one form; two 200s with equal bodies; `server.calls().length === 1`; the workflow's `authenticatedUser` is the owner).
  - `reusing an operation ID for a different instruction is 409 operation_conflict`.
  - `a first generation records extractionSchemaId null, and the scope filter finds it only by null` (`admission.listWorkflows({ attributes: { projectContextId, extractionSchemaId: null } })` has it; with a random schema ID it does not).
  - `a cancel during the key wait never reaches the provider` (A14: `hasKey` connection, no key; POST without awaiting; once the counted `wait` began, `admission.cancelWorkflow`; `CANCELLED` within 3 s; `server.calls().length === 0`; putting the key afterwards changes nothing).
  - `a cancel during a provider call stops it about 1 s later` (A14: key present; `reply({ text: 'x', hold: true })`; `waitForCall(1)`; cancel at `t0`; `calls()[0].closedAt - t0 <= 2_500`; the workflow is `CANCELLED`).
  - `a key planted in a provider error in a JSON step reaches no DBOS or public table and no log` (A10: `plantedKey()` in the cache; `reply({ status: 500, body: '{"error":"echo {{authorization}}"}', headers: { 'x-echo': key } })`; the POST answers 502 `model_operation_failed`; then a success reply with `headers: { 'x-echo': key }` answers 200; `databaseHolds(url, key, [schema, 'public'])` is empty; the captured output does not contain the key).
  - `NuExtract on a keyed vLLM connection waits for its key, stops on cancel, and leaves no key in history` (A15: `configureOwnerRoute(account, { provider: 'vllm', modelId: 'numind/NuExtract3', hasKey: true, routes: ['schemaSuggestion'] })`; no key → 409 `model_key_required` after the wait and 0 calls; a cancel during the wait → 0 calls; the key present and an echoing 500 → no key in any table; the key present and a success → the call's `authorization` is `Bearer <key>`).
  - `a replayed step whose call is checkpointed never waits for a key` (A14; scenario `generation-replay`: on the first run, with the key, its `steps.step` wrapper SIGKILLs right after the `generateSchema` step resolved; the second run holds no key and a 60 s wait; the workflow reaches `SUCCESS` within 5 s with the first run's template; `server.calls().length === 1`; the second process's counted `wait` stays 0 — the scenario writes its count to a file).
  - `a Studio killed mid-generation recovers it: the operation stays listed as running, and finishes once the page resends the key` (A2 kill; scenario `generation-recover`: the first run holds the call and SIGKILLs once `waitForCall(1)` resolved; between the runs `admission.listWorkflows({ workflow_id_prefix: 'suggestion:' })` shows `PENDING`; the second run puts the key before launch — the resend — and the workflow finishes with the second call's template; exactly 2 calls).
  - `with no page to resend it, a recovered generation fails with model_key_required after the wait and nobody retries it` (A13: `generation-recover` with `FREE_TEST_RESEND=0`: the output is `{ ok: false, status: 409, code: 'model_key_required' }`; no call after the restart; the counted `wait` ran once).
  The scenarios follow M4's contract (`run({ firstRun, env })`, `FREE_TEST_DBOS_SCHEMA`, `FREE_TEST_KEI_SCHEMA`, `FREE_TEST_EXECUTOR`, `FREE_CRASH_MARKER`), read the scripted server's base URL and the seeded IDs from `FREE_TEST_*` variables the parent sets, and on the second run only wait (`awaitWorkflowOutcome`, 60 s) and shut down. The scripted server lives in the parent process, so it survives the child's SIGKILL.

- [ ] **Step 6: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:postgres                  # DATABASE_URL = EXTRACTION_TEST_DATABASE_URL
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/project-store.ts packages/db/src/project-store.test.ts prototypes/studio/api prototypes/studio/server \
    prototypes/studio/src/api.ts prototypes/studio/src/App.tsx prototypes/studio/src/api.test.ts prototypes/studio/src/apiEndpoints.test.ts \
    prototypes/studio/test/support
  git commit -m "feat(studio): run Schema Suggestion as a durable operation that a reload or a Studio restart can find"
  ```

### Task 4: `proposeSchemaEdit` on DBOS

**Files:**
- Create: `prototypes/studio/api/_schema_edit_workflow.ts` (+ `_schema_edit_workflow.test.ts`), `prototypes/studio/api/edit_schema.test.ts`, `prototypes/studio/api/schema_edit.postgres.test.ts`, `prototypes/studio/test/support/scenarios/edit-recover.ts`
- Modify: `prototypes/studio/api/edit_schema.ts`, `prototypes/studio/api/_schema_edit.ts` (delete `loadOwnedSchemaModelContext`, 148-184), `packages/db/src/project-store.ts` (worker store `readSchemaRevisionTree`), `prototypes/studio/server/workflows.ts` (+ test), `prototypes/studio/server/researcher-project-ownership.test.ts` (the `edit_schema` cases send `operation_id`)
- Modify: `prototypes/studio/src/api.ts` (`requestSchemaEdit` sends `operation_id`), `prototypes/studio/src/SchemaPanel.tsx` (`sendChatMessage` mints one per send), `prototypes/studio/src/api.test.ts`, `prototypes/studio/src/SchemaPanel.test.tsx`

**Interfaces:**
- Consumes: Task 3's `_model_operation.ts`, `ownedSourceScope` and PostgreSQL support.
- Produces:
  ```ts
  export const PROPOSE_SCHEMA_EDIT = 'proposeSchemaEdit'
  export type SchemaEditInput = Readonly<{ operationId: string; owner: string; projectContextId: string; extractionSchemaId: string; baseSchemaRevisionId: string; sourceRepresentationRevisionId: string | null; instruction: string; temperature: number | null }>
  export type SchemaEditProposed = { baseSchemaRevisionId: string; response: SchemaEditResponse }
  export type SchemaEditPorts = Readonly<{ steps: WorkflowSteps; readSchemaTree(extractionSchemaId: string, schemaRevisionId: string): Promise<unknown | null>; readMarkdown(sourceRepresentationRevisionId: string): Promise<string | null>; propose: typeof proposeSchemaEdit; generateJson: typeof generateSchemaEditJson }>
  export function proposeSchemaEditWorkflow(input: SchemaEditInput, ports: SchemaEditPorts): Promise<OperationResult<SchemaEditProposed>>
  export function registerSchemaEditWorkflow(ports: () => SchemaEditPorts): void
  // packages/db, InternalProjectWorkerStore
  readSchemaRevisionTree(extractionSchemaId: string, schemaRevisionId: string): Promise<unknown | null>
  // src/api.ts
  export function requestSchemaEdit(context: SchemaModelContext, instruction: string, signal: AbortSignal | undefined, operationId: string): Promise<SchemaEditResponse>
  ```

- [ ] **Step 1: Write the failing tests**

  `api/_schema_edit_workflow.test.ts`:
  - `reads the base schema and the document outside the step and proposes in one step named proposeSchemaEdit` (the output is `{ ok: true, baseSchemaRevisionId, response }`; a schema-only edit never calls `readMarkdown` and `propose` gets `null`).
  - `each of the repair's model calls gets its own ten-minute limit` (`propose` receives a `generate` option; calling it twice calls the fake `generateJson` twice, with the owner as caller and two distinct signals from `AbortSignal.timeout(600_000)`).
  - `a refused or failed proposal is a successful operation carrying that response; an ApiError is a typed failure` (`{ status: 'refused', message }` → `ok: true`; `ModelKeyRequiredError` → `{ ok: false, status: 409, code: 'model_key_required' }`).
  - `a deleted base revision or document ends with a typed 404 and no step`.
  `api/edit_schema.test.ts`: `starts edit:<operation_id> with the owner, project and schema attributes, and the source keys only for a document-grounded edit`; `answers today's SchemaEditResponse body`; `a missing operation_id is 422`; `a foreign schema revision or source is 404 and starts nothing`.
  `src/SchemaPanel.test.tsx`: `each edit request carries a new operation ID` (two sends, two different `operation_id`s).
  `api/schema_edit.postgres.test.ts` (Task 3's setup with `registerSchemaEditWorkflow`):
  - `an edit runs as edit:<operationId>, and a repeated POST returns the same proposal without a second model call` (A6).
  - `a Studio killed mid-proposal recovers it: the operation stays listed as running and finishes with a proposal on its base` (A2 kill; scenario `edit-recover`, shaped like `generation-recover`).
  - `a schema-only edit records only the project and schema attributes` (`attributes` equals `{ projectContextId, extractionSchemaId }`).
  Run them. Expected: FAIL.

- [ ] **Step 2: Implement**

  `api/_schema_edit_workflow.ts`:
  ```ts
  /** `proposeSchemaEdit(input)`: one step wraps proposeSchemaEdit with its bounded repair; its typed result — the proposal
   *  and its base revision — is the outcome. Nothing is saved until the researcher applies it (spec, *Edit proposals*). */
  export async function proposeSchemaEditWorkflow(input: SchemaEditInput, ports: SchemaEditPorts): Promise<OperationResult<SchemaEditProposed>> {
    // The base revision and the document are immutable; both are read at workflow scope, outside history.
    const tree = await ports.readSchemaTree(input.extractionSchemaId, input.baseSchemaRevisionId)
    const markdown = input.sourceRepresentationRevisionId === null ? null : await ports.readMarkdown(input.sourceRepresentationRevisionId)
    if (tree === null || (input.sourceRepresentationRevisionId !== null && markdown === null))
      return { ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' }
    const caller = { researcherAccountId: input.owner }
    return ports.steps.step('proposeSchemaEdit', async (): Promise<OperationResult<SchemaEditProposed>> => {
      try {
        const response = await ports.propose(parseSchemaDefinition(tree).schemaNodes, input.instruction, markdown, {
          caller,
          ...(input.temperature === null ? {} : { temperature: input.temperature }),
          // One call, one ten-minute limit: the bounded repair may make a second call.
          generate: async (prompt, temperature, target) =>
            (await ports.generateJson(caller, prompt, temperature, AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS), target)).text,
        })
        return { ok: true, baseSchemaRevisionId: input.baseSchemaRevisionId, response }
      } catch (error) {
        return { ok: false, ...operationFailureOf(error) }
      }
    })
  }
  ```
  `registerSchemaEditWorkflow` registers it under `PROPOSE_SCHEMA_EDIT`; `server/workflows.ts` appends the name and registers it with `readSchemaTree: (schemaId, revisionId) => worker.readSchemaRevisionTree(schemaId, revisionId)`, `readMarkdown: (id) => worker.readRevisionMarkdown(id)`, `propose: proposeSchemaEdit` and `generateJson: generateSchemaEditJson`. The worker store's `readSchemaRevisionTree` returns the `schemaTree` of `SchemaRevision { id, extractionSchemaId }`, or null.
  `api/edit_schema.ts`: `FIELDS` gains `operation_id`; after today's validation, ownership is `loadOwnedSchemaRevision(…)` plus, for a document-grounded edit, `ownedSourceScope(…)` (no package read); the input is a `SchemaEditInput`; then `startOrJoinOperation(operations(), { workflowName: PROPOSE_SCHEMA_EDIT, workflowID: \`edit:${operationId}\`, owner, input, attributes: { projectContextId, extractionSchemaId, ...(source ? { sourceDocumentId, sourceRepresentationRevisionId } : {}) } })` and `awaitOperation<SchemaEditProposed>`; `ok: false` throws its `ApiError`; `ok: true` answers `json(result.response)`. `createPostEditSchema(store, operations = () => studioDbos().admission)`. Delete `loadOwnedSchemaModelContext` (its only caller is gone).
  `src/api.ts`: `requestSchemaEdit(context, instruction, signal, operationId)` appends `operation_id`. `src/SchemaPanel.tsx` `sendChatMessage`: `const operationId = crypto.randomUUID()` per send, kept in `editOperationRef` beside `chatAbortRef` (Task 9's Stop and Task 10's Discard read it), passed to `requestSchemaEdit`.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/project-store.ts prototypes/studio/api prototypes/studio/server prototypes/studio/src/api.ts \
    prototypes/studio/src/api.test.ts prototypes/studio/src/SchemaPanel.tsx prototypes/studio/src/SchemaPanel.test.tsx prototypes/studio/test/support
  git commit -m "feat(studio): run schema edit proposals as durable operations that survive a reload"
  ```

### Task 5: `GET` and `DELETE /api/model-operations`: find, cancel and discard a scope's operations

**Files:**
- Create: `prototypes/studio/shared/modelOperation.contract.ts` (+ `modelOperation.contract.test.ts`), `prototypes/studio/api/model_operations.ts` (+ `model_operations.test.ts`), `prototypes/studio/api/model_operations.postgres.test.ts`
- Modify: `prototypes/studio/server/api-dispatcher.ts` (`PARAMETERIZED`, 16-42) and `server/api-dispatcher.test.ts`; `packages/db/src/project-store.ts` (`modelOperationScopeExists`) and `project-store.postgres.check.ts`; every Studio fixture that implements `ResearcherProjectStore` (find them with `grep -rln "ResearcherProjectStore" prototypes/studio/api prototypes/studio/server --include=*.fixture.ts --include=*.test.ts`) gains a stub; `server/researcher-project-ownership.test.ts` (listing and `DELETE` for a foreign scope)

**Interfaces:**
- Consumes: Tasks 3–4 (`SchemaGenerationInput`, `SchemaEditInput`, `OperationResult`, `ModelOperationClient`), M4's `executionOf`, `LIVE_WORKFLOW_STATUSES`, `INTERRUPTED_FAILURE`.
- Produces:
  ```ts
  // shared/modelOperation.contract.ts
  export const MODEL_OPERATION_WORKFLOW_ID: RegExp        // ^(suggestion|edit):(<canonical UUID>)$ — Task 8 adds chat: to DELETE separately
  export const modelOperationSchema, modelOperationListingSchema
  export type ModelOperation = z.infer<typeof modelOperationSchema>
  export type ModelOperationListing = z.infer<typeof modelOperationListingSchema>
  // packages/db, ResearcherProjectStore
  modelOperationScopeExists(projectContextId: string, extractionSchemaId: string | null): Promise<boolean>
  // api/model_operations.ts
  export function modelOperationOf(status: WorkflowStatus): ModelOperation | null
  export function createModelOperationHandlers(store: ModelOperationStore, operations?: () => ModelOperationClient): { GET(request: Request): Promise<Response>; DELETE(request: Request): Promise<Response> }
  ```

- [ ] **Step 1: The contract**

  ```ts
  import { z } from 'zod'
  import { CANONICAL_UUID } from 'studio-configuration'
  import { canonicalUuidSchema } from './projectContext.contract.js'
  import { schemaEditResponseSchema } from './schemaEdit.contract.js'

  const uuid = CANONICAL_UUID.source.replace(/^\^|\$$/g, '')
  /** A generation or edit operation's workflow ID (spec, *Workflows*); full match, no `m` flag. */
  export const MODEL_OPERATION_WORKFLOW_ID = new RegExp(`^(suggestion|edit):(${uuid})$`)

  const failureSchema = z.object({ code: z.string(), message: z.string() }).strict()
  const common = {
    workflowId: z.string(),
    operationId: canonicalUuidSchema,
    /** QUEUED/RUNNING while the workflow is live; SUCCEEDED when it returned `ok: true`; FAILED otherwise, including a
     *  stop (cancel, crash beyond recovery, history gone), whose failure is `interrupted`. */
    status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
    instruction: z.string(),
    createdAt: z.string(),
    failure: failureSchema.nullable(),
  }
  export const modelOperationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('generation'), ...common, baseSchemaRevisionId: canonicalUuidSchema.nullable(),
      template: z.record(z.string(), z.unknown()).nullable() }).strict(),
    z.object({ kind: z.literal('proposal'), ...common, baseSchemaRevisionId: canonicalUuidSchema,
      response: schemaEditResponseSchema.nullable() }).strict(),
  ])
  export const modelOperationListingSchema = z.object({ operations: z.array(modelOperationSchema).max(20) }).strict()
  export type ModelOperation = z.infer<typeof modelOperationSchema>
  export type ModelOperationListing = z.infer<typeof modelOperationListingSchema>
  ```
  Check the exact shape of `CANONICAL_UUID` in `studio-configuration` first; if it is not anchored with `^…$`, use its `source` unchanged. The contract test pins `MODEL_OPERATION_WORKFLOW_ID` against `suggestion:<uuid>`, `edit:<uuid>`, and refuses `chat:<uuid>`, `suggestion:<uuid>\n`, `edit:<UUID in upper case>` and `suggestion:<uuid>:x`.

- [ ] **Step 2: Write the failing tests**

  `api/model_operations.test.ts` (fake store; fake client recording calls):
  - `lists the owner's generations and edits for a scope, newest first, in one listWorkflows call` — `GET /api/model-operations?projectContextId=<p>` calls `listWorkflows` exactly once with `{ workflow_id_prefix: ['suggestion:', 'edit:'], attributes: { projectContextId: p, extractionSchemaId: null }, authenticatedUser: <session account>, loadInput: true, loadOutput: true, sortDesc: true, limit: 20 }`; with `&extractionSchemaId=<s>` the attribute is `s`; the body parses with `modelOperationListingSchema`; `Cache-Control: no-store`.
  - `maps live, finished and stopped workflows` — `ENQUEUED` → `QUEUED`, `PENDING` → `RUNNING`, `SUCCESS` with `ok: true` → `SUCCEEDED` with `template` (generation) or `response` (proposal), `SUCCESS` with `ok: false` → `FAILED` with its `{ code, message }`, `CANCELLED`/`ERROR`/`MAX_RECOVERY_ATTEMPTS_EXCEEDED` → `FAILED` with `INTERRUPTED_FAILURE`; `instruction` and `baseSchemaRevisionId` come from the recorded input.
  - `an unowned or deleted scope is 404 and lists nothing` (`modelOperationScopeExists` → false: no `listWorkflows` call); `a malformed scope is 422`; `a DBOS outage is 503`.
  - `DELETE cancels a live operation` (`PENDING` → `cancelWorkflow(id)`, 204).
  - `DELETE of a finished proposal deletes it and every older finished proposal on its base, never a newer one or another base's` (four `SUCCESS` `edit:` rows: p1 < p2 < p3 on base R1, q on R2; `DELETE edit:p2` → `deleteWorkflows([p2, p1])` in any order; `listWorkflows` was asked for `{ workflow_id_prefix: 'edit:', attributes: { projectContextId, extractionSchemaId }, authenticatedUser, status: 'SUCCESS', loadInput: true, loadOutput: false }`).
  - `DELETE of any other settled operation deletes nothing` (a finished generation; a failed proposal).
  - `a workflow of another account, of a deleted scope, or a malformed or percent-broken ID is 404 and changes nothing`.
  `server/api-dispatcher.test.ts`: `routes /api/model-operations and /api/model-operations/<encoded workflow ID> to model_operations`.
  `api/model_operations.postgres.test.ts` (Task 3's setup with both Task 3 and Task 4 workflows registered; the handler runs on a real store and the admission client):
  - `a first generation is listed under the project with no Extraction Schema, and not under a schema` (spec: explicit `extractionSchemaId: null`).
  - `a running operation is listed with its instruction, and DELETE cancels it` (held scripted call; `status: 'RUNNING'`; after `DELETE` the workflow is `CANCELLED` and the listing says `FAILED` `interrupted`).
  - `Discard deletes that proposal and every older finished proposal on its base; a newer one from another tab survives` (three proposals on one base, one on another; `DELETE` of the middle one; the listing keeps the newest on that base and the one on the other base).
  - `a second account can neither list nor cancel nor discard the first account's operations` (A9: account B gets 404 for A's scope and for `DELETE` of A's running and finished workflows; A's workflows are unchanged).
  - `after the project is deleted, listing and DELETE are 404` (A9).
  `packages/db/src/project-store.postgres.check.ts`: `modelOperationScopeExists is true only for the account's project and, when named, a schema of that project`.
  Run them. Expected: FAIL.

- [ ] **Step 3: Implement**

  `packages/db`:
  ```ts
  async modelOperationScopeExists(projectContextId, extractionSchemaId) {
    return database.transaction(async ({ orm }) => {
      const project = await orm.public.ProjectContext.select('id').first({ id: projectContextId, researcherAccountId })
      if (!project) return false
      if (extractionSchemaId === null) return true
      return (await orm.public.ExtractionSchema.select('id').first({ id: extractionSchemaId, projectContextId })) !== null
    })
  },
  ```
  `api/model_operations.ts`:
  ```ts
  type ModelOperationStore = Pick<ResearcherProjectStore, 'researcherAccountId' | 'modelOperationScopeExists'>
  const scopeSchema = z.object({ projectContextId: canonicalUuidSchema, extractionSchemaId: canonicalUuidSchema.nullable() }).strict()
  const PREFIX = '/api/model-operations'
  const notFound = () => new ApiError(404, 'not_found', 'Model operation was not found.')

  /** One workflow as the page sees it. The recorded input names the instruction and base; the output is the outcome. */
  export function modelOperationOf(status: WorkflowStatus): ModelOperation | null {
    const match = MODEL_OPERATION_WORKFLOW_ID.exec(status.workflowID)
    const input = status.input?.[0] as (SchemaGenerationInput | SchemaEditInput) | undefined
    if (!match || !input) return null
    const execution = executionOf(status.status)
    const output = status.status === 'SUCCESS' ? status.output as OperationResult<SchemaGenerated | SchemaEditProposed> : null
    const settled = execution === 'QUEUED' || execution === 'RUNNING' ? execution : output?.ok ? 'SUCCEEDED' : 'FAILED'
    const failure = settled !== 'FAILED' ? null : output && !output.ok ? { code: output.code, message: output.message } : { ...INTERRUPTED_FAILURE }
    const common = { workflowId: status.workflowID, operationId: match[2]!, status: settled, instruction: input.instruction,
      createdAt: new Date(status.createdAt).toISOString(), failure }
    return match[1] === 'suggestion'
      ? { kind: 'generation', ...common, baseSchemaRevisionId: input.baseSchemaRevisionId,
          template: output?.ok ? (output as SchemaGenerated).template : null }
      : { kind: 'proposal', ...common, baseSchemaRevisionId: (input as SchemaEditInput).baseSchemaRevisionId,
          response: output?.ok ? (output as SchemaEditProposed).response : null }
  }

  export function createModelOperationHandlers(store: ModelOperationStore,
    operations: () => ModelOperationClient = () => studioDbos().admission) {
    const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Model operations are unavailable.')
    /** Only PostgreSQL authorizes (spec, *Status and ownership*): the account owns the project, and the schema, when
     *  named, still exists in it. A deleted scope is gone at once, before garbage collection removes its workflows. */
    const inScope = (projectContextId: string, extractionSchemaId: string | null) =>
      store.modelOperationScopeExists(projectContextId, extractionSchemaId).catch((cause) => { throw unavailable(cause) })
    return {
      async GET(request: Request) {
        try {
          const url = new URL(request.url)
          if (url.pathname !== PREFIX) throw notFound()
          const scope = scopeSchema.safeParse({
            projectContextId: url.searchParams.get('projectContextId'),
            extractionSchemaId: url.searchParams.get('extractionSchemaId'),
          })
          if (!scope.success) throw new ApiError(422, 'invalid_request', 'projectContextId (and extractionSchemaId, when named) must be canonical lowercase UUIDs.')
          if (!(await inScope(scope.data.projectContextId, scope.data.extractionSchemaId))) throw notFound()
          const statuses = await operations().listWorkflows({
            workflow_id_prefix: ['suggestion:', 'edit:'],
            // An explicit null matches only a first generation's recorded null (JSONB containment).
            attributes: { projectContextId: scope.data.projectContextId, extractionSchemaId: scope.data.extractionSchemaId },
            authenticatedUser: store.researcherAccountId,
            loadInput: true, loadOutput: true, sortDesc: true, limit: 20,
          }).catch((cause) => { throw unavailable(cause) })
          return json({ operations: statuses.flatMap((status) => modelOperationOf(status) ?? []) }, { headers: noStore })
        } catch (error) {
          return noStoreError(error)
        }
      },
      async DELETE(request: Request) {
        try {
          const workflowId = decodedTail(new URL(request.url).pathname)          // decodeURIComponent in a try: a broken escape is 404
          const match = workflowId === null ? null : MODEL_OPERATION_WORKFLOW_ID.exec(workflowId)
          if (!match) throw notFound()
          const client = operations()
          const recorded = await client.getWorkflow(workflowId!).catch((cause) => { throw unavailable(cause) })
          const projectContextId = recorded?.attributes?.projectContextId
          const extractionSchemaId = (recorded?.attributes?.extractionSchemaId ?? null) as string | null
          if (!recorded || recorded.authenticatedUser !== store.researcherAccountId || typeof projectContextId !== 'string'
            || !(await inScope(projectContextId, extractionSchemaId))) throw notFound()
          if (LIVE_WORKFLOW_STATUSES.has(recorded.status)) {
            await client.cancelWorkflow(workflowId!).catch((cause) => { throw unavailable(cause) })
          } else if (match[1] === 'edit' && recorded.status === 'SUCCESS' && (recorded.output as OperationResult<SchemaEditProposed>)?.ok) {
            // Discard persists: this proposal and every older finished one on its base go, so an older one cannot reappear
            // and a newer one from another tab survives. Finished history is settled, so deleting it is safe at once.
            const base = (recorded.input?.[0] as SchemaEditInput).baseSchemaRevisionId
            const finished = await client.listWorkflows({
              workflow_id_prefix: 'edit:', attributes: { projectContextId, extractionSchemaId },
              authenticatedUser: store.researcherAccountId, status: 'SUCCESS', loadInput: true, loadOutput: false,
            }).catch((cause) => { throw unavailable(cause) })
            const discarded = finished
              .filter((status) => (status.input?.[0] as SchemaEditInput | undefined)?.baseSchemaRevisionId === base
                && (status.workflowID === workflowId || status.createdAt < recorded.createdAt))
              .map((status) => status.workflowID)
            await client.deleteWorkflows(discarded).catch((cause) => { throw unavailable(cause) })
          }
          return new Response(null, { status: 204, headers: noStore })
        } catch (error) {
          return noStoreError(error)
        }
      },
    }
  }

  export function createResearcherApiHandlers(store: ResearcherProjectStore) {
    return createModelOperationHandlers(store)
  }
  ```
  `decodedTail(pathname)` returns `decodeURIComponent(pathname.slice(PREFIX.length + 1))` for a path under `PREFIX/`, or null (also when decoding throws). The dispatcher gains `[/^\/api\/model-operations(?:\/[^/]+)?$/, 'model_operations']`.

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres          # fresh databases
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/project-store.ts packages/db/src/project-store.postgres.check.ts prototypes/studio/shared \
    prototypes/studio/api prototypes/studio/server
  git commit -m "feat(studio): list, cancel and discard a scope's schema generations and edit proposals"
  ```

### Task 6: `ChatTurn` in the baseline; atomic question admission with per-revision exclusion

**Files:**
- Modify: `packages/db/src/prisma/contract.prisma` (add `ChatTurn`; `SourceRepresentationRevision` gains `chatTurns ChatTurn[]`); regenerate the baseline (Global Constraints) and commit `migrations/app/*_baseline/` and `migrations/app/refs/db.json`; recreate the databases
- Modify: `packages/db/src/pool-client-transaction.ts` (`AdmittedWorkflow.deduplicationID?`, `DuplicateActiveWorkflowError`), `packages/db/src/index.ts`, `packages/db/package.json` (`test:postgres` gains `src/chat-turn.postgres.check.ts`)
- Create: `packages/db/src/chat-turns.ts` (the chat store methods, spread into the two stores), `packages/db/src/chat-turn.postgres.check.ts`
- Modify: `packages/db/src/project-store.ts` (the `ResearcherProjectStore` and `InternalProjectWorkerStore` types and factories spread `chat-turns.ts`)
- Modify: `prototypes/studio/server/app.ts` (the enqueue adapter maps `DBOSQueueDuplicatedError`) and `server/app.test.ts`; Studio fixtures implementing `ResearcherProjectStore` gain stubs

**Interfaces:**
- Consumes: M4's `withPoolClientTransaction`, `TransactionalEnqueue`, `isUniqueViolation`, `WorkflowStatuses`, `executionOf`.
- Produces:
  ```ts
  // pool-client-transaction.ts
  export type AdmittedWorkflow = Readonly<{ workflowName: string; workflowID: string; queueName: string; deduplicationID?: string; authenticatedUser: string; attributes: Readonly<Record<string, unknown>> }>
  export class DuplicateActiveWorkflowError extends Error { readonly deduplicationID: string }
  // chat-turns.ts
  export const CHAT_TURN_NAME = 'chatTurn'
  export const STUDIO_QUEUE_NAME = 'studio'          // reuse M4's constant if packages/db already has one (grep "'studio'" packages/db/src)
  export type ChatTurnFailureRecord = Readonly<{ code: string; message: string }>
  export type ChatTurnRecord = Readonly<{ turnId: string; sourceRepresentationRevisionId: string; question: string; answer: string | null; failure: ChatTurnFailureRecord | null; createdAt: Date }>
  export type ChatTurnStatus = 'QUEUED' | 'RUNNING' | 'ANSWERED' | 'FAILED' | 'UNANSWERED'
  export type ChatTranscript = Readonly<{ sourceRepresentationRevisionId: string; turns: readonly (ChatTurnRecord & { status: ChatTurnStatus })[]; reconnectTurnId: string | null }>
  export type ChatAdmission = { status: 'created' | 'replayed'; turn: ChatTurnRecord } | { status: 'conflict' } | { status: 'busy' }
  export type AdmittedChatTurn = Readonly<{ turnId: string; owner: string; projectContextId: string; sourceDocumentId: string; sourceRepresentationRevisionId: string; question: string; history: readonly { question: string; answer: string }[]; settled: boolean }>
  export type ChatTurnOutcome = { answer: string } | { failure: ChatTurnFailureRecord }
  // ResearcherProjectStore gains
  admitChatTurn(input: { projectContextId: string; sourceRepresentationRevisionId: string; turnId: string; question: string }): Promise<ChatAdmission | null>
  readChatTranscript(sourceRepresentationRevisionId: string): Promise<ChatTranscript | null>
  ownedChatTurn(sourceRepresentationRevisionId: string, turnId: string): Promise<ChatTurnRecord | null>
  cancelChatTurn(turnId: string, failure: ChatTurnFailureRecord): Promise<'cancelled' | 'settled' | null>
  // InternalProjectWorkerStore gains
  loadChatTurn(turnId: string): Promise<AdmittedChatTurn | null>
  settleChatTurn(turnId: string, outcome: ChatTurnOutcome): Promise<'settled' | 'already-settled' | 'missing'>
  ```

- [ ] **Step 1: Edit the baseline**

  ```prisma
  // One document-chat turn (spec, *Interactive model work → Chat*): the question, admitted in one transaction with its
  // chat:<id> workflow, and at most one outcome — `answer` or `failure` — written once, conditionally, by that workflow
  // or by a cancel. Neither set: running, or unanswered once its workflow is gone. Deleting the revision deletes it.
  model ChatTurn {
    id                             Uuid                         @id @default(uuid())
    sourceRepresentationRevisionId Uuid
    question                       String
    answer                         String?
    failure                        Json?
    createdAt                      Timestamptz6                 @default(now())
    sourceRepresentationRevision   SourceRepresentationRevision @relation(fields: [sourceRepresentationRevisionId], references: [id], onDelete: Cascade)

    @@index([sourceRepresentationRevisionId, createdAt])
  }
  ```
  Regenerate (Global Constraints), note the generated primary-key constraint name in `ops.json` (expected `chatTurn_pkey`; use whatever it is below), recreate the databases.

- [ ] **Step 2: Write the failing checks** (`packages/db/src/chat-turn.postgres.check.ts`)

  Style of M4's `pool-client-transaction.postgres.check.ts`: top-level `test`, `PROJECT_STORE_POSTGRES_URL` required and validated, `process.env.DATABASE_URL` set before dynamic imports, DBOS launched once on a throwaway schema with no workflows (an enqueued `chat:` row stays `ENQUEUED`, holding its deduplication ID), an enqueue implementing `TransactionalEnqueue` that maps `DBOSErrors.DBOSQueueDuplicatedError` to `DuplicateActiveWorkflowError` exactly as Studio's adapter does, and `workflowStatuses` from that client. Each sub-test seeds its own account, project, document and revision.
  - `admission commits the question and chat:<turnId> together, with the revision's deduplication ID, the owner and the scope attributes` (`workflow_status` row: `queue_name 'studio'`, `deduplication_id 'chat:<revision>'`, `authenticated_user` the owner, `attributes` `{ projectContextId, sourceDocumentId, sourceRepresentationRevisionId }`, input `[{ turnId }]`).
  - `an enqueue that fails after the insert rolls back both`.
  - `two simultaneous identical turns create one question and replay once` (*Verification*: concurrent replay; `Promise.all` of two admissions → `['created', 'replayed']`; one row; one workflow).
  - `the same turn ID with another question or revision is a conflict` (no second row, no workflow).
  - `a second turn while one is active is busy and leaves no question behind` (*Verification*: active-chat exclusion and rollback; both sequential and simultaneous; exactly one row).
  - `cancelling the active turn records the cancellation, frees the revision, and the next turn is admitted` (`cancelChatTurn` → `'cancelled'`; `admission.cancelWorkflow('chat:<id>')`; a new turn → `'created'`).
  - `one answer per turn when an answer races a cancel` (*Verification*: twenty fresh turns, each `Promise.all([settleChatTurn(id, { answer: 'a' }), cancelChatTurn(id, failure)])`; every row has exactly one of `answer` and `failure`, and the two results are complementary: `settled` with `settled`, or `already-settled` with `cancelled`).
  - `a replayed answer write finds the turn settled and writes nothing` (`settleChatTurn` twice → `settled`, then `already-settled`; the answer is the first one).
  - `the transcript orders turns, derives running and unanswered, and names only a live turn for reconnect` (turns: answered; failed; one whose workflow was cancelled without an outcome → `UNANSWERED`; one `ENQUEUED` → `QUEUED`, which is `reconnectTurnId`).
  - `a SUCCESS workflow over a turn without an outcome reads as unanswered after the re-read`.
  - `loadChatTurn returns the question, the owner and the earlier answered turns in order` (unanswered and failed turns are left out; later turns are left out).
  - `a second account reads, reconnects to and cancels none of the first account's turns` (`readChatTranscript`, `ownedChatTurn`, `cancelChatTurn`, `admitChatTurn` on A's revision → `null` for B).
  - `deleting the Source Document deletes its transcript` (cascade through the revision).
  - `the ChatTurn table holds no key column` (`information_schema.columns` for `chatTurn` is exactly `id, sourceRepresentationRevisionId, question, answer, failure, createdAt`).
  Run: `pnpm --filter db test:postgres` (fresh databases). Expected: FAIL.

- [ ] **Step 3: Implement `packages/db/src/chat-turns.ts`**

  ```ts
  /** The chat store (spec, *Chat*). One active turn per immutable Source Representation Revision; the question and its
   *  workflow commit together; every outcome write is conditional, so a replay, a cancel race or a late answer is a no-op. */
  export function chatTurnMethods(database: Database, researcherAccountId: string,
    options: { workflowStatuses?: WorkflowStatuses; enqueue?: TransactionalEnqueue }) {
    const compare = (row: StoredChatTurn, input: { sourceRepresentationRevisionId: string; question: string }): ChatAdmission =>
      row.sourceRepresentationRevisionId === input.sourceRepresentationRevisionId && row.question === input.question
        ? { status: 'replayed', turn: recordOf(row) }
        : { status: 'conflict' }
    return {
      async admitChatTurn(input: { projectContextId: string; sourceRepresentationRevisionId: string; turnId: string; question: string }) {
        const enqueue = options.enqueue
        if (!enqueue) throw new Error('Chat admission needs the transactional enqueue.')
        try {
          return await withPoolClientTransaction(async (transaction, client): Promise<ChatAdmission | null> => {
            const scope = await ownedRevisionScope(transaction, researcherAccountId, input.sourceRepresentationRevisionId)
            if (!scope || scope.projectContextId !== input.projectContextId) return null
            const existing = await transaction.orm.public.ChatTurn.select(...TURN_FIELDS).first({ id: input.turnId })
            if (existing) return compare(existing, input)                      // committed earlier: nothing to enqueue
            const created = await transaction.orm.public.ChatTurn.create({
              id: input.turnId, sourceRepresentationRevisionId: input.sourceRepresentationRevisionId, question: input.question,
            })
            await enqueue(client, {
              workflowName: CHAT_TURN_NAME,
              workflowID: `chat:${input.turnId}`,
              queueName: STUDIO_QUEUE_NAME,
              // One active turn per immutable revision (spec, *Chat exclusion*): a second one's enqueue is rejected, and
              // the rollback takes its question with it.
              deduplicationID: `chat:${input.sourceRepresentationRevisionId}`,
              authenticatedUser: researcherAccountId,
              attributes: { projectContextId: scope.projectContextId, sourceDocumentId: scope.sourceDocumentId,
                sourceRepresentationRevisionId: input.sourceRepresentationRevisionId },
            }, { turnId: input.turnId })
            return { status: 'created', turn: recordOf(created) }
          })
        } catch (error) {
          if (error instanceof DuplicateActiveWorkflowError) return { status: 'busy' }
          // Two first requests for one turn: the loser's insert waited for the winner's commit (spec, *Replays*).
          if (!isUniqueViolation(error, 'chatTurn_pkey')) throw error
          const row = await database.orm.public.ChatTurn.select(...TURN_FIELDS).first({ id: input.turnId })
          return row ? compare(row, input) : { status: 'conflict' }
        }
      },
      async readChatTranscript(sourceRepresentationRevisionId: string): Promise<ChatTranscript | null> {
        const read = () => database.transaction(async (transaction) => {
          if (!(await ownedRevisionScope(transaction, researcherAccountId, sourceRepresentationRevisionId))) return null
          return transaction.orm.public.ChatTurn.where({ sourceRepresentationRevisionId }).select(...TURN_FIELDS)
            .orderBy([(turn) => turn.createdAt.asc(), (turn) => turn.id.asc()]).all()
        })
        let rows = await read()
        if (rows === null) return null
        const unsettled = (all: readonly StoredChatTurn[]) => all.filter((row) => row.answer === null && row.failure === null)
        const statusesOf = options.workflowStatuses
        if (!statusesOf) throw new Error('Reading a transcript needs the workflow statuses.')
        const statuses = await statusesOf(unsettled(rows).map((row) => `chat:${row.id}`))
        // SUCCESS means the workflow wrote its outcome just now: read once more; still no outcome is unanswered.
        if (unsettled(rows).some((row) => executionOf(statuses.get(`chat:${row.id}`)) === 'REREAD')) rows = await read()
        if (rows === null) return null
        const turns = rows.map((row) => ({ ...recordOf(row), status: turnStatus(row, statuses.get(`chat:${row.id}`)) }))
        const live = [...turns].reverse().find((turn) => turn.status === 'QUEUED' || turn.status === 'RUNNING')
        return { sourceRepresentationRevisionId, turns, reconnectTurnId: live?.turnId ?? null }
      },
      async ownedChatTurn(sourceRepresentationRevisionId: string, turnId: string) {
        return database.transaction(async (transaction) => {
          if (!(await ownedRevisionScope(transaction, researcherAccountId, sourceRepresentationRevisionId))) return null
          const row = await transaction.orm.public.ChatTurn.select(...TURN_FIELDS).first({ id: turnId, sourceRepresentationRevisionId })
          return row ? recordOf(row) : null
        })
      },
      async cancelChatTurn(turnId: string, failure: ChatTurnFailureRecord) {
        return database.transaction(async (transaction) => {
          const row = await transaction.orm.public.ChatTurn.select('sourceRepresentationRevisionId').first({ id: turnId })
          if (!row || !(await ownedRevisionScope(transaction, researcherAccountId, row.sourceRepresentationRevisionId))) return null
          // The cancellation handler records the domain outcome before cancelling; the workflow cannot (spec, *Rules*).
          const written = await transaction.orm.public.ChatTurn.where({ id: turnId, answer: null, failure: null }).updateAll({ failure })
          return written.length === 1 ? 'cancelled' as const : 'settled' as const
        })
      },
    }
  }

  function turnStatus(row: StoredChatTurn, workflowStatus: string | undefined): ChatTurnStatus {
    if (row.answer !== null) return 'ANSWERED'
    if (row.failure !== null) return 'FAILED'
    const execution = executionOf(workflowStatus)
    return execution === 'QUEUED' || execution === 'RUNNING' ? execution : 'UNANSWERED'
  }

  export function chatTurnWorkerMethods(database: Database) {
    return {
      async loadChatTurn(turnId: string): Promise<AdmittedChatTurn | null> {
        return database.transaction(async (transaction) => {
          const turn = await transaction.orm.public.ChatTurn.select(...TURN_FIELDS).first({ id: turnId })
          if (!turn) return null
          const scope = await revisionScope(transaction, turn.sourceRepresentationRevisionId)   // { owner, projectContextId, sourceDocumentId }
          if (!scope) return null
          const all = await transaction.orm.public.ChatTurn.where({ sourceRepresentationRevisionId: turn.sourceRepresentationRevisionId })
            .select(...TURN_FIELDS).orderBy([(row) => row.createdAt.asc(), (row) => row.id.asc()]).all()
          const earlier = all.slice(0, all.findIndex((row) => row.id === turnId))
          return {
            turnId, ...scope, sourceRepresentationRevisionId: turn.sourceRepresentationRevisionId, question: turn.question,
            history: earlier.flatMap((row) => (row.answer === null ? [] : [{ question: row.question, answer: row.answer }])),
            settled: turn.answer !== null || turn.failure !== null,
          }
        })
      },
      async settleChatTurn(turnId: string, outcome: ChatTurnOutcome) {
        const written = await database.orm.public.ChatTurn.where({ id: turnId, answer: null, failure: null })
          .updateAll('answer' in outcome ? { answer: outcome.answer } : { failure: outcome.failure })
        if (written.length === 1) return 'settled' as const
        return (await database.orm.public.ChatTurn.select('id').first({ id: turnId })) ? 'already-settled' as const : 'missing' as const
      },
    }
  }
  ```
  `TURN_FIELDS` is `['id', 'sourceRepresentationRevisionId', 'question', 'answer', 'failure', 'createdAt'] as const`; `recordOf` renames `id` to `turnId`. `ownedRevisionScope(transaction, account, revisionId)` joins revision → document → project with `projectContext.researcherAccountId = account` (as `ownedSourceRepresentationDescriptor` does) and returns `{ projectContextId, sourceDocumentId }`; `revisionScope` is the same join without the account filter, returning the owner too. `createResearcherProjectStore` spreads `chatTurnMethods(database, researcherAccountId, options)`; `createInternalProjectWorkerStore` spreads `chatTurnWorkerMethods(database)`.
  `pool-client-transaction.ts`:
  ```ts
  /** Another live workflow holds the deduplication ID (DBOS's rejection policy). Studio's enqueue adapter raises it in
   *  place of DBOSQueueDuplicatedError, so packages/db imports no DBOS runtime. */
  export class DuplicateActiveWorkflowError extends Error {
    constructor(readonly deduplicationID: string, options?: ErrorOptions) {
      super(`A live workflow holds deduplication ID ${deduplicationID}.`, options)
      this.name = 'DuplicateActiveWorkflowError'
    }
  }
  ```
  and `AdmittedWorkflow` gains `deduplicationID?: string` (M4's adapter spreads `workflow` into the enqueue options, so it reaches DBOS unchanged). `server/app.ts`'s enqueue adapter:
  ```ts
  enqueue: async (client, workflow, input) => {
    try {
      await studioDbos().admission.enqueueInTransaction(client, { ...workflow, attributes: { ...workflow.attributes } }, input)
    } catch (error) {
      if (error instanceof DBOSErrors.DBOSQueueDuplicatedError)
        throw new DuplicateActiveWorkflowError(workflow.deduplicationID ?? workflow.workflowID, { cause: error })
      throw error
    }
  },
  ```
  with `server/app.test.ts`: `the enqueue adapter reports a taken deduplication ID as DuplicateActiveWorkflowError`.

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres          # fresh databases
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/prisma/contract.prisma packages/db/migrations/app packages/db/src/pool-client-transaction.ts \
    packages/db/src/index.ts packages/db/src/chat-turns.ts packages/db/src/chat-turn.postgres.check.ts packages/db/src/project-store.ts \
    packages/db/package.json prototypes/studio/server/app.ts prototypes/studio/server/app.test.ts prototypes/studio/api prototypes/studio/server
  git commit -m "feat(db): store chat turns and admit each question with its workflow, one active turn per revision"
  ```
  Tell the controller that an existing `pnpm dev` database must be recreated once (Global Constraints).

### Task 7: `chatTurn`: durable streaming, the answer write, the sanitized failure

**Files:**
- Create: `prototypes/studio/api/_chat_turn_workflow.ts` (+ `_chat_turn_workflow.test.ts`), `prototypes/studio/test/support/cliStandInModel.ts`, `prototypes/studio/api/chat_turn_workflow.postgres.test.ts`, `prototypes/studio/test/support/scenarios/chat-answer-kill.ts`, `…/chat-stream-kill.ts`, `…/chat-route-change.ts`, `…/chat-key-recover.ts`
- Modify: `prototypes/studio/api/_model.ts` (export `ModelDependencies`; add `resolveChatModel`, `chatSystemPrompt`), `prototypes/studio/server/workflows.ts` (+ test)

**Interfaces:**
- Consumes: Task 1 (`modelStreamOnError`, the model boundary), Task 2 (`sanitizedChatModel`, `chatFailureOf`, `chatTurnFailed`), Task 3 (PostgreSQL support), Task 6 (`AdmittedChatTurn`, `ChatTurnOutcome`, `loadChatTurn`, `settleChatTurn`, `admitChatTurn`), M4's `WorkflowSteps`, `dbosSteps`, `isWorkflowCancellation`.
- Produces:
  ```ts
  // api/_chat_turn_workflow.ts
  export const CHAT_TURN = 'chatTurn'
  export const CHAT_STREAM_KEY = 'ui'
  export type ChatTurnInput = Readonly<{ turnId: string }>
  export type ChatTurnStore = Readonly<{ load(turnId: string): Promise<AdmittedChatTurn | null>; readMarkdown(sourceRepresentationRevisionId: string): Promise<string | null>; settle(turnId: string, outcome: ChatTurnOutcome): Promise<'settled' | 'already-settled' | 'missing'> }>
  export type ChatTurnPorts = Readonly<{ steps: WorkflowSteps; store: ChatTurnStore; resolveModel(owner: string): Promise<LanguageModel>; stream?: typeof streamText; callTimeoutMs?: number }>
  export function chatTurnWorkflow(input: ChatTurnInput, ports: ChatTurnPorts): Promise<void>
  export function registerChatTurnWorkflow(ports: () => ChatTurnPorts): void
  // api/_model.ts
  export type ModelDependencies                                   // the existing type, exported
  export function resolveChatModel(caller: ModelCaller, dependencies?: ModelDependencies): Promise<LanguageModel>
  export function chatSystemPrompt(documentMarkdown: string): string
  // test/support/cliStandInModel.ts
  export function cliStandInModel(options?: { answer?: string }): LanguageModelV4   // provider 'claude-code', honours abortSignal, emits provider metadata
  ```

- [ ] **Step 1: Write the failing unit tests** (`api/_chat_turn_workflow.test.ts`)

  The body runs outside DBOS (`durableCalls` then calls the model directly), with fake `steps` recording step names, a fake store and `plantingModel`/stand-in models.
  - `loads the turn, streams from the owner's model with the document as system prompt and earlier turns as messages, then records the answer` (steps `loadTurn`, `recordAnswer`; the model's `prompt` holds `chatSystemPrompt(markdown)` then user/assistant/user messages in order; `settle` receives `{ answer }`).
  - `a settled or deleted turn streams nothing` (`load` → `settled: true` or null; the model is never called; no `record*` step).
  - `a provider failure records a typed failure and throws a fresh ChatTurnFailed error without a cause` (`plantingModel(key, 'throw')`: `recordFailure` with `CHAT_FAILED`; the rejection is `ChatTurnFailed` with `code: 'model_operation_failed'`, `cause === undefined`, and `holdsKey(it, key) === false`).
  - `a missing route records invalid_model_config` (`resolveModel` rejects `ApiError(409, 'invalid_model_config', …)`).
  - `a partial failure saves no answer` (`'error-part'` after `partial`: `recordFailure` only).
  - `the chat's streamText sets maxRetries 0, no streamRetries, and an onError that returns nothing` (`ports.stream` is a spy that records its options and delegates to `streamText`: `maxRetries === 0`; `'streamRetries' in options === false`; `options.onError({ error: new Error('x') }) === undefined`).
  - `a workflow cancellation during the stream propagates without a failure write` (under DBOS the cancellation surfaces from `durableCalls`' own `DBOS.runStep`, outside the sanitizer, as a stream error: the `stream` spy calls `options.onError({ error: new DBOSErrors.DBOSWorkflowCancelledError('chat:x') })` and returns a result whose `consumeStream` resolves; the workflow rejects with that error and no `record*` step runs).
  Run: `pnpm --filter studio exec vitest run api/_chat_turn_workflow.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

  `api/_model.ts`:
  ```ts
  export function chatSystemPrompt(documentMarkdown: string): string {
    return 'Answer questions using the source document below. Say when the source does not support an answer.\n\n' +
      `SOURCE DOCUMENT MARKDOWN:\n${documentMarkdown}\nEND SOURCE DOCUMENT MARKDOWN`
  }

  /** The owner's Interaction Route model for one chat attempt, resolved again on every attempt (spec, *No pins*): a
   *  recovered turn follows today's route and key. Keys are read inside the provider attempt, never here. */
  export async function resolveChatModel(caller: ModelCaller, dependencies: ModelDependencies = {}): Promise<LanguageModel> {
    const resolved = await operationTarget('chat', undefined, undefined, caller, dependencies)
    if (resolved.profile !== 'general') throw new ApiError(409, 'invalid_model_config', 'The Interaction Route must use general execution.')
    return resolved.model
  }
  ```
  `api/_chat_turn_workflow.ts`:
  ```ts
  import { DBOS } from '@dbos-inc/dbos-sdk'
  import { durableCalls } from '@dbos-inc/vercel-ai'
  import { streamText, wrapLanguageModel, type LanguageModel, type ModelMessage } from 'ai'
  import type { AdmittedChatTurn, ChatTurnOutcome } from 'db'
  import { isWorkflowCancellation, type WorkflowSteps } from 'extraction/workflows'
  import { chatFailureOf, chatTurnFailed, sanitizedChatModel } from './_chat_sanitizer.js'
  import { chatSystemPrompt, modelStreamOnError } from './_model.js'
  import { MODEL_OPERATION_TIMEOUT_MS } from './_model_operation.js'

  export const CHAT_TURN = 'chatTurn'
  export const CHAT_STREAM_KEY = 'ui'
  /** The turn ID only: the question and the earlier turns are the ChatTurn rows (spec, *Chat → Request*). */
  export type ChatTurnInput = Readonly<{ turnId: string }>

  function chatMessages(turn: AdmittedChatTurn): ModelMessage[] {
    return [
      ...turn.history.flatMap(({ question, answer }): ModelMessage[] => [
        { role: 'user', content: question },
        { role: 'assistant', content: answer },
      ]),
      { role: 'user', content: turn.question },
    ]
  }

  /**
   * `chatTurn(turnId)` (spec, *Chat → Workflow*). The load step checkpoints the question and the earlier answered turns;
   * the document is read at workflow scope, so no checkpoint holds it. streamText runs at workflow scope; durableCalls
   * makes the model call one step named `chat` — a fixed name, so replay stays valid when the route changed between
   * attempts — and writes its parts to the durable stream `ui` from inside that step. The sanitizer sits inside it.
   * One retry owner: durableCalls (maxRetries 0; no streamRetries; an onError that returns nothing), and 0.4.4 refuses a
   * retry once content streamed, so a partial failure never gains replacement text.
   */
  export async function chatTurnWorkflow({ turnId }: ChatTurnInput, ports: ChatTurnPorts): Promise<void> {
    const { steps, store } = ports
    const turn = await steps.step('loadTurn', () => store.load(turnId))
    if (turn === null || turn.settled) return
    const markdown = await store.readMarkdown(turn.sourceRepresentationRevisionId)
    if (markdown === null) return                             // the revision is gone, and its turns with it
    let failure: unknown
    const capture = (error: unknown) => { failure ??= error }
    let answer = ''
    try {
      const model = wrapLanguageModel({
        model: sanitizedChatModel(await ports.resolveModel(turn.owner)),
        middleware: durableCalls({
          name: 'chat', durableStream: CHAT_STREAM_KEY, retriesAllowed: true, maxAttempts: 3,
          timeoutMS: ports.callTimeoutMs ?? MODEL_OPERATION_TIMEOUT_MS,
        }),
      })
      const result = (ports.stream ?? streamText)({
        model,
        system: chatSystemPrompt(markdown),
        messages: chatMessages(turn),
        maxRetries: 0,
        onError: modelStreamOnError('chat', capture),
      })
      await result.consumeStream({ onError: capture })
      if (failure === undefined) answer = await result.text
    } catch (error) {
      if (isWorkflowCancellation(error)) throw error
      capture(error)
    }
    if (failure !== undefined) {
      if (isWorkflowCancellation(failure)) throw failure
      const typed = chatFailureOf(failure)
      // Record the typed failure, then end the workflow with a fresh sanitized error: a typed failure returned as success
      // would close the durable stream with an ordinary finish (stream probe). Partial text is never saved.
      await steps.step('recordFailure', () => store.settle(turnId, { failure: typed }))
      throw chatTurnFailed(typed)
    }
    // Conditional: a cancel that won, a deleted turn or a replay of this step writes nothing.
    await steps.step('recordAnswer', () => store.settle(turnId, { answer }))
  }

  export function registerChatTurnWorkflow(ports: () => ChatTurnPorts): void {
    DBOS.registerWorkflow(async (input: ChatTurnInput) => chatTurnWorkflow(input, ports()), { name: CHAT_TURN })
  }
  ```
  `server/workflows.ts`: append `CHAT_TURN` and register
  ```ts
  registerChatTurnWorkflow(() => {
    const worker = createInternalProjectWorkerStore()
    return {
      steps: dbosSteps,
      store: { load: (id) => worker.loadChatTurn(id), readMarkdown: (id) => worker.readRevisionMarkdown(id), settle: (id, outcome) => worker.settleChatTurn(id, outcome) },
      resolveModel: (owner) => resolveChatModel({ researcherAccountId: owner }),
    }
  })
  ```
  and `server/workflows.test.ts` asserts `CHAT_TURN_NAME === CHAT_TURN` and `STUDIO_QUEUE_NAME === STUDIO_QUEUE`.
  `test/support/cliStandInModel.ts`: a v4 model with `provider: 'claude-code'`, `modelId: 'sonnet'`, whose `doStream` emits `stream-start`, a `text-start`/`text-delta`/`text-end` with the answer (default `stand-in answer`) and a `finish` whose `providerMetadata` is `{ 'claude-code': { sessionId: 'FREE_CLI_SESSION_MARKER', costUsd: 0 } }` (the shape the real provider reports), and that rejects with an `AbortError` when `params.abortSignal` aborts before it finishes. It stands in for the CLI subprocess only: resolution, the deployment connection, the sanitizer, `durableCalls` and the stream are FREE's own.

- [ ] **Step 3: Write the PostgreSQL tests** (`api/chat_turn_workflow.postgres.test.ts`)

  Setup: Task 3's support; `configureOwnerRoute(account, { provider: 'openai-compatible', baseUrl: server.baseUrl, modelId: 'scripted', hasKey: true, routes: ['interaction'] })`; a counted key cache holding `plantedKey()`; ports with the Task 6 stores (`admitChatTurn` through `createResearcherProjectStore(account, undefined, { workflowStatuses, enqueue })` with Studio's adapter; `load`/`settle` through the worker store), `readMarkdown` returning a synthetic document and `resolveModel: (owner) => resolveChatModel({ researcherAccountId: owner }, { keys, keyWaitMs: 400, deployment, modelFactories })`. Streams are read with `readDurableStream({ workflowID: \`chat:${turnId}\`, key: 'ui', messageId: turnId })` into a list of UI chunks.
  - `a chat turn over the scripted HTTP provider streams its answer under the turn ID and records it once` (A8 HTTP: `start.messageId === turnId`; the text deltas join to the reply; `answer` is stored; one call, carrying `Bearer <key>`). This first test is also the gate for the one assumption no probe covered: `stream-probe.mjs` and `version-probe.mjs` called `model.doStream` directly inside a workflow, whereas `chatTurn` calls `streamText` at workflow scope and relies on DBOS's context reaching `durableCalls` through the AI SDK's internal promise chain (the integration's documented pattern). If this test fails with the model called outside a step (no `chat` row in `operation_outputs`, nothing in the `ui` stream), diagnose that first, not the store; report it to the controller rather than moving the model call into a hand-written step.
  - `a chat turn on a CLI deployment connection completes end to end through the stand-in` (A8 CLI: `deployment = deploymentModels({ FREE_DEPLOYMENT_CLI_PROVIDERS: 'claude-code' })`, the owner's Interaction Route names that deployment connection, `modelFactories: { 'claude-code': () => cliStandInModel() }`; the answer is stored and streamed; `databaseHolds(url, 'FREE_CLI_SESSION_MARKER', [schema])` is empty: provider metadata was stripped).
  - `a reader that reconnects mid-stream sees the text so far once, then the rest, under the turn ID` (A4: `reply({ text: 'partial-then-rest', hold: true })`; a first reader receives the first delta; a second reader opened from offset 0 receives it once; `release()`; both end with the full text exactly once and `finish`).
  - `a partial provider failure ends the stream with an error finish, records the failure and saves no answer; the provider was called once` (A4: `reply({ text: 'partial', dropAfterFirstChunk: true })`: the stream ends `error` then `finish` `error`; the row has `failure.code === 'model_operation_failed'` and `answer === null`; `server.calls().length === 1`; the workflow is `ERROR`).
  - `an answer written before a kill is written once` (A1; scenario `chat-answer-kill`: its `settle` wrapper SIGKILLs right after the commit of `{ answer }` on the first run; after the second run the scenario's result file reads `settled`, `already-settled`; the stored answer is unchanged; `SUCCESS`).
  - `a Studio killed mid-stream recovers the turn: the transcript names it for reconnect, and a new reader sees only the recovered attempt's text under the turn ID` (A2 kill, A4 superseded attempts; scenario `chat-stream-kill`: the first run SIGKILLs once `DBOS.readStreamOffset(workflowID, 'ui', 0)` returned a record of the held reply `partial-A`; between the runs `readChatTranscript` has `reconnectTurnId === turnId`; the second run answers `answer-A2`; a reader from offset 0 yields `answer-A2` only, never `partial-A`; `start.messageId === turnId`).
  - `a route changed between attempts: an interrupted call reruns on the new route` (A7; scenario `chat-route-change` mode `interrupted`: as above, but between the runs `configureOwnerRoute` re-points the Interaction Route to a second scripted server B; B answers; A was called once, B once; the stored answer is B's).
  - `a route changed between attempts: a checkpointed call replays without a model call and without waiting for a key` (A7, A14; mode `checkpointed`: the first run's `settle` wrapper SIGKILLs before its commit, after the `chat` step checkpointed; between the runs the route moves to B; the second run holds no key; it finishes within 5 s with A's answer; B is never called; no `DBOSUnexpectedStepError`).
  - `with no page to resend it, a recovered chat call fails with model_key_required after the wait and neither retry owner retries it` (A13; scenario `chat-key-recover`: the first run SIGKILLs during a held call; the second run holds no key; the row's failure is `model_key_required`; no call after the restart; the counted `wait` ran once; the stream ends with an error finish whose text is `ModelKeyRequiredError`'s message).
  - `a cancel during the key wait never reaches the provider` (A14: no key; once the counted `wait` began, `admission.cancelWorkflow('chat:<id>')`; `CANCELLED` within 3 s; no call; the stream ends with `abort`).
  - `a cancel during a provider call stops it about 1 s later` (A14: `hold`; cancel at `t0`; `calls()[0].closedAt - t0 <= 2_500`).
  - `a key planted in the error cause chain, response headers and provider metadata of a chat call reaches no table, stream record or log` (A10: turn 1 against `reply({ status: 500, body: '{"error":"{{authorization}}"}', headers: { 'x-echo': key } })`; turn 2 against `modelFactories['openai-compatible'] = () => plantingModel(key, 'error-part')`; turn 3 against `plantingModel(key, 'success')`; after each settles, `databaseHolds(url, key, [schema, 'public'])` is empty, `holdsKey(readChunks, key)` is false, and the captured output does not contain the key).
  - `a chat turn's checkpoints hold the history and the answer, not the document` (A11: a 200 000-character synthetic document containing `FREE_SYNTHETIC_DOCUMENT_<hex>` and two earlier answered turns; `databaseHolds(url, marker, [schema])` is empty; the bytes of every row of every table in the DBOS schema whose text mentions `chat:<turnId>` sum below 20 000; print the measured number as `chat checkpoint bytes: <n>` for Task 14's record).
  Scenarios follow Task 3's contract; the scripted servers stay in the parent.

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter studio exec vitest run api/_chat_turn_workflow.test.ts
  pnpm --filter studio exec vitest run --config vitest.postgres.config.ts api/chat_turn_workflow.postgres.test.ts
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio build && grep -c '@dbos-inc/vercel-ai' prototypes/studio/dist/server/index.js   # at least 1: kept external
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api prototypes/studio/server prototypes/studio/test/support
  git commit -m "feat(studio): answer chat turns as durable workflows that stream through durableCalls and record one outcome"
  ```

### Task 8: The chat routes: question admission, the transcript, exact-turn reconnect, cancel

**Files:**
- Create: `prototypes/studio/shared/chat.contract.ts` (+ `chat.contract.test.ts`), `prototypes/studio/api/chat.test.ts`, `prototypes/studio/api/chat_routes.postgres.test.ts`
- Modify: `prototypes/studio/api/chat.ts` (rewritten), `prototypes/studio/api/model_operations.ts` (`DELETE chat:<turnId>`) and its tests, `prototypes/studio/server/api-dispatcher.ts` (+ test), `prototypes/studio/server/researcher-project-ownership.test.ts` (chat cases)
- Modify: `prototypes/studio/api/_model.ts` (delete `streamChatWithModel`), `prototypes/studio/api/_model.test.ts` / `_model.transport.test.ts` (delete its cases; Task 7 covers the stream's `onError`), `prototypes/studio/api/_schema_edit.ts` (delete `loadOwnedSourceMarkdown` and `readCanonicalMarkdown`: no handler reads Markdown any more)
- Modify: `prototypes/studio/src/ChatTab.tsx` (the transport sends `{ projectContextId, sourceRepresentationRevisionId, turnId, question }` with the revision as chat ID) and `src/ChatTab.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`createModelOperationHandlers`), Task 6 (store methods), Task 7 (`CHAT_STREAM_KEY`), Task 2 (`chatStreamErrorText`, `CHAT_CANCELLED`).
- Produces:
  ```ts
  // shared/chat.contract.ts
  export const chatRequestSchema          // { projectContextId, sourceRepresentationRevisionId, turnId, question: trimmed, 1–8000 characters }
  export const chatTurnSchema             // { turnId, question, answer | null, failure: { code, message } | null, status, createdAt }
  export const chatTranscriptSchema       // { sourceRepresentationRevisionId, turns, reconnectTurnId | null }
  export type ChatTranscriptDto = z.infer<typeof chatTranscriptSchema>
  export const CHAT_TURN_WORKFLOW_ID: RegExp   // ^chat:(<canonical UUID>)$
  // api/chat.ts
  export function createChatHandlers(store: ChatStore, dbos?: () => { operations: Pick<DBOSClient, 'getWorkflow'>; streams: DurableStreamSource }): { POST; GET }
  ```
  Routes: `POST /api/chat` → 200 UI message stream or 204; 400 malformed; 404 not owned; 409 `chat_turn_conflict` / `chat_turn_active`; 503 outage. `GET /api/chat/<revision ID>` → `ChatTranscriptDto`. `GET /api/chat/<revision ID>/stream?turnId=<id>` → 200 stream or 204; 404 unless the turn belongs to the owned revision. `DELETE /api/model-operations/chat:<turnId>` → 204 (404 unless owned).

- [ ] **Step 1: Write the failing tests**

  `shared/chat.contract.test.ts`: `a chat request carries only the revision, the turn ID and the question` (`messages`, `temperature` and unknown keys are refused; an empty or 8 001-character question is refused).
  `api/chat.test.ts` (fake store; fake `operations.getWorkflow`; fake `streams` replaying scripted records):
  - `POST admits the question and answers the turn's stream with the turn ID as the message ID`.
  - `a replayed turn answers its stream, or 204 when its history is gone`.
  - `another active turn is 409 chat_turn_active; a reused turn ID with another question is 409 chat_turn_conflict; an unowned revision is 404`.
  - `a malformed body is 400 with a fixed message and no details`.
  - `GET returns the transcript with reconnectTurnId`; `GET …/stream needs a canonical turnId (422) that belongs to the owned revision (404)`; `a stream that ends in a workflow error carries chatTurn's message only`.
  `api/model_operations.test.ts`: `DELETE chat:<turnId> records the cancellation before cancelling a live workflow, and is 404 for another account's turn`.
  `server/api-dispatcher.test.ts`: `routes /api/chat, /api/chat/<id> and /api/chat/<id>/stream to chat`.
  `src/ChatTab.test.tsx`: replace `sends chat through the shared authenticated fetch` with `sends only the new question with a new turn ID, using the revision as the chat ID`; keep `a chat message is sent after the keys`.
  `api/chat_routes.postgres.test.ts` (Task 7's setup; the handlers run on the real store, admission client and `DBOS` as stream source):
  - `POST admits the question and streams the answer with the turn ID as the assistant message ID`.
  - `a repeated POST after a dropped connection returns the same turn's stream, and the model runs once` (A6: abort the first response's body read after the first chunk; POST the same body; the second stream holds the whole answer once; one question row; one call).
  - `a different active turn on the same revision is 409 chat_turn_active and stores no question`.
  - `an answer that finishes between the transcript read and the reconnect still streams in full under the turn ID` (A5: `hold`; `GET` transcript → `reconnectTurnId === turnId`; `release()` and wait for `SUCCESS`; `GET …/stream?turnId=` → the whole answer with `start.messageId === turnId`; the transcript now reads `ANSWERED`).
  - `exact-turn reconnect works across completion and answers 204 once the turn's history is deleted; the transcript then holds the answer` (A6: after `SUCCESS` the stream route replays the answer; after `admission.deleteWorkflows(['chat:<id>'])` it answers 204; the transcript still has the answer).
  - `DELETE chat:<turnId> records the cancellation, stops the workflow and frees the revision for a new turn`.
  - `a second account can neither read, stream nor cancel the first account's turns; after the project is deleted every reconnect is 404` (A9).
  Run them. Expected: FAIL.

- [ ] **Step 2: Implement**

  `shared/chat.contract.ts`:
  ```ts
  export const chatRequestSchema = z.object({
    projectContextId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
    /** Client-minted per question; a repeat after an uncertain failure reuses it (spec, *Client IDs*). */
    turnId: canonicalUuidSchema,
    question: z.string().trim().min(1).max(8_000),
  }).strict()
  export const chatTurnSchema = z.object({
    turnId: canonicalUuidSchema,
    question: z.string(),
    answer: z.string().nullable(),
    failure: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
    status: z.enum(['QUEUED', 'RUNNING', 'ANSWERED', 'FAILED', 'UNANSWERED']),
    createdAt: z.string(),
  }).strict()
  export const chatTranscriptSchema = z.object({
    sourceRepresentationRevisionId: canonicalUuidSchema,
    turns: z.array(chatTurnSchema),
    /** The live turn to reconnect to with GET …/stream?turnId=, if any (at most one per revision). */
    reconnectTurnId: canonicalUuidSchema.nullable(),
  }).strict()
  ```
  `api/chat.ts`:
  ```ts
  type ChatStore = Pick<ResearcherProjectStore, 'admitChatTurn' | 'readChatTranscript' | 'ownedChatTurn'>
  type ChatDbos = { operations: Pick<DBOSClient, 'getWorkflow'>; streams: DurableStreamSource }
  const CHAT_PATH = /^\/api\/chat\/([^/]+)(\/stream)?$/
  const notFound = () => new ApiError(404, 'not_found', 'Project model context was not found.')
  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Chat is unavailable.')

  export function createChatHandlers(store: ChatStore,
    dbos: () => ChatDbos = () => ({ operations: studioDbos().admission, streams: DBOS })) {
    /** The named turn's durable stream, replayed from offset 0 with the turn ID as the assistant message ID, live or
     *  after completion; 204 once its history is gone (readDurableStream throws for a workflow DBOS no longer holds),
     *  and the page re-reads the transcript (spec, *Reload*). */
    async function streamTurn(turnId: string): Promise<Response> {
      const workflowID = `chat:${turnId}`
      const { operations, streams } = dbos()
      const recorded = await operations.getWorkflow(workflowID).catch((cause) => { throw unavailable(cause) })
      if (!recorded) return new Response(null, { status: 204, headers: noStore })
      return createUIMessageStreamResponse({
        headers: noStore,
        stream: readDurableStream({ workflowID, key: CHAT_STREAM_KEY, messageId: turnId, client: streams, onError: chatStreamErrorText }),
      })
    }
    return {
      async POST(request: Request): Promise<Response> {
        try {
          if (new URL(request.url).pathname !== '/api/chat') throw notFound()
          const parsed = chatRequestSchema.safeParse(await parseJsonRequest(request))
          if (!parsed.success) throw new ApiError(400, 'invalid_request', 'The chat request is invalid.')
          const admitted = await store.admitChatTurn(parsed.data).catch((cause) => { throw unavailable(cause) })
          if (admitted === null) throw notFound()
          if (admitted.status === 'conflict')
            throw new ApiError(409, 'chat_turn_conflict', 'This turn ID was already used for another question. Ask again.')
          if (admitted.status === 'busy')
            throw new ApiError(409, 'chat_turn_active', 'Another question about this document is still being answered.')
          return await streamTurn(parsed.data.turnId)
        } catch (error) {
          return noStoreError(error)
        }
      },
      async GET(request: Request): Promise<Response> {
        try {
          const url = new URL(request.url)
          const match = CHAT_PATH.exec(url.pathname)
          if (!match || !canonicalUuidSchema.safeParse(match[1]).success) throw notFound()
          const revisionId = match[1]!
          if (!match[2]) {
            const transcript = await store.readChatTranscript(revisionId).catch((cause) => { throw unavailable(cause) })
            if (!transcript) throw notFound()
            return json(transcriptDto(transcript), { headers: noStore })
          }
          const turnId = url.searchParams.get('turnId')
          if (!turnId || !canonicalUuidSchema.safeParse(turnId).success)
            throw new ApiError(422, 'invalid_request', 'turnId must be a canonical lowercase UUID.')
          // Ownership on every reconnect: the turn must belong to this revision, which the account must own.
          if (!(await store.ownedChatTurn(revisionId, turnId).catch((cause) => { throw unavailable(cause) }))) throw notFound()
          return await streamTurn(turnId)
        } catch (error) {
          return noStoreError(error)
        }
      },
    }
  }

  export function createResearcherApiHandlers(store: ResearcherProjectStore) {
    return createChatHandlers(store)
  }
  ```
  `transcriptDto` maps `createdAt` to ISO strings. The dispatcher gains `[/^\/api\/chat(?:\/[^/]+(?:\/stream)?)?$/, 'chat']`.
  `api/model_operations.ts` `DELETE`: right after decoding `workflowId` (and creating `client`), before matching `MODEL_OPERATION_WORKFLOW_ID`,
  ```ts
  const chat = CHAT_TURN_WORKFLOW_ID.exec(workflowId)
  if (chat) {
    // Record the domain outcome first (spec, *Rules*: the workflow cannot record its own cancellation); the conditional
    // write makes an answer racing this cancel the one winner.
    const outcome = await store.cancelChatTurn(chat[1]!, CHAT_CANCELLED).catch((cause) => { throw unavailable(cause) })
    if (outcome === null) throw notFound()
    const recorded = await client.getWorkflow(workflowId).catch((cause) => { throw unavailable(cause) })
    if (recorded && LIVE_WORKFLOW_STATUSES.has(recorded.status)) await client.cancelWorkflow(workflowId).catch((cause) => { throw unavailable(cause) })
    return new Response(null, { status: 204, headers: noStore })
  }
  ```
  (`ModelOperationStore` gains `cancelChatTurn`.)
  `src/ChatTab.tsx` (minimal here; Task 11 rewrites the tab): `prepareSendMessagesRequest` sends `{ projectContextId, sourceRepresentationRevisionId, turnId: <the new user message's id>, question: <its text> }`; `sendMessages` uses `chatId: sourceRepresentationRevisionId`; `nextId()` stays `crypto.randomUUID()`, and the user message's ID is the turn ID.
  Delete `streamChatWithModel` and its tests, `loadOwnedSourceMarkdown` and `readCanonicalMarkdown`; then `grep -rn "streamChatWithModel\|loadOwnedSourceMarkdown\|free-document-chat" prototypes/studio --include=*.ts --include=*.tsx` prints nothing.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/shared prototypes/studio/api prototypes/studio/server prototypes/studio/src/ChatTab.tsx prototypes/studio/src/ChatTab.test.tsx
  git commit -m "feat(studio)!: admit chat questions as turns and serve their durable streams, transcripts and exact-turn reconnects"
  ```

### Task 9: The browser repeats an uncertain model POST and cancels only on a user's Stop

**Files:**
- Modify: `prototypes/studio/src/api.ts` (`repeatableModelPost`; `requestSchema`/`requestSchemaEdit` use it; `deleteModelOperation`), `prototypes/studio/src/api.test.ts`
- Modify: `prototypes/studio/src/currentSchemaRevision.ts` (`generate(request, { cancel })`; `cancelGeneration` calls it), `prototypes/studio/src/currentSchemaRevision.test.ts`, `prototypes/studio/src/App.tsx` (`handleGenerate` passes the cancel)
- Modify: `prototypes/studio/src/SchemaPanel.tsx` (`cancelChat`, 1013-1015), `prototypes/studio/src/SchemaPanel.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–5 (operation IDs, `DELETE /api/model-operations`).
- Produces:
  ```ts
  // src/api.ts
  export function repeatableModelPost(path: string, body: () => BodyInit, init?: { headers?: HeadersInit; signal?: AbortSignal }): Promise<Response>
  export function deleteModelOperation(workflowId: string): Promise<void>     // 204 and 404 resolve; anything else throws ApiRequestError
  // SchemaEditorController
  generate(request: (signal: AbortSignal) => Promise<unknown>, options?: { cancel?: () => Promise<void> }): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

  `src/api.test.ts` (fake timers; a `fetch` stub recording `METHOD path` and bodies):
  - `a model POST is repeated with the same body after a network failure or a proxy 502/503/504, keys first each time` (the stub throws a `TypeError`, then answers a 502 HTML page, then 200: three POSTs with identical form fields, including `operation_id`; each is preceded by `PUT /api/model-keys`).
  - `a confirmed failure is never repeated; an uncertain one at most three times` (409 `model_key_required` → one POST; 502 `{"error":{"code":"model_operation_failed",…}}` → one POST; 503 `persistence_unavailable` five times → four POSTs, then `requestSchema` rejects with that error; 504 `operation_pending` counts as uncertain).
  - `an abort ends the repetition` (abort during the 1 s delay: it rejects with the abort and sends nothing more).
  - `deleteModelOperation encodes the workflow ID` (`DELETE /api/model-operations/suggestion%3A<uuid>`; 204 and 404 resolve; 503 rejects).
  `src/currentSchemaRevision.test.ts`: `Stop cancels the running generation on the server; unmounting only detaches` (`generate(request, { cancel })`; `cancelGeneration()` calls `cancel` once and aborts the request's signal; a second generation followed by `dispose()` aborts its signal and never calls its `cancel`).
  `src/SchemaPanel.test.tsx`: `Stop on a running edit cancels edit:<operationId> on the server and says Cancelled.`; `unmounting during an edit cancels nothing on the server`.
  Run them. Expected: FAIL.

- [ ] **Step 2: Implement**

  `src/api.ts`:
  ```ts
  const REPEAT_DELAYS_MS = [1_000, 2_000, 4_000] as const
  /** Studio's own codes that still leave the outcome unknown; every other Studio error is a confirmed failure. */
  const UNCERTAIN_CODES: ReadonlySet<string> = new Set(['persistence_unavailable', 'operation_pending'])

  async function uncertain(response: Response): Promise<boolean> {
    if (response.status !== 502 && response.status !== 503 && response.status !== 504) return false
    const body: unknown = await response.clone().json().catch(() => null)
    const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined
    return typeof code !== 'string' || UNCERTAIN_CODES.has(code)
  }

  function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    })
  }

  /**
   * A POST that starts model work under a client-minted ID (spec, *Browser*). Studio replays the same ID, so after a
   * network failure, or a 502/503/504 that is not one of Studio's confirmed failures, the outcome is unknown and the same
   * request goes again — at most three more times, 1, 2 and 4 s apart. The keys go first each time: a Studio restart
   * that cut the connection also emptied its copy. An abort ends it; a confirmed failure comes back as it is, and a new
   * user action — "try again" included — mints a new ID instead.
   */
  export async function repeatableModelPost(path: string, body: () => BodyInit,
    init: { headers?: HeadersInit; signal?: AbortSignal } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      await ensureModelKeysSent()
      init.signal?.throwIfAborted()
      const last = attempt === REPEAT_DELAYS_MS.length
      try {
        const response = await authenticatedFetch(`${API_BASE}${path}`, { method: 'POST', headers: init.headers, body: body(), signal: init.signal })
        if (last || !(await uncertain(response))) return response
      } catch (error) {
        if (init.signal?.aborted || last) throw error
      }
      await pause(REPEAT_DELAYS_MS[attempt]!, init.signal)
    }
  }

  export async function deleteModelOperation(workflowId: string): Promise<void> {
    const response = await authenticatedFetch(`${API_BASE}/model-operations/${encodeURIComponent(workflowId)}`, { method: 'DELETE' })
    if (response.ok || response.status === 404) return
    throw new ApiRequestError((await readErrorDetail(response)) || `Could not stop ${workflowId} (HTTP ${response.status})`, response.status)
  }
  ```
  `requestSchema` and `requestSchemaEdit` post through a `postModelForm(endpoint, form, decode, signal)` that calls `repeatableModelPost(endpoint, () => form, { headers: { accept: 'application/json' }, signal })` and keeps `postForm`'s error handling; they no longer call `ensureModelKeysSent` themselves.
  `src/currentSchemaRevision.ts`: `generate(request, options = {})` stores `options.cancel` in `generationCancel` for the run (cleared when it settles) and
  ```ts
  cancelGeneration() {
    // A user's Stop: tell Studio, then stop waiting. dispose() only stops waiting — the workflow runs on and a reloaded
    // page finds it (spec, *A client abort only detaches*).
    const cancel = generationCancel
    generationCancel = null
    void cancel?.().catch(() => undefined)
    generationAbort?.abort()
    if (!generating) return
    generating = false
    publish()
  },
  ```
  `App.tsx`: `schema.generate(request, { cancel: () => deleteModelOperation(\`suggestion:${operationId}\`) })`. `SchemaPanel.tsx` `cancelChat`: `const operationId = editOperationRef.current; if (operationId) void deleteModelOperation(\`edit:${operationId}\`).catch(() => undefined); chatAbortRef.current?.abort()`. The unmount cleanup (`chatAbortRef.current?.abort()`, 538-541) stays an abort only.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/src/api.ts prototypes/studio/src/api.test.ts prototypes/studio/src/currentSchemaRevision.ts \
    prototypes/studio/src/currentSchemaRevision.test.ts prototypes/studio/src/App.tsx prototypes/studio/src/SchemaPanel.tsx prototypes/studio/src/SchemaPanel.test.tsx
  git commit -m "feat(studio): repeat an uncertain model request under its ID and cancel only when the researcher stops it"
  ```

### Task 10: The schema panel restores running operations, unsaved generations and unreviewed proposals

**Files:**
- Create: `prototypes/studio/src/modelOperationRecovery.ts` (+ `modelOperationRecovery.test.ts`), `prototypes/studio/src/useModelOperationRecovery.ts` (+ `useModelOperationRecovery.test.tsx`), `prototypes/studio/src/useSchemaProposalReview.test.tsx`
- Modify: `prototypes/studio/src/api.ts` (`listModelOperations`), `prototypes/studio/src/currentSchemaRevision.ts` (`adoptGenerated` extracted from `generate`, 417-466; `restoreGeneration`; `operationScope`; `durableSchemaPersistence` takes `projectContextId`), `prototypes/studio/src/currentSchemaRevision.test.ts`, `prototypes/studio/src/useCurrentSchemaRevision.ts` (passes `scope.projectContextId`), `prototypes/studio/src/useSchemaProposalReview.ts` (`start(…, workflowId)`; Discard deletes on the server), `prototypes/studio/src/SchemaPanel.tsx` (the hook; the running-operation line; `start` gets `edit:<operationId>`), `prototypes/studio/src/SchemaPanel.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`ModelOperation`, the listing and `DELETE`), Task 9 (`deleteModelOperation`), M4 Task 9's exported `requestModelKeyResend`, `deriveSchemaProposal` (`shared/schemaChanges.ts:129`).
- Produces:
  ```ts
  // src/api.ts
  export function listModelOperations(scope: { projectContextId: string; extractionSchemaId: string | null }, signal?: AbortSignal): Promise<ModelOperation[]>
  // SchemaEditorController gains
  operationScope(): { projectContextId: string; extractionSchemaId: string | null } | null     // null for local drafts
  restoreGeneration(template: unknown, baseSchemaRevisionId: string | null): Promise<boolean>
  // src/modelOperationRecovery.ts
  export type RecoveryView = Readonly<{ cleanCurrentRevisionId: string | null; noSchemaYet: boolean; busy: boolean }>
  export type RecoveryPlan = Readonly<{ running: readonly ModelOperation[]; saveGeneration: Extract<ModelOperation, { kind: 'generation' }> | null; reopenProposal: Extract<ModelOperation, { kind: 'proposal' }> | null; keyMissing: readonly string[] }>
  export function recoveryView(snapshot: SchemaEditorSnapshot, busy: boolean): RecoveryView
  export function planRecovery(operations: readonly ModelOperation[], view: RecoveryView): RecoveryPlan
  // src/useModelOperationRecovery.ts
  export function useModelOperationRecovery(options: { schema: SchemaEditorController; proposalReview: SchemaProposalReview; busy: boolean; appendMessage(message: string): void; onReopened?(proposal: DerivedProposal): void }): { running: readonly ModelOperation[]; stop(workflowId: string): void }
  // useSchemaProposalReview
  start(proposal: DerivedProposal, original: SchemaNode[], originalDraftVersion: number, originalSchemaRevisionId: string | null, workflowId: string | null): void
  ```

- [ ] **Step 1: Write the failing tests**

  `src/modelOperationRecovery.test.ts` (operations newest first, as the listing returns them):
  - `a running operation is shown and nothing else acts`.
  - `the newest finished generation whose base is the clean current revision is saved`.
  - `a generation whose base is older, or a draft that is dirty or was recovered from the session, is dropped` (A3: `cleanCurrentRevisionId` null or another revision → `saveGeneration: null`).
  - `a first generation is saved only while no Extraction Schema exists`.
  - `the newest finished proposal on the clean current revision is reopened, unless a review or a request is under way` (`busy: true` → null).
  - `of a generation and a proposal on the same base, only the newer acts`.
  - `a failed or refused proposal, and a finished operation on another base, acts on nothing`.
  - `model_key_required failures are named once for a key resend`.
  `src/currentSchemaRevision.test.ts`:
  - `restoreGeneration saves onto a clean base and drops on a conflict without an error` (clean draft on R1 → `true`, one append with expected head R1; append rejects `SchemaRevisionConflictError` → `false`, `generationError === null`, the draft is the conflict's current revision).
  - `restoreGeneration refuses a dirty draft, a moved base and a running generation`; `restoreGeneration initializes the first schema only while none exists`.
  - `a surviving tab keeps saving through its acknowledged head, including edits during generation` (A3: hold the generation request; edit a field; the edit saves as R2; resolve the generation; it appends R3 with expected head R2; no conflict).
  `src/useModelOperationRecovery.test.tsx` (jsdom; fake timers; a `fetch` stub serving the listing):
  - `polls every 2 s only while a watched operation runs, and stops on unmount` (one running at load: listings at 0, 2, 4 s; once it settles, no further request; unmount mid-poll: no request afterwards).
  - `a watched generation that finishes is saved onto its base; one whose base moved meanwhile is dropped`.
  - `a restored proposal reopens the review bar through proposalReview.start with its workflow ID`.
  - `a restored model_key_required failure resends the keys once` (`requestModelKeyResend` spied: one call per workflow ID across polls).
  - `operations this tab starts after load are left to the live path` (a new running operation in a later listing is neither shown nor acted on).
  - `local drafts list nothing` (`operationScope()` null: no request).
  `src/useSchemaProposalReview.test.tsx`: `Discard deletes the proposal's workflow on the server; Apply does not` (Discard → `DELETE /api/model-operations/edit%3A<id>`; a failed delete appends "The proposal could not be discarded on the server; it may return after a reload.").
  `src/SchemaPanel.test.tsx`: `a reloaded panel shows a running operation with its instruction, and Stop cancels it`; `a restored proposal reopens the review bar and replays onto the base revision's nodes`.
  Run them. Expected: FAIL.

- [ ] **Step 2: Implement the plan and the controller changes**

  `src/modelOperationRecovery.ts`:
  ```ts
  export function recoveryView(snapshot: SchemaEditorSnapshot, busy: boolean): RecoveryView {
    const save = snapshot.save
    // Clean: saved, and the visible draft is exactly the acknowledged revision.
    const clean = save?.status === 'saved' && snapshot.extractableSchemaRevisionId === save.acknowledged.schemaRevisionId
    return {
      cleanCurrentRevisionId: clean ? save.acknowledged.schemaRevisionId : null,
      noSchemaYet: snapshot.extractionSchemaId === null && snapshot.draft === null,
      busy: busy || snapshot.generating || snapshot.historicalPreview !== null,
    }
  }

  const live = (operation: ModelOperation) => operation.status === 'QUEUED' || operation.status === 'RUNNING'

  /**
   * What a page does with the operations it found on load (spec, *What the schema panel does on load*). Running ones are
   * shown and polled. Of the finished ones, only the newest whose base is still the current revision acts — a generation
   * is saved, a proposal reopened, never both, since saving moves the base — and only while nothing else is under way. A
   * generation without a base acts only while no Extraction Schema exists; a proposal only onto a clean draft. Everything
   * else is dropped, as a reload drops a conflicted save today.
   */
  export function planRecovery(operations: readonly ModelOperation[], view: RecoveryView): RecoveryPlan {
    const onBase = (operation: ModelOperation) =>
      operation.baseSchemaRevisionId === null ? view.noSchemaYet : operation.baseSchemaRevisionId === view.cleanCurrentRevisionId
    const actionable = (operation: ModelOperation) => operation.status === 'SUCCEEDED' && onBase(operation)
      && (operation.kind === 'generation' ? operation.template !== null : operation.response?.status === 'proposed')
    const newest = view.busy ? undefined : operations.find(actionable)
    return {
      running: operations.filter(live),
      saveGeneration: newest?.kind === 'generation' ? newest : null,
      reopenProposal: newest?.kind === 'proposal' ? newest : null,
      keyMissing: operations.filter((operation) => operation.failure?.code === 'model_key_required').map((operation) => operation.workflowId),
    }
  }
  ```
  `src/currentSchemaRevision.ts`: move `generate`'s save branch (431-455) into
  ```ts
  /** Joins a generated candidate to the revision chain — onto the acknowledged head when a schema exists (the save
   *  coordinator's expected head), else as the first revision. generate() and restoreGeneration() share it. */
  async function adoptGenerated(definition: SchemaDefinition, signal?: AbortSignal): Promise<boolean> {
    if ((persistence.extractionSchemaId?.() ?? null) !== null) {
      persistence.edit(definition)
      const revision = await flushPersistence()
      if (!revision) throw new Error('A durable Extraction Schema is required.')
      if (draft === null || !sameSchemaDefinition(draft, revision)) {
        draft = normalizeSchemaDefinition(revision)
        draftVersion += 1
      }
      extractableSchemaRevisionId = revision.schemaRevisionId
      replacementVersion += 1
      return true
    }
    if (!persistence.initialize) throw new Error('Schema generation is unavailable for this draft.')
    const revision = await persistence.initialize(definition, signal)
    if (signal?.aborted || disposed) return false
    replacementVersion += 1
    draft = definition
    draftVersion += 1
    extractableSchemaRevisionId = revision.schemaRevisionId
    return true
  }
  ```
  (`generate` keeps its behaviour: `if (!(await adoptGenerated(definition, abort.signal))) return` then the existing `generating = false; publish()`), and add
  ```ts
  operationScope() {
    const projectContextId = persistence.projectContextId?.() ?? null
    return projectContextId === null ? null : { projectContextId, extractionSchemaId: persistence.extractionSchemaId?.() ?? null }
  },
  /** Saves a generation that finished while no tab waited for it (a reload or a restart), but only onto its base: the
   *  base is still the acknowledged revision of a clean draft, or no Extraction Schema exists yet. Anything else — and a
   *  conflict, meaning newer work landed first — drops it without an error (spec, *Generation*). */
  async restoreGeneration(template, baseSchemaRevisionId) {
    if (disposed || generating) return false
    const save = persistence.saveState?.() ?? null
    const onBase = baseSchemaRevisionId === null
      ? (persistence.extractionSchemaId?.() ?? null) === null && draft === null
      : save?.status === 'saved' && save.acknowledged.schemaRevisionId === baseSchemaRevisionId
        && extractableSchemaRevisionId === baseSchemaRevisionId
    if (!onBase) return false
    let definition: SchemaDefinition
    try {
      definition = normalizeSchemaDefinition(templateToSchemaDefinition(template))
    } catch {
      return false
    }
    try {
      const saved = await adoptGenerated(definition)
      publish()
      return saved
    } catch {
      if (disposed) return false
      const current = persistence.reloadCurrent?.() ?? null
      if (current) {
        draft = normalizeSchemaDefinition(current)
        draftVersion += 1
        replacementVersion += 1
        extractableSchemaRevisionId = current.schemaRevisionId
      }
      publish()
      return false
    }
  },
  ```
  `SchemaEditorPersistence` gains optional `projectContextId?(): string`; `durableSchemaPersistence(options)` takes `projectContextId` and returns it; `useDurableCurrentSchemaRevision` passes `scope.projectContextId`.

- [ ] **Step 3: Implement the hook and wire the panel**

  `src/useModelOperationRecovery.ts`:
  ```ts
  const POLL_MS = 2_000

  export function useModelOperationRecovery({ schema, proposalReview, busy, appendMessage, onReopened }: RecoveryOptions) {
    const [running, setRunning] = useState<readonly ModelOperation[]>([])
    const latest = useRef({ proposalReview, busy, appendMessage, onReopened })
    useEffect(() => { latest.current = { proposalReview, busy, appendMessage, onReopened } })
    useEffect(() => {
      const scope = schema.operationScope()        // fixed at load: the operations this page found live in it
      if (!scope) return
      const abort = new AbortController()
      const watched = new Set<string>()             // running at load; this tab acts on them when they settle
      const resent = new Set<string>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let first = true
      const act = async () => {
        let listed: ModelOperation[]
        try {
          listed = await listModelOperations(scope, abort.signal)
        } catch {
          if (!abort.signal.aborted && watched.size > 0) timer = setTimeout(() => void act(), POLL_MS)
          return
        }
        if (abort.signal.aborted) return
        // On load every listed operation counts; afterwards only those that were running then. Operations this tab
        // starts later follow the live path (generate() and the save coordinator).
        const found = first ? listed : listed.filter((operation) => watched.has(operation.workflowId))
        if (first) for (const operation of listed) if (operation.status === 'QUEUED' || operation.status === 'RUNNING') watched.add(operation.workflowId)
        first = false
        const { proposalReview, busy, appendMessage, onReopened } = latest.current
        const plan = planRecovery(found, recoveryView(schema.snapshot(), busy))
        for (const workflowId of plan.keyMissing) {
          if (resent.has(workflowId)) continue
          resent.add(workflowId)
          requestModelKeyResend()                   // a 200 listing never reaches authenticatedFetch's 409 hook
        }
        if (plan.saveGeneration) {
          await schema.restoreGeneration(plan.saveGeneration.template, plan.saveGeneration.baseSchemaRevisionId)
        } else if (plan.reopenProposal?.response?.status === 'proposed') {
          const snapshot = schema.snapshot()
          const original = snapshot.draft?.schemaNodes ?? []
          const proposal = deriveSchemaProposal(original, plan.reopenProposal.response)
          if (proposal.changes.length > 0 || proposal.issues.length > 0) {
            // The draft is clean on the base, so its nodes are the base revision's; the draft-version guard still holds.
            proposalReview.start(proposal, original, snapshot.draftVersion, plan.reopenProposal.baseSchemaRevisionId, plan.reopenProposal.workflowId)
            onReopened?.(proposal)
            appendMessage(`Reopened the proposal for “${plan.reopenProposal.instruction}”.`)
          }
        }
        for (const operation of found) if (operation.status !== 'QUEUED' && operation.status !== 'RUNNING') watched.delete(operation.workflowId)
        setRunning(plan.running.filter((operation) => watched.has(operation.workflowId)))
        if (watched.size > 0) timer = setTimeout(() => void act(), POLL_MS)
      }
      void act()
      return () => {
        abort.abort()
        clearTimeout(timer)
      }
    }, [schema])
    const stop = useCallback((workflowId: string) => {
      void deleteModelOperation(workflowId).catch(() => undefined)   // the next poll sees it stopped and drops it
    }, [])
    return { running, stop }
  }
  ```
  `useSchemaProposalReview`: `PendingSchemaProposal` gains `workflowId: string | null`; `discard()` calls `deleteModelOperation(pending.workflowId)` when set (a rejection appends "The proposal could not be discarded on the server; it may return after a reload."); `apply()` does not delete (the base moves, so the proposal no longer restores).
  `SchemaPanel.tsx`: `const recovery = useModelOperationRecovery({ schema, proposalReview, busy: chatLoading || pending !== null, appendMessage: appendChatMessage, onReopened: (proposal) => setExpandedIds(…ancestors, as sendChatMessage does) })`; the live `proposalReview.start(…)` in `sendChatMessage` passes `` `edit:${operationId}` ``; above the chat log, each `recovery.running` item renders a line "Still working on an earlier request: “<instruction>”" with a **Stop** button calling `recovery.stop(workflowId)`.

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/src
  git commit -m "feat(studio): restore running operations, unsaved generations and unreviewed proposals when the schema panel loads"
  ```

### Task 11: The Chat tab: transcript, exact-turn reconnect, Stop, one key resend

**Files:**
- Modify: `prototypes/studio/src/ChatTab.tsx` (rewritten), `prototypes/studio/src/ChatTab.test.tsx`, `prototypes/studio/src/api.ts` (`readChatTranscript`), `prototypes/studio/src/RightRail.tsx` (a `chat` tab; comment 3-5 and 181-191 updated), `prototypes/studio/src/RightRail.test.tsx`, `prototypes/studio/src/App.tsx` (passes the chat scope to `RightRail`)

**Interfaces:**
- Consumes: Task 8 (routes and `chatTranscriptSchema`), Task 9 (`repeatableModelPost`, `deleteModelOperation`), M4 Task 9's `requestModelKeyResend`.
- Produces:
  ```ts
  // src/api.ts
  export function readChatTranscript(sourceRepresentationRevisionId: string, signal?: AbortSignal): Promise<ChatTranscriptDto>
  // src/RightRail.tsx
  export type RailTab = 'evidence' | 'schema' | 'chat' | 'results'
  // RightRailProps gains: chat?: { projectContextId: string; sourceRepresentationRevisionId: string }   (absent → no Chat tab)
  ```

- [ ] **Step 1: Write the failing tests** (`src/ChatTab.test.tsx`, jsdom; a `fetch` stub that serves the transcript and answers stream routes with UI-message SSE bodies built with `createUIMessageStreamResponse`)
  - `loads the transcript and shows answered, failed and unanswered turns under their turn IDs` (assistant bubbles carry `data-message-id={turnId}`; a failure shows its message; an unanswered turn shows "No answer: this question stopped before it was answered. Ask again.").
  - `reconnects to the transcript's live turn and shows its text once under the turn ID` (A4, A5: `reconnectTurnId` → `GET /api/chat/<rev>/stream?turnId=<id>`; the replayed partial and the rest appear once in one bubble with that ID).
  - `sends only the new question with a new turn ID and the revision as chat ID, keys first` (body exactly `{ projectContextId, sourceRepresentationRevisionId, turnId, question }`; `PUT /api/model-keys` precedes the POST).
  - `a dropped stream reconnects to the same turn, then re-reads the transcript` (A6: the POST's body errors mid-stream with a network `TypeError`: a `GET …/stream?turnId=<same id>` follows, then `GET /api/chat/<rev>`).
  - `a 204 or a finished stream re-reads the transcript, whose answer wins over the streamed text` (A6: the stream's text differs from the transcript's answer; after it ends the bubble shows the transcript's).
  - `another active turn restores the question, says why, and reconnects to the running turn` (409 `chat_turn_active`: the input holds the question again; the note "Another question about this document is still being answered."; the transcript's live turn is followed).
  - `Stop cancels chat:<turnId> on the server and re-reads the transcript` (`DELETE /api/model-operations/chat%3A<id>`).
  - `a model_key_required turn resends the keys once and asking again mints a new turn` (A13: after the re-read the newest turn failed with `model_key_required`: `requestModelKeyResend` called once, even across a second re-read; the next question uses a new turn ID).
  - `unmounting stops reading without cancelling the turn` (no `DELETE`).
  `src/RightRail.test.tsx`: `the Chat tab sits between Schema and Results and its panel stays mounted while hidden`; `no Chat tab without a chat scope`.
  Run them. Expected: FAIL.

- [ ] **Step 2: Implement**

  `ChatTab.tsx` keeps the component's name, props and markup style; its logic becomes:
  ```ts
  const UNANSWERED = 'No answer: this question stopped before it was answered. Ask again.'

  function transcriptMessages(transcript: ChatTranscriptDto): UIMessage[] {
    return transcript.turns.flatMap((turn): UIMessage[] => [
      { id: `${turn.turnId}:question`, role: 'user', parts: [{ type: 'text', text: turn.question }] },
      ...(turn.status === 'QUEUED' || turn.status === 'RUNNING' ? [] : [{
        id: turn.turnId,                             // the turn ID is the assistant message's stable ID (spec, *Chat ID*)
        role: 'assistant' as const,
        metadata: { outcome: turn.answer !== null ? 'answer' : turn.failure ? 'failure' : 'unanswered' },
        parts: [{ type: 'text' as const, text: turn.answer ?? turn.failure?.message ?? UNANSWERED }],
      }]),
    ])
  }

  function chatTransport(projectContextId: string, sourceRepresentationRevisionId: string) {
    return new DefaultChatTransport<UIMessage>({
      api: `${API_BASE}/chat`,
      // A question's POST repeats under its turn ID when its outcome is unknown, keys first; reconnects are plain GETs.
      fetch: (input, init) => init?.method === 'POST'
        ? repeatableModelPost('/chat', () => init.body as BodyInit, { headers: init.headers, signal: init.signal ?? undefined })
        : authenticatedFetch(input, init),
      prepareSendMessagesRequest: ({ messages }) => {
        const question = messages.at(-1)!
        // Only the new question: the history lives in ChatTurn rows (spec, *Request*).
        return { body: { projectContextId, sourceRepresentationRevisionId, turnId: question.id, question: messageText(question) } }
      },
      prepareReconnectToStreamRequest: ({ id, body }) => ({
        api: `${API_BASE}/chat/${id}/stream?turnId=${encodeURIComponent(String(body?.turnId))}`,
      }),
    })
  }
  ```
  The component (one `AbortController` per read, aborted on unmount; a `resentFor` ref holding turn IDs):
  - **load** (mount, and after every stream end, error or 204): `readChatTranscript` → `setMessages(transcriptMessages(t))`; if the newest turn failed with `model_key_required` and `resentFor` lacks it, add it and call `requestModelKeyResend()` (the error arrived inside a 200; Ruling 5); if `reconnectTurnId` is set and no read is running, **follow** `transport.reconnectToStream({ chatId: sourceRepresentationRevisionId, body: { turnId } })`.
  - **follow**(stream promise, turnId): a null stream (204) → load; otherwise read with `readUIMessageStream({ stream })`, replacing the message with the chunk-provided ID (the turn ID) as it grows; when the read throws and the signal was not aborted (a dropped connection, not an `error` chunk), reconnect with the same turn ID up to three times (1, 2, 4 s) before giving up; then load.
  - **send**: `const turnId = crypto.randomUUID()` (a new action, a new ID; "try again" is a new question); append the user message `{ id: turnId, … }`; `transport.sendMessages({ chatId: sourceRepresentationRevisionId, messages: [userMessage], trigger: 'submit-message', messageId: undefined, abortSignal, body: {} })` → follow. A rejection whose text parses as `{ error: { code: 'chat_turn_active' } }` restores the draft and shows the note, then loads (which follows the live turn); any other rejection loads (the transport throws on a 204 because the body is empty; the transcript is authoritative either way).
  - **Stop** (shown instead of the send button while a turn is followed): `deleteModelOperation(\`chat:${turnId}\`)`, then abort the read, then load.
  No `data-dbos-superseded` handling exists or is added: a new reader never sees superseded attempts, and a live reader's socket dies with the process it read from (spec, *Reload*).
  `RightRail.tsx`: `RailTab` gains `'chat'`; with a `chat` prop the tab list is Evidence (developer UI), Schema, Chat, Results, and a `rail-panel-chat` panel renders `<ChatTab {...chat} />`, hidden like the others; update the retirement comments to say the Chat tab returned with durable chat (M5). `App.tsx` passes `chat={{ projectContextId, sourceRepresentationRevisionId: sourceRepresentationId }}`.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/src
  git commit -m "feat(studio): bring back document chat with a transcript that survives a reload and reconnects to its turn"
  ```

### Task 12: Browser reload recovery end to end (default Playwright suite)

**Files:**
- Create: `prototypes/studio/e2e/interactive-reload.spec.ts`, `prototypes/studio/e2e/interactiveStack.ts`
- Modify: `prototypes/studio/e2e/tsconfig.json` (include `../test/support/scriptedModelServer.ts` when the spec's import needs it)

**Interfaces:**
- Consumes: Tasks 3–11; M4's e2e ingestion path (the kei stand-in in the Playwright worker, as `e2e/canonical-evidence-lifecycle.spec.ts` uses it at M4's end).
- Produces:
  ```ts
  // e2e/interactiveStack.ts
  export function prepareInteractiveDocument(page: Page, options: { hasKey: boolean; key?: string }): Promise<{
    projectContextId: string; sourceDocumentId: string; sourceRepresentationRevisionId: string
    model: Awaited<ReturnType<typeof startScriptedModelServer>>
    open(): Promise<void>            // navigates to the document workspace and waits for the schema panel
    schemaRevisions(): Promise<readonly { schemaRevisionId: string; revisionNumber: number }[]>
    close(): Promise<void>
  }>
  ```

- [ ] **Step 1: The helper**

  `prepareInteractiveDocument` logs in (`loginResearcher`), creates a project, ingests one small PDF through the public upload route with the kei stand-in exactly as `canonical-evidence-lifecycle.spec.ts` does at M4's end (move that seeding into this helper if it is inline there), starts a scripted model server, and applies a researcher Model Configuration whose Interaction and Schema Suggestion routes name one `openai-compatible` connection at `model.baseUrl` (the `PUT /api/model_config` body as `e2e/model-configuration.spec.ts` builds it); with `hasKey`, it also stores `key` in this browser for that connection (`localStorage` `free.modelKeys.v1:<account>` in the shape `src/modelKeys/modelKeyStore.ts` writes). Every spec that uses it runs in serial mode.

- [ ] **Step 2: The specs** (`interactive-reload.spec.ts`)

  - `a reload mid-suggestSchema finds the running generation and saves it onto its base` (A2, A3: `model.reply({ text: <a template JSON>, hold: true })`; Generate; `model.waitForCall(1)`; reload; the panel shows "Still working on an earlier request" with the instruction; `model.release()`; the generated fields appear; `schemaRevisions()` grew by one; one model call).
  - `a reloaded page drops a finished generation when newer work exists` (A3: hold a regeneration; reload; in a second page of the same account, rename a field so a newer revision lands; release; the first page never saves the generation — its revisions are the original and the second page's — and shows no error).
  - `a surviving tab keeps saving through its acknowledged head, including edits during generation` (A3: hold a regeneration; edit a field description in the same tab; the edit saves; release; the generation saves on top of it; no conflict banner).
  - `a reload mid-proposeSchemaEdit reopens the review bar; Discard persists across another reload` (A2, A3: hold an edit; reload; "Still working on…"; release; the review bar returns with the proposal on the base revision's fields; Discard; reload; no review bar).
  - `a reload mid-chatTurn returns the transcript and replays the partial answer once under the turn ID` (A2, A4: open the Chat tab; `reply({ text: 'partial answer', hold: true })` streams its first chunk; ask; the bubble shows `partial answer` once; reload; open Chat; the question is there and the partial text appears exactly once; release; the whole answer appears once; reload again: the answer is in the transcript).
  - `a dropped chat stream reconnects to the same turn, and a repeated POST returns the same turn` (A6, *Verification* chat reconnect and re-POST: `page.route('**/api/chat', …)` lets the first POST reach Studio with `route.fetch()`, then aborts it towards the page; the page repeats the POST with the same body; then `page.route('**/api/chat/*/stream*', …)` aborts one reconnect; the answer appears once; one question in the transcript; one model call).

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio exec playwright test e2e/interactive-reload.spec.ts
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/e2e/interactive-reload.spec.ts prototypes/studio/e2e/interactiveStack.ts prototypes/studio/e2e/tsconfig.json \
    prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts
  git commit -m "test(studio): prove generation, edit proposals and chat come back after a page reload"
  ```

### Task 13: A Studio restart with the page open, and a planted key in no dump, volume or log

**Files:**
- Create: `prototypes/studio/playwright.recovery.config.ts`, `prototypes/studio/e2e/interactive-restart.spec.ts`, `prototypes/studio/e2e/studioRestart.ts`
- Modify: `prototypes/studio/e2e/playwrightStack.ts` (`runPlaywrightWebServer`, 905-952: respawn Vite after a SIGKILL when `FREE_PLAYWRIGHT_RESTARTABLE=1`; `spawnVite`, 747-770: tee output to `FREE_PLAYWRIGHT_STUDIO_LOG`; export `readPlaywrightLifecycleStateForTest()`), `prototypes/studio/server/playwrightStack.test.ts`, `prototypes/studio/playwright.config.ts` (`testIgnore` adds `interactive-restart.spec.ts`), `prototypes/studio/package.json` (`test:e2e` runs both configs; `test:e2e:recovery`), `.gitignore` (add `artifacts/recovery-tests/` beside the service-test artifacts if those are listed)

**Interfaces:**
- Consumes: Task 12's `prepareInteractiveDocument`, Tasks 3–11.
- Produces: `killStudio(): Promise<void>` (SIGKILLs the Vite process group, waits for the wrapper's respawn and for Studio to answer); `readPlaywrightLifecycleStateForTest(): Promise<{ vitePid?: number; wrapperPid: number }>`.

- [ ] **Step 1: The restartable stack**

  `playwrightStack.ts`: when `process.env.FREE_PLAYWRIGHT_RESTARTABLE === '1'` and Vite exits with signal `SIGKILL`, `runPlaywrightWebServer` spawns it again on the same port, rewrites the lifecycle state with the new `vitePid`, and keeps waiting (any other exit still fails the web server; a teardown request still cleans up the current Vite). When `FREE_PLAYWRIGHT_STUDIO_LOG` is set, `spawnVite` uses `stdio: ['ignore', 'pipe', 'pipe']` and writes both streams to the process's own stdout/stderr and appends them to that file. `server/playwrightStack.test.ts`: `a restartable web server respawns Vite after a SIGKILL and records its new PID`; `any other Vite exit still fails the web server`; `Vite's output is appended to the Studio log when one is named`.
  `playwright.recovery.config.ts`: `configurePlaywrightStack({ applicationPort: 41_771, composeProject: 'free-studio-recovery-e2e', databaseName: 'free_test_studio_recovery', oidcPort: 41_772, postgresPort: 45_436 })`; `testMatch: 'interactive-restart.spec.ts'`, `workers: 1`, `timeout: 300_000`, `outputDir` and state under `artifacts/recovery-tests/`; `webServer.env` as `playwright.config.ts` sets it at M4's end (the kei stand-in settings included) plus `XDG_DATA_HOME` and `FREE_SOURCE_INBOX` under the state directory, `FREE_PLAYWRIGHT_RESTARTABLE: '1'` and `FREE_PLAYWRIGHT_STUDIO_LOG`. `package.json`: `"test:e2e": "playwright test && playwright test --config playwright.recovery.config.ts"`, `"test:e2e:recovery": "playwright test --config playwright.recovery.config.ts"` (CI's `pnpm test:e2e` then runs both with no other change).
  `e2e/studioRestart.ts`: `killStudio()` reads the lifecycle state, `process.kill(-vitePid, 'SIGKILL')` (Vite runs detached, in its own process group), waits up to 30 s for a new `vitePid` and up to 60 s for `GET /auth/signed-out` to answer 200.

- [ ] **Step 2: The specs** (`interactive-restart.spec.ts`, serial)

  - `a Studio restart with the page open resends the keys, and the recovered generation continues` (A13, A2: `prepareInteractiveDocument(page, { hasKey: true, key })`; hold a generation; `killStudio()`; the page's repeated POST is preceded by `PUT /api/model-keys` (seen through `page.on('request')`); the recovered call reaches the model with `authorization: Bearer <key>`; release; the fields save).
  - `a Studio restart between two polls: the reloaded page sees the new boot ID, resends the keys, and the recovered proposal continues` (A13 "between two polls": hold an edit; reload — the panel now polls; `killStudio()`; the next poll's response carries a new `X-FREE-Studio-Boot`; a `PUT /api/model-keys` follows; the recovered call carries the key; release; the review bar returns).
  - `a Studio restart mid-chatTurn: the Chat tab reconnects and the recovered answer appears once` (A2 kill: hold a chat turn after its first chunk; `killStudio()`; the tab reconnects by its turn ID after the transcript read; release; the answer appears once).
  - `a planted key reaches no pg_dump, data volume or Studio log after chat, generation, a batch suggestion and a probe` (A12: `key = plantedKey()` typed into the Model Configuration page for an `openai-compatible` connection at the scripted server; the server answers the first call of each kind with `{ status: 500, body: '{"error":"{{authorization}}"}', headers: { 'x-echo': key } }` and later ones with `headers: { 'x-echo': key }`; run a probe (the page's own probe), a generation (fails, then succeeds as a new operation), a Batch Schema Suggestion over the uploaded document (fails, then retried with the next expected attempt) and a chat turn (fails, then a new turn succeeds); then `docker compose -p "$FREE_PLAYWRIGHT_COMPOSE_PROJECT" -f e2e/playwright.compose.yaml exec -T postgres pg_dump -U free_e2e "$FREE_PLAYWRIGHT_DATABASE_NAME"` (run with `execFile`, output kept in memory, never printed) does not contain the key; no file under the state directory (Studio's data and the source inbox) contains it; the Studio log does not contain it. The browser's own `localStorage` holds it by design and is not scanned).

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio exec vitest run server/playwrightStack.test.ts
  pnpm --filter studio test:e2e:recovery
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/playwright.recovery.config.ts prototypes/studio/playwright.config.ts prototypes/studio/package.json \
    prototypes/studio/e2e/interactive-restart.spec.ts prototypes/studio/e2e/studioRestart.ts prototypes/studio/e2e/playwrightStack.ts \
    prototypes/studio/server/playwrightStack.test.ts .gitignore
  git commit -m "test(studio): restart Studio under an open page and prove a planted key reaches no dump, volume or log"
  ```

### Task 14: Verification and bookkeeping

**Files:**
- Create: `docs/validation/<YYYY-MM-DD>-dbos-m5-verification.md`
- Modify: `docs/plans/2026-09-24-unified-durable-execution.md` (the M5 heading), this plan's `Status:` line

- [ ] **Step 1: Residue search**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -rnE "free-document-chat|streamChatWithModel|data-dbos-superseded|loadOwnedSourceMarkdown|loadOwnedSchemaModelContext|chatId: 'free" \
    prototypes packages --include=*.ts --include=*.tsx --exclude-dir=node_modules
  grep -rnE "\b(streamText|streamObject)\(" prototypes/studio/api prototypes/studio/server --include=*.ts | grep -v "\.test\.ts"
  ```
  Expected: the first prints nothing; every line of the second is a call that passes `modelStreamOnError` (the Task 1 test already enforces it).

- [ ] **Step 2: Run every tier**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety
  # fresh disposable databases (Global Constraints), DATABASE_URL = EXTRACTION_TEST_DATABASE_URL, plus PARSING_TEST_DATABASE_URL:
  pnpm test:postgres
  pnpm test:e2e && pnpm --filter studio test:e2e:base-path
  pnpm test:service
  pnpm --filter studio build
  ```
  Then the production-bundle smoke of M4 Task 14, extended: with the bundle running on a disposable `free_test_m5_bundle` database, enqueue `chatTurn` on `studio` for a random turn ID through a `DBOSClient` (`applicationName: 'studio'`); it reaches `SUCCESS` (its `loadTurn` finds no row), which proves `@dbos-inc/vercel-ai` loads from outside the bundle. Record commands and output. A tier this host cannot run is recorded with its reason, never as passed.

- [ ] **Step 3: The live checks (Ruling 6)**

  On a host with a real model (the Spark's deployment vLLM, or a hosted provider with the researcher's own key) and `pnpm dev`:
  1. Ask a chat question; reload mid-answer; the answer finishes once under the same turn. Ask another; kill Studio mid-answer (Compose `restart` of `studio`, or SIGKILL of the development server); the page resends its keys and the answer finishes once.
  2. With `FREE_DEPLOYMENT_CLI_PROVIDERS=claude-code` (or `codex-cli`) and the operator's CLI login, route the Assistant model to that deployment connection and complete one chat turn end to end, then one Schema Suggestion.
  3. Inspect `dbos.workflow_status` and `dbos.operation_outputs` for one chat turn and one generation: no document text, no key, no provider metadata.
  Record what ran, where and the result. If no live model or CLI login is available here, say so in the record and leave these for the cutover smoke test (spec *Cutover*, step 6).

- [ ] **Step 4: Record**

  Write the verification record (tested commit, commands, results, skips, the `chat checkpoint bytes` Task 7 printed, the live-check outcomes, and a pointer to the traceability table below). In the DBOS plan, replace `**M5: interactive work on DBOS.**` with `**M5: interactive work on DBOS — done YYYY-MM-DD.** Task plan: [2026-09-26-dbos-m5-interactive.md](2026-09-26-dbos-m5-interactive.md).` Set this plan's status to `done YYYY-MM-DD`.
  ```bash
  git add docs/validation/<file> docs/plans/2026-09-24-unified-durable-execution.md docs/plans/2026-09-26-dbos-m5-interactive.md
  git commit -m "docs(plans): record DBOS M5 completion"
  ```

---

## Traceability: M5 acceptance → tests

Test files are under `prototypes/studio/` unless they start with `packages/`.

| Spec M5 acceptance (sub-bullet) | Test (file › name) | Task |
|---|---|---|
| A1 Kill after the chat answer write but before its checkpoint: the answer is written once | `api/chat_turn_workflow.postgres.test.ts` › `an answer written before a kill is written once`; `packages/db/src/chat-turn.postgres.check.ts` › `a replayed answer write finds the turn settled and writes nothing` | 6, 7 |
| A2 Reload the page mid-`suggestSchema`, mid-`proposeSchemaEdit`, mid-`chatTurn`: the page finds each operation | `e2e/interactive-reload.spec.ts` › `a reload mid-suggestSchema finds the running generation …`, `a reload mid-proposeSchemaEdit reopens the review bar …`, `a reload mid-chatTurn returns the transcript …` | 12 |
| A2 … and separately kill Studio at the same points | `e2e/interactive-restart.spec.ts` › `a Studio restart with the page open … generation continues`, `… between two polls … recovered proposal continues`, `a Studio restart mid-chatTurn …`; `api/schema_generation.postgres.test.ts` › `a Studio killed mid-generation recovers it …`; `api/schema_edit.postgres.test.ts` › `a Studio killed mid-proposal recovers it …`; `api/chat_turn_workflow.postgres.test.ts` › `a Studio killed mid-stream recovers the turn …` | 3, 4, 7, 13 |
| A3 A reloaded page saves a finished generation only onto its base, dropping it when newer work exists | `src/modelOperationRecovery.test.ts` › `the newest finished generation whose base is the clean current revision is saved`, `a generation whose base is older, or a draft that is dirty …, is dropped`, `a first generation is saved only while no Extraction Schema exists`; `src/currentSchemaRevision.test.ts` › `restoreGeneration saves onto a clean base and drops on a conflict without an error`; `e2e/interactive-reload.spec.ts` › `a reloaded page drops a finished generation when newer work exists` | 10, 12 |
| A3 A surviving tab keeps today's acknowledged-head save behavior, including edits during generation | `src/currentSchemaRevision.test.ts` › `a surviving tab keeps saving through its acknowledged head, including edits during generation`; `e2e/interactive-reload.spec.ts` › same name | 10, 12 |
| A3 The review bar returns | `src/useModelOperationRecovery.test.tsx` › `a restored proposal reopens the review bar …`; `src/SchemaPanel.test.tsx` › `a restored proposal reopens the review bar and replays onto the base revision's nodes`; `e2e/interactive-reload.spec.ts` › `a reload mid-proposeSchemaEdit reopens the review bar; Discard persists …` | 10, 12 |
| A4 The transcript returns and partial text replays once under the turn ID | `api/chat_turn_workflow.postgres.test.ts` › `a reader that reconnects mid-stream sees the text so far once …`; `src/ChatTab.test.tsx` › `reconnects to the transcript's live turn and shows its text once under the turn ID`; `e2e/interactive-reload.spec.ts` › `a reload mid-chatTurn returns the transcript and replays the partial answer once …` | 7, 11, 12 |
| A4 New readers skip superseded attempts | `api/chat_turn_workflow.postgres.test.ts` › `a Studio killed mid-stream recovers the turn: … a new reader sees only the recovered attempt's text …` | 7 |
| A4 A partial provider failure produces an error finish and persisted failure, never a saved partial answer or an in-process retry that appends replacement text | `api/chat_turn_workflow.postgres.test.ts` › `a partial provider failure ends the stream with an error finish, records the failure and saves no answer; the provider was called once`; `api/_chat_turn_workflow.test.ts` › `a partial failure saves no answer`, `the chat's streamText sets maxRetries 0, no streamRetries, and an onError that returns nothing` | 7 |
| A5 An answer that finishes between the transcript read and the reconnect still appears, with the turn ID as its message ID | `api/chat_routes.postgres.test.ts` › `an answer that finishes between the transcript read and the reconnect still streams in full under the turn ID`; `src/ChatTab.test.tsx` › `reconnects to the transcript's live turn …` | 8, 11 |
| A6 A repeated POST after a dropped connection returns the same result | `api/chat_routes.postgres.test.ts` › `a repeated POST after a dropped connection returns the same turn's stream …`; `api/schema_generation.postgres.test.ts` › `… a repeated POST returns the same result without a second model call`; `api/schema_edit.postgres.test.ts` › `… a repeated POST returns the same proposal …`; `src/api.test.ts` › `a model POST is repeated with the same body …`; `e2e/interactive-reload.spec.ts` › `a dropped chat stream reconnects to the same turn, and a repeated POST returns the same turn` | 3, 4, 8, 9, 12 |
| A6 Exact-turn reconnect works across completion and returns 204 for expired history, followed by the authoritative transcript | `api/chat_routes.postgres.test.ts` › `exact-turn reconnect works across completion and answers 204 once the turn's history is deleted …`; `src/ChatTab.test.tsx` › `a 204 or a finished stream re-reads the transcript …`, `a dropped stream reconnects to the same turn, then re-reads the transcript` | 8, 11 |
| A7 Change the route between attempts | `api/chat_turn_workflow.postgres.test.ts` › `a route changed between attempts: an interrupted call reruns on the new route`, `… a checkpointed call replays without a model call and without waiting for a key` | 7 |
| A8 One HTTP and one CLI provider complete a chat turn end to end | `api/chat_turn_workflow.postgres.test.ts` › `a chat turn over the scripted HTTP provider …`, `a chat turn on a CLI deployment connection completes end to end through the stand-in`; live: Task 14 Step 3 (real CLI and real HTTP model, recorded) | 7, 14 |
| A9 A second account can list, read, stream or cancel none of the first's operations or turns; ownership holds on every reconnect, including after the project is deleted | `api/model_operations.postgres.test.ts` › `a second account can neither list nor cancel nor discard …`, `after the project is deleted, listing and DELETE are 404`; `api/chat_routes.postgres.test.ts` › `a second account can neither read, stream nor cancel the first account's turns; after the project is deleted every reconnect is 404`; `packages/db/src/chat-turn.postgres.check.ts` › `a second account reads, reconnects to and cancels none …`; `server/researcher-project-ownership.test.ts` (model-operation and chat cases) | 5, 6, 8 |
| A10 A synthetic key planted in a provider error's cause chain in a JSON step | `api/schema_generation.postgres.test.ts` › `a key planted in a provider error in a JSON step reaches no DBOS or public table and no log` | 3 |
| A10 … and inside `durableCalls`; in a successful response's headers and provider metadata; no input, output, error or stream record holds it | `api/_chat_sanitizer.test.ts` › `every failure path yields a ChatModelFailure …`, `a successful stream keeps its text and drops provider metadata, raw chunks, request and response`; `api/chat_turn_workflow.postgres.test.ts` › `a key planted in the error cause chain, response headers and provider metadata of a chat call reaches no table, stream record or log` | 2, 7 |
| A11 A chat turn's checkpoint holds the history and the answer, not the document | `api/chat_turn_workflow.postgres.test.ts` › `a chat turn's checkpoints hold the history and the answer, not the document` (size recorded in Task 14) | 7, 14 |
| A12 Plant a key and run chat, generation, a batch suggestion and a probe: no `pg_dump`, volume or log holds it | `e2e/interactive-restart.spec.ts` › `a planted key reaches no pg_dump, data volume or Studio log after chat, generation, a batch suggestion and a probe` | 13 |
| A13 Restart Studio mid-call with the page open, including between two polls; the new boot ID triggers the resend and the recovered call continues | `e2e/interactive-restart.spec.ts` › `a Studio restart with the page open resends the keys …`, `a Studio restart between two polls …`, `a Studio restart mid-chatTurn …`; `src/api.test.ts` › `… keys first each time` | 9, 13 |
| A13 With no page open, the call fails with `model_key_required` after the wait, and neither retry owner retries it | `api/schema_generation.postgres.test.ts` › `with no page to resend it, a recovered generation fails with model_key_required …`; `api/chat_turn_workflow.postgres.test.ts` › `with no page to resend it, a recovered chat call fails with model_key_required after the wait and neither retry owner retries it` | 3, 7 |
| A13 Resending keys then retrying starts a new operation/turn ID or batch attempt | `src/ChatTab.test.tsx` › `a model_key_required turn resends the keys once and asking again mints a new turn`; `src/useModelOperationRecovery.test.tsx` › `a restored model_key_required failure resends the keys once`; `src/SchemaPanel.test.tsx` › `each edit request carries a new operation ID`; `src/api.test.ts` › `a confirmed failure is never repeated …`; M4 Task 9 `BatchExtractionsPanel.test.tsx` › `a model_key_required failure resends this browser's keys once, and Try again posts the next expected attempt` | 4, 9, 10, 11 (M4 9) |
| A14 A replayed step whose call is checkpointed never waits for a key | `api/schema_generation.postgres.test.ts` › `a replayed step whose call is checkpointed never waits for a key`; `api/chat_turn_workflow.postgres.test.ts` › `a route changed between attempts: a checkpointed call replays … without waiting for a key` | 3, 7 |
| A14 A cancel during the wait never reaches the provider | `api/schema_generation.postgres.test.ts` › `a cancel during the key wait never reaches the provider`; `api/chat_turn_workflow.postgres.test.ts` › same name; `api/_model_keys.test.ts` › `requireModelKey ends the wait when the step's cancel signal fires …`; `api/_provider.test.ts` › `a keyed model's key wait ends on the step's cancel signal and never calls the provider` | 1, 3, 7 |
| A14 A cancel during a provider call stops it about 1 s later | `api/schema_generation.postgres.test.ts` › `a cancel during a provider call stops it about 1 s later`; `api/chat_turn_workflow.postgres.test.ts` › same name; `api/_provider.test.ts` › `every general model's provider call receives the step's cancel signal, keyed or keyless` | 1, 3, 7 |
| A15 Schema Suggestion over the NuExtract protocol on a keyed vLLM connection passes the same key-wait, cancellation and no-key-in-history checks | `api/schema_generation.postgres.test.ts` › `NuExtract on a keyed vLLM connection waits for its key, stops on cancel, and leaves no key in history`; `api/_model.transport.test.ts` › `NuExtract's key wait and fetch receive the step's cancel signal` | 1, 3 |

Spec *Verification* items M5 owns: atomic admission, concurrent replay, active-chat exclusion and rollback (`chat-turn.postgres.check.ts`, 6); one answer per chat turn when an answer races a cancel (`chat-turn.postgres.check.ts` › `one answer per turn when an answer races a cancel`, 6); no key in any table (3, 7, 13); a page reload mid-chat, mid-generation and mid-edit (12); a Studio restart with the page open, keys resent, the call continuing (13); chat reconnect and re-POST recovery (12); the residue item `free-document-chat` (14).

Other M5 items and where they are built: `suggestSchema`, `proposeSchemaEdit` and `chatTurn` with its answer write (3, 4, 7); `@dbos-inc/vercel-ai` for chat only, with the sanitizer inside `durableCalls` (1, 2, 7); operation and turn IDs with 409 on conflicting reuse (3, 4, 6, 8); atomic question/enqueue with per-revision dedup, 409 for another active turn and same-turn primary-key replay (6, 8); owner checks and conditional answer/failure writes (5, 6, 8); a typed chat failure followed by a sanitized throw (2, 7); `GET`/`DELETE /api/model-operations`, `GET /api/chat/<revision ID>` and `/stream?turnId=` (5, 8); `src/api.ts` repeats the same POST after a network failure or 502/503/504 (9); a new user action mints a new ID (3, 4, 9, 11; ingestion retry without a client key is M4 Task 10); `generate_schema` carries the operation ID and base; the schema panel restores a running operation, saves a finished generation on its base and reopens an unreviewed proposal (3, 10); `ChatTab.tsx` loads the transcript, sends only the new question, uses the revision ID as chat ID, reconnects to the returned turn ID on load and after a dropped stream, re-reads after 204/end, with no custom superseded handler (8, 11); aborts from a user action call the cancel route (9, 10, 11); a new boot ID resends keys before recovery continues (M2's `authenticatedFetch`, 9, 13); `model_key_required` resend then a new ID, never a re-POST of the failed ID (9, 10, 11); the key wrapper composes `cancelSignal` (1); every stream call has an explicit `onError` (1); the `ChatTurn` baseline edit (6).

## Deferred to M6 and later

| Item | Goes to | Why |
|---|---|---|
| History retention for settled interactive work (24 h) and the rest of `collectGarbage` | M6 | spec *Milestones → M6*; M5 only relies on history existing, and answers 204 when it does not |
| README #5/#7, CONTEXT.md (chat transcripts in FREE's tables; interactive work stores no Model Attribution), ADR 0012, the OpenSpec spec for schema chat edit, `docs/architecture/current.c4` (the Chat tab and the model-operation routes) | M6 | spec *Milestones → M6 → Other docs* |
| The full *Verification* residue search and the pool measurement across Studio's pools | M6 verification | Task 14 searches only M5's own residue |
| M0R 6's pending "Studio chat and schema generation during a kei extraction on `extraction_model`" | Spark, separate | needs the Spark's model servers; not an M5 acceptance bullet |
| A bound on how many earlier turns a chat sends as history | not planned | the spec sends every earlier answered turn; revisit only if transcripts grow large (the checkpoint measurement in Task 7 is the signal) |
| Persisting the schema panel's message log; more than one thread per revision; carrying a transcript to a reprocessed revision | out of scope | spec *Out of scope* |
