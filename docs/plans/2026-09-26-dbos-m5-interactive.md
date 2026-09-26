# DBOS M5: Interactive Work on DBOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **in progress (inline, 2026-09-26): executed by the controller session on `feat/dbos-m5` (from `feat/dbos-m2-m6` at e1c8ae6) while M4 finishes on `feat/dbos-m2-m6`; see *Execution addendum*. Plan written 2026-09-26 against `feat/dbos-m2-m6` at bf80322; revised 2026-09-26 after the user deleted the document chat (Ruling 1), which removed the chat workflow, table, routes and tab from this plan and added Task 1.**

**Goal:** Deliver milestone M5 of the DBOS plan on `feat/dbos-m2-m6`: Schema Suggestion (`suggestSchema`) and schema edit proposals (`proposeSchemaEdit`) run as named DBOS workflows that survive a browser reload and a Studio restart; `GET`/`DELETE /api/model-operations` let a reloaded page find, cancel or discard its work; the unreachable document chat (`/api/chat`, `ChatTab`) is deleted rather than made durable (user, 2026-09-26); no key, provider error body, provider metadata or document text enters DBOS history; every tier ends green.

**Architecture:** Task 1 deletes the document chat end to end, so no later task touches dead code. The schema tab's two chats are the interactive work M5 makes durable: the pre-generation instruction chat (`SchemaInstructionsChat`, local state that feeds `generate_schema` → `suggestSchema`) and "Describe a change to the schema…" (`requestSchemaEdit` → `edit_schema` → `proposeSchemaEdit`). Both are workflow-first: the handler owner-checks in PostgreSQL, enqueues `suggestion:<operationId>` / `edit:<operationId>` by name on the `studio` queue through the admission client, compares the recorded input on reuse (409 on conflict), then waits for the workflow's typed result and answers exactly as today, so a live tab keeps saving through `generate()` and the save coordinator. Each model step catches every error inside the step and returns FREE's typed failure (`operationFailureOf`), so DBOS never serializes a provider error. The model boundary composes `DBOS.stepStatus.cancelSignal` into every provider attempt, keyed or keyless, so a cancel ends a key wait or a provider call about 1 s later. The schema panel restores running operations (2 s poll), unsaved generations onto their base and unreviewed proposals onto a clean draft.

**Tech Stack:** Studio (TypeScript, React 19, Vite 8, Hono, Zod 4, Vitest 4, Playwright, AI SDK `ai` 7.0.93), `@dbos-inc/dbos-sdk` 5.1.10, `packages/db` (Prisma Next 0.16, `pg` 8.22.0, `tsx --test`), Docker Compose (Playwright stacks only). M5 adds no dependency.

**Spec:** [docs/plans/2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md). Read *Decisions* (4, 6, 8 and 15 — 15 records the chat deletion and limits 4 and 8 to generation and edit proposals), *Rules* (all: secrets, status derivation, workflow IDs, ownership), *Workflows → Admission* (Binding, Queues, Replays, No-row operations, Client IDs) and *Status and ownership*, *Interactive model work* (*Generation* and *Edit proposals*; its *Chat* sections are not built), *Cancellation → Studio model calls*, *Queues, deadlines and upgrades* (the `studio` row, *Other workflows start directly*, *Ownership*, *Versions*), *Model configuration and keys → Keys* (Handoff, Cache, Use), *Public contract changes* (model-operation bullets), *Milestones → M5* (Workflows, Handlers, Browser, Acceptance; the chat items are superseded, see the traceability table), *Verification* and *Risks* (one Studio process; research content in DBOS history). Evidence this plan builds on: [evidence README](2026-09-24-unified-durable-execution-evidence/README.md) — [stream-probe.mjs](2026-09-24-unified-durable-execution-evidence/stream-probe.mjs) (an outer sanitized return still leaves the secret in the recorded step error, so sanitizing happens inside the step), [version-probe.mjs](2026-09-24-unified-durable-execution-evidence/version-probe.mjs) (`cancelSignal` reaches a wrapper model inside a step and fires ≈1001 ms after `cancelWorkflow`, with no provider call after it) and [m0r/README.md](2026-09-24-unified-durable-execution-evidence/m0r/README.md) (items 2–3: explicit names, one launch, `minPollingIntervalMs: 100`, `return-existing` only outside caller transactions). The M4 plan ([2026-09-26-dbos-m4-studio-background.md](2026-09-26-dbos-m4-studio-background.md)) owns every piece of infrastructure named below as "(M4)".

## Rulings (controller, 2026-09-26)

1. **Ruling (user, 2026-09-26): the document chat is deleted, not made durable.** `/api/chat` (`api/chat.ts`, `streamChatWithModel` in `api/_model.ts`) and `src/ChatTab.tsx` have had no UI since 44ce50b (2026-08-13, "integrate chat into schema panel"): `src/RightRail.tsx:3-5,181-183` comments the Chat tab out and only `src/ChatTab.test.tsx` imports `ChatTab`. The schema tab's "chat" is two other things, and both stay: (a) the pre-generation instruction chat (`SchemaInstructionsChat`, `src/SchemaInstructions.tsx:28`, local state feeding `generate_schema` → `suggestSchema`) and (b) "Describe a change to the schema…" (`src/SchemaPanel.tsx:1753`) → `requestSchemaEdit` → `edit_schema` → `proposeSchemaEdit`. Task 1 deletes the chat before any other task. Consequently M5 builds no `chatTurn` workflow, no `ChatTurn` table (so no baseline edit, and no database needs recreating for M5), no chat routes, no Chat tab and no `@dbos-inc/vercel-ai`; spec decisions 4 and 8 apply to generation and edit proposals only (spec decision 15). — *Why:* a durable workflow, a table, four routes and a tab for a feature no researcher can reach cost more than they return; the reload- and restart-proof interactive work researchers use is generation and edit proposals. — *Cost if wrong:* document chat is rebuilt later from the spec's *Chat* sections, which stay in the spec, and the first version of this plan (a722fe1).
2. **Ruling: `@dbos-inc/vercel-ai` is not installed, and Task 1 removes M4's `ssr.external` entry for it** (`vite.server.config.ts:22`, pinned by `vite.server.config.test.ts:3-10`). Studio's `package.json` never declared it. This supersedes the first version's Ruling 1, which installed it for chat. — *Why:* chat was its only user. — *Cost if wrong:* one dependency and one list entry to add back.
3. **Ruling: `DBOS.stepStatus.cancelSignal` is composed inside the model boundary, never by the caller.** The key wait runs inside `keyedModel`'s provider attempt and reads that attempt's `params.abortSignal`; NuExtract reads its key and fetches on its own; deployment vLLM and CLI connections never pass through `keyedModel`. So `requireModelKey` (`api/_model_keys.ts`, whose comment already says the keyed wrapper must compose it) composes it into the key wait, a step-cancellation middleware composes it into every general model's provider call, keyed or not, and NuExtract's attempt composes it into its key read and `fetch` (Task 2). Every attempt the AI SDK makes, retries included, then carries it whatever the caller passes. M4's Ruling 9 put the composition in the key wrapper while its Task 8 code composes at the caller (`modelSignal(steps.cancelSignal())`); the caller-side composition stays and is now redundant. — *Why:* spec *Cancellation → Studio model calls*. — *Cost if wrong:* a cancelled generation or edit keeps its provider call (and its bill) running to the end, or a keyless connection never stops.
4. **Ruling: provider errors are sanitized inside the step boundary.** DBOS records a step's thrown error with every enumerable property and its cause (spec *Rules → Secrets never enter DBOS*; `ApiError.cause` is enumerable, and `asModelOperationError`, `api/_http.ts:139-144`, puts the provider error there). So each model step (`generateSchema`, `proposeSchemaEdit`) catches every error inside its closure and returns `{ ok: false, status, code, message }` built by `operationFailureOf` — an `ApiError`'s own status, code and message (FREE's copy; no `ApiError` in `_model.ts` or `_provider.ts` interpolates provider text), anything else 500 `unexpected_failure` — and never rethrows. A step's success output holds only the generated template or proposal: never the provider's response, headers or metadata. — *Why:* stream probe (a sanitized return outside the step leaves the secret in `operation_outputs`). — *Cost if wrong:* a key or a provider body sits in `dbos.operation_outputs` for 24 h and in every dump.
5. **Ruling: after Task 1 no `streamText` or `streamObject` call remains in Studio's server code, and a source-scan test (Task 2) fails when one appears without an explicit `onError`.** The only call today is `streamChatWithModel`'s (`api/_model.ts:116`); `generateText` (203, 211) throws instead of logging. No shared `onError` helper is built for a caller that does not exist. — *Why:* the SDK's default `onError` logs the whole error, including provider bodies and `Bearer <key>` runtime messages (M2 fix, `api/_model.ts:124-132`). — *Cost if wrong:* a later streaming call logs a key.
6. **Ruling: a restored operation that failed with `model_key_required` triggers exactly one key resend per operation.** A live generation or edit receives its 409 through `authenticatedFetch`'s hook (M2). The listing a reloaded page polls answers 200, which that hook never sees, so the schema panel calls `requestModelKeyResend()` (exported by M4 Task 9) once per workflow ID (Task 7); asking again mints a new operation ID. This replaces the first version's chat resend.
7. **Ruling: route change and provider coverage are tested without live providers.** HTTP: a scripted OpenAI-compatible server (`test/support/scriptedModelServer.ts`) behind the real `@ai-sdk/openai-compatible` provider, the real route resolver and the real key cache. Route change (spec *No pins*): the generation crash scenarios re-point the owner's Schema Suggestion Route to a second scripted server between the two runs (Task 3). Left to the live check (Task 10, recorded, never claimed as passed on a host that cannot run it): one Schema Suggestion and one edit proposal on a real hosted or Spark vLLM model through `pnpm dev` across a reload and a Studio restart, and one Schema Suggestion and one edit proposal on the operator's Codex or Claude Code login.
8. **Ruling: the generation rule is the spec's, verbatim.** A live tab saves exactly as today, through `generate()` (`src/currentSchemaRevision.ts:417`) and the save coordinator (acknowledged head, editing during a regeneration allowed). A reloaded page saves a finished generation only while its base is still the current revision (clean draft), or while there is still no Extraction Schema; otherwise it drops it. The schema panel restores running operations (2 s poll), unsaved generations and unreviewed proposals; Discard deletes that proposal and every older finished proposal on the same base.
9. **Ruling: key acceptance is tested by planting.** A synthetic key `FREE_SYNTHETIC_KEY_<hex>` is put in Studio's cache for a `hasKey` connection; the scripted server echoes it into an error body (its `{{authorization}}` token) and into the response headers of failed and successful calls, and `operationFailureOf`'s unit test plants it in an `APICallError`'s `requestBodyValues`, `responseHeaders`, `responseBody` and `cause`. Detection is a text scan of every row of every table in the test's DBOS schema and `public` (Studio PostgreSQL tier, Task 3) and — for the full-stack bullet — `pg_dump` of the Playwright database, a recursive scan of Studio's data directories and a scan of Studio's captured log (Task 9).
10. **Ruling: M5 ends with every tier green** — unit, typecheck, lint, safety, all PostgreSQL tiers, `pnpm test:e2e` (both Playwright configs, Task 9 adds the second), base-path e2e and `pnpm test:service` (unchanged by M5, rerun in Task 10).

## Code facts this plan relies on (verified at bf80322 and the M4 working tree; rechecked 2026-09-26 for the revision)

- **Model calls today** (`prototypes/studio/api/_model.ts`, line numbers before Task 1): `streamChatWithModel(caller, messages, documentMarkdown, temperature?, signal?, target?, dependencies?)` (101-144) holds the only `streamText` call (116); Task 1 deletes it with the imports only it uses (`convertToModelMessages`, `createUIMessageStreamResponse`, `toUIMessageStream`, `UIMessage` and `streamText` from `ai`; `ModelKeyRequiredError`, 22, used only by its `onError`s at 127 and 138). `generateSchemaWithModel(caller, { document, instruction, temperature, signal }, target?, dependencies?)` (146-194). `generateWithNuExtract` reads the key inside the attempt (`target.key(input.signal)`, 289-298) and fetches with `signal: input.signal` (316). `generateSchemaEditJson(caller, prompt, temperature?, signal?, target?, dependencies?)` (370-398). `operationTarget` resolves the caller's account (87-99). `asModelOperationError(error, message?)` (`api/_http.ts:139-144`) wraps a non-`ApiError` as 502 `model_operation_failed` with the provider error as `cause`.
- **Keys** (`api/_model_keys.ts`): `MODEL_KEY_WAIT_MS = 60_000`; `ModelKeyRequiredError` (409 `model_key_required`, `isRetryable = false`); `ModelKeyCache.wait(accountId, connection, signal, waitMs)`; `requireModelKey(cache, accountId, connection, signal, waitMs)` (133-144, comment 127-132 says the keyed wrapper must compose `cancelSignal`); `studioProcess = { bootId, keys }` (150-153).
- **Provider seam** (`api/_provider.ts`): private `providerModel` (558); `keyedModel(createModel, connection, modelId, key)` (570-591) reads the key from `params.abortSignal` per attempt; `ModelOperation = 'schema-suggestion' | 'chat' | 'schema-edit'` (654), where every operation but `schema-suggestion` resolves the Interaction Route (705); `resolveCapabilityRoute(operation, { temperature }, dependencies)` (698-760): `key = (signal) => requireModelKey(keys, researcherAccountId, connection, signal, keyWaitMs)` (729-730), NuExtract target with `key` (737-740), `model = connection.hasKey ? keyedModel(…) : createModel(…)` (751); `RouteResolverDependencies` has `keys`, `keyWaitMs`, `modelFactories`, `deployment`, `readConfig`. Keyless connections (deployment vLLM, CLI, keyless Ollama/OpenAI-compatible) never pass through `keyedModel`.
- **Handlers today:** `api/generate_schema.ts` (form `project_context_id`, `source_representation_revision_id`, `instruction`, `temperature`; `createPostGenerateSchema(store, reader, generate)` at 36; reads Markdown through `loadOwnedSourceMarkdown`, 19 and 52); `api/edit_schema.ts` (form adds `extraction_schema_id`, `schema_revision_id`; `createPostEditSchema(store, reader, propose)` at 37; reads through `loadOwnedSchemaModelContext`, 16 and 67); `api/chat.ts` (JSON `{ projectContextId, sourceRepresentationRevisionId, messages, temperature? }`, `createPostChat(store, reader, stream)` at 41; Task 1 deletes it). Owner loaders `readCanonicalMarkdown` (87), `loadOwnedSourceMarkdown` (101), `loadOwnedSchemaRevision`, `loadOwnedSchemaModelContext` (148-184), `formContextIdentity` and `proposeSchemaEdit(nodes, instruction, documentMarkdown, { caller, temperature, signal, target, generate })` are in `api/_schema_edit.ts` (76-243). `getSourceRepresentation` returns only `{ artifactReference, artifactSha256 }` (`packages/db/src/project-store.ts:125-164`).
- **Dispatcher** (`server/api-dispatcher.ts`): `PARAMETERIZED` routes (16-42); `/api/chat` reaches `api/chat.ts` only through the generic `API_ROUTE` (8) and the eager glob of `api/[a-z]*.ts` (65-72), so deleting the module removes the route and the path answers the dispatcher's 404 `API route not found.`; `server/api-dispatcher.test.ts:36,55` lists it. No module registers a workflow or opens a connection at import. `STUDIO_BOOT_HEADER` is stamped on every `/api` response (`server/app.ts:391,394`).
- **Chat residue** (all deleted or rewritten by Task 1): `src/ChatTab.tsx` (fixed chat ID `free-document-chat`, 72; the only user of `DefaultChatTransport`/`readUIMessageStream`) and `src/ChatTab.test.tsx`; `api/_model.test.ts` (import 5, `streamTextMock` 11-21, cases 287-320); `api/_model.transport.test.ts` (import 4; the chat log audit from the `it.each` at 88 to the end); `src/apiEndpoints.test.ts` (`UIMessage` import 2, imports 12-14, mock 25, `chatRequest` 97-107, `streams chat with owner-scoped canonical Markdown` 153-178, chat parts of 237-282 and 284-321, `maps pre-stream failures to the stable envelope` 323-339); `server/researcher-project-ownership.test.ts` (import 27, `ModelSpies.chat` 194, its spy 549-551, the module 738-744, the chat case ending at 1178); `server/api-dispatcher.test.ts` (36, 55); `src/auth/authenticatedFetch.test.ts` (`/api/chat` as a dummy URL, 120-139); `api/_provider.test.ts` (`resolveCapabilityRoute('chat', …)` at 474, 617, 632, 737, 833, 848, 861, 893, 946, 979; 158-159 are Ollama's native `/api/chat` and stay) and `api/model_auth.test.ts:320`; `vite.server.config.ts:22` and `vite.server.config.test.ts:8`; `src/RightRail.tsx:3-5,181-183` (retirement comments); `prototypes/studio/README.md:53` ("document chat"). Not chat residue, and left alone: a Project Context's `'chat'` phase (`shared/projectContext.contract.ts:26`, `src/ui/PhaseProgress.tsx:5,25`, shown as "Chatting"; `src/ui/PhaseProgress.test.tsx:14`), `README.md:58`, `CLAUDE.md:6` and `DESIGN.md:107` (chat templates and chat-message UI), and the schema panel's own chat naming (`sendChatMessage`, `chatAbortRef`, `chatLoading`).
- **Browser:** `RailTab = 'evidence' | 'schema' | 'results'` (`RightRail.tsx:19`). `SchemaInstructionsChat` (`src/SchemaInstructions.tsx:28`, rendered at `SchemaPanel.tsx:1633`) keeps the pre-generation instruction in local state. `requestSchema` / `requestSchemaEdit` post forms after `ensureModelKeysSent()` (`src/api.ts:83-100,264-281`). `App.handleGenerate` calls `schema.generate((signal) => requestSchema(…))` (`src/App.tsx:444-464`). The schema panel's edit flow ("Describe a change to the schema…", `SchemaPanel.tsx:1753`) is `sendChatMessage` / `cancelChat` (`src/SchemaPanel.tsx:931-1015`); `useSchemaProposalReview.start(proposal, original, originalDraftVersion, originalSchemaRevisionId)` and its draft-version guard (`src/useSchemaProposalReview.ts:59-94`); `deriveSchemaProposal(original, response)` (`shared/schemaChanges.ts:129`). `SchemaPanel` is also rendered on the Batch prepare screen over a durable schema without a source revision (`src/projectContexts/BatchExtractionsPanel.tsx:1277-1310`). A document workspace opens the project's newest Extraction Schema (`project-store.ts:1330-1341`), so an Extraction Schema is project-scoped. `requestModelKeyResend` is module-private today (`src/auth/authenticatedFetch.ts:35`); M4 Task 9 exports it.
- **DBOS 5.1.10:** `listWorkflows({ workflow_id_prefix: string | string[], attributes, authenticatedUser, status, loadInput, loadOutput, limit, sortDesc })`; `attributes` filters by JSONB `@>` (`system_database.js:3252-3256`), so `{ extractionSchemaId: null }` matches only rows that recorded the key with `null`; `WorkflowStatus.input` is the argument array, `createdAt` epoch ms. `DBOSClient.getWorkflow(id)` loads input, output and attributes (it lists by ID with `loadInput`/`loadOutput` defaulting to true, `system_database.js:1154-1158,3159-3160`), `cancelWorkflow`, `deleteWorkflows(ids)`; `enqueue` with a reused `workflowID` returns the existing workflow. `DBOS.stepStatus?.cancelSignal` (`context.d.ts:3-18`) is aborted with **a `DBOSWorkflowCancelledError` as its reason, not an `AbortError`** (`system_database.js:2157-2167`), so a key wait or `fetch` ended by a cancel rejects with that error.
- **M4 (plan names; Task 2 present in the working tree):** `WorkflowStatuses`, `executionOf`, `LIVE_WORKFLOW_STATUSES`, `INTERRUPTED_FAILURE` (`packages/db/src/execution-status.ts`); `createResearcherProjectStore(account, database?, { workflowStatuses, enqueue })` with the Studio adapter in `server/app.ts` (M4 Task 9); `createInternalProjectWorkerStore()` with `readRevisionMarkdown` and `projectContextOwner` (M4 Task 9); `WorkflowSteps` (`step(name, run, config?)`, `cancelSignal()`) and `dbosSteps` (`extraction/workflows`, M4 Task 5); `server/dbos.ts` (`studioDbos()`, `STUDIO_QUEUE`, `awaitWorkflowOutcome`, `launchStudioDbos({ …, schema, keiSchema, executorId, register })`); `server/workflows.ts` (`STUDIO_WORKFLOW_NAMES`, `registerStudioWorkflows`); the Studio PostgreSQL tier (`vitest.postgres.config.ts`, `test/support/postgres.ts`: `disposableDatabaseUrl`, `testSchemas`, `dropSchemas`) and crash harness (`test/support/crash.ts` `runWorkflowChild(scenario, env)`, `workflowChild.ts`, scenarios in `test/support/scenarios/`); `cancelScopeWork` cancels live workflows by `sourceDocumentId`/`projectContextId` attribute after a deletion (M4 Task 12).

## Global Constraints

- **Worktree and branch:** `/home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6` on `feat/dbos-m2-m6`. Other agents write under `docs/plans/2026-09-24-unified-durable-execution-evidence/m0r*/`: never touch, stage or commit anything there. Stage explicit paths, never `git add -A .` at the root.
- **Preconditions:** M4 is complete (its Task 14 recorded; the DBOS plan carries its "done" line). Verify: `grep -c "M4: Studio's background work on DBOS — done" docs/plans/2026-09-24-unified-durable-execution.md` prints 1; `grep -n "export function registerStudioWorkflows\|STUDIO_WORKFLOW_NAMES" prototypes/studio/server/workflows.ts` lists M4's four names; `grep -n "export function requestModelKeyResend" prototypes/studio/src/auth/authenticatedFetch.ts` finds it; `grep -n "readRevisionMarkdown" packages/db/src/project-store.ts` finds it. If any fails, stop and report to the controller.
- **Pins:** unchanged; M5 adds no dependency. `pnpm why @dbos-inc/dbos-sdk` lists one version (5.1.10) and `pnpm --filter studio why ai` one `ai` 7.0.93. `@dbos-inc/vercel-ai` is not installed (Ruling 2).
- **Names (fixed):** workflows `suggestSchema` (`suggestion:<operationId>`) and `proposeSchemaEdit` (`edit:<operationId>`), both on queue `studio`, both registered only by `registerStudioWorkflows()` with an explicit `name`. Operation IDs are client-minted canonical lowercase UUIDs; workflow IDs are matched with full-match expressions (`^…$`, no `m` flag).
- **Workflow attributes (fixed):** generation `{ projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId: string | null }` (explicit `null` before the first schema); edit `{ projectContextId, extractionSchemaId, sourceDocumentId?, sourceRepresentationRevisionId? }` (the source keys only for a document-grounded edit). `authenticatedUser` is always the Project Context owner.
- **Secrets:** workflow inputs carry IDs and instructions only — never a key, never document text. No test or script prints a database URL with its password or a synthetic key. Model steps return typed results whose failure is `{ status, code, message }` with FREE's own copy; nothing a provider returned (body, headers, metadata, error message) is stored except the model's generated text.
- **No compatibility aliases** (spec, *Public contract changes*): `/api/chat` goes with no stub, redirect or 410 (the dispatcher's ordinary 404 answers it), and `free-document-chat` goes; no custom `data-dbos-superseded` handling is added anywhere.
- **Deletions:** implementer subagents may not run `git rm` without the user's authorization. Run plain `rm`, then `git add -A <those exact paths>`.
- **Test tiers (exact commands):**
  - Studio: `pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test`; one file: `pnpm --filter studio exec vitest run <path>`; browser tests start with `// @vitest-environment jsdom`.
  - Studio PostgreSQL: `pnpm --filter studio test:postgres` with `DATABASE_URL` and `EXTRACTION_TEST_DATABASE_URL` exported and equal; one file: `pnpm --filter studio exec vitest run --config vitest.postgres.config.ts <path>`.
  - db: `pnpm --filter db typecheck && pnpm --filter db test`; `pnpm --filter db test:postgres` with `PROJECT_STORE_POSTGRES_URL` exported (fresh databases).
  - E2E: `pnpm --filter studio test:e2e` (from Task 9 it runs `playwright.config.ts` then `playwright.recovery.config.ts`); one spec: `pnpm --filter studio exec playwright test e2e/<name>.spec.ts` (default config) or `pnpm --filter studio exec playwright test --config playwright.recovery.config.ts`; base path `pnpm --filter studio test:e2e:base-path`.
  - Real service: `pnpm test:service`. Safety and scripts: `pnpm test:safety`, `node --test scripts/free.test.mjs scripts/test-ci.test.mjs`.
  - Whole repository: `pnpm typecheck && pnpm lint && pnpm test:unit:node && pnpm test:safety && pnpm test:postgres:node && pnpm test:e2e && pnpm test:service`.
- **Disposable databases only** (README #10): user `postgres`, loopback, explicit port 5432, databases `free_test_*`; the guards refuse anything else. Reuse the M1–M4 container; never stop it or any other service. Before a PostgreSQL tier run, (re)create the databases:
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
- **No baseline edit:** M5 changes no table (Ruling 1). `packages/db/src/prisma/contract.prisma` and `packages/db/migrations/app/` stay as M4 left them, and an existing `pnpm dev` database needs no recreation for M5.
- **Commits:** one per task, conventional prefix, message ending with the session's attribution line. Never `git stash`, `reset` or `commit --amend` another task's work.

## Execution addendum (inline, 2026-09-26)

The user asked for M5 to be implemented **without subagents**, starting while another session (df73e0ca) is still executing M4 (its Task 9 was dispatched at e1c8ae6). This section adapts the plan; the tasks themselves are unchanged.

**Mode.** The controller session implements every task itself with `superpowers:executing-plans`, one commit per task, ledger in `.superpowers/sdd/2026-09-26-dbos-m5-interactive/progress.md` (gitignored; copied into the M5 worktree). Consequently: "report to the controller" means decide, record the ruling in the ledger and continue; the subagent-only rule about `git rm` authorization does not apply (plain `rm` + `git add -A <paths>` still works); "use a high-effort implementer" is moot. The final whole-branch review is a separate question for the user (Codex read-only via `codex exec` is not a subagent; see *Open questions*).

**Worktree and branch (supersedes the first bullet of *Global Constraints*).** `/home/gennaro/.t3/worktrees/FREE/t3code-ade16c5b` on `feat/dbos-m5`, created from `feat/dbos-m2-m6` at e1c8ae6. Every `cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6` in Tasks 1–10 means this worktree; the M4 worktree is never read for state, edited, staged or committed. `feat/dbos-m2-m6` is **merged** into `feat/dbos-m5` at each gate below (merge, never rebase: M1 and M3 were integrated the same way, and the ledgers cite SHAs). `feat/dbos-m5` is merged into `feat/dbos-m2-m6` only after M4's "done" line, its final review and its fix wave have landed there (the M4 session stops at that point).

**Gates (replace the single *Preconditions* check, which fails until M4 ends).**

| Tasks | Gate | Verify before starting (in this worktree, after the merge) |
|---|---|---|
| 1–2 | none: nothing they consume is in M4's uncommitted tree (checked at e1c8ae6: `api/chat.ts`, `ChatTab.tsx`, `streamChatWithModel`, `ModelOperation` with `'chat'`, `keyedModel`, `requireModelKey`, `vite.server.config.ts:22` are as the plan describes) | — |
| 3–7 | M4 Task 9 **committed** on `feat/dbos-m2-m6` (it adds `readRevisionMarkdown`, `createResearcherProjectStore(…, { workflowStatuses, enqueue })`, the worker store, the exported `requestModelKeyResend`, and `server/app.ts`'s store adapter) | `grep -n "readRevisionMarkdown" packages/db/src/project-store.ts`; `grep -n "export function requestModelKeyResend" prototypes/studio/src/auth/authenticatedFetch.ts`; `grep -n "workflowStatuses" packages/db/src/project-store.ts prototypes/studio/server/app.ts`; then run the ledger's pre-flight scan for Tasks 3–7 (line numbers in *Code facts* were taken at bf80322 and move with M4) |
| 8–9 | M4 Tasks 10 and 13 committed (kei stand-in ingestion in `e2e/canonical-evidence-lifecycle.spec.ts`; `FREE_SOURCE_INBOX` in the Playwright configs; the fixed stand-in port 41750 replaced, M4 F10) | `grep -n "FREE_SOURCE_INBOX" prototypes/studio/playwright.config.ts`; `grep -n "41750\|41_750" prototypes/studio/e2e/*.ts prototypes/studio/playwright*.ts` prints nothing |
| 10 | M4 complete: `grep -c "M4: Studio's background work on DBOS — done" docs/plans/2026-09-24-unified-durable-execution.md` prints 1, and its final review's fix wave is merged | the *Preconditions* greps of *Global Constraints* |

**Merge hotspots expected at gate 1.** `server/researcher-project-ownership.test.ts` (Task 1 deletes the chat regions; M4 Task 9 edits the pump regions: different hunks), `server/workflows.ts` (both append names), `src/auth/authenticatedFetch.test.ts` (Task 1's dummy URL; M4 Task 9's export). Task 2 note: M4's F11 fix already rewrote the `_model_keys.ts` comment at 127-132 to name `modelSignal` (the caller-side composition); Task 2 replaces whatever text is there with the model-boundary wording and must not reintroduce "the keyed wrapper must compose it". Keep Tasks 1 and 2 as two small commits so the merge stays legible.

**Environment.** Node dependencies installed with `FREE_SKIP_PYTHON=1 pnpm install --frozen-lockfile` (no 6 GB parsing venv in this worktree; `/home` was at 93 %). Python tiers (`pnpm test:service` in Task 10 only; M5 does not touch the parsing service) reuse an existing venv: `UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv` (or the main checkout's `prototypes/parsing_service/.venv`); never create a new one. PostgreSQL: `free-m1-pg` is up; the `free_test_m5_*` names in *Global Constraints* do not collide with M4's.

**Playwright isolation.** The default and base-path stacks have fixed ports and Compose projects, so an e2e run here would collide with one in the M4 session. Every e2e command run from this worktree while M4 is still active exports (both are read by `configurePlaywrightStack`):

```bash
# default suite (Tasks 1, 3–8)
export FREE_PLAYWRIGHT_PORT=41781 FREE_PLAYWRIGHT_OIDC_PORT=41782 FREE_PLAYWRIGHT_POSTGRES_PORT=45437 \
  FREE_PLAYWRIGHT_COMPOSE_PROJECT=free-studio-m5-e2e FREE_PLAYWRIGHT_DATABASE_NAME=free_test_studio_m5
# base path (Task 10)
export FREE_PLAYWRIGHT_PORT=41783 FREE_PLAYWRIGHT_OIDC_PORT=41784 FREE_PLAYWRIGHT_POSTGRES_PORT=45438 \
  FREE_PLAYWRIGHT_COMPOSE_PROJECT=free-studio-m5-e2e-base-path FREE_PLAYWRIGHT_DATABASE_NAME=free_test_studio_m5_base_path
```

Task 9's recovery config already has its own values (41771/41772/45436). Once M4 has stopped, the defaults are fine again.

**Open questions for the user (asked in the plan review; execution does not block on them).**
1. Final review: the user's standing preference is a Codex read-only whole-branch review; is that excluded by "no subagents"? Default if unanswered: run it at the end of Task 10 (it is a CLI, not an Agent-tool subagent).
2. Task 10 Step 3's live checks need the Spark or a hosted key; the plan already allows recording them as deferred to the M6 cutover smoke. Default: defer.
3. Learning mode: the only policy-shaped code in this plan is `recoveryView`/`planRecovery` (Task 7). The user may write those two functions themselves against Task 7's tests; otherwise the plan's version is used.

**Answers (user, 2026-09-26):** (1) a **Codex read-only review after each task** (`codex exec -s read-only`, prompt from the task's brief and the filtered diff `BASE..HEAD`; Critical/Important findings get one fix round with RED→GREEN tests before the task's ledger line, Minor ones are ledgered as deferred) in addition to the whole-branch review at the end; (2) unanswered — the default holds, the live checks are recorded as deferred to the M6 cutover smoke; (3) **no learning mode**: the plan's code is used as written.

## Test tiers at the M5 seam

| Tier | Tasks 1–8 | Task 9 on |
|---|---|---|
| Studio, db unit; typecheck; lint | green | green |
| db, extraction, Studio PostgreSQL | green | green |
| `pnpm test:e2e` (default config) | green | green |
| `pnpm test:e2e` recovery config | — | green |
| `pnpm test:safety`, scripts, `pnpm test:service` | green | green |
| `pnpm dev` generation / edit across a reload | live tab only (Tasks 3–4); restore from Task 7 | works |
| `pnpm dev` document chat | deleted by Task 1 (unreachable since 44ce50b) | deleted |

## Plan decisions (not settled by the spec; settled here)

The first version's decisions 1 (the Chat tab comes back), 2 (chat cancellation through `DELETE /api/model-operations/chat:<turnId>` and a Stop button), 9 (the chat transcript), 11 (`AdmittedWorkflow.deduplicationID` and `DuplicateActiveWorkflowError`) and 12 (the chat request without `temperature` and history) are superseded by Ruling 1; the rest are renumbered below.

1. **Workflow-first operations are enqueued by name on the `studio` queue through the admission client** (as M4 plan decision 2 does for reprocessing), with `authenticatedUser` and the fixed attributes; a reused operation ID returns the existing workflow and the handler compares its recorded input with `isDeepStrictEqual` (409 `operation_conflict` on any difference, including `workflowName`). No deduplication ID: the operation ID is the identity.
2. **Generation and edit handlers wait for the workflow** (`awaitWorkflowOutcome`, 250 ms interval, at most 25 min: two 10-minute calls for an edit's repair plus the 60 s key wait) and answer exactly today's success body and status codes. A client abort ends the wait only; the workflow runs on. A wait that times out answers 504 `operation_pending`; a cancelled workflow answers 409 `operation_cancelled`; `ERROR`/`MAX_RECOVERY_ATTEMPTS_EXCEEDED`/missing answers 500 `interrupted` with `INTERRUPTED_FAILURE.message`.
3. **Model steps return typed results** `{ ok: true, … } | { ok: false, status, code, message }` (spec *Typed results*; Ruling 4): every error a step catches becomes `operationFailureOf(error)` — an `ApiError`'s own status, code and message (FREE's copy), anything else 500 `unexpected_failure`. Nothing is rethrown from inside a model step, so a provider error's cause never reaches DBOS's error serializer.
4. **Document text is read at workflow scope** (spec *What DBOS history holds*): both workflows read the immutable revision's canonical Markdown (and an edit's base schema tree) with a plain call outside any step, pass it to the step closure, and never return it. A missing revision or schema revision ends the workflow with a typed 404.
5. **The model-operation DTO** (`shared/modelOperation.contract.ts`): `{ workflowId, operationId, kind: 'generation' | 'proposal', status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED', instruction, baseSchemaRevisionId, createdAt, template | response | null, failure | null }`. `SUCCEEDED` means the workflow returned `ok: true`; `FAILED` covers `ok: false` and every stopped status (with `INTERRUPTED_FAILURE` for a stop).
6. **`DELETE /api/model-operations/<workflow ID>`:** a live `suggestion:`/`edit:` workflow is cancelled (204); a finished `edit:` proposal is deleted together with every older finished `edit:` workflow in the same scope whose input names the same `baseSchemaRevisionId` (204); any other settled operation answers 204 and deletes nothing. Ownership: the workflow's recorded `projectContextId` (and `extractionSchemaId`) must pass the PostgreSQL scope check for the session's account and its `authenticatedUser` must be that account; otherwise 404, never 403.
7. **The browser repeats a model-work POST** (`repeatableModelPost`, Task 6) after a network error or a 502/503/504 whose body is not a Studio error, or whose code is `persistence_unavailable` or `operation_pending` — at most three more times (1, 2 and 4 s apart), resending the keys before each attempt, never after an abort. A confirmed Studio failure (any other code, any 4xx) is never repeated. Extraction admission keeps its read-based reconciliation (spec *Replays*) and is not repeated.
8. **A reloaded page acts only on operations it found at load** (and polls only those that were running then); operations this tab starts afterwards follow the live path. Of the finished operations whose base is the current revision, only the newest acts: a generation is saved, or a proposal reopened — never both, because saving moves the base.
9. **The listing is scoped to Project Context and Extraction Schema, as the spec says.** A first generation (`extractionSchemaId: null`) can therefore be restored in any document workspace of its project before the project has a schema; the project has one schema, so that is where the generation would have landed anyway.
10. **The Studio-restart and planted-key browser tests run in their own Playwright stack** (`playwright.recovery.config.ts`, one worker) whose web-server wrapper respawns Vite after a SIGKILL and tees its output to a log file; restarting the shared default stack would break parallel specs.

## Review Focus

1. **A key or provider body reaches storage or logs through a path the step boundary does not see** — a model step that rethrows; an `ApiError` whose enumerable `cause` is the provider error; a key echoed in response headers, a `TypeError` message or a Zod issue; DBOS or the AI SDK logging a step error; a `streamText`/`streamObject` call added without `onError`. Expected: no table, dump, data file or log line contains the key. Pinned by Task 3 `operationFailureOf keeps only FREE's copy, whatever the provider error holds` and `a key planted in a provider error in a JSON step reaches no DBOS or public table and no log`, Task 2 `every streamText and streamObject call in server code passes an explicit onError`, and Task 9 `a planted key reaches no pg_dump, data volume or Studio log after a generation, an edit proposal, a batch suggestion and a probe`.
2. **A stale generation lands on newer work after a reload** — a dirty or session-recovered draft, another tab that already saved it, a base that moved while the poll ran, or a first generation arriving after another tab created the schema. Expected: dropped silently, as a reloaded conflicted save is today. Pinned by Task 7 `planRecovery` cases, `restoreGeneration saves onto a clean base and drops on a conflict without an error`, and Task 8 `a reloaded page drops a finished generation when newer work exists`.
3. **A workflow ID alone authorizes a read or cancel** — another account's `suggestion:`/`edit:` ID, a project deleted between two polls. Expected: 404 with no DBOS call beyond locating the scope. Pinned by Task 5 `a second account can neither list nor cancel nor discard the first account's operations` and `after the project is deleted, listing and DELETE are 404`.
4. **Recovery loops or storms** — `model_key_required` resent forever, a repeated POST re-running a confirmed failure, a poll that never stops. Expected: one resend per operation, at most three repeats per POST, polling ends when every watched operation settled or the panel unmounts. Pinned by Task 6 `a confirmed failure is never repeated; an uncertain one at most three times` and `a model POST is repeated with the same body after a network failure or a proxy 502/503/504, keys first each time`, and Task 7 `polls every 2 s only while a watched operation runs, and stops on unmount` and `a restored model_key_required failure resends the keys once`.
5. **The chat deletion leaves a live reference or removes a shared helper too early** — a dispatcher fixture, an ownership-test module, `ssr.external`, a README line; or `loadOwnedSourceMarkdown` deleted while `generate_schema` still calls it. Expected: Task 1's residue grep prints only the listed false positives and every tier stays green after Task 1; `loadOwnedSourceMarkdown` goes in Task 3, `readCanonicalMarkdown` and `loadOwnedSchemaModelContext` in Task 4. Pinned by Task 1 Step 3 and Task 10 Step 1.

---

### Task 1: Delete the document chat end to end

The user's decision (Ruling 1). Nothing replaces the chat, and nothing a researcher can reach changes: no page has mounted `ChatTab` since 44ce50b. The schema tab's instruction chat and edit chat are not touched here. `loadOwnedSourceMarkdown` stays until Task 3 (`generate_schema.ts` still calls it); `readCanonicalMarkdown` and `loadOwnedSchemaModelContext` stay until Task 4. No CSP or dev-asset list names the chat (checked 2026-09-26: `server/app.ts`'s two `Content-Security-Policy` headers, 297 and 318, `vite.config.ts`, `index.html`), and no dependency exists only for it (`ai` stays for generation; `@dbos-inc/vercel-ai` was never installed).

**Files:**
- Delete: `prototypes/studio/api/chat.ts`, `prototypes/studio/src/ChatTab.tsx`, `prototypes/studio/src/ChatTab.test.tsx`
- Modify: `prototypes/studio/api/_model.ts` (delete `streamChatWithModel`, 101-144, and the imports only it used), `prototypes/studio/api/_model.test.ts` (import 5, `streamTextMock` 11-21, the two chat cases 287-320), `prototypes/studio/api/_model.transport.test.ts` (import 4; the chat log audit, from the `it.each` at 88, becomes a schema-generation log audit)
- Modify: `prototypes/studio/api/_provider.ts` (`ModelOperation` loses `'chat'`, 654), `prototypes/studio/api/_provider.test.ts` (its `'chat'` cases, 474-979, use `'schema-edit'`, which resolves the same Interaction Route; 158-159 are Ollama's native `/api/chat` and stay), `prototypes/studio/api/model_auth.test.ts` (320)
- Modify: `prototypes/studio/src/apiEndpoints.test.ts` (the chat imports, mock, helper and cases), `prototypes/studio/server/researcher-project-ownership.test.ts` (27, 194, 549-551, 738-744, 1157-1178), `prototypes/studio/server/api-dispatcher.test.ts` (36, 55), `prototypes/studio/src/auth/authenticatedFetch.test.ts` (120-139)
- Modify: `prototypes/studio/vite.server.config.ts` (22), `prototypes/studio/vite.server.config.test.ts` (3-10)
- Modify: `prototypes/studio/src/RightRail.tsx` (comments 3-5 and 181-183), `prototypes/studio/README.md` (53)

**Interfaces:**
- Consumes: nothing.
- Produces: `ModelOperation = 'schema-suggestion' | 'schema-edit'` (`api/_provider.ts`); no `/api/chat` route; `vite.server.config.ts` keeps only `@dbos-inc/dbos-sdk` external.

- [ ] **Step 1: Record the residue before deleting**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -rnE "ChatTab|streamChatWithModel|createPostChat|free-document-chat|api/chat\.|'/api/chat'|@dbos-inc/vercel-ai|resolveCapabilityRoute\('chat'|document chat" \
    prototypes/studio --include=*.ts --include=*.tsx --include=*.md --exclude-dir=node_modules --exclude-dir=dist
  ```
  Expected: the files listed above except `api/_provider.ts` (its `'chat'` is a bare union member) and `src/RightRail.tsx` (its comments say "document Chat tab"), and nothing else. A hit anywhere else is residue this plan missed: report it to the controller before deleting.

- [ ] **Step 2: Delete and edit**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6/prototypes/studio
  rm api/chat.ts src/ChatTab.tsx src/ChatTab.test.tsx
  ```
  - `api/_model.ts`: delete `streamChatWithModel` with its doc comment (101-144). Remove every import typecheck or lint then reports unused — expected: `convertToModelMessages`, `createUIMessageStreamResponse`, `toUIMessageStream`, `type UIMessage` and `streamText` from `ai`, and `ModelKeyRequiredError` (its only use was the chat's `onError`s). `APICallError` stays (206).
  - `api/_model.test.ts`: delete the import of `streamChatWithModel` (5), the cases `sanitizes model errors after the chat stream is committed` and `names a missing key in the chat stream and passes the request signal to the model` (287-320), and `streamTextMock` from the hoisted mocks and the `ai` mock (11-21) once nothing uses it.
  - `api/_model.transport.test.ts`: the `it.each` at 88 (`a failed chat call logs neither the key nor the provider response nor the document (%s)`) keeps its two planted providers and becomes `a failed schema generation logs neither the key nor the provider response nor the document (%s)`: call `generateSchemaWithModel(CALLER, { document: { file: null, pages: null, markdown: '# planted-document' }, instruction: 'planted-question' }, { profile: 'general', model: provider.chatModel('audit'), jsonOutput: 'prompt', temperatureSupported: true })`; it rejects with an `ApiError` (FREE's copy); neither its `message` nor any logged argument (the existing `inspect` scan) holds `sk-test-planted`, `planted-document` or `planted-question`. The import at 4 loses `streamChatWithModel`. This keeps the only log audit of a provider error that echoes a key.
  - `api/_provider.ts`: `export type ModelOperation = 'schema-suggestion' | 'schema-edit'` (654); `resolveCapabilityRoute`'s route choice (705) is unchanged, since `schema-edit` already resolves the Interaction Route.
  - `api/_provider.test.ts`: every `resolveCapabilityRoute('chat', …)` (474 `resolveChat`, 632, 833, 848, 861, 946, 979) passes `'schema-edit'` (rename `resolveChat` to `resolveInteraction`), as does `api/model_auth.test.ts:320`; drop `'chat'` from the `it.each` lists at 617 and 737, and the `['chat', 'interaction-model', 'interaction']` row at 893 (its `schema-edit` row stays). Test names that say "chat" say "schema edit" or "Interaction Route".
  - `src/apiEndpoints.test.ts`: delete the `UIMessage` import (2), `streamChatWithModel` and `createPostChat` (12, 14), the mock entry (25), `chatRequest` (97-107), `streams chat with owner-scoped canonical Markdown` (153-178), the chat parts of `rejects browser-authored source and schema context` (264-281) and of `returns 404 for cross-owner and mixed pins before artifact or model access` (297-303 and 320), and `maps pre-stream failures to the stable envelope` (323-339, chat only; Task 3's `generate_schema.test.ts` pins a typed failure's envelope).
  - `server/researcher-project-ownership.test.ts`: delete the `createPostChat` import (27), `ModelSpies.chat` (194) and its spy (549-551), the `'../api/chat.ts'` module (738-744), and the chat request in the cross-owner model case (1157-1178, from `const readsBeforeChat` to `expect(fixture.models.chat).not.toHaveBeenCalled()`).
  - `server/api-dispatcher.test.ts`: drop `chat: scopedModule()` (36) and the `['/api/chat', 'chat']` row (55).
  - `src/auth/authenticatedFetch.test.ts`: the dummy URL `/api/chat` (120, 125, 130, 139) becomes `/api/edit_schema`, a route that can answer `model_key_required`.
  - `vite.server.config.ts`: `ssr: { external: ['@dbos-inc/dbos-sdk'] }`, and its comment names DBOS alone; `vite.server.config.test.ts` expects `['@dbos-inc/dbos-sdk']`. `package.json` and `pnpm-lock.yaml` never held `@dbos-inc/vercel-ai`: leave them.
  - `src/RightRail.tsx`: the comments at 3-5 and 181-183 say only that the Annotation tab was retired and is left commented out; the document Chat tab was deleted (M5), and the schema panel's own instruction and edit chats replace it.
  - `README.md` (53): "…to Schema Suggestion and conversational Extraction Schema editing." (M6 rewrites this section; this only drops the deleted feature.)

- [ ] **Step 3: Residue grep and every Studio tier**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -rnE "ChatTab|streamChatWithModel|createPostChat|free-document-chat|api/chat\.|'/api/chat'|@dbos-inc/vercel-ai|resolveCapabilityRoute\('chat'|document chat" \
    prototypes/studio --include=*.ts --include=*.tsx --include=*.md --exclude-dir=node_modules --exclude-dir=dist
  grep -rnE "\b(streamText|streamObject)\(" prototypes/studio/api prototypes/studio/server --include=*.ts
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio build && ! grep -q "vercel-ai" prototypes/studio/dist/server/index.js
  pnpm --filter studio test:e2e
  ```
  Expected: both greps print nothing (the first searches only for chat residue, so Ollama's `/api/chat` in `_provider.test.ts`, the Project Context phase `'chat'`, chat templates in `README.md:58`/`CLAUDE.md:6` and `DESIGN.md:107`'s chat-message entry do not match); every tier is green.

- [ ] **Step 4: Commit**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add -A prototypes/studio/api/chat.ts prototypes/studio/src/ChatTab.tsx prototypes/studio/src/ChatTab.test.tsx
  git add prototypes/studio/api/_model.ts prototypes/studio/api/_model.test.ts prototypes/studio/api/_model.transport.test.ts \
    prototypes/studio/api/_provider.ts prototypes/studio/api/_provider.test.ts prototypes/studio/api/model_auth.test.ts \
    prototypes/studio/src/apiEndpoints.test.ts prototypes/studio/server/researcher-project-ownership.test.ts prototypes/studio/server/api-dispatcher.test.ts \
    prototypes/studio/src/auth/authenticatedFetch.test.ts prototypes/studio/vite.server.config.ts \
    prototypes/studio/vite.server.config.test.ts prototypes/studio/src/RightRail.tsx prototypes/studio/README.md
  git commit -m "feat(studio)!: delete the document chat, which no page has shown since the schema panel took over"
  ```

### Task 2: The model boundary: DBOS's cancel signal inside every provider attempt, and no stream call without `onError`

**Files:**
- Modify: `prototypes/studio/api/_model_keys.ts` (`withStepCancellation`; `requireModelKey` composes it; comments 13 and 127-132), `prototypes/studio/api/_model_keys.test.ts`
- Modify: `prototypes/studio/api/_provider.ts` (add `stepCancellable`; `resolveCapabilityRoute` wraps every general model, 751), `prototypes/studio/api/_provider.test.ts`
- Modify: `prototypes/studio/api/_model.ts` (NuExtract's signal), `prototypes/studio/api/_model.test.ts` (the NuExtract fixture lives here, not in the transport test — execution ruling, 2026-09-26)
- Create: `prototypes/studio/api/_model_stream_calls.test.ts` (execution ruling after the Codex review of Task 2: the scan resolves `ai`'s stream functions through the file's imports with the TypeScript parser and requires `onError` in each call's own options — a coarse `onError:` count let an unrelated handler in the same file mask a bare call; the walk is recursive)

**Interfaces:**
- Consumes: Task 1's `ModelOperation`.
- Produces:
  ```ts
  // api/_model_keys.ts
  export function withStepCancellation(signal: AbortSignal | undefined, cancel?: AbortSignal | undefined): AbortSignal | undefined
  // api/_provider.ts
  export function stepCancellable(model: LanguageModel): LanguageModel
  ```

- [ ] **Step 1: Write the failing tests**

  `api/_model_keys.test.ts` (the first case passes the cancel signal explicitly; the second mocks DBOS):
  - `withStepCancellation returns the call signal unchanged outside a step, the step's cancel signal alone without a call signal, and both composed inside a step` — `withStepCancellation(undefined, undefined) === undefined`; `withStepCancellation(call, undefined) === call`; `withStepCancellation(undefined, cancel) === cancel`; with both, aborting either aborts the result and leaves the other untouched.
  - `requireModelKey ends the wait when the step's cancel signal fires, and returns no key after it` — `vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { get stepStatus() { return stepStatus.current } } }))` with `const stepStatus = vi.hoisted(() => ({ current: undefined as undefined | { cancelSignal: AbortSignal } }))`; set `stepStatus.current = { cancelSignal: controller.signal }`; start `requireModelKey(cache, 'acct', connection, undefined, 60_000)`; abort the controller; the promise rejects with the controller's reason; a key put afterwards changes nothing.
  `api/_provider.test.ts` (same hoisted mock):
  - `every general model's provider call receives the step's cancel signal, keyed or keyless` — resolve a route twice, once for a `hasKey` OpenAI-compatible connection (key in the cache) and once for a keyless one, with `modelFactories['openai-compatible']` returning a stand-in whose `doGenerate` records `params.abortSignal`; with `stepStatus.current` set, call `generateText({ model: target.model, prompt: 'x' })`; abort the cancel controller; both recorded signals report `aborted === true`.
  - `a keyed model's key wait ends on the step's cancel signal and never calls the provider` — no key in the cache; the stand-in counts calls; aborting the cancel controller rejects the call and the count stays 0.
  `api/_model.transport.test.ts`:
  - `NuExtract's key wait and fetch receive the step's cancel signal` — the NuExtract target from the existing fixtures with a recording `fetch`; the recorded `init.signal` aborts when the cancel controller aborts.
  `api/_model_stream_calls.test.ts`:
  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { expect, it } from 'vitest'

  /** Stream calls in `source` beyond the explicit `onError:` options it names: a coarse count, enough to stop a call
   *  that relies on the SDK's default onError, which logs provider bodies and `Bearer <key>` messages (Ruling 5). */
  function unhandledStreamCalls(source: string): number {
    const calls = source.match(/\b(?:streamText|streamObject)\(/g)?.length ?? 0
    const handled = source.match(/\bonError:/g)?.length ?? 0
    return Math.max(0, calls - handled)
  }

  it('the scan counts a stream call without onError', () => {
    expect(unhandledStreamCalls('const r = streamText({ model })')).toBe(1)
    expect(unhandledStreamCalls('const r = streamObject({ model, onError: log })')).toBe(0)
  })

  it('every streamText and streamObject call in server code passes an explicit onError', () => {
    for (const directory of ['api', 'server']) {
      const root = join(import.meta.dirname, '..', directory)
      for (const file of readdirSync(root).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
        expect({ file, unhandled: unhandledStreamCalls(readFileSync(join(root, file), 'utf8')) }).toEqual({ file, unhandled: 0 })
      }
    }
  })
  ```
  (Doc comments must not contain an opening parenthesis right after `streamText` or `streamObject`: write "streamText calls". After Task 1 no such call exists, so the second case passes at once; it guards later code.)

  Run: `pnpm --filter studio exec vitest run api/_model_keys.test.ts api/_provider.test.ts api/_model.test.ts api/_model_stream_calls.test.ts`. Expected: FAIL (missing exports); the scan cases pass.

- [ ] **Step 2: Implement**

  `api/_model_keys.ts` (add `import { DBOS } from '@dbos-inc/dbos-sdk'`; importing it runs no query and registers nothing):
  ```ts
  /**
   * The provider attempt's signal with DBOS's `cancelSignal` added when the attempt runs inside a step, so a cancelled
   * workflow ends a key wait or a provider call about 1 s later (spec, *Cancellation → Studio model calls*). It is
   * composed here, at the model boundary, so every attempt carries it — the AI SDK's retries, NuExtract's own fetch,
   * keyed and keyless connections — whatever the caller passed. Outside a step it returns `signal` unchanged.
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
  The `ModelKeyRequiredError.isRetryable` comment (13) becomes "Only a page resending the key can fix this, so neither the AI SDK nor a DBOS step may retry it." (`durableCalls` is not used.)

  `api/_provider.ts`: add after `keyedModel` (the private `providerModel`, 558, stays private):
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

  `api/_model.ts`: in `generateWithNuExtract`, start with `const signal = withStepCancellation(input.signal)` and use `signal` for `target.key(signal)`, `signal?.throwIfAborted()` and the `fetch`.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio exec vitest run api/_model_keys.test.ts api/_provider.test.ts api/_model.test.ts api/_model_stream_calls.test.ts
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api/_model_keys.ts prototypes/studio/api/_model_keys.test.ts \
    prototypes/studio/api/_provider.ts prototypes/studio/api/_provider.test.ts prototypes/studio/api/_model.ts \
    prototypes/studio/api/_model.transport.test.ts prototypes/studio/api/_model_stream_calls.test.ts
  git commit -m "feat(studio): stop every model call on DBOS's cancel signal at the model boundary"
  ```

### Task 3: `suggestSchema` on DBOS: operation IDs, typed results, the waiting handler; keys and cancellation proven on PostgreSQL

The largest task: it also builds the operation helper with the step-boundary sanitizer (Ruling 4) and the PostgreSQL-tier support (scripted model server, planted keys, seeding, key scans) that Tasks 4, 5, 8 and 9 reuse. Use a high-effort implementer.

**Files:**
- Create: `prototypes/studio/api/_model_operation.ts` (+ `_model_operation.test.ts`), `prototypes/studio/api/_schema_generation_workflow.ts` (+ `_schema_generation_workflow.test.ts`), `prototypes/studio/api/generate_schema.test.ts`
- Modify: `prototypes/studio/api/generate_schema.ts`, `prototypes/studio/api/_schema_edit.ts` (add `ownedSourceScope`, `optionalSchemaBase`; delete `loadOwnedSourceMarkdown`, 101-122, whose last caller was `generate_schema.ts`), `prototypes/studio/server/workflows.ts` (+ `workflows.test.ts`), `prototypes/studio/server/researcher-project-ownership.test.ts` (the `generate_schema` cases send `operation_id` and fake the operation client)
- Modify: `packages/db/src/project-store.ts` (`ownedSourceRepresentationDescriptor` 125-164 also selects `sourceDocumentId`; `getSourceRepresentation` returns it), `packages/db/src/project-store.test.ts`
- Modify: `prototypes/studio/src/api.ts` (`requestSchema` sends `operation_id` and the base), `prototypes/studio/src/App.tsx` (`handleGenerate`, 444-464), `prototypes/studio/src/api.test.ts`, `prototypes/studio/src/apiEndpoints.test.ts` (where it lists form fields)
- Create (Studio PostgreSQL tier): `prototypes/studio/test/support/scriptedModelServer.ts`, `prototypes/studio/test/support/plantedKey.ts`, `prototypes/studio/test/support/interactive.ts`, `prototypes/studio/api/schema_generation.postgres.test.ts`, `prototypes/studio/test/support/scenarios/generation-recover.ts`, `prototypes/studio/test/support/scenarios/generation-replay.ts`

**Interfaces:**
- Consumes: M4's `studioDbos`, `STUDIO_QUEUE`, `awaitWorkflowOutcome`, `dbosSteps`, `WorkflowSteps`, `createInternalProjectWorkerStore().readRevisionMarkdown`, `INTERRUPTED_FAILURE`, the Studio PostgreSQL tier and crash harness; Task 2's model boundary.
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
  export type ScriptedReply = { text: string; hold?: boolean; headers?: Readonly<Record<string, string>> } | { status: number; body: string; headers?: Readonly<Record<string, string>> }
  export type ScriptedCall = Readonly<{ authorization: string | null; body: unknown; receivedAt: number; closedAt: number | null }>
  export function startScriptedModelServer(): Promise<{ baseUrl: string; reply(...replies: ScriptedReply[]): void; calls(): readonly ScriptedCall[]; waitForCall(count: number, timeoutMs?: number): Promise<ScriptedCall>; release(): void; close(): Promise<void> }>
  // test/support/interactive.ts
  export function seedInteractiveScope(): Promise<{ accountId: string; projectContextId: string; sourceDocumentId: string; sourceRepresentationRevisionId: string }>
  export function configureOwnerRoute(accountId: string, route: { provider: 'openai-compatible' | 'vllm'; baseUrl: string; modelId: string; hasKey: boolean; routes?: ReadonlyArray<'interaction' | 'schemaSuggestion'> }): Promise<{ connectionId: string }>
  export function databaseHolds(url: string, needle: string, schemas: readonly string[]): Promise<readonly string[]>   // "<schema>.<table>" whose rows hold it
  export function captureOutput(): { text(): string; restore(): void }                                               // console.* and process.std{out,err}.write
  // test/support/plantedKey.ts
  export function plantedKey(): string                                   // FREE_SYNTHETIC_KEY_<16 hex>
  export function holdsKey(value: unknown, key: string): boolean         // own properties (enumerable or not), causes, arrays, maps, strings
  ```

- [ ] **Step 1: The PostgreSQL-tier support**

  `test/support/scriptedModelServer.ts`: a `node:http` server on `127.0.0.1:0` answering `POST /v1/chat/completions` (and `GET /v1/models` with one model, `scripted`). Replies are taken FIFO from `reply(...)`; with none queued it answers `{ text: 'scripted answer' }`. Each call records `authorization` (the request header or null), the parsed body, `receivedAt` and `closedAt` (from `res.on('close')`). A text reply answers with one `chat.completion` JSON (`choices[0].message.content` is the text; `usage` `{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}`) and its `headers`; a request with `stream: true` answers 400, since no M5 call streams (Ruling 5). `hold: true` withholds the reply until `release()`. An error reply writes its status, headers and body; the token `{{authorization}}` in the body is replaced by the request's `authorization` header (how a provider echoes a key into an error). `waitForCall(n)` resolves when the n-th call arrived (default timeout 10 s).

  `test/support/plantedKey.ts`: `plantedKey()` is `` `FREE_SYNTHETIC_KEY_${randomBytes(8).toString('hex')}` ``. `holdsKey` walks a value depth-first with a `seen` set over `Object.getOwnPropertyNames` (so the non-enumerable `message`, `stack` and `cause` count), `Map`/`Set` entries and array items, and tests every string with `includes(key)`.

  `test/support/interactive.ts`: `seedInteractiveScope()` creates with the post-M4 ORM (`db.orm.public`) a `ResearcherAccount` (random tenant and object IDs), a `ProjectContext`, a `SourceDocument` and one `SourceRepresentationRevision` with placeholder artifact fields (the workflows' ports read Markdown from a test double, never from the package store); copy the column list from M4's Studio PostgreSQL seeding (for example `api/source_ingestion.postgres.test.ts`) if it has a helper, otherwise fill every NOT NULL column of the post-M4 contract. `configureOwnerRoute` calls `applyAccountModelConfig(accountId, update)` (`api/_model_config.ts:191`) with one researcher connection (`id: randomUUID()`) and the given routes (default `['interaction', 'schemaSuggestion']`). `databaseHolds` lists `information_schema.tables` (`BASE TABLE`) of the given schemas and runs per table `SELECT count(*)::int AS n FROM "<schema>"."<table>" AS x WHERE x::text LIKE $1` with `'%' + needle + '%'`. `captureOutput` wraps `console.log/info/warn/error` and `process.stdout.write`/`process.stderr.write` (DBOS's logger writes there).

- [ ] **Step 2: Write the failing unit tests**

  `api/_model_operation.test.ts` (a fake client recording calls; `getWorkflow` and `listWorkflows` scripted):
  - `a new operation is enqueued by name on the studio queue with its owner and attributes` (`enqueue` receives `{ queueName: 'studio', workflowName, workflowID, authenticatedUser: owner, attributes }` and the input).
  - `a reused operation ID with the same input joins it; any other input or workflow name is 409 operation_conflict` (`getWorkflow` returns `{ workflowName, input: [recorded] }`).
  - `a DBOS outage while starting or reading is 503 persistence_unavailable`.
  - `awaitOperation returns a finished workflow's typed output; a cancel is 409 operation_cancelled, an error or a missing workflow 500 interrupted, a timeout 504 operation_pending`.
  - `operationFailureOf keeps an ApiError's status, code and message and turns anything else into 500 unexpected_failure without its message`.
  - `operationFailureOf keeps only FREE's copy, whatever the provider error holds` (the step-boundary sanitizer, Ruling 4: with `key = plantedKey()`, for an `APICallError` whose `message`, `requestBodyValues`, `responseHeaders`, `responseBody` and `cause` hold the key; for `asModelOperationError(thatError)` — an `ApiError` whose enumerable `cause` is it; for a `TypeError` whose message quotes `Bearer <key>`; for a thrown string holding the key; and for an object whose `message` getter throws: the result has exactly the keys `status`, `code` and `message`, and `holdsKey(result, key) === false`).
  `api/_schema_generation_workflow.test.ts` (fake `steps` that run at once and record names; scripted `generate`):
  - `reads the document outside the step, generates in one step named generateSchema, and returns the template with its base` (`readMarkdown` runs before the step; `generate` runs only inside it; the output carries `baseSchemaRevisionId`).
  - `every call resolves the owner's account and gets a ten-minute signal` (`generate`'s caller is `{ researcherAccountId: input.owner }`; spy `AbortSignal.timeout`: called with `600_000`, and its signal is the one passed).
  - `an expected failure is returned as a typed result, never thrown` (`new ApiError(502, 'invalid_model_output', 'x')` → `{ ok: false, status: 502, code: 'invalid_model_output', message: 'x' }`; `ModelKeyRequiredError` → status 409, code `model_key_required`).
  - `the step's output copies only the template, the raw text, the page count and the base` (the scripted `generate` resolves `{ template, raw, pages, providerMetadata: { synthetic: { marker: key } }, response: { headers: { 'x-echo': key } } }` cast to its type; the output's keys are exactly `ok`, `template`, `raw`, `pages`, `baseSchemaRevisionId`, and `holdsKey(output, key) === false`).
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
          // The model boundary adds the step's cancel signal (Task 2).
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
  (`createResearcherApiHandlers` keeps `{ POST: createPostGenerateSchema(store) }`; the package-reader and `generate` parameters go. Delete `loadOwnedSourceMarkdown` from `api/_schema_edit.ts`: after Task 1 removed `api/chat.ts`, this handler was its last caller; `readCanonicalMarkdown` stays for `loadOwnedSchemaModelContext` until Task 4.)
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
  - `a replayed step whose call is checkpointed never waits for a key, even after the route moved` (A14, A7; scenario `generation-replay`: on the first run, with the key, its `steps.step` wrapper SIGKILLs right after the `generateSchema` step resolved; between the runs the parent re-points the owner's Schema Suggestion Route to a second scripted server B (`configureOwnerRoute`); the second run holds no key and a 60 s wait; the workflow reaches `SUCCESS` within 5 s with the first run's template; `server.calls().length === 1` and B has no call; the second process's counted `wait` stays 0 — the scenario writes its count to a file).
  - `a Studio killed mid-generation recovers it: the operation stays listed as running, and finishes once the page resends the key` (A2 kill; scenario `generation-recover`: the first run holds the call and SIGKILLs once `waitForCall(1)` resolved; between the runs `admission.listWorkflows({ workflow_id_prefix: 'suggestion:' })` shows `PENDING`; the second run puts the key before launch — the resend — and the workflow finishes with the second call's template; exactly 2 calls).
  - `a route changed between attempts: an interrupted generation reruns on the new route` (A7, spec *No pins*; scenario `generation-recover` with `FREE_TEST_MOVE_ROUTE=1`: between the runs the parent re-points the owner's Schema Suggestion Route to a second scripted server B; the second run puts the key before launch; A was called once, B once; the workflow's template is B's reply).
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
- Modify: `prototypes/studio/api/edit_schema.ts`, `prototypes/studio/api/_schema_edit.ts` (delete `loadOwnedSchemaModelContext`, 148-184, and `readCanonicalMarkdown`, 87-99), `packages/db/src/project-store.ts` (worker store `readSchemaRevisionTree`), `prototypes/studio/server/workflows.ts` (+ test), `prototypes/studio/server/researcher-project-ownership.test.ts` (the `edit_schema` cases send `operation_id`)
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
  `api/edit_schema.ts`: `FIELDS` gains `operation_id`; after today's validation, ownership is `loadOwnedSchemaRevision(…)` plus, for a document-grounded edit, `ownedSourceScope(…)` (no package read); the input is a `SchemaEditInput`; then `startOrJoinOperation(operations(), { workflowName: PROPOSE_SCHEMA_EDIT, workflowID: \`edit:${operationId}\`, owner, input, attributes: { projectContextId, extractionSchemaId, ...(source ? { sourceDocumentId, sourceRepresentationRevisionId } : {}) } })` and `awaitOperation<SchemaEditProposed>`; `ok: false` throws its `ApiError`; `ok: true` answers `json(result.response)`. `createPostEditSchema(store, operations = () => studioDbos().admission)`. Delete `loadOwnedSchemaModelContext` (its only caller is gone) and `readCanonicalMarkdown` (its last caller was `loadOwnedSchemaModelContext`; no handler reads Markdown any more).
  `src/api.ts`: `requestSchemaEdit(context, instruction, signal, operationId)` appends `operation_id`. `src/SchemaPanel.tsx` `sendChatMessage`: `const operationId = crypto.randomUUID()` per send, kept in `editOperationRef` beside `chatAbortRef` (Task 6's Stop and Task 7's Discard read it), passed to `requestSchemaEdit`.

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
  export const MODEL_OPERATION_WORKFLOW_ID: RegExp        // ^(suggestion|edit):(<canonical UUID>)$
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
  Check the exact shape of `CANONICAL_UUID` in `studio-configuration` first; if it is not anchored with `^…$`, use its `source` unchanged. The contract test pins `MODEL_OPERATION_WORKFLOW_ID` against `suggestion:<uuid>`, `edit:<uuid>`, and refuses `chat:<uuid>` (no chat workflows exist), `suggestion:<uuid>\n`, `edit:<UUID in upper case>` and `suggestion:<uuid>:x`.

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

### Task 6: The browser repeats an uncertain model POST and cancels only on a user's Stop

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

### Task 7: The schema panel restores running operations, unsaved generations and unreviewed proposals

**Files:**
- Create: `prototypes/studio/src/modelOperationRecovery.ts` (+ `modelOperationRecovery.test.ts`), `prototypes/studio/src/useModelOperationRecovery.ts` (+ `useModelOperationRecovery.test.tsx`), `prototypes/studio/src/useSchemaProposalReview.test.tsx`
- Modify: `prototypes/studio/src/api.ts` (`listModelOperations`), `prototypes/studio/src/currentSchemaRevision.ts` (`adoptGenerated` extracted from `generate`, 417-466; `restoreGeneration`; `operationScope`; `durableSchemaPersistence` takes `projectContextId`), `prototypes/studio/src/currentSchemaRevision.test.ts`, `prototypes/studio/src/useCurrentSchemaRevision.ts` (passes `scope.projectContextId`), `prototypes/studio/src/useSchemaProposalReview.ts` (`start(…, workflowId)`; Discard deletes on the server), `prototypes/studio/src/SchemaPanel.tsx` (the hook; the running-operation line; `start` gets `edit:<operationId>`), `prototypes/studio/src/SchemaPanel.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`ModelOperation`, the listing and `DELETE`), Task 6 (`deleteModelOperation`), M4 Task 9's exported `requestModelKeyResend`, `deriveSchemaProposal` (`shared/schemaChanges.ts:129`).
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

### Task 8: Browser reload recovery end to end (default Playwright suite)

**Files:**
- Create: `prototypes/studio/e2e/interactive-reload.spec.ts`, `prototypes/studio/e2e/interactiveStack.ts`
- Modify: `prototypes/studio/e2e/tsconfig.json` (include `../test/support/scriptedModelServer.ts` and `../test/support/plantedKey.ts` when the specs' imports need them)

**Interfaces:**
- Consumes: Tasks 3–7; M4's e2e ingestion path (the kei stand-in in the Playwright worker, as `e2e/canonical-evidence-lifecycle.spec.ts` uses it at M4's end).
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
  (The first version's two chat specs — a reload mid-`chatTurn`, and a dropped chat stream with a repeated POST — went with the chat, Ruling 1.)

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio exec playwright test e2e/interactive-reload.spec.ts
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/e2e/interactive-reload.spec.ts prototypes/studio/e2e/interactiveStack.ts prototypes/studio/e2e/tsconfig.json \
    prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts
  git commit -m "test(studio): prove generation and edit proposals come back after a page reload"
  ```

### Task 9: A Studio restart with the page open, and a planted key in no dump, volume or log

**Files:**
- Create: `prototypes/studio/playwright.recovery.config.ts`, `prototypes/studio/e2e/interactive-restart.spec.ts`, `prototypes/studio/e2e/studioRestart.ts`
- Modify: `prototypes/studio/e2e/playwrightStack.ts` (`runPlaywrightWebServer`, 905-952: respawn Vite after a SIGKILL when `FREE_PLAYWRIGHT_RESTARTABLE=1`; `spawnVite`, 747-770: tee output to `FREE_PLAYWRIGHT_STUDIO_LOG`; export `readPlaywrightLifecycleStateForTest()`), `prototypes/studio/server/playwrightStack.test.ts`, `prototypes/studio/playwright.config.ts` (`testIgnore` adds `interactive-restart.spec.ts`), `prototypes/studio/package.json` (`test:e2e` runs both configs; `test:e2e:recovery`), `.gitignore` (add `artifacts/recovery-tests/` beside the service-test artifacts if those are listed)

**Interfaces:**
- Consumes: Task 8's `prepareInteractiveDocument`, Task 3's `plantedKey`, Tasks 3–7.
- Produces: `killStudio(): Promise<void>` (SIGKILLs the Vite process group, waits for the wrapper's respawn and for Studio to answer); `readPlaywrightLifecycleStateForTest(): Promise<{ vitePid?: number; wrapperPid: number }>`.

- [ ] **Step 1: The restartable stack**

  `playwrightStack.ts`: when `process.env.FREE_PLAYWRIGHT_RESTARTABLE === '1'` and Vite exits with signal `SIGKILL`, `runPlaywrightWebServer` spawns it again on the same port, rewrites the lifecycle state with the new `vitePid`, and keeps waiting (any other exit still fails the web server; a teardown request still cleans up the current Vite). When `FREE_PLAYWRIGHT_STUDIO_LOG` is set, `spawnVite` uses `stdio: ['ignore', 'pipe', 'pipe']` and writes both streams to the process's own stdout/stderr and appends them to that file. `server/playwrightStack.test.ts`: `a restartable web server respawns Vite after a SIGKILL and records its new PID`; `any other Vite exit still fails the web server`; `Vite's output is appended to the Studio log when one is named`.
  `playwright.recovery.config.ts`: `configurePlaywrightStack({ applicationPort: 41_771, composeProject: 'free-studio-recovery-e2e', databaseName: 'free_test_studio_recovery', oidcPort: 41_772, postgresPort: 45_436 })`; `testMatch: 'interactive-restart.spec.ts'`, `workers: 1`, `timeout: 300_000`, `outputDir` and state under `artifacts/recovery-tests/`; `webServer.env` as `playwright.config.ts` sets it at M4's end (the kei stand-in settings included) plus `XDG_DATA_HOME` and `FREE_SOURCE_INBOX` under the state directory, `FREE_PLAYWRIGHT_RESTARTABLE: '1'` and `FREE_PLAYWRIGHT_STUDIO_LOG`. `package.json`: `"test:e2e": "playwright test && playwright test --config playwright.recovery.config.ts"`, `"test:e2e:recovery": "playwright test --config playwright.recovery.config.ts"` (CI's `pnpm test:e2e` then runs both with no other change).
  `e2e/studioRestart.ts`: `killStudio()` reads the lifecycle state, `process.kill(-vitePid, 'SIGKILL')` (Vite runs detached, in its own process group), waits up to 30 s for a new `vitePid` and up to 60 s for `GET /auth/signed-out` to answer 200.

- [ ] **Step 2: The specs** (`interactive-restart.spec.ts`, serial)

  - `a Studio restart with the page open resends the keys, and the recovered generation continues` (A13, A2: `prepareInteractiveDocument(page, { hasKey: true, key })`; hold a generation; `killStudio()`; the page's repeated POST is preceded by `PUT /api/model-keys` (seen through `page.on('request')`); the recovered call reaches the model with `authorization: Bearer <key>`; release; the fields save).
  - `a Studio restart between two polls: the reloaded page sees the new boot ID, resends the keys, and the recovered proposal continues` (A13 "between two polls": hold an edit; reload — the panel now polls; `killStudio()`; the next poll's response carries a new `X-FREE-Studio-Boot`; a `PUT /api/model-keys` follows; the recovered call carries the key; release; the review bar returns).
  - `a planted key reaches no pg_dump, data volume or Studio log after a generation, an edit proposal, a batch suggestion and a probe` (A12, with an edit proposal in place of the deleted chat: `key = plantedKey()` typed into the Model Configuration page for an `openai-compatible` connection at the scripted server; the server answers the first call of each kind with `{ status: 500, body: '{"error":"{{authorization}}"}', headers: { 'x-echo': key } }` and later ones with `headers: { 'x-echo': key }`; run a probe (the page's own probe), a generation (fails, then succeeds as a new operation), an edit proposal (fails, then succeeds as a new operation) and a Batch Schema Suggestion over the uploaded document (fails, then retried with the next expected attempt); then `docker compose -p "$FREE_PLAYWRIGHT_COMPOSE_PROJECT" -f e2e/playwright.compose.yaml exec -T postgres pg_dump -U free_e2e "$FREE_PLAYWRIGHT_DATABASE_NAME"` (run with `execFile`, output kept in memory, never printed) does not contain the key; no file under the state directory (Studio's data and the source inbox) contains it; the Studio log does not contain it. The browser's own `localStorage` holds it by design and is not scanned).

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

### Task 10: Verification and bookkeeping

**Files:**
- Create: `docs/validation/<YYYY-MM-DD>-dbos-m5-verification.md`
- Modify: `docs/plans/2026-09-24-unified-durable-execution.md` (the M5 heading), this plan's `Status:` line

- [ ] **Step 1: Residue search**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -rnE "free-document-chat|streamChatWithModel|createPostChat|ChatTab|data-dbos-superseded|loadOwnedSourceMarkdown|readCanonicalMarkdown|loadOwnedSchemaModelContext|@dbos-inc/vercel-ai|chatTurn|ChatTurn" \
    prototypes packages --include=*.ts --include=*.tsx --include=*.json --exclude-dir=node_modules --exclude-dir=dist
  grep -rnE "\b(streamText|streamObject)\(" prototypes/studio/api prototypes/studio/server --include=*.ts | grep -v "\.test\.ts"
  ```
  Expected: both print nothing (Task 2's scan test already stops a stream call without `onError`).

- [ ] **Step 2: Run every tier**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety
  # fresh disposable databases (Global Constraints), DATABASE_URL = EXTRACTION_TEST_DATABASE_URL, plus PARSING_TEST_DATABASE_URL:
  pnpm test:postgres
  pnpm test:e2e && pnpm --filter studio test:e2e:base-path
  pnpm test:service
  pnpm --filter studio build
  ```
  Then the production-bundle smoke of M4 Task 14, extended: with the bundle running on a disposable `free_test_m5_bundle` database, enqueue `suggestSchema` on `studio` as `suggestion:<random UUID>` through a `DBOSClient` (`applicationName: 'studio'`) with a `SchemaGenerationInput` naming a random revision; it reaches `SUCCESS` with the typed 404 (its `readMarkdown` finds no revision), which proves the bundle registers M5's workflows. Record commands and output. A tier this host cannot run is recorded with its reason, never as passed.

- [ ] **Step 3: The live checks (Ruling 7)**

  On a host with a real model (the Spark's deployment vLLM, or a hosted provider with the researcher's own key) and `pnpm dev`:
  1. Generate a schema from the instruction chat; reload mid-generation; the panel shows it running and saves it onto its base once. Describe a change to the schema; kill Studio mid-proposal (Compose `restart` of `studio`, or SIGKILL of the development server); the page resends its keys and the review bar returns once.
  2. With `FREE_DEPLOYMENT_CLI_PROVIDERS=claude-code` (or `codex-cli`) and the operator's CLI login, route the Assistant model to that deployment connection and complete one Schema Suggestion (Schema Suggestion follows the Assistant model while unset) and one edit proposal end to end.
  3. Inspect `dbos.workflow_status` and `dbos.operation_outputs` for one generation and one edit proposal: no document text, no key, no provider metadata.
  Record what ran, where and the result. If no live model or CLI login is available here, say so in the record and leave these for the cutover smoke test (spec *Cutover*, step 6).

- [ ] **Step 4: Record**

  Write the verification record (tested commit, commands, results, skips, the live-check outcomes, and a pointer to the traceability table below). In the DBOS plan, replace `**M5: interactive work on DBOS.**` with `**M5: interactive work on DBOS — done YYYY-MM-DD.** Task plan: [2026-09-26-dbos-m5-interactive.md](2026-09-26-dbos-m5-interactive.md).` Set this plan's status to `done YYYY-MM-DD`.
  ```bash
  git add docs/validation/<file> docs/plans/2026-09-24-unified-durable-execution.md docs/plans/2026-09-26-dbos-m5-interactive.md
  git commit -m "docs(plans): record DBOS M5 completion"
  ```

---

## Traceability: M5 acceptance → tests

Test files are under `prototypes/studio/` unless they start with `packages/`. "Superseded" rows are the spec's chat acceptance items, which the user's decision (Ruling 1; spec decision 15) removed from M5; they are listed rather than dropped.

| Spec M5 acceptance (sub-bullet) | Test (file › name) | Task |
|---|---|---|
| A1 Kill after the chat answer write but before its checkpoint: the answer is written once | Superseded by the user's 2026-09-26 decision: document chat deleted | — |
| A2 Reload the page mid-`suggestSchema`, mid-`proposeSchemaEdit`: the page finds each operation | `e2e/interactive-reload.spec.ts` › `a reload mid-suggestSchema finds the running generation …`, `a reload mid-proposeSchemaEdit reopens the review bar …` | 8 |
| A2 … mid-`chatTurn` | Superseded by the user's 2026-09-26 decision: document chat deleted | — |
| A2 … and separately kill Studio at the same points | `e2e/interactive-restart.spec.ts` › `a Studio restart with the page open … generation continues`, `… between two polls … recovered proposal continues`; `api/schema_generation.postgres.test.ts` › `a Studio killed mid-generation recovers it …`; `api/schema_edit.postgres.test.ts` › `a Studio killed mid-proposal recovers it …` (mid-`chatTurn`: superseded by the user's 2026-09-26 decision: document chat deleted) | 3, 4, 9 |
| A3 A reloaded page saves a finished generation only onto its base, dropping it when newer work exists | `src/modelOperationRecovery.test.ts` › `the newest finished generation whose base is the clean current revision is saved`, `a generation whose base is older, or a draft that is dirty …, is dropped`, `a first generation is saved only while no Extraction Schema exists`; `src/currentSchemaRevision.test.ts` › `restoreGeneration saves onto a clean base and drops on a conflict without an error`; `e2e/interactive-reload.spec.ts` › `a reloaded page drops a finished generation when newer work exists` | 7, 8 |
| A3 A surviving tab keeps today's acknowledged-head save behavior, including edits during generation | `src/currentSchemaRevision.test.ts` › `a surviving tab keeps saving through its acknowledged head, including edits during generation`; `e2e/interactive-reload.spec.ts` › same name | 7, 8 |
| A3 The review bar returns | `src/useModelOperationRecovery.test.tsx` › `a restored proposal reopens the review bar …`; `src/SchemaPanel.test.tsx` › `a restored proposal reopens the review bar and replays onto the base revision's nodes`; `e2e/interactive-reload.spec.ts` › `a reload mid-proposeSchemaEdit reopens the review bar; Discard persists …` | 7, 8 |
| A4 The transcript returns and partial text replays once under the turn ID | Superseded by the user's 2026-09-26 decision: document chat deleted | — |
| A4 New readers skip superseded attempts | Superseded by the user's 2026-09-26 decision: document chat deleted | — |
| A4 A partial provider failure produces an error finish and persisted failure, never a saved partial answer or an in-process retry that appends replacement text | Superseded by the user's 2026-09-26 decision: document chat deleted (no model call streams after Task 1; Ruling 5's scan stops a new one without `onError`) | — |
| A5 An answer that finishes between the transcript read and the reconnect still appears, with the turn ID as its message ID | Superseded by the user's 2026-09-26 decision: document chat deleted | — |
| A6 A repeated POST after a dropped connection returns the same result | `api/schema_generation.postgres.test.ts` › `… a repeated POST returns the same result without a second model call`; `api/schema_edit.postgres.test.ts` › `… a repeated POST returns the same proposal …`; `src/api.test.ts` › `a model POST is repeated with the same body …`; `e2e/interactive-restart.spec.ts` › `a Studio restart with the page open resends the keys …` (the page's repeated POST) | 3, 4, 6, 9 |
| A6 Exact-turn reconnect works across completion and returns 204 for expired history, followed by the authoritative transcript | Superseded by the user's 2026-09-26 decision: document chat deleted | — |
| A7 Change the route between attempts | `api/schema_generation.postgres.test.ts` › `a route changed between attempts: an interrupted generation reruns on the new route`, `a replayed step whose call is checkpointed never waits for a key, even after the route moved` (retargeted from chat to Schema Suggestion: the spec's *No pins* rule is not chat-specific) | 3 |
| A8 One HTTP and one CLI provider complete a chat turn end to end | Superseded by the user's 2026-09-26 decision: document chat deleted. The live check still runs one Schema Suggestion and one edit proposal on a real HTTP model and on a CLI login (Task 10 Step 3, recorded) | (10) |
| A9 A second account can list or cancel none of the first's operations; ownership holds on every read, including after the project is deleted | `api/model_operations.postgres.test.ts` › `a second account can neither list nor cancel nor discard …`, `after the project is deleted, listing and DELETE are 404`; `server/researcher-project-ownership.test.ts` (model-operation cases) | 5 |
| A9 … read or stream none of the first's turns | Superseded by the user's 2026-09-26 decision: document chat deleted | — |
| A10 A synthetic key planted in a provider error's cause chain in a JSON step | `api/_model_operation.test.ts` › `operationFailureOf keeps only FREE's copy, whatever the provider error holds`; `api/schema_generation.postgres.test.ts` › `a key planted in a provider error in a JSON step reaches no DBOS or public table and no log` | 3 |
| A10 … in a successful response's headers and provider metadata; no input, output, error or stream record holds it | `api/schema_generation.postgres.test.ts` › `a key planted in a provider error in a JSON step …` (its success reply echoes the key in a header); `api/_schema_generation_workflow.test.ts` › `the step's output copies only the template, the raw text, the page count and the base` | 3 |
| A10 … inside `durableCalls` | Superseded by the user's 2026-09-26 decision: document chat deleted (no `durableCalls`) | — |
| A11 A chat turn's checkpoint holds the history and the answer, not the document | Superseded by the user's 2026-09-26 decision: document chat deleted. Generation and edits keep the document out of history: `api/_schema_generation_workflow.test.ts` › `reads the document outside the step …`; `api/_schema_edit_workflow.test.ts` › `reads the base schema and the document outside the step …` | (3, 4) |
| A12 Plant a key and run generation, a batch suggestion and a probe: no `pg_dump`, volume or log holds it | `e2e/interactive-restart.spec.ts` › `a planted key reaches no pg_dump, data volume or Studio log after a generation, an edit proposal, a batch suggestion and a probe` (the chat run: superseded by the user's 2026-09-26 decision: document chat deleted; an edit proposal takes its place) | 9 |
| A13 Restart Studio mid-call with the page open, including between two polls; the new boot ID triggers the resend and the recovered call continues | `e2e/interactive-restart.spec.ts` › `a Studio restart with the page open resends the keys …`, `a Studio restart between two polls …`; `src/api.test.ts` › `… keys first each time` | 6, 9 |
| A13 With no page open, the call fails with `model_key_required` after the wait, and neither retry owner retries it | `api/schema_generation.postgres.test.ts` › `with no page to resend it, a recovered generation fails with model_key_required …` | 3 |
| A13 Resending keys then retrying starts a new operation ID or batch attempt | `src/useModelOperationRecovery.test.tsx` › `a restored model_key_required failure resends the keys once`; `src/SchemaPanel.test.tsx` › `each edit request carries a new operation ID`; `src/api.test.ts` › `a confirmed failure is never repeated …`; M4 Task 9 `BatchExtractionsPanel.test.tsx` › `a model_key_required failure resends this browser's keys once, and Try again posts the next expected attempt` (a new turn ID: superseded by the user's 2026-09-26 decision: document chat deleted) | 4, 6, 7 (M4 9) |
| A14 A replayed step whose call is checkpointed never waits for a key | `api/schema_generation.postgres.test.ts` › `a replayed step whose call is checkpointed never waits for a key, even after the route moved` | 3 |
| A14 A cancel during the wait never reaches the provider | `api/schema_generation.postgres.test.ts` › `a cancel during the key wait never reaches the provider`; `api/_model_keys.test.ts` › `requireModelKey ends the wait when the step's cancel signal fires …`; `api/_provider.test.ts` › `a keyed model's key wait ends on the step's cancel signal and never calls the provider` | 2, 3 |
| A14 A cancel during a provider call stops it about 1 s later | `api/schema_generation.postgres.test.ts` › `a cancel during a provider call stops it about 1 s later`; `api/_provider.test.ts` › `every general model's provider call receives the step's cancel signal, keyed or keyless` | 2, 3 |
| A15 Schema Suggestion over the NuExtract protocol on a keyed vLLM connection passes the same key-wait, cancellation and no-key-in-history checks | `api/schema_generation.postgres.test.ts` › `NuExtract on a keyed vLLM connection waits for its key, stops on cancel, and leaves no key in history`; `api/_model.transport.test.ts` › `NuExtract's key wait and fetch receive the step's cancel signal` | 2, 3 |

Spec *Verification* items M5 owns: no key in any table (3, 9); a page reload mid-generation and mid-edit (8); a Studio restart with the page open, keys resent, the call continuing (9); the residue item `free-document-chat` (1, 10). Superseded by the user's 2026-09-26 decision (document chat deleted): atomic question admission, concurrent chat replay, active-chat exclusion and rollback; one answer per chat turn when an answer races a cancel; a page reload mid-chat; chat reconnect and re-POST recovery; chat across a reload and a restart in the manual run.

Other M5 items and where they are built: `suggestSchema` and `proposeSchemaEdit` (3, 4); operation IDs with 409 on conflicting reuse (3, 4); owner checks (3, 4, 5); typed results with provider errors sanitized inside the step (3, Ruling 4); `GET`/`DELETE /api/model-operations` (5); `src/api.ts` repeats the same POST after a network failure or 502/503/504 (6); a new user action mints a new ID (3, 4, 6; ingestion retry without a client key is M4 Task 10); `generate_schema` carries the operation ID and base; the schema panel restores a running operation, saves a finished generation on its base and reopens an unreviewed proposal (3, 7); aborts from a user action call the cancel route (6, 7); a new boot ID resends keys before recovery continues (M2's `authenticatedFetch`, 6, 9); `model_key_required` resend then a new ID, never a re-POST of the failed ID (6, 7); the key wrapper composes `cancelSignal` (2); every stream call has an explicit `onError` (1 removes the only one, 2 guards new ones). Superseded by the user's 2026-09-26 decision (document chat deleted): `chatTurn` and its answer write; `@dbos-inc/vercel-ai` and the sanitizer inside `durableCalls`; turn IDs; atomic question/enqueue with per-revision dedup and same-turn replay; conditional answer/failure writes and the typed chat failure followed by a sanitized throw; `GET /api/chat/<revision ID>` and `/stream?turnId=`; everything `ChatTab.tsx` was to do; the `ChatTurn` baseline edit.

## Deferred to M6 and later

| Item | Goes to | Why |
|---|---|---|
| History retention for settled interactive work (24 h) and the rest of `collectGarbage` | M6 | spec *Milestones → M6*; M5 only relies on history existing |
| README #5/#7, CONTEXT.md (interactive work stores no Model Attribution; `CONTEXT.md:149` still says the Interaction Route serves document chat), ADR 0007 (`:9`, document chat), ADR 0012, the OpenSpec specs for schema chat edit and capability-route resolution (`openspec/specs/capability-route-resolution/spec.md:8,16-18,48,77-79`, document chat), `docs/architecture/current.c4` (the model-operation routes; no Chat tab) | M6 | spec *Milestones → M6 → Other docs*; the document-chat mentions are stale since Task 1 |
| The M6 plan's chat items: its Ruling 3 (the Chat tab as developer-UI only), `@dbos-inc/vercel-ai` among the pins (line 50), the `chat:` prefix in `GC_POLICY` and `STUDIO_WORKFLOW_PREFIXES`, `ChatTurn` scopes in garbage collection, the precondition grep for `chatTurn`, the README "developer view" sentence and the Spark smoke's chat turn | M6 plan revision (controller) | written against the first version of this plan; this revision cannot edit it |
| The full *Verification* residue search and the pool measurement across Studio's pools | M6 verification | Task 10 searches only M5's own residue |
| M0R 6's pending "Studio chat and schema generation during a kei extraction on `extraction_model`" | Spark, separate | needs the Spark's model servers; with chat deleted only its schema-generation half remains; not an M5 acceptance bullet |
| Persisting the schema panel's message log | out of scope | spec *Out of scope* |
