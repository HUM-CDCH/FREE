# DBOS M2: Platform, Baseline and Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **not started (plan written 2026-09-26 against 84013ee).**

**Goal:** Deliver milestone M2 of the DBOS plan on branch `feat/dbos-m2-m6`: one baseline migration without dead schema, per-researcher Model Configuration in PostgreSQL, keys held by the researcher's browser (Studio keeps a copy only in memory), the redesigned Model Configuration page (variant B1), kei's ingestion model listing, the app shell's Content-Security-Policy, and the Studio-side runtime that M3 and M4 build on (kei's database role, a restarting dev watch, CLI deployment connections). DBOS itself enters Studio in M4 and kei in M3.

**Architecture:** `packages/db` gets a from-null baseline migration (edited in place again by M4 and M5) with a `ModelConfiguration` row per Researcher Account and a lock-serialized store. Studio's `model_config` / `model_probe` become researcher-scoped handlers; every model call resolves the *owner's* configuration and reads keys lazily from an in-memory cache inside each provider attempt, waiting up to 60 s for a page to resend a missing key. The browser keeps keys in `localStorage` per account, bound to a connection's ID, provider and API base, and hands them to Studio with `PUT /api/model-keys` on load, after Apply, before model work, when a response carries a new `X-FREE-Studio-Boot`, and after `model_key_required`. The page follows the researcher's work in three steps over one draft with one route setter.

**Tech Stack:** Studio (TypeScript, React 19, Vite 8, Hono, Zod 4, AI SDK 7, Vitest, Playwright), `packages/db` (Prisma Next 0.16, `pg`, `tsx --test`), `packages/extraction`, Parsing Service `kei_exp` (Python 3.13, FastAPI, pytest, uv), Docker Compose.

**Spec:** [docs/plans/2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md). Read *Decisions*, *Rules*, *Model configuration and keys* (all of it, including *The page*), *Public contract changes*, *Milestones → M2*, and *Verification* before starting. The page's reference prototype is on branch `prototype/model-config-b1` (`git show prototype/model-config-b1:prototypes/studio/src/providerConfig/prototype/VariantB1.tsx`, `parts.tsx`, `useSimpleDraft.ts`, `README.md`); it is read, never merged, and its equality-based Schema Suggestion linking is superseded (see Task 13).

## Rulings (controller, 2026-09-26)

1. **Ruling: milestone seams stay green; M2 creates the single baseline migration and each later milestone edits it in place only for code it changes.** The M2 baseline is today's schema minus only what no code reads or writes after M1 (`SchemaSuggestion`, `SchemaSuggestionInput`, `ConversationalSchemaEdit`, `PromptRevision` and their `SchemaRevision` columns; Catalog-retry columns; `BatchExtraction.failure` / `finishedAt`), plus the per-account `ModelConfiguration` table. `ExtractionJob` / `BatchExtractionMember` removal, ingestion keys, per-source suggestion columns and transient phases, Extraction admission inputs/outcome, batch/source uniqueness, suggestion attempt/outcome and cascading membership move to M4's baseline edit; `ChatTurn` to M5's. Anything still read stays. — *Why:* each milestone ends with code and schema that agree, so every tier stays green at every seam and M2 can be verified on its own. — *Cost if wrong:* dropping a column still read breaks extraction/batch reads at runtime (a 500 on a Postgres-backed read), which only the Postgres tiers catch.
2. **Ruling: Compose/runtime items whose consumers change later move with those consumers.** Removing `parsing_db` / `parsing_migrate` / the parsing API's database environment, the `source-inbox` volume, `parsing_worker` waiting for Studio's healthcheck, and `free.mjs`'s `parsing_db` handling go to M3/M4 (Procrastinate still needs `parsing_db` until M3). M2 keeps: the Studio entrypoint's idempotent kei role (`FREE_KEI_POSTGRES_PASSWORD`) and `kei_dbos` schema, `FREE_DEPLOYMENT_CLI_PROVIDERS` (both CLI kinds in the local development overlay), Studio's development watch with `sync+restart` for server code and `sync` for `src/`, and the kei-role-denied check. — *Why:* removing a runtime dependency before its last consumer is gone breaks `pnpm dev` and the parsing tiers mid-branch. — *Cost if wrong:* M3/M4 inherit a half-removed topology, or M2 ships a broken local stack.
3. **Ruling: the M2 safety test "a parsing API without database access" moves to M3 with the `parsing_db` removal.** — *Why:* in M2 the parsing API still owns `KEI_DATABASE_URL` and Procrastinate. — *Cost if wrong:* the test would fail against a topology M2 is not allowed to change.

## Code facts this plan relies on (verified at 84013ee)

- **Dropped by the baseline (Task 1)** — verified by grep:
  - `PromptRevision`, `SchemaSuggestion`, `SchemaSuggestionInput`, `ConversationalSchemaEdit`, `SchemaRevision.schemaSuggestionId` / `conversationalSchemaEditId`: written only by the fixture in `packages/db/src/project-store.postgres.check.ts:178-221`. Their enums `AttemptOutcome` and `AnnotationMode` have no other user (`AnnotationMode` in `src/App.tsx` is pdf.js's).
  - `Extraction.retryOfId`, its `retryOf`/`retries` relation and `extraction_retry_pin_fkey/key/idx`: no reader or writer.
  - `ExtractionJob.retryDocument`, `rediscover`, `retryRecordStartBlockIds`: no reader or writer (the only mention is the 422 request-body test in `prototypes/studio/api/extractions.test.ts:313-327`, which posts them as unknown fields and stays).
  - `BatchExtraction.failure`, `finishedAt`: never selected (`postgres-persistence.ts:511`, `project-store.ts:985,1204`) and never written (`postgres-persistence.ts:1651`, `postgres-suggested-batch.ts:107`).
- **Kept, although the spec lists it as a Catalog-retry column:** `ExtractionJob.retryOfId` with its self-relation and `extraction_job_retry_pin_key/idx/fkey`. `jobIdentityMatches` reads it (`packages/extraction/src/postgres-persistence.ts:338,402`) and `extraction-module.integration.test.ts:1356` plants it. It leaves with `ExtractionJob` in M4.
- **Kept:** `AnnotationSetRevision` (read at `project-store.ts:1311`), `SchemaRevision.modelAttribution`, `BatchSchemaSuggestion.phase` SOURCES/MERGING (written by the pump until M4).
- `lockSourceDocumentRow` and the 409 `source_representation_superseded` from PR #140 are untouched by M2; their tests in `pnpm --filter extraction test:postgres` and `pnpm --filter studio test` must stay green in every task.
- `server/api-dispatcher.ts:8` accepts `/api/<[a-z_]+>` only, so `/api/model-keys` and `/api/ingestion-models` need `PARAMETERIZED` entries.
- `POST /auth/logout` (`server/app.ts:497`) never inspects the session; evicting keys needs `backend.inspect`.
- The Playwright suites run the **Vite development server** (`e2e/playwrightStack.ts`), never `server/static.ts`; `index.html` loads Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`); the sign-out form's POST is answered with a 302 to the identity provider (so the policy must not set `form-action`).
- kei has no OCR default today: `POST /api/runs` requires `model` (`api.py:105`) and Studio sends `KEI_EXP_MODEL` (`compose.yaml:117`, default `surya`). `KEI_OCR_MODEL` arrives in M3.
- `scripts/free.mjs` has no `parsing_db` stop entry at 84013ee (`free.mjs:450` stops `studio parsing_service parsing_worker`); its `parsing_db` coupling is `FREE_PARSING_POSTGRES_PASSWORD` (`free.mjs:421,547`), which leaves with `parsing_db` in M3.
- The AI SDK retries only `APICallError`/`GatewayError` with `isRetryable === true` (`node_modules/ai/dist/index.js:2822`); a thrown `ApiError` is never retried.

## Global Constraints

- **Worktree and branch:** work in `/home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6` on `feat/dbos-m2-m6` (based on `feat/kei-exp-parser` at 84013ee). Other agents write concurrently under `docs/plans/2026-09-24-unified-durable-execution-evidence/m0r*/`: never touch, stage or commit anything there. Stage explicit paths, never `git add -A .` at the root.
- **No DBOS in M2.** Add no `@dbos-inc/*` or `dbos` dependency. Where the spec names `DBOS.stepStatus.cancelSignal`, M2 takes an `AbortSignal` parameter that M4/M5 will compose with it.
- **No compatibility aliases** (spec, *Public contract changes*): update schemas, handlers, browser consumers and tests together; no legacy readers, no tolerant parsers, no old field names kept "for now".
- **Never print secrets.** Tests use synthetic keys shaped `sk-test-<purpose>` and assert they appear in no response body, error, log line or stored row. Handlers never log request bodies. `model_keys` and `model_probe` answer a malformed body with the fixed `400 invalid_request` and no `details` and no `cause`. Passwords for the kei role are never passed to PostgreSQL in plain text (Task 3 sends a SCRAM verifier) and never echoed by scripts.
- **Deletions:** implementer subagents may not run `git rm` without the user's authorization. For every deletion this plan lists, run plain `rm` (or `rm -r`) and then `git add -A <those exact paths>`; that is allowed.
- **Python:** run from `prototypes/parsing_service` with `uv run --no-sync …`; lint touched files with `uvx ruff check <files>`. Never `pip`. `pnpm install` must be run with `FREE_SKIP_PYTHON=1` so the root `postinstall` does not `uv sync`.
- **Test tiers (exact commands):**
  - Studio: `pnpm --filter studio typecheck`, `pnpm --filter studio lint`, `pnpm --filter studio test`. One file: `pnpm --filter studio exec vitest run <path>`. Browser tests start with `// @vitest-environment jsdom`.
  - Studio E2E (starts its own Docker PostgreSQL and mock OIDC, then Vite): `pnpm --filter studio test:e2e`; one spec: `pnpm --filter studio exec playwright test e2e/<name>.spec.ts`.
  - db: `pnpm --filter db typecheck`, `pnpm --filter db test`, and `pnpm --filter db test:postgres` with `PROJECT_STORE_POSTGRES_URL` exported.
  - extraction: `pnpm --filter extraction typecheck`, `pnpm --filter extraction test`, and `pnpm --filter extraction test:postgres` with `EXTRACTION_TEST_DATABASE_URL` exported.
  - Parsing fast: `cd prototypes/parsing_service && uv run --no-sync pytest -q -m "not postgres and not live_model"`.
  - Safety (Docker needed for Compose rendering): `pnpm test:safety`. Scripts: `node --test scripts/free.test.mjs`.
  - Whole repository: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:postgres`, `pnpm test:e2e`, `pnpm test:service`.
- **Disposable databases only** (README #10): user `postgres`, loopback, explicit port 5432, databases `free_test_*`; the guards refuse anything else. The M1 container `free-m1-pg` may already be running on `127.0.0.1:5432`; reuse it, never stop it or any other service. Every task that changes `contract.prisma` must recreate its databases, because a from-null baseline does not apply to a database signed by the old chain:
  ```bash
  docker ps --filter name=free-m1-pg --format '{{.Names}}'   # prints free-m1-pg when it is running
  # Only if it is not running and port 5432 is free (never stop another service to free it):
  docker run --rm -d --name free-m1-pg --mount type=tmpfs,destination=/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=m1-disposable-only \
    -e POSTGRES_DB=free_test_parsing postgres:17
  for name in free_test_m2_store free_test_m2_extraction; do
    docker exec free-m1-pg dropdb -U postgres --if-exists "$name"
    docker exec free-m1-pg createdb -U postgres "$name"
  done
  export PROJECT_STORE_POSTGRES_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m2_store
  export EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m2_extraction
  DATABASE_URL=$PROJECT_STORE_POSTGRES_URL pnpm --filter db db:init
  DATABASE_URL=$EXTRACTION_TEST_DATABASE_URL pnpm --filter db db:init
  ```
  If `free-m1-pg` was started with another password, ask the controller for it rather than restarting the container. `project-store.postgres.check.ts` requires an empty database, so recreate both before each `test:postgres` run.
- **Development database:** after Task 1, an existing `pnpm dev` stack's `postgres-data` volume carries the old migration chain and `db:init` will refuse it. Do not reset it yourself; tell the controller that the developer must recreate it once.
- **Contract generation:** after any `contract.prisma` edit run `DATABASE_URL=postgresql://contract:emit@127.0.0.1:5432/free pnpm --filter db contract:emit` (the URL is never dialled). `src/prisma/contract.{d.ts,json}` and `migrations/app/refs/*.contract.*` are generated and gitignored.
- **Copy (verbatim):** "Model Configuration", "Models", "Connections", "Reading documents", "Schema & chat", "Extracting data", "Assistant model", "Schema Suggestion", "Change", "Use defaults", "Use a different model", "Use the assistant model", "Close Model Configuration" (existing accessible name, kept).
- **Constants:** `MODEL_KEY_WAIT_MS = 60_000`; the boot header is `X-FREE-Studio-Boot`; browser storage key `free.modelKeys.v1:<researcherAccountId>`; reserved deployment connection IDs `…d001` (instruct), `…d002` (NuExtract), `…d003` (Codex CLI), `…d004` (Claude Code).
- **Commits:** one per task, conventional prefix (`feat`, `refactor`, `test`, `chore`, `docs`), message ending with the session's attribution line. Never `git stash`, `reset` or `commit --amend` another task's work.

## Plan decisions (not settled by the spec; settled here)

1. **Configuration row lock.** `ModelConfiguration.document` is nullable; `apply` runs `upsert({ create: { researcherAccountId }, update: { updatedAt } })` inside the transaction, which inserts the row on first use or takes its lock (`ON CONFLICT DO UPDATE`), and only then reads, validates and writes the document. The lock statement never writes `document`, because a value read before the lock could overwrite a concurrent commit. A committed row always has a document; `null` exists only inside the first apply's transaction.
2. **`model_key_required`** is `409`, `isRetryable: false`, with a fixed message that names no connection and no key.
3. **`PUT /api/model-keys`** body `{ account, keys: { [connectionId]: { provider, baseUrl, key } | null } }`; `409 account_mismatch` when `account` is not the session's; an entry is cached only for the account's own `hasKey` connection at its current provider and base, otherwise silently skipped; `null` removes. Response `200 { accepted: string[] }` (IDs only).
4. **Boot ID** lives in the same module as the process key cache (`studioProcess = { bootId, keys }`): the ID names the cache's lifetime, which is exactly what a page must know to resend. Every `/api` response carries it.
5. **`hasKey`:** managed kinds (OpenAI, Anthropic, Google) always `true`; deployment connections always `false`; CLI kinds are never researcher connections (Task 11); for optional kinds (Ollama, vLLM, OpenAI-compatible) the page sets it from the key line: saving a key sets it, "Remove" or "Use without a key" clears it.
6. **Probe credentials:** a probe carries a credential exactly when the connection has `hasKey`; Studio rejects a `hasKey` probe without one and a non-`hasKey` probe with one (`409 invalid_model_config`), and never looks a key up.
7. **CSP:** `default-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self'` on the production app shell only (not on assets, so pdf.js's worker keeps its WASM decoders). No `form-action` (sign-out redirects to the identity provider). Development delivers the same policy as a `<meta>` element plus the SHA-256 hashes of Vite's own inline scripts and `ws: wss:`.
8. **kei role:** a Node script on `pg` (the Studio image has no `psql`), SCRAM verifier computed client-side, `REVOKE ALL ON SCHEMA public FROM PUBLIC` (Studio connects as the database owner and is unaffected).
9. **Ingestion listing default:** kei's `DEFAULT_OCR_MODEL = os.environ.get("KEI_OCR_MODEL", "surya")`; layout default `DEFAULT_LAYOUT_MODEL`. M3 wires `KEI_OCR_MODEL` through Compose and makes `convert` use it.
10. **`FREE_DEPLOYMENT_CLI_PROVIDERS`:** comma-separated `codex-cli`, `claude-code`; unknown entries are ignored.
11. **Model calls take the owner:** `generateSchemaWithModel`, `generateSchemaEditJson` and `streamChatWithModel` take a `ModelCaller` (`{ researcherAccountId }`) first; there is no accountless default.

## Review Focus

1. **A concurrent Apply loses the other's write**, or a first Apply races the row's creation. Expected: one account's applies serialize and each sees the previous commit. Pinned by Task 2, `concurrent applies of one account serialize and the second sees the first's document`.
2. **A cached or stored key reaches a different API base** — after Apply re-addresses a connection, or when a draft changes the base and a scheduled probe fires. Expected: never. Pinned by Task 6 (`a key sent for one API base is never read for another`, `retain drops …`), Task 9 (`a draft base change clears the typed key and never probes the new base with the old key`), Task 14 (e2e).
3. **A `hasKey` connection is called anonymously** — a factory built with `null` actually used, or NuExtract sending no `Authorization`. Expected: the attempt waits, then fails with `model_key_required`, and the server is never contacted. Pinned by Task 6 (`keyedModel …`) and Task 9 (`a hasKey route with no cached key waits, then fails without calling its server`, NuExtract variant).
4. **An aborted call still reaches the provider after the key wait**, or the wait leaks timers/listeners. Pinned by Task 6 (`wait rejects on abort …`, `keyedModel stops before the provider when the signal aborts during the wait`).
5. **The boot-ID resend loops or storms** (first response, the PUT's own response, concurrent requests). Pinned by Task 6 (`authenticatedFetch …` cases) and Task 12.
6. **The CSP breaks the PDF viewer, fonts, sign-out or the dev server's React Refresh.** Pinned by Task 5 (`e2e/app-shell-csp.spec.ts`, full e2e run, unit tests).
7. **Background suggestion work resolves the wrong account** (session instead of owner, or an accountless default). Pinned by Task 7 (`the pump resolves the Project Context owner's configuration`).
8. **A malformed `model_keys`/`model_probe` body echoes a key** through Zod details or a JSON parse cause. Pinned by Task 9 (`a malformed … echoes nothing and logs nothing`).

## Deferred to later milestones (spec M2 items this plan does not do)

| Spec M2 item | Goes to | Reason |
|---|---|---|
| Remove `parsing_db`, `parsing-postgres`, `parsing_migrate`, the parsing API's database environment | M3 | Ruling 2: Procrastinate needs them until M3 |
| Add the `source-inbox` volume | M3/M4, with its first writer/reader | Ruling 2 |
| `parsing_worker` waits for Studio's healthcheck; remove Studio's `depends_on: parsing_worker` | M3 | Ruling 2: kei's DBOS worker is the consumer |
| `scripts/free.mjs`: drop `parsing_db` (no stop entry exists; `FREE_PARSING_POSTGRES_PASSWORD` in dev env, production validation and `.env.example`) | M3 | Ruling 2 |
| Safety test: a parsing API without database access | M3 | Ruling 3 |
| Safety test: kei's restricted URL | M3 (needs controller confirmation) | No M2 process uses a kei URL on `db`; the kei worker gets one in M3 (same reasoning as Ruling 3) |
| Baseline: drop `ExtractionJob` (incl. `retryOfId`), `BatchExtractionMember`, ingestion keys; per-source suggestion columns and transient phases; Extraction admission inputs/outcome; batch/source uniqueness; suggestion `attempt`/outcome; cascading membership | M4 baseline edit | Ruling 1 |
| Baseline: `ChatTurn` | M5 baseline edit | Ruling 1 |
| Key wrapper composes `DBOS.stepStatus.cancelSignal` | M4/M5 | No DBOS in M2; the wrapper already takes an `AbortSignal` |
| Admission resolves the owner's Ingestion Model Choice into `convert` | M3 (inputs) / M4 (admission) | Spec: stored from M2, used from M4 |
| `docs/operations/deployment.md` (`FREE_KEI_POSTGRES_PASSWORD`, `FREE_DEPLOYMENT_CLI_PROVIDERS`, the obsolete `model-config.json` paragraph), README #7/#10, CONTEXT.md, ADR 0013 and amendments to 0007/0011 | M6 | Spec *Milestones → M6* |

---

## Task 1: One baseline migration without dead schema, with the `ModelConfiguration` table

**Files:**
- Modify: `packages/db/src/prisma/contract.prisma`
- Delete: `packages/db/migrations/app/20260820T0540_baseline/`, `20260824T0914_source_document_content_identity/`, `20260824T0947_extraction_value_review_decisions/`, `20260826T1742_entra_researcher_identity/`, `20260827T1819_version_extraction_reviews/`, `20260831T1023_extraction_jobs/`, `20260906T2044_extraction_review_drafts/`, `20260923T1050_extraction_job_catalog_recipe/`, `20260923T1547_extraction_requested_models/`, `20260923T1946_source_reprocessing/`
- Create (generated): `packages/db/migrations/app/<UTC timestamp>_baseline/` (`migration.json`, `migration.ts`, `ops.json`, `end-contract.json`, `end-contract.d.ts`)
- Modify (generated): `packages/db/migrations/app/refs/db.json`
- Delete: `packages/db/src/entra-auth-migration.test.ts`, `packages/db/src/extraction-job-migration.test.ts`
- Modify: `packages/db/src/project-store.postgres.check.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the ORM model `ModelConfiguration { researcherAccountId: string (PK, FK → ResearcherAccount, cascade), document: Json | null, updatedAt: Date }` and `ResearcherAccount.modelConfiguration`. No other model gains or changes a field.

- [ ] **Step 1: Re-verify the drop list against the code**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -rnwE "PromptRevision|SchemaSuggestionInput|ConversationalSchemaEdit|conversationalSchemaEditId|schemaSuggestionId|promptRevisionId" packages prototypes/studio --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=migrations | grep -v "contract\.d\.ts"
  grep -rnwE "retryDocument|rediscover|retryRecordStartBlockIds" packages prototypes/studio --include=*.ts --exclude-dir=node_modules --exclude-dir=migrations | grep -v "contract\.d\.ts"
  grep -rnw "retryOfId" packages prototypes/studio --include=*.ts --exclude-dir=node_modules --exclude-dir=migrations | grep -v "contract\.d\.ts"
  grep -rn "AttemptOutcome\|annotationMode:" packages prototypes/studio --include=*.ts --exclude-dir=node_modules --exclude-dir=migrations | grep -v "contract\.d\.ts"
  ```
  Expected: the first grep lists only `project-store.postgres.check.ts`; the second only `prototypes/studio/api/extractions.test.ts`; the third `postgres-persistence.ts` and `extraction-module.integration.test.ts` (ExtractionJob, kept) plus the two Studio contract/422 tests; the fourth only `project-store.postgres.check.ts`. Anything else means a reader exists: keep that field and report it.

- [ ] **Step 2: Edit `contract.prisma`**

  1. Delete the enums `AttemptOutcome` and `AnnotationMode`.
  2. Delete the models `PromptRevision`, `SchemaSuggestion`, `ConversationalSchemaEdit`, `SchemaSuggestionInput`.
  3. `ExtractionSchema`: delete `promptRevisions`, `suggestions`, `conversationalEdits`.
  4. `SourceRepresentationRevision`: delete `schemaSuggestionInputs`, `conversationalEdits`.
  5. `AnnotationSetRevision`: delete `schemaSuggestionInputs`, `conversationalEdits`.
  6. `SchemaRevision`: delete `schemaSuggestionId`, `schemaSuggestion`, `conversationalSchemaEditId`, `conversationalSchemaEdit`, `conversationalEditBases`.
  7. `BatchExtraction`: delete `failure` and `finishedAt`.
  8. `ExtractionJob`: delete `retryDocument`, `rediscover`, `retryRecordStartBlockIds`. Keep `retryOfId`, `retryOf`, `retries` and both `extraction_job_retry_pin_*` constraints, with this comment above `retryOfId`:
     ```prisma
     // Read only by jobIdentityMatches' guard against pre-M1 retry rows; leaves with ExtractionJob in M4.
     ```
  9. `Extraction`: delete `retryOfId`, `retryOf`, `retries`, `@@unique([id, sourceRepresentationRevisionId, schemaRevisionId, strategy], map: "extraction_retry_pin_key")` and `@@index([retryOfId, …], map: "extraction_retry_pin_idx")`.
  10. `ResearcherAccount`: add `modelConfiguration ModelConfiguration?` after `projectContexts`.
  11. Add after `ResearcherAccount`:
      ```prisma
      // One Researcher Account's Model Configuration: its Model Connections (whether each uses a key, never the key),
      // Capability Routes, Extraction Model Choice and Ingestion Model Choice. Studio validates `document` before every
      // write. A committed row always has a document: null exists only inside the first apply's transaction, which
      // creates the row to lock it (packages/db/src/model-configuration-store.ts).
      model ModelConfiguration {
        researcherAccountId Uuid              @id
        document            Json?
        updatedAt           Timestamptz6      @default(now())
        researcherAccount   ResearcherAccount @relation(fields: [researcherAccountId], references: [id], onDelete: Cascade)
      }
      ```

- [ ] **Step 3: Regenerate the contract and replace the migration history with one baseline**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6/packages/db
  export CONTRACT_URL=postgresql://contract:emit@127.0.0.1:5432/free
  DATABASE_URL=$CONTRACT_URL pnpm contract:emit
  rm -r migrations/app/2026*
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration plan --name baseline --no-interactive
  cat migrations/app/*_baseline/migration.json          # note the "to" hash
  DATABASE_URL=$CONTRACT_URL npx prisma-next ref set db <the "to" hash> --no-interactive
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration check --no-interactive
  ```
  Expected: one `*_baseline` directory with `"from": null`; `refs/db.json` names the same hash; `migration check` prints `All checks passed`. This recipe was probed on a scratch copy on 2026-09-26. Open `migration.ts` and confirm it creates `modelConfiguration` and none of `promptRevision`, `schemaSuggestion`, `schemaSuggestionInput`, `conversationalSchemaEdit`. Later milestones rerun the same recipe after editing `contract.prisma` ("edited in place").

- [ ] **Step 4: Delete the two historical migration tests**

  ```bash
  rm packages/db/src/entra-auth-migration.test.ts packages/db/src/extraction-job-migration.test.ts
  ```

- [ ] **Step 5: Rewrite the cascade fixture**

  In `packages/db/src/project-store.postgres.check.ts`, replace everything from `const prompt = await db.orm.public.PromptRevision.create({` through the `appliedRevision` creation with:
  ```ts
  await db.orm.public.SchemaRevision.create({
    extractionSchemaId: schema.id,
    revisionNumber: 1,
    origin: 'RESEARCHER_EDIT',
    schemaTree: [],
  })
  const appliedRevision = await db.orm.public.SchemaRevision.create({
    extractionSchemaId: schema.id,
    revisionNumber: 2,
    origin: 'MODEL_EDIT',
    schemaTree: [],
  })
  ```
  Keep the `annotation` row (its cascade is still asserted). In the final `for (const table of [...])` list delete `PromptRevision`, `SchemaSuggestion`, `SchemaSuggestionInput` and `ConversationalSchemaEdit`.

- [ ] **Step 6: Run every tier that reads the schema**

  Recreate and migrate both disposable databases (Global Constraints recipe), then:
  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio test
  pnpm --filter studio test:e2e
  ```
  Expected: all pass. The e2e run proves the Playwright stack migrates a fresh database with the new baseline (`e2e/playwrightStack.ts` runs `db:init`).

- [ ] **Step 7: Residue check and commit**

  ```bash
  grep -rnwE "PromptRevision|SchemaSuggestionInput|ConversationalSchemaEdit|AttemptOutcome|AnnotationMode" packages --include=*.ts --include=*.prisma --exclude-dir=node_modules
  git add -A packages/db/migrations packages/db/src/prisma/contract.prisma packages/db/src/project-store.postgres.check.ts packages/db/src/entra-auth-migration.test.ts packages/db/src/extraction-job-migration.test.ts
  git commit -m "refactor(db)!: replace the migration history with one baseline without dead schema"
  ```
  Expected grep output: nothing (pdf.js's `AnnotationMode` lives in `prototypes/studio`, outside this grep).

## Task 2: `ModelConfigurationStore` and the Project Context owner lookup

**Files:**
- Create: `packages/db/src/model-configuration-store.ts`
- Create: `packages/db/src/model-configuration.postgres.check.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/src/project-store.ts` (`InternalProjectWorkerStore`), `packages/db/package.json`

**Interfaces:**
- Consumes: Task 1's `ModelConfiguration` model.
- Produces:
  ```ts
  export type ModelConfigurationStore = {
    read(researcherAccountId: string): Promise<unknown | null>
    apply(researcherAccountId: string, next: (previous: unknown | null) => unknown | Promise<unknown>): Promise<unknown>
  }
  export function createModelConfigurationStore(database?: Database): ModelConfigurationStore
  // InternalProjectWorkerStore gains:
  projectContextOwner(projectContextId: string): Promise<string | null>
  ```

- [ ] **Step 1: Write the PostgreSQL check first**

  Create `packages/db/src/model-configuration.postgres.check.ts` in the style of `project-store.postgres.check.ts` (top-level `test`, throws when `PROJECT_STORE_POSTGRES_URL` is unset, `validateDisposableTestDatabaseTarget`, sets `process.env.DATABASE_URL`, dynamic imports). It must not assume an empty database, creates its own accounts with `randomUUID()` tenant/object IDs, and deletes them in `after`. Sub-tests:
  - `an account that never applied reads null`
  - `an apply is read back, and another account still reads null`
  - `a failing next writes nothing, not even the row` (after the rejection, `db.orm.public.ModelConfiguration.select('researcherAccountId').first({ researcherAccountId })` is `null`)
  - `concurrent applies of one account serialize and the second sees the first's document`:
    ```ts
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = store.apply(a.id, async () => {
      entered.resolve()
      await release.promise
      return { n: 1 }
    })
    await entered.promise
    let seen: unknown = 'not yet'
    const second = store.apply(a.id, (previous) => {
      seen = previous
      return { n: 2 }
    })
    await setTimeout(300)
    assert.equal(seen, 'not yet') // waiting on the configuration row's lock
    release.resolve()
    await Promise.all([first, second])
    assert.deepEqual(seen, { n: 1 })
    assert.deepEqual(await store.read(a.id), { n: 2 })
    ```
    Run it twice: once when account A has no row yet (both applies race the first insert) and once after a first apply.
  - `applies of two accounts do not wait for each other` (A's `next` blocks on a gate; B's apply completes before the gate opens)
  - `deleting the account deletes its configuration`
  - `the table stores no key: only researcherAccountId, document and updatedAt` (`SELECT column_name FROM information_schema.columns WHERE table_name = 'modelConfiguration' ORDER BY 1`)
  - `projectContextOwner names the owning account and null for an unknown project` (create a project with `createResearcherProjectStore(a.id, db).createProjectContext('Owner check')`, delete it afterwards)

  Add it to the end of `test:postgres` in `packages/db/package.json`:
  `"test:postgres": "tsx --test --test-concurrency=1 src/project-store.postgres.check.ts src/source-reprocessing.postgres.check.ts src/model-configuration.postgres.check.ts"`

- [ ] **Step 2: Run it and see it fail**

  Run: `pnpm --filter db test:postgres` (fresh databases). Expected: FAIL, the store module does not exist.

- [ ] **Step 3: Implement the store**

  ```ts
  import { db, type Database } from './prisma/db.js'

  /**
   * One Researcher Account's Model Configuration document. Studio validates it before every write; keys never enter
   * it. The store only guarantees that one account's applies run one at a time, each reading the document the
   * previous one committed.
   */
  export type ModelConfigurationStore = {
    /** The account's document, or null before its first apply. */
    read(researcherAccountId: string): Promise<unknown | null>
    /**
     * Replaces the account's document in one transaction that holds the configuration row's lock. `next` receives the
     * committed document (null before the first apply) and returns the one to store; when it throws, nothing is
     * written and the error propagates.
     */
    apply(
      researcherAccountId: string,
      next: (previous: unknown | null) => unknown | Promise<unknown>,
    ): Promise<unknown>
  }

  export function createModelConfigurationStore(database: Database = db): ModelConfigurationStore {
    return {
      async read(researcherAccountId) {
        const row = await database.orm.public.ModelConfiguration.select('document').first({ researcherAccountId })
        return row?.document ?? null
      },
      apply(researcherAccountId, next) {
        return database.transaction(async ({ orm }) => {
          // Inserts the row on the account's first apply, otherwise takes its lock (ON CONFLICT DO UPDATE); a
          // concurrent first insert makes this statement wait for that transaction. The lock statement never writes
          // `document`: a value read before the lock could overwrite a concurrent commit.
          const locked = await orm.public.ModelConfiguration.upsert({
            create: { researcherAccountId },
            update: { updatedAt: new Date() },
          })
          const document = await next(locked.document ?? null)
          await orm.public.ModelConfiguration.where({ researcherAccountId }).update({ document, updatedAt: new Date() })
          return document
        })
      },
    }
  }
  ```
  If the serialization check fails because this Prisma Next version's `upsert` does not take the lock, keep the same transaction but ensure the row with `upsert({ create: { researcherAccountId }, update: {} })`, lock it with `where({ researcherAccountId }).update({ updatedAt: new Date() })`, and read the document afterwards with `select('document').first(...)`. The check decides; do not weaken it.

  Export from `packages/db/src/index.ts`:
  ```ts
  export { createModelConfigurationStore } from './model-configuration-store.js'
  export type { ModelConfigurationStore } from './model-configuration-store.js'
  ```

- [ ] **Step 4: Add `projectContextOwner`**

  In `InternalProjectWorkerStore` (type near `project-store.ts:669`) add:
  ```ts
  /** The Researcher Account that owns the Project Context, or null when it no longer exists. Background model work
   *  resolves the owner's configuration and keys through it. */
  projectContextOwner(projectContextId: string): Promise<string | null>
  ```
  and in `createInternalProjectWorkerStore`:
  ```ts
  async projectContextOwner(projectContextId) {
    const project = await database.orm.public.ProjectContext.select('researcherAccountId').first({ id: projectContextId })
    return project?.researcherAccountId ?? null
  },
  ```
  Update every fake `InternalProjectWorkerStore` the typecheck names (Studio's `api/project_operations.test.ts`, `api/durable_operations.test.ts`, …) with a `projectContextOwner` returning the fixture's account.

- [ ] **Step 5: Run the tiers**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test
  # recreate + migrate both databases, then:
  pnpm --filter db test:postgres
  pnpm --filter extraction typecheck && pnpm --filter studio typecheck && pnpm --filter studio test
  ```
  Expected: all pass.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/db/src/model-configuration-store.ts packages/db/src/model-configuration.postgres.check.ts packages/db/src/index.ts packages/db/src/project-store.ts packages/db/package.json prototypes/studio/api
  git commit -m "feat(db): store one Model Configuration per Researcher Account behind a row lock"
  ```

## Task 3: kei's database role and schema at Studio start; Studio's dev watch restarts server code

**Files:**
- Create: `packages/db/src/kei-role.ts`, `packages/db/src/kei-role.test.ts`, `packages/db/src/ensure-kei-role.ts`, `packages/db/src/kei-role.postgres.check.ts`
- Modify: `packages/db/package.json`, `docker/studio-entrypoint.sh`, `compose.override.yaml`, `compose.prod.yaml`, `scripts/free.mjs`, `scripts/free.test.mjs`, `.env.example`, `tests/safety.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `ensureKeiRole(client: ClientBase, options: { password: string; role?: string; schema?: string }): Promise<void>`; `scramSha256Verifier(password: string, salt?: Buffer, iterations?: number): string`; `KEI_ROLE = 'kei'`, `KEI_SCHEMA = 'kei_dbos'`; operator command `pnpm --filter db db:kei-role` (reads `DATABASE_URL`, `FREE_KEI_POSTGRES_PASSWORD`). M3's kei worker connects as `kei` to `free` with `kei_dbos` as its DBOS system schema.

- [ ] **Step 1: Write the failing tests**

  `packages/db/src/kei-role.test.ts` (unit, no database):
  - `the verifier is SCRAM-SHA-256 and never contains the password`: `scramSha256Verifier('p'.repeat(32), Buffer.alloc(16, 1), 4096)` matches `/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/` and does not include the password.
  - `role and schema names must be plain lowercase identifiers` (`ensureKeiRole` with `role: 'kei; drop'` rejects before issuing any query; use a fake client whose `query` records calls).

  `packages/db/src/kei-role.postgres.check.ts` (uses `PROJECT_STORE_POSTGRES_URL`, validated; unique names so it never touches a real `kei`):
  ```ts
  const suffix = randomBytes(4).toString('hex')
  const role = `free_test_kei_${suffix}`
  const schema = `free_test_kei_dbos_${suffix}`
  const password = randomBytes(24).toString('hex')
  // Studio's DBOS schema arrives in M4. A schema the Studio role creates grants PUBLIC nothing; this stands in for it.
  await owner.query('CREATE SCHEMA IF NOT EXISTS dbos')
  await owner.query('CREATE TABLE IF NOT EXISTS dbos.workflow_status (workflow_uuid text PRIMARY KEY)')
  await owner.query('CREATE TABLE IF NOT EXISTS public.kei_denial_probe (id int)')
  await ensureKeiRole(owner, { role, schema, password })
  await ensureKeiRole(owner, { role, schema, password }) // a Studio restart runs it again
  const keiUrl = new URL(databaseUrl); keiUrl.username = role; keiUrl.password = password
  // connect `kei` with keiUrl, then:
  for (const sql of [
    'SELECT count(*) FROM public.kei_denial_probe',
    'CREATE TABLE public.kei_probe (id int)',
    'SELECT count(*) FROM dbos.workflow_status',
    'CREATE TABLE dbos.kei_probe (id int)',
    `CREATE SCHEMA kei_other_${suffix}`,
  ]) await assert.rejects(kei.query(sql), (error: { code?: string }) => error.code === '42501', sql)
  await kei.query(`CREATE TABLE ${schema}.probe (id int)`)
  await kei.query(`INSERT INTO ${schema}.probe VALUES (1)`)
  ```
  Test name: `kei logs in with its own role, owns only kei_dbos, and is denied on public and dbos`. Cleanup in `after`: end the kei client; as owner `DROP SCHEMA IF EXISTS <schema> CASCADE`, `DROP SCHEMA IF EXISTS dbos CASCADE`, `DROP TABLE IF EXISTS public.kei_denial_probe`, `DROP OWNED BY <role>`, `DROP ROLE IF EXISTS <role>`, `GRANT USAGE ON SCHEMA public TO PUBLIC`. Append the file to `test:postgres`, and add `"db:kei-role": "tsx src/ensure-kei-role.ts"` to the scripts.

  In `tests/safety.test.mjs`:
  - add `'db:kei-role'` to the supported list in `database tooling: package exposes only supported operator commands`;
  - add `FREE_KEI_POSTGRES_PASSWORD: 'd'.repeat(64)` to the production environment fixture near line 100;
  - new test `kei role: only Studio receives the kei password, after migrations`: render the development Compose file (existing `renderDevelopmentCompose`) and assert `services.studio.environment.FREE_KEI_POSTGRES_PASSWORD` is set and no other service has it; read `compose.prod.yaml` and assert it contains `FREE_KEI_POSTGRES_PASSWORD:?`; read `docker/studio-entrypoint.sh` and assert `db:kei-role` appears after `db:init` and before `exec "$@"`.
  - rewrite `development: Studio watches shared configuration and rebuild-owned database inputs` for the new rules (Step 5): a `sync+restart` rule for `/prototypes/studio` whose `ignore` contains `src/`; a `sync` rule for `/prototypes/studio/src` targeting `/workspace/prototypes/studio/src`; `sync+restart` for `/packages/db` (keeping the rebuild-owned ignores), `/packages/studio-configuration`, `/packages/extraction`, `/packages/extraction-result-export`; and no `sync` rule other than the `src/` one.

  In `scripts/free.test.mjs`: add `FREE_KEI_POSTGRES_PASSWORD` to the fixture (line ~570), to the required-fields list (line ~590) and to the hexadecimal-password loop (line ~654).

- [ ] **Step 2: Run them and see them fail**

  ```bash
  pnpm --filter db test
  pnpm --filter db test:postgres   # fresh databases
  node --test scripts/free.test.mjs
  pnpm test:safety
  ```
  Expected: FAIL (missing module, missing script, missing environment, old watch rules).

- [ ] **Step 3: Implement `kei-role.ts` and the script**

  ```ts
  import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
  import type { ClientBase } from 'pg'

  export const KEI_ROLE = 'kei'
  export const KEI_SCHEMA = 'kei_dbos'
  const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

  /** A SCRAM-SHA-256 verifier, so the plain password never reaches PostgreSQL or its logs. ASCII passwords only. */
  export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096): string {
    const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
    const clientKey = createHmac('sha256', salted).update('Client Key').digest()
    const storedKey = createHash('sha256').update(clientKey).digest()
    const serverKey = createHmac('sha256', salted).update('Server Key').digest()
    return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  }

  /**
   * kei parses untrusted PDFs, so its role owns its own DBOS schema and nothing else: it cannot read or rewrite
   * Studio's tables in `public` or Studio's workflow inputs in `dbos`. Idempotent; runs as the database owner after
   * the migrations, on every Studio start.
   */
  export async function ensureKeiRole(
    client: ClientBase,
    options: Readonly<{ password: string; role?: string; schema?: string }>,
  ): Promise<void> {
    const role = options.role ?? KEI_ROLE
    const schema = options.schema ?? KEI_SCHEMA
    if (!IDENTIFIER.test(role) || !IDENTIFIER.test(schema))
      throw new Error('The kei role and schema must be plain lowercase identifiers.')
    if (!/^[\x21-\x7e]+$/.test(options.password))
      throw new Error('FREE_KEI_POSTGRES_PASSWORD must be printable ASCII.')
    const verifier = client.escapeLiteral(scramSha256Verifier(options.password))
    await client.query('BEGIN')
    try {
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1
      await client.query(
        `${exists ? 'ALTER' : 'CREATE'} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${verifier}`,
      )
      // PostgreSQL grants every role USAGE on `public`; Studio connects as the database owner and is unaffected.
      await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}`)
      await client.query(`ALTER SCHEMA ${schema} OWNER TO ${role}`)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
  ```
  `packages/db/src/ensure-kei-role.ts`:
  ```ts
  import { Client } from 'pg'
  import { ensureKeiRole } from './kei-role.js'

  const url = process.env.DATABASE_URL
  const password = process.env.FREE_KEI_POSTGRES_PASSWORD
  if (!url || !password) {
    console.error('DATABASE_URL and FREE_KEI_POSTGRES_PASSWORD must be set.')
    process.exit(1)
  }
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await ensureKeiRole(client, { password })
  } finally {
    await client.end()
  }
  console.log('The kei role and its kei_dbos schema are ready.')
  ```

- [ ] **Step 4: Wire the entrypoint, Compose, `free.mjs` and `.env.example`**

  `docker/studio-entrypoint.sh`: after the `DATABASE_URL` check add `: "${FREE_KEI_POSTGRES_PASSWORD:?FREE_KEI_POSTGRES_PASSWORD must be set}"`, and after `pnpm --filter db db:init` add:
  ```sh
  # kei (the Parsing Service's DBOS worker from M3) logs in with its own role, which owns only kei_dbos.
  pnpm --filter db db:kei-role
  ```
  (The D-Bus and keyring lines stay until Task 10.)

  `compose.override.yaml`, `studio.environment`: `FREE_KEI_POSTGRES_PASSWORD: "${FREE_KEI_POSTGRES_PASSWORD:-kei-development}"`.
  `compose.prod.yaml`, `studio.environment`: `FREE_KEI_POSTGRES_PASSWORD: "${FREE_KEI_POSTGRES_PASSWORD:?FREE_KEI_POSTGRES_PASSWORD must be set to a generated hexadecimal password}"`.
  `scripts/free.mjs` `validateProductionEnvironment`: the loop at line 547 becomes `for (const field of ['FREE_POSTGRES_PASSWORD', 'FREE_PARSING_POSTGRES_PASSWORD', 'FREE_KEI_POSTGRES_PASSWORD'])`.
  `.env.example`: after `FREE_PARSING_POSTGRES_PASSWORD` add
  ```
  # The Parsing Service's own database role (from M3 its DBOS worker); Studio creates it at start.
  FREE_KEI_POSTGRES_PASSWORD=<separately-generated-hex-output>
  ```

- [ ] **Step 5: Split Studio's development watch**

  In `compose.override.yaml` replace the first `studio` watch rule (the whole-package `sync` of `./prototypes/studio`) with the two rules below, and change the four `packages/*` `sync` rules to `sync+restart` without changing their `ignore` lists:
  ```yaml
          # Server code (api/, server/, shared/, the Vite and TypeScript configs) runs in the Studio process. From M4
          # that process also hosts DBOS, which launches once per process, so an edit restarts the container instead
          # of re-evaluating modules in place. Only the browser source below hot-reloads.
          - action: sync+restart
            path: ./prototypes/studio
            target: /workspace/prototypes/studio
            initial_sync: true
            ignore:
              - package.json
              # Hot-reloaded by the next rule.
              - src/
              - e2e/
              - playwright.config.ts
              - node_modules/
              - dist/
              - dist-lib/
              - test-results/
              - .certs/
              - .design-sync/
          - action: sync
            path: ./prototypes/studio/src
            target: /workspace/prototypes/studio/src
            initial_sync: true
  ```
  Update the file's header comment ("live source sync that restarts …") to say server code restarts Studio and browser source syncs live. Do not touch any `depends_on` (Ruling 2).

- [ ] **Step 6: Run the tiers**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres
  node --test scripts/free.test.mjs
  pnpm test:safety
  docker compose -f compose.yaml -f compose.override.yaml config --quiet   # needs FREE_SESSION_SECRET exported to any value
  ```
  Expected: all pass.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/db/src/kei-role.ts packages/db/src/kei-role.test.ts packages/db/src/ensure-kei-role.ts packages/db/src/kei-role.postgres.check.ts packages/db/package.json docker/studio-entrypoint.sh compose.override.yaml compose.prod.yaml scripts/free.mjs scripts/free.test.mjs .env.example tests/safety.test.mjs
  git commit -m "feat(platform): create kei's restricted role and schema at Studio start; restart Studio on server edits"
  ```

## Task 4: kei's `GET /api/ingestion-models` and Studio's forwarding route

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/models.py`, `prototypes/parsing_service/src/kei_exp/api.py`, `prototypes/parsing_service/README.md`
- Create: `prototypes/parsing_service/tests/test_ingestion_models.py`
- Modify: `packages/extraction/src/kei-exp.ts`, `packages/extraction/src/index.ts`, `packages/extraction/src/module.test.ts`
- Modify: `prototypes/studio/shared/modelConfig.contract.ts`, `prototypes/studio/shared/modelConfig.contract.test.ts`
- Create: `prototypes/studio/api/ingestion_models.ts`, `prototypes/studio/api/ingestion_models.test.ts`
- Modify: `prototypes/studio/server/api-dispatcher.ts`, `prototypes/studio/server/api-dispatcher.test.ts`, `prototypes/studio/src/api.ts`, `prototypes/studio/src/api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (shared contract, additive):
  ```ts
  export const INGESTION_MODEL_ROLES = ['ocr', 'layout'] as const
  export const ingestionModelRoleSchema = z.enum(INGESTION_MODEL_ROLES)
  export type IngestionModelRole = z.infer<typeof ingestionModelRoleSchema>
  /** A kei model key: a `kei_exp.models.MODELS` key for `ocr`, a `LAYOUT_MODELS` key for `layout`. Never a Model
   *  Connection's model. */
  export const ingestionModelKeySchema = z.string().min(1).max(128)
  const ingestionModelOptionSchema = z
    .object({ key: ingestionModelKeySchema, label: z.string().min(1), serving: z.boolean() })
    .strict()
  export const ingestionModelListingSchema = z
    .object({
      defaults: z.object({ ocr: ingestionModelKeySchema, layout: ingestionModelKeySchema }).strict(),
      models: z.object({ ocr: z.array(ingestionModelOptionSchema), layout: z.array(ingestionModelOptionSchema) }).strict(),
    })
    .strict()
  export type IngestionModelListing = z.infer<typeof ingestionModelListingSchema>
  ```
  `KeiExpClient.listIngestionModels(signal?: AbortSignal): Promise<KeiExpIngestionModelListing>`; Studio `GET /api/ingestion-models` (researcher-scoped); browser `readIngestionModels(signal?: AbortSignal): Promise<IngestionModelListing>` in `src/api.ts`.

- [ ] **Step 1: Write the failing Python tests**

  `tests/test_ingestion_models.py` (fast tier: no store, no model loading; `TestClient(api.app)` without `with` skips the lifespan, as `test_api_lifecycle.py` does):
  ```python
  """GET /api/ingestion-models: what a new parse may run on, per role, and the default per role."""
  from fastapi.testclient import TestClient

  from kei_exp import api
  from kei_exp.cut import DEFAULT_LAYOUT_MODEL, LAYOUT_MODELS
  from kei_exp.models import DEFAULT_OCR_MODEL, MODELS


  def test_the_listing_names_both_defaults_and_marks_only_the_loaded_ocr_model_serving(monkeypatch):
      monkeypatch.setattr(api, "loaded_model", lambda url: (True, MODELS["surya"].repo))
      body = TestClient(api.app).get("/api/ingestion-models").json()
      assert body["defaults"] == {"ocr": DEFAULT_OCR_MODEL, "layout": DEFAULT_LAYOUT_MODEL}
      ocr = {model["key"]: model for model in body["models"]["ocr"]}
      assert set(ocr) == set(MODELS)
      assert {key for key, model in ocr.items() if model["serving"]} == {"surya"}
      assert ocr["surya"]["label"] == MODELS["surya"].repo


  def test_layout_detectors_run_inside_kei_and_are_always_selectable(monkeypatch):
      monkeypatch.setattr(api, "loaded_model", lambda url: (False, None))
      body = TestClient(api.app).get("/api/ingestion-models").json()
      assert [model["key"] for model in body["models"]["layout"]] == list(LAYOUT_MODELS)
      assert all(model["serving"] for model in body["models"]["layout"])


  def test_an_unreachable_ocr_server_serves_no_ocr_model_and_the_listing_still_answers(monkeypatch):
      monkeypatch.setattr(api, "loaded_model", lambda url: (False, None))
      response = TestClient(api.app).get("/api/ingestion-models")
      assert response.status_code == 200
      assert not any(model["serving"] for model in response.json()["models"]["ocr"])


  def test_the_ocr_default_is_a_known_model():
      assert DEFAULT_OCR_MODEL in MODELS
  ```
  Run: `cd prototypes/parsing_service && uv run --no-sync pytest -q tests/test_ingestion_models.py`. Expected: FAIL (`DEFAULT_OCR_MODEL` missing).

- [ ] **Step 2: Implement the kei route**

  `src/kei_exp/models.py`, after `MODELS`:
  ```python
  # The OCR model a new parse runs on when its owner chose none. M3 wires KEI_OCR_MODEL through Compose and makes
  # `convert` resolve an omitted choice from this same value; until then Studio's KEI_EXP_MODEL (also surya) is sent.
  DEFAULT_OCR_MODEL = os.environ.get("KEI_OCR_MODEL", "surya")
  if DEFAULT_OCR_MODEL not in MODELS:
      raise ValueError(f"KEI_OCR_MODEL names no known OCR model: {DEFAULT_OCR_MODEL!r}")
  ```
  (add `import os`). `src/kei_exp/api.py`, import `DEFAULT_OCR_MODEL` beside `MODELS`, then after `list_extraction_models`:
  ```python
  @app.get("/api/ingestion-models")
  def list_ingestion_models() -> dict:
      """The OCR and layout models a new parse may run on, and the default per role; shaped like
      /api/extraction-models. An OCR model is `serving` only while the OCR server has it loaded, which is what this
      listing observed, not a promise. Layout detectors run inside this service and are always selectable. A page with
      a text layer uses neither."""
      _, served = loaded_model(VLLM_URL)
      return {
          "defaults": {"ocr": DEFAULT_OCR_MODEL, "layout": DEFAULT_LAYOUT_MODEL},
          "models": {
              "ocr": [{"key": key, "label": record.repo, "serving": record.repo == served}
                      for key, record in MODELS.items()],
              "layout": [{"key": key, "label": label, "serving": True} for key, label in LAYOUT_MODELS.items()],
          },
      }
  ```
  README (*HTTP and evidence contract*): add a bullet describing `GET /api/ingestion-models` in the same words.

  Run: `uv run --no-sync pytest -q tests/test_ingestion_models.py && uv run --no-sync pytest -q -m "not postgres and not live_model" && uvx ruff check src/kei_exp/models.py src/kei_exp/api.py tests/test_ingestion_models.py`. Expected: pass.

- [ ] **Step 3: kei client method (packages/extraction)**

  Test first in `packages/extraction/src/module.test.ts`: `listIngestionModels reads kei's listing and refuses an invalid one` (a fake `fetch` returning the Python shape → parsed; a body missing `defaults` → `ExtractionError` code `invalid_model_output`; a network failure → `model_unavailable`). Then add to `kei-exp.ts`:
  ```ts
  const ingestionOptionSchema = z.object({ key: z.string().min(1), label: z.string().min(1), serving: z.boolean() }).strict()
  const ingestionListingSchema = z.object({
    defaults: z.object({ ocr: z.string().min(1), layout: z.string().min(1) }).strict(),
    models: z.object({ ocr: z.array(ingestionOptionSchema), layout: z.array(ingestionOptionSchema) }).strict(),
  }).strict()
  export type KeiExpIngestionModelListing = z.infer<typeof ingestionListingSchema>
  ```
  and `listIngestionModels(signal)` on `KeiExpClient`, implemented exactly like `listModels` against `${root}/api/ingestion-models` with the messages "kei-exp could not be reached to list its ingestion models" / "kei-exp returned an invalid ingestion model listing." Export the type from `index.ts`. Run `pnpm --filter extraction typecheck && pnpm --filter extraction test`.

- [ ] **Step 4: Studio route, contract and browser reader**

  Add the shared schemas above to `shared/modelConfig.contract.ts` with a round-trip test in `modelConfig.contract.test.ts`. Create `api/ingestion_models.test.ts` mirroring `api/extraction_models.test.ts` (`serves kei's listing unchanged`, `answers 503 ingestion_models_unavailable with no-store when kei is unreachable or answers an invalid listing`, `forwards the request's abort signal`, `answers 404 for any other path`). Then `api/ingestion_models.ts`:
  ```ts
  import type { KeiExpClient } from 'extraction'
  import { ingestionModelListingSchema } from '../shared/modelConfig.contract.js'
  import { ApiError, json, noStore, noStoreError } from './_http.js'
  import { keiExpClient } from './_extraction_runtime.js'

  const ROUTE = '/api/ingestion-models'

  /** `GET /api/ingestion-models`: kei's OCR and layout models, whether its OCR server serves each now, and the default
   *  per role. The researcher's Ingestion Model Choice picks among them for new ingestions and reprocessing. A failed
   *  listing blocks neither ingestion nor any configuration edit. */
  export function createGetIngestionModels(client: Pick<KeiExpClient, 'listIngestionModels'>) {
    return async function GET(request: Request): Promise<Response> {
      try {
        if (new URL(request.url).pathname !== ROUTE) throw new ApiError(404, 'not_found', 'API route not found.')
        let listing: unknown
        try {
          listing = await client.listIngestionModels(request.signal)
        } catch (cause) {
          request.signal.throwIfAborted()
          throw new ApiError(503, 'ingestion_models_unavailable', 'The Parsing Service could not list its ingestion models.', { cause })
        }
        const parsed = ingestionModelListingSchema.safeParse(listing)
        if (!parsed.success)
          throw new ApiError(503, 'ingestion_models_unavailable', 'The Parsing Service could not list its ingestion models.')
        return json(parsed.data, { headers: noStore })
      } catch (error) {
        return noStoreError(error)
      }
    }
  }

  export function createResearcherApiHandlers(): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
    return { GET: createGetIngestionModels(keiExpClient) }
  }
  ```
  `server/api-dispatcher.ts` `PARAMETERIZED`: add `[/^\/api\/ingestion-models$/, 'ingestion_models']`, with a dispatcher test that `/api/ingestion-models` resolves to `ingestion_models`. `src/api.ts`: `readIngestionModels(signal)` beside `readExtractionModels`, parsing with `ingestionModelListingSchema`, with a test in `src/api.test.ts`.

- [ ] **Step 5: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter extraction typecheck && pnpm --filter extraction test
  (cd prototypes/parsing_service && uv run --no-sync pytest -q -m "not postgres and not live_model")
  git add prototypes/parsing_service/src/kei_exp/models.py prototypes/parsing_service/src/kei_exp/api.py prototypes/parsing_service/README.md prototypes/parsing_service/tests/test_ingestion_models.py packages/extraction/src prototypes/studio/shared prototypes/studio/api/ingestion_models.ts prototypes/studio/api/ingestion_models.test.ts prototypes/studio/server/api-dispatcher.ts prototypes/studio/server/api-dispatcher.test.ts prototypes/studio/src/api.ts prototypes/studio/src/api.test.ts
  git commit -m "feat(ingestion): list kei's OCR and layout models and forward the listing through Studio"
  ```

## Task 5: The app shell's Content-Security-Policy

**Files:**
- Create: `prototypes/studio/server/contentSecurityPolicy.ts`, `prototypes/studio/server/contentSecurityPolicy.test.ts`
- Modify: `prototypes/studio/server/static.ts`, `prototypes/studio/server/static.test.ts`, `prototypes/studio/vite.config.ts`
- Create: `prototypes/studio/e2e/bundledDocument.ts`, `prototypes/studio/e2e/app-shell-csp.spec.ts`
- Modify: `prototypes/studio/e2e/critical-flows.spec.ts` (use the extracted helper in its first test), `tests/safety.test.mjs`

**Interfaces:**
- Produces: `APP_SHELL_CONTENT_SECURITY_POLICY: string`; `withDevelopmentContentSecurityPolicy(html: string): string`; `routeBundledDocument(page: Page): Promise<void>` and `openBundledDocument(page: Page): Promise<void>` (e2e helpers).

- [ ] **Step 1: Write the failing unit tests**

  `server/contentSecurityPolicy.test.ts`:
  - `the app shell loads script and pdf.js's worker only from Studio and refuses inline script and framing`: parse the policy into a map; `script-src` is exactly `'self'`; `worker-src` exactly `'self'`; `frame-ancestors` `'none'`; `object-src` `'none'`; no `'unsafe-inline'`, `'unsafe-eval'` or hash in `script-src`; no `form-action` directive.
  - `development adds only Vite's own inline scripts, by hash, and its HMR socket`: input `<html><head><script type="module">import "/@react-refresh"</script></head><body><script type="module" src="./src/main.tsx"></script></body></html>`; the output's first element in `<head>` is `<meta http-equiv="Content-Security-Policy" …>`; its `script-src` is `'self' 'sha256-<base64 of that script body>'`; `connect-src` includes `ws:` and `wss:`; there is no `frame-ancestors`; the external script contributes no hash.

  `server/static.test.ts`: `the index response carries the app shell policy and assets do not` (`Content-Security-Policy` equals `APP_SHELL_CONTENT_SECURITY_POLICY` on `/` and on a deep link; absent on `/assets/app-abc12345.js`).

  Run: `pnpm --filter studio exec vitest run server/contentSecurityPolicy.test.ts server/static.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

  `server/contentSecurityPolicy.ts` (no imports other than `node:crypto`; the safety test imports it with Node 24's type stripping):
  ```ts
  import { createHash } from 'node:crypto'

  /**
   * Researchers' API keys live in this origin's localStorage (docs/plans/2026-09-24-unified-durable-execution.md,
   * *Model configuration and keys → XSS*), so script and pdf.js's worker load only from Studio, inline script is
   * refused and no page may frame Studio. Styles and fonts also allow Google Fonts, which index.html loads, and styles
   * allow inline attributes (React, pdf.js, and Vite's injected <style> in development). No form-action: sign-out is a
   * form POST answered with a redirect to the identity provider. The sign-in relay keeps its own policy (app.ts).
   */
  const DIRECTIVES = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'worker-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'connect-src': ["'self'"],
  } as const satisfies Readonly<Record<string, readonly string[]>>

  function serialize(directives: Readonly<Record<string, readonly string[]>>): string {
    return Object.entries(directives).map(([name, sources]) => [name, ...sources].join(' ')).join('; ')
  }

  export const APP_SHELL_CONTENT_SECURITY_POLICY = serialize(DIRECTIVES)

  const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi

  /**
   * Development only: the same policy as a <meta> element placed before every script, plus the hash of each inline
   * script Vite itself injected (React Refresh's preamble) and Vite's HMR socket. A meta policy cannot carry
   * frame-ancestors. Any other inline script, including one injected later, is still refused.
   */
  export function withDevelopmentContentSecurityPolicy(html: string): string {
    const hashes = [...html.matchAll(INLINE_SCRIPT)].map(
      ([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
    )
    const development = Object.fromEntries(
      Object.entries(DIRECTIVES)
        .filter(([name]) => name !== 'frame-ancestors')
        .map(([name, sources]) => [
          name,
          name === 'script-src' ? [...sources, ...hashes] : name === 'connect-src' ? [...sources, 'ws:', 'wss:'] : sources,
        ]),
    )
    const meta = `<meta http-equiv="Content-Security-Policy" content="${serialize(development)}" />`
    return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n    ${meta}`)
  }
  ```
  `server/static.ts` `indexResponse`: add `'Content-Security-Policy': APP_SHELL_CONTENT_SECURITY_POLICY` to its headers only.
  `vite.config.ts`: add a plugin used only while serving:
  ```ts
  function appShellContentSecurityPolicy(): Plugin {
    return {
      name: 'free-app-shell-csp',
      apply: 'serve',
      // After React Refresh injected its preamble, so its hash is part of the policy.
      transformIndexHtml: { order: 'post', handler: withDevelopmentContentSecurityPolicy },
    }
  }
  ```
  and register it in `plugins` next to `studioBaseHtml`.

- [ ] **Step 3: Browser test under the policy**

  Move the fixture routing of `critical-flows.spec.ts`' first test (`projectContextFixture`, `createGetProjectContexts`, `createGetDocumentReopen`, the `source-representations` routes, the two activations) into `e2e/bundledDocument.ts` as `routeBundledDocument(page)` and `openBundledDocument(page)`, and make that first test use them. Then `e2e/app-shell-csp.spec.ts`:
  ```ts
  test('the app shell policy runs the PDF viewer and its worker, and refuses inline script @deterministic', async ({ page }) => {
    await page.addInitScript(() => {
      const violations: string[] = []
      Object.assign(window, { __cspViolations: violations })
      document.addEventListener('securitypolicyviolation', (event) =>
        violations.push(`${event.effectiveDirective} ${event.blockedURI}`))
    })
    await routeBundledDocument(page)
    await gotoAuthenticated(page, '/')
    await openBundledDocument(page)
    await expect(page.locator('.pdfViewer .page')).toHaveCount(6)
    await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([])

    await page.addScriptTag({ content: 'window.__freeInlineScriptRan = true' }).catch(() => undefined)
    expect(await page.evaluate(() => (window as { __freeInlineScriptRan?: boolean }).__freeInlineScriptRan)).toBeUndefined()
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __cspViolations: string[] }).__cspViolations.some((entry) => entry.startsWith('script-src')))).toBe(true)
  })
  ```
  The e2e server is Vite (development policy); the production header is pinned by the unit tests. Both derive from one directive table.

- [ ] **Step 4: Safety test**

  In `tests/safety.test.mjs` add `app shell: the production policy is strict about script, workers and framing`: `const { APP_SHELL_CONTENT_SECURITY_POLICY } = await import('../prototypes/studio/server/contentSecurityPolicy.ts')` (Node 24 strips types), then the same directive assertions as the unit test, plus `readFileSync('prototypes/studio/server/static.ts')` contains `APP_SHELL_CONTENT_SECURITY_POLICY`.

- [ ] **Step 5: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio build
  pnpm --filter studio test:e2e      # the whole suite: every spec now runs under the development policy
  pnpm test:safety
  git add prototypes/studio/server/contentSecurityPolicy.ts prototypes/studio/server/contentSecurityPolicy.test.ts prototypes/studio/server/static.ts prototypes/studio/server/static.test.ts prototypes/studio/vite.config.ts prototypes/studio/e2e/bundledDocument.ts prototypes/studio/e2e/app-shell-csp.spec.ts prototypes/studio/e2e/critical-flows.spec.ts tests/safety.test.mjs
  git commit -m "feat(studio): send a strict Content-Security-Policy with the app shell"
  ```
  If a spec other than the new one reports a CSP violation, fix the cause (never add `'unsafe-inline'` to `script-src`); report any directive you had to widen.

## Task 6: Key custody building blocks (Studio cache and boot ID; browser store, handoff and boot tracking)

**Files:**
- Create: `prototypes/studio/api/_model_keys.ts`, `prototypes/studio/api/_model_keys.test.ts`
- Create: `prototypes/studio/shared/modelKeys.contract.ts`
- Modify: `prototypes/studio/api/_provider.ts`, `prototypes/studio/api/_provider.test.ts` (add `keyedModel`)
- Modify: `prototypes/studio/server/app.ts`, `prototypes/studio/server/app.test.ts`
- Create: `prototypes/studio/src/modelKeys/modelKeyStore.ts`, `modelKeyStore.test.ts`, `modelKeyHandoff.ts`, `modelKeyHandoff.test.ts`
- Modify: `prototypes/studio/src/auth/authenticatedFetch.ts`, `prototypes/studio/src/auth/authenticatedFetch.test.ts`

Nothing uses these pieces yet except the boot header and sign-out eviction; Task 9 wires the server side and Task 12 the app.

**Interfaces:**
- Produces (server, `api/_model_keys.ts`):
  ```ts
  export const MODEL_KEY_WAIT_MS = 60_000
  export type ModelKeyAddress = Readonly<{ provider: ProviderKind; baseUrl: string | null }>
  type KeyedConnection = Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'>
  export class ModelKeyRequiredError extends ApiError { readonly isRetryable = false }
  export type ModelKeyCache = {
    put(accountId: string, connectionId: string, address: ModelKeyAddress, key: string): void
    remove(accountId: string, connectionId: string): void
    forgetAccount(accountId: string): void
    retain(accountId: string, connections: readonly (KeyedConnection & { hasKey: boolean })[]): void
    read(accountId: string, connection: KeyedConnection): string | null
    wait(accountId: string, connection: KeyedConnection, signal: AbortSignal | undefined, waitMs?: number): Promise<string | null>
    clear(): void
  }
  export function createModelKeyCache(): ModelKeyCache
  export function requireModelKey(cache: ModelKeyCache, accountId: string, connection: KeyedConnection, signal: AbortSignal | undefined, waitMs?: number): Promise<string>
  export const studioProcess: Readonly<{ bootId: string; keys: ModelKeyCache }>
  ```
  `api/_provider.ts`: `export function keyedModel(createModel: ModelFactory, connection: ModelConnection, modelId: string, key: (signal: AbortSignal | undefined) => Promise<string>): LanguageModel` (and export the `ModelFactory` type).
  `server/app.ts`: `export const STUDIO_BOOT_HEADER = 'X-FREE-Studio-Boot'`; `StudioAppOptions.modelKeys?: { bootId: string; keys: Pick<ModelKeyCache, 'forgetAccount'> }`.
  `shared/modelKeys.contract.ts`:
  ```ts
  export const modelKeyEntrySchema = z
    .object({ provider: providerKindSchema, baseUrl: z.string().min(1).nullable(), key: z.string().min(1).max(8192) })
    .strict()
  export const modelKeysRequestSchema = z
    .object({ account: uuidSchema, keys: z.record(uuidSchema, modelKeyEntrySchema.nullable()) })
    .strict()
  export const modelKeysResponseSchema = z.object({ accepted: z.array(uuidSchema) }).strict()
  export type ModelKeysRequest = z.infer<typeof modelKeysRequestSchema>
  ```
  Browser `src/modelKeys/modelKeyStore.ts`: `storedModelKeys(accountId)`, `modelKeyFor(accountId, connection)`, `saveModelKey(accountId, connection, key)`, `removeModelKey(accountId, connectionId)`, `retainModelKeys(accountId, connections): string[]` (returns dropped IDs), `clearModelKeys(accountId)`. `src/modelKeys/modelKeyHandoff.ts`: `sendModelKeys(accountId: string, removed?: readonly string[]): Promise<void>`. `src/auth/authenticatedFetch.ts`: `STUDIO_BOOT_HEADER`, `subscribeToModelKeyResend(listener: () => void): () => void`.

- [ ] **Step 1: Write the failing server tests**

  `api/_model_keys.test.ts` (use `vi.useFakeTimers()` for waits):
  - `a key sent for one API base is never read for another` (put at base A; `read` with base B → null; with provider changed → null)
  - `one account never reads another account's key`
  - `remove and forgetAccount drop keys; forgetAccount leaves other accounts alone`
  - `retain drops keys of removed, re-addressed or keyless connections and keeps the rest`
  - `wait resolves as soon as a matching key arrives` (put during the wait; a put for another base does not resolve it)
  - `wait resolves null after the wait and leaves no timer or listener behind` (`vi.getTimerCount()` is 0; the signal has no listener: spy on `addEventListener`/`removeEventListener`)
  - `wait rejects with the abort reason before any key arrives, and immediately when already aborted`
  - `requireModelKey throws model_key_required, 409, isRetryable false, with a message naming no key or connection`

  `api/_provider.test.ts`, new `describe('keyedModel')` using a real `vllm` factory and a stubbed `fetch` (the file's existing pattern):
  - `builds the provider client per attempt with the key read inside that attempt` (two `generateText` calls with `maxRetries: 0`; the key function yields `sk-test-attempt-1` then `sk-test-attempt-2`; each request's `authorization` is `Bearer` + that attempt's key)
  - `never calls the server when the key is missing, and the AI SDK does not retry model_key_required` (key function rejects with `ModelKeyRequiredError`; default `maxRetries`; `fetch` not called; key function called once)
  - `stops before the provider when the signal aborts during the wait`

  `server/app.test.ts`:
  - `every API response carries the boot header, including 401 and 404` (inject `modelKeys: { bootId: 'boot-1', keys }`)
  - `sign-out evicts the signed-in account's keys` (a valid session cookie → `forgetAccount` called with its account ID; the logout redirect is unchanged)
  - `sign-out without a session evicts nothing and still clears cookies`

- [ ] **Step 2: Implement the server pieces**

  `api/_model_keys.ts`:
  ```ts
  import { randomUUID } from 'node:crypto'
  import type { ModelConnection, ProviderKind } from '../shared/modelConfig.contract.js'
  import { ApiError } from './_http.js'

  /** How long a provider attempt waits for a page to resend a missing key before it fails with `model_key_required`. */
  export const MODEL_KEY_WAIT_MS = 60_000

  /** The provider and API base a key was sent for. A key is used only while its connection still has both. */
  export type ModelKeyAddress = Readonly<{ provider: ProviderKind; baseUrl: string | null }>
  type KeyedConnection = Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'>
  type Held = ModelKeyAddress & Readonly<{ key: string }>

  export class ModelKeyRequiredError extends ApiError {
    /** Only a page resending the key can fix this, so neither the AI SDK nor `durableCalls` (M5) may retry it. */
    readonly isRetryable = false
    constructor() {
      super(409, 'model_key_required',
        'Studio does not hold the key for this Model Connection. Open FREE in a browser where the key is saved, then try again.')
      this.name = 'ModelKeyRequiredError'
    }
  }

  export type ModelKeyCache = { /* as in Interfaces */ }

  const slot = (accountId: string, connectionId: string) => `${accountId}\u0000${connectionId}`
  const sameAddress = (held: ModelKeyAddress, connection: KeyedConnection) =>
    held.provider === connection.provider && held.baseUrl === connection.baseUrl

  export function createModelKeyCache(): ModelKeyCache {
    const held = new Map<string, Held>()
    const waiters = new Map<string, Set<() => void>>()
    const ofAccount = (accountId: string) => [...held.keys()].filter((key) => key.startsWith(`${accountId}\u0000`))
    const cache: ModelKeyCache = {
      put(accountId, connectionId, address, key) {
        const at = slot(accountId, connectionId)
        held.set(at, { provider: address.provider, baseUrl: address.baseUrl, key })
        for (const wake of waiters.get(at) ?? []) wake()
      },
      remove(accountId, connectionId) {
        held.delete(slot(accountId, connectionId))
      },
      forgetAccount(accountId) {
        for (const at of ofAccount(accountId)) held.delete(at)
      },
      retain(accountId, connections) {
        const current = new Map(connections.filter(({ hasKey }) => hasKey).map((connection) => [connection.id, connection]))
        for (const at of ofAccount(accountId)) {
          const connection = current.get(at.slice(accountId.length + 1))
          if (!connection || !sameAddress(held.get(at)!, connection)) held.delete(at)
        }
      },
      read(accountId, connection) {
        const entry = held.get(slot(accountId, connection.id))
        return entry && sameAddress(entry, connection) ? entry.key : null
      },
      async wait(accountId, connection, signal, waitMs = MODEL_KEY_WAIT_MS) {
        signal?.throwIfAborted()
        const ready = cache.read(accountId, connection)
        if (ready !== null) return ready
        const at = slot(accountId, connection.id)
        const { promise, resolve, reject } = Promise.withResolvers<string | null>()
        const wake = () => {
          const key = cache.read(accountId, connection)
          if (key !== null) resolve(key)
        }
        const abort = () => reject(signal!.reason)
        const timer = setTimeout(() => resolve(null), waitMs)
        const set = waiters.get(at) ?? new Set<() => void>()
        waiters.set(at, set)
        set.add(wake)
        signal?.addEventListener('abort', abort, { once: true })
        try {
          return await promise
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          set.delete(wake)
          if (set.size === 0) waiters.delete(at)
        }
      },
      clear() {
        held.clear()
      },
    }
    return cache
  }

  /**
   * The key for one provider attempt: from the cache, or after waiting up to `waitMs` for a page to resend it. The wait
   * ends early when `signal` aborts, and nothing after it runs. In M4/M5 the caller composes DBOS's
   * `DBOS.stepStatus.cancelSignal` into `signal`.
   */
  export async function requireModelKey(
    cache: ModelKeyCache, accountId: string, connection: KeyedConnection,
    signal: AbortSignal | undefined, waitMs = MODEL_KEY_WAIT_MS,
  ): Promise<string> {
    const key = await cache.wait(accountId, connection, signal, waitMs)
    if (key === null) throw new ModelKeyRequiredError()
    signal?.throwIfAborted()
    return key
  }

  /** This Studio process's key cache and the boot ID that names it: a page that sees a new boot ID knows the keys it
   *  sent are gone and sends them again. One process (decision 2), so one map; it empties when the process exits. */
  export const studioProcess = { bootId: randomUUID(), keys: createModelKeyCache() } as const
  ```

  `api/_provider.ts`: export `ModelFactory` and add:
  ```ts
  /**
   * A route's model for a connection with `hasKey`: the key is read inside each provider attempt and the provider
   * client is built for that attempt alone, as the Ollama adapter already builds its client per call. A replayed step
   * whose call is checkpointed never reaches here, so it never needs a key. The base model supplies metadata only and
   * is never called, so an anonymous request cannot happen.
   */
  export function keyedModel(
    createModel: ModelFactory,
    connection: ModelConnection,
    modelId: string,
    key: (signal: AbortSignal | undefined) => Promise<string>,
  ): LanguageModel {
    const attempt = async (signal: AbortSignal | undefined) => {
      const credential = await key(signal)
      signal?.throwIfAborted()
      return createModel(connection, modelId, credential)
    }
    return wrapLanguageModel({
      model: createModel(connection, modelId, null),
      middleware: {
        specificationVersion: 'v4',
        wrapGenerate: async ({ params }) => (await attempt(params.abortSignal)).doGenerate(params),
        wrapStream: async ({ params }) => (await attempt(params.abortSignal)).doStream(params),
      },
    })
  }
  ```
  Narrow `createModel(...)`'s result to the provider-model interface the way the Ollama adapter's `create(...)` result is used, so `doGenerate`/`doStream` typecheck.

  `server/app.ts`:
  ```ts
  export const STUDIO_BOOT_HEADER = 'X-FREE-Studio-Boot'
  // in createStudioApp, before authGuard is registered:
  const custody = options.modelKeys ?? studioProcess
  const stampBoot: MiddlewareHandler<StudioEnvironment> = async (context, next) => {
    await next()
    // Every API response names this process's key cache, so a page resends its keys after a restart.
    try {
      context.res.headers.set(STUDIO_BOOT_HEADER, custody.bootId)
    } catch {
      context.res = new Response(context.res.body, context.res)
      context.res.headers.set(STUDIO_BOOT_HEADER, custody.bootId)
    }
  }
  app.use('/api', stampBoot)
  app.use('/api/*', stampBoot)
  ```
  and `/auth/logout`:
  ```ts
  app.post('/auth/logout', async (context) => {
    // Sign-out clears Studio's copy of this account's keys; the browser clears its own (Task 12).
    const state = await backend.inspect(context.req.raw).catch(() => null)
    if (state?.authenticated) custody.keys.forgetAccount(state.account.id)
    return externalRedirect(identityProvider.logoutUrl(signedOutUri), [transactions.clear(), sessions.clear(), signedOutCookie(basePath)])
  })
  ```

- [ ] **Step 3: Write the failing browser tests**

  `src/modelKeys/modelKeyStore.test.ts` (jsdom):
  - `keys are kept per account under free.modelKeys.v1:<account>`
  - `a key is returned only for the connection's current provider and base`
  - `retain drops keys of removed, re-addressed and keyless connections and returns their IDs`
  - `unreadable storage reads as no keys` (malformed JSON; a throwing `localStorage` getter)
  - `clearModelKeys removes one account's keys and leaves another's`

  `src/modelKeys/modelKeyHandoff.test.ts` (mock `authenticatedFetch`):
  - `sends every stored key with its address, and null for each removed ID` (body `{ account, keys }`)
  - `sends nothing when the account has no keys and nothing was removed`
  - `concurrent calls share one request and a call during it sends once more afterwards`
  - `a failed request resolves, and its removals are sent with the next call`

  `src/auth/authenticatedFetch.test.ts`:
  - `the first boot ID seen requests no resend`
  - `a new boot ID requests exactly one resend, recorded before the resend's own response arrives` (two responses with `boot-2` → one notification)
  - `a 409 model_key_required response requests a resend; other 409s do not`
  - `the response body stays readable by the caller after the 409 inspection`

- [ ] **Step 4: Implement the browser pieces**

  `src/modelKeys/modelKeyStore.ts`:
  ```ts
  import { z } from 'zod'
  import { providerKindSchema, type ModelConnection } from '../../shared/modelConfig.contract'

  /** This browser's keys for one Researcher Account, each bound to a connection's ID, provider and API base. A key is
   *  never offered for another base. Accounts sharing one browser profile share its storage; the namespace keeps them
   *  apart for the app, not against a script (the CSP is that defence). */
  const PREFIX = 'free.modelKeys.v1:'
  const storedSchema = z.record(z.string(), z.object({
    provider: providerKindSchema, baseUrl: z.string().nullable(), key: z.string().min(1),
  }).strict())
  export type StoredModelKeys = z.infer<typeof storedSchema>
  type Addressed = Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'>

  function storage(): Storage | null {
    try { return window.localStorage } catch { return null }
  }
  function read(accountId: string): StoredModelKeys {
    try {
      const parsed = storedSchema.safeParse(JSON.parse(storage()?.getItem(PREFIX + accountId) ?? '{}'))
      return parsed.success ? parsed.data : {}
    } catch { return {} }
  }
  function write(accountId: string, keys: StoredModelKeys): void {
    try {
      if (Object.keys(keys).length === 0) storage()?.removeItem(PREFIX + accountId)
      else storage()?.setItem(PREFIX + accountId, JSON.stringify(keys))
    } catch { /* Storage is optional; the page then simply holds no keys. */ }
  }
  export function storedModelKeys(accountId: string): StoredModelKeys { return read(accountId) }
  export function modelKeyFor(accountId: string, connection: Addressed): string | null {
    const entry = read(accountId)[connection.id]
    return entry && entry.provider === connection.provider && entry.baseUrl === connection.baseUrl ? entry.key : null
  }
  export function saveModelKey(accountId: string, connection: Addressed, key: string): void {
    write(accountId, { ...read(accountId), [connection.id]: { provider: connection.provider, baseUrl: connection.baseUrl, key } })
  }
  export function removeModelKey(accountId: string, connectionId: string): void {
    const keys = read(accountId)
    delete keys[connectionId]
    write(accountId, keys)
  }
  export function retainModelKeys(accountId: string, connections: readonly (Addressed & { hasKey: boolean })[]): string[] {
    const current = new Map(connections.filter(({ hasKey }) => hasKey).map((connection) => [connection.id, connection]))
    const keys = read(accountId)
    const dropped = Object.entries(keys)
      .filter(([id, entry]) => {
        const connection = current.get(id)
        return !connection || connection.provider !== entry.provider || connection.baseUrl !== entry.baseUrl
      })
      .map(([id]) => id)
    for (const id of dropped) delete keys[id]
    write(accountId, keys)
    return dropped
  }
  export function clearModelKeys(accountId: string): void { write(accountId, {}) }
  ```
  `src/modelKeys/modelKeyHandoff.ts`:
  ```ts
  import { authenticatedFetch } from '../auth/authenticatedFetch'
  import { storedModelKeys } from './modelKeyStore'

  const pendingRemovals = new Map<string, Set<string>>()
  let running: Promise<void> | null = null
  let queued: Promise<void> | null = null

  /** Hands this browser's keys for `accountId` to Studio (`PUT /api/model-keys`), with `null` for each removed key.
   *  Best effort: resolves even when Studio is unreachable. Concurrent calls share one request, and a call made while
   *  one runs sends once more after it, so the newest state always arrives. */
  export function sendModelKeys(accountId: string, removed: readonly string[] = []): Promise<void> {
    const removals = pendingRemovals.get(accountId) ?? new Set<string>()
    for (const id of removed) removals.add(id)
    pendingRemovals.set(accountId, removals)
    if (!running) {
      running = put(accountId).finally(() => { running = null })
      return running
    }
    queued ??= running.then(() => { queued = null; return sendModelKeys(accountId) })
    return queued
  }

  async function put(accountId: string): Promise<void> {
    const removals = [...(pendingRemovals.get(accountId) ?? [])]
    pendingRemovals.delete(accountId)
    const keys: Record<string, { provider: string; baseUrl: string | null; key: string } | null> =
      Object.fromEntries(removals.map((id) => [id, null]))
    for (const [id, entry] of Object.entries(storedModelKeys(accountId))) keys[id] = entry
    if (Object.keys(keys).length === 0) return
    try {
      await authenticatedFetch('/api/model-keys', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: accountId, keys }),
      })
    } catch {
      const retry = pendingRemovals.get(accountId) ?? new Set<string>()
      for (const id of removals) retry.add(id)
      pendingRemovals.set(accountId, retry)
    }
  }
  ```
  `src/auth/authenticatedFetch.ts`, after the `fetch`:
  ```ts
  export const STUDIO_BOOT_HEADER = 'X-FREE-Studio-Boot'
  let studioBoot: string | null = null
  const resendListeners = new Set<() => void>()

  /** Called when Studio no longer holds this page's keys: it restarted (a new boot ID) or answered model_key_required. */
  export function subscribeToModelKeyResend(listener: () => void): () => void {
    resendListeners.add(listener)
    return () => resendListeners.delete(listener)
  }
  function requestModelKeyResend(): void {
    for (const listener of [...resendListeners]) listener()
  }
  // inside authenticatedFetch, after `const response = await fetch(…)`:
  const boot = response.headers.get(STUDIO_BOOT_HEADER)
  if (boot !== null && boot !== studioBoot) {
    const restarted = studioBoot !== null
    // Recorded before any resend starts, so the resend's own response, which carries the same ID, triggers nothing.
    studioBoot = boot
    if (restarted) requestModelKeyResend()
  }
  if (response.status === 409)
    void response.clone().json().then(
      (body: unknown) => {
        if ((body as { error?: { code?: unknown } } | null)?.error?.code === 'model_key_required') requestModelKeyResend()
      },
      () => undefined,
    )
  ```

- [ ] **Step 5: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  git add prototypes/studio/api/_model_keys.ts prototypes/studio/api/_model_keys.test.ts prototypes/studio/shared/modelKeys.contract.ts prototypes/studio/api/_provider.ts prototypes/studio/api/_provider.test.ts prototypes/studio/server/app.ts prototypes/studio/server/app.test.ts prototypes/studio/src/modelKeys prototypes/studio/src/auth/authenticatedFetch.ts prototypes/studio/src/auth/authenticatedFetch.test.ts
  git commit -m "feat(studio): add the in-memory key cache, boot ID, browser key store and handoff"
  ```

## Task 7: Per-account configuration storage and ownership

The wire contract does not change yet; credentials still go through the OS keyring, which Task 9 deletes. This task moves storage and ownership only.

**Files:**
- Modify: `prototypes/studio/api/_model_config.ts`, `api/model_config.ts`, `api/model_probe.ts`, `api/_provider.ts`, `api/_model.ts`
- Modify: `api/generate_schema.ts`, `api/chat.ts`, `api/edit_schema.ts`, `api/_schema_edit.ts`, `api/_project_operations.ts`, `api/extractions.ts`, `api/batch_extractions.ts`, `api/batch_schema_suggestions.ts`
- Create: `prototypes/studio/api/model_configuration.fixture.ts` (the dispatcher's glob excludes `*.fixture.ts`)
- Modify: `server/api-dispatcher.ts`, `server/api-dispatcher.test.ts`
- Modify tests: `api/_model_config.test.ts`, `api/model_auth.test.ts`, `api/model_probe.test.ts`, `api/_provider.test.ts`, `api/_model.test.ts`, `api/_schema_edit.test.ts`, `api/project_operations.test.ts`, `api/durable_operations.test.ts`, the handler tests of the files above
- Modify: `src/providerConfig/providerConfig.data.ts`, `src/providerConfig/ProviderConfigPage.tsx`, `src/providerConfig/ProviderConfigPage.test.tsx` (the reset flow goes)
- Modify: `e2e/model-configuration.spec.ts` (drop reset assertions), `e2e/canonical-evidence-lifecycle.spec.ts`, `playwright.config.ts`, `playwright.base-path.config.ts`, `playwright.service.config.ts`

**Interfaces:**
- Consumes: Task 2's `createModelConfigurationStore`, `projectContextOwner`.
- Produces:
  ```ts
  // api/_model_config.ts
  export function modelConfigurations(): ModelConfigurationStore           // lazily created process store
  export async function readAccountModelConfig(researcherAccountId: string, store?: ModelConfigurationStore): Promise<ModelConfig>
  export async function configuredExtractionModels(researcherAccountId: string, store?: ModelConfigurationStore): Promise<ExtractionModelChoice | null>
  // api/_model.ts
  export type ModelCaller = Readonly<{ researcherAccountId: string }>
  export function streamChatWithModel(caller: ModelCaller, messages, documentMarkdown, temperature?, target?, dependencies?): Promise<Response>
  export function generateSchemaWithModel(caller: ModelCaller, input: SchemaModelInput, target?, dependencies?)
  export function generateSchemaEditJson(caller: ModelCaller, prompt, temperature?, target?, dependencies?)
  // api/_schema_edit.ts: SchemaEditOptions gains `caller: ModelCaller` (required)
  // api/model_config.ts, api/model_probe.ts: createResearcherApiHandlers(store, dependencies?) instead of GET/PUT/POST exports
  // api/model_configuration.fixture.ts
  export function inMemoryModelConfigurations(initial?: Record<string, unknown>): ModelConfigurationStore & { documents: Map<string, unknown> }
  ```

- [ ] **Step 1: Write the failing tests**

  - `api/model_auth.test.ts`: build the registry with `createResearcherApiHandlers` for `model_config` and `model_probe` over one `inMemoryModelConfigurations()` shared by two accounts; issue two session cookies. New cases: `each account reads only its own configuration` (A PUTs; B's GET is the empty configuration; B PUTs its own; A's GET is unchanged); keep `denies unauthenticated …` (now: no store read, no keyring call, no provider call).
  - `api/_model_config.test.ts`: delete every file-storage case (`ConfigFileSystem`, atomic write, fsync, rename, `modelConfigPath`, `readModelConfig`, `resetModelConfig`, `writeModelConfig`, unreadable-document/reset cases). Keep the validation cases. Switch the credential cases from temp directories to `inMemoryModelConfigurations()` (their keyring assertions stay until Task 9). New: `an account that never applied reads the empty configuration`; `a stored document that fails validation is a 500 that echoes nothing`; `configuredExtractionModels reads the given account's choice`.
  - `api/_provider.test.ts`: `resolving a route that names another account's connection is 409` (B's configuration routes to A's connection ID → "names a Model Connection that does not exist"); `a resolver without a configuration reader is refused` (unchanged behaviour, now the only path).
  - `api/_model.test.ts`: `a model call reads its caller's configuration` (`readConfig` spy receives nothing; the default reader is called with the caller's account — inject `readConfig` and assert it is used; construct one case without `readConfig` and mock `readAccountModelConfig` via `vi.mock('./_model_config.js')` to assert the account ID).
  - `api/project_operations.test.ts` (or `durable_operations.test.ts`, whichever drives `createProjectOperations`): `the pump resolves the Project Context owner's configuration` (fake `projectContextOwner` returns `owner-account`; the injected `generate` receives `{ researcherAccountId: 'owner-account' }` as its first argument) and `a suggestion whose project is gone is not run` (`projectContextOwner` → null; `generate` not called).
  - `api/extractions.test.ts`, `api/batch_extractions.test.ts`, `api/batch_schema_suggestions.test.ts`: the default `extractionModels` reader is called with the store's `researcherAccountId` (inject a spy through `configuredExtractionModels` via `vi.mock`).
  - `server/api-dispatcher.test.ts`: `model_config` and `model_probe` are researcher-scoped (registering them with module-level `GET`/`PUT`/`POST` now throws "must not export module-level handlers").

  Run: `pnpm --filter studio test`. Expected: FAIL.

- [ ] **Step 2: Storage and ownership in `_model_config.ts`**

  Delete `ConfigFileHandle`, `ConfigFileSystem`, `nodeFileSystem`, `ConfigStorageOptions`, `modelConfigPath`, `invalidModelConfig`'s file path use, `isMissingFile`, `readModelConfig`, `resetModelConfig`, `writeModelConfig` and the `envPaths`, `node:fs/promises`, `node:path`, `node:crypto` imports. Add:
  ```ts
  import { createModelConfigurationStore, type ModelConfigurationStore } from 'db'

  let store: ModelConfigurationStore | undefined
  /** The process's configuration store. Each Researcher Account owns one document (decision 6). */
  export function modelConfigurations(): ModelConfigurationStore {
    return (store ??= createModelConfigurationStore())
  }

  /** The account's configuration, or the empty one before its first Apply. Validation on write keeps the stored
   *  document valid, so one that fails here is a server fault: 500, with no details. */
  export async function readAccountModelConfig(researcherAccountId: string, source = modelConfigurations()): Promise<ModelConfig> {
    const stored = await source.read(researcherAccountId)
    if (stored === null) return emptyModelConfig()
    return storedModelConfig(stored)
  }

  function storedModelConfig(stored: unknown): ModelConfig {
    const parsed = modelConfigSchema.safeParse(stored)
    if (!parsed.success || semanticIssues(parsed.data).length > 0)
      throw new ApiError(500, 'invalid_model_config', 'The saved model configuration is invalid.')
    return parsed.data
  }

  export async function configuredExtractionModels(researcherAccountId: string, source = modelConfigurations()): Promise<ExtractionModelChoice | null> {
    const { extractionModels } = await readAccountModelConfig(researcherAccountId, source)
    return extractionModels.fields || extractionModels.reasoning ? extractionModels : null
  }
  ```
  `updateModelConfig` becomes `updateAccountModelConfig(value, { researcherAccountId, store, credentialStore })`: parse; then `await (store ?? modelConfigurations()).apply(researcherAccountId, async (stored) => { previous = stored === null ? emptyModelConfig() : storedModelConfig(stored); …today's issue checks and keyring actions…; return config })`; then today's post-commit keyring cleanup and `credentialStates`. The keyring actions run inside the row-locked transaction until Task 9 removes them.

- [ ] **Step 3: Researcher-scoped handlers**

  `api/model_config.ts`: delete `modelConfigWriteBarrier`, `serializeModelConfigWrite` (the row lock replaces the in-process barrier), `createDeleteModelConfig` and the `GET`/`PUT`/`DELETE` exports. Export:
  ```ts
  export type ModelConfigDependencies = {
    configurations?: ModelConfigurationStore
    credentialStore?: CredentialStore
    deployment?: () => DeploymentModels
  }
  /** A researcher reads and changes only their own configuration. */
  export function createResearcherApiHandlers(store: Pick<ResearcherProjectStore, 'researcherAccountId'>, dependencies: ModelConfigDependencies = {}) {
    return { GET: createGetModelConfig(store.researcherAccountId, dependencies), PUT: createPutModelConfig(store.researcherAccountId, dependencies) }
  }
  ```
  `api/model_probe.ts`: same shape (`POST`), with `savedCredential` reading `readAccountModelConfig(researcherAccountId, …)`. `server/api-dispatcher.ts`: `STATIC_API` keeps only `healthz`. In `ProviderConfigPage.tsx` delete the `unreadable`/`confirmingReset`/`resetting` state, `reset()`, and the reset controls and copy; in `providerConfig.data.ts` delete `resetModelConfig`; delete the reset cases from `ProviderConfigPage.test.tsx` and any reset assertion in `e2e/model-configuration.spec.ts` (a load error still renders its message).

- [ ] **Step 4: Model calls take the owner**

  `api/_provider.ts`: `RouteResolverDependencies.readConfig` becomes required (`readConfig: () => Promise<ModelConfig>`), `config?` goes, and the runtime "reader is unavailable" branch goes.
  `api/_model.ts`:
  ```ts
  /** Whose configuration and keys a model call uses: the Project Context's owner. Background and (from M4/M5) workflow
   *  calls carry only this ID and resolve the rest when the call runs. */
  export type ModelCaller = Readonly<{ researcherAccountId: string }>
  type ModelDependencies = Omit<RouteResolverDependencies, 'readConfig'> & {
    readConfig?: () => Promise<ModelConfig>
    fetch?: typeof fetch
  }
  async function operationTarget(operation: ModelOperation, temperature: number | undefined, target: ExecutionTarget | undefined, caller: ModelCaller, dependencies: ModelDependencies): Promise<ExecutionTarget> {
    return target ?? resolveCapabilityRoute(operation, { temperature }, {
      ...dependencies,
      readConfig: dependencies.readConfig ?? (() => readAccountModelConfig(caller.researcherAccountId)),
    })
  }
  ```
  and `caller` becomes the first parameter of the three exported model functions. Callers:
  - `generate_schema.ts`: `generate({ researcherAccountId: store.researcherAccountId }, { … })`;
  - `chat.ts`: `stream({ researcherAccountId: store.researcherAccountId }, messages, markdown, temperature)`;
  - `edit_schema.ts` → `proposeSchemaEdit(…, { temperature, caller: { researcherAccountId: store.researcherAccountId } })`; `_schema_edit.ts` passes `options.caller` to `generateSchemaEditJson`;
  - `_project_operations.ts` `runSuggestion`, before the source loop:
    ```ts
    // Background work runs on the Project Context owner's configuration and keys, never on whoever kicked the pump.
    const owner = await store.projectContextOwner(suggestion.projectContextId)
    if (owner === null) return
    ```
    and `generate({ researcherAccountId: owner }, { … })`;
  - `extractions.ts`, `batch_extractions.ts`, `batch_schema_suggestions.ts`: `dependencies.extractionModels ?? (() => configuredExtractionModels(store.researcherAccountId))`.

- [ ] **Step 5: E2E seeding and Playwright environment**

  `e2e/canonical-evidence-lifecycle.spec.ts`: delete the `configHome`/`configRoot` constants, the `rm`/`mkdir`/`writeFile(model-config.json)` block and now-unused imports; after the spec creates its `ResearcherAccount` row, seed the same document with `await db.orm.public.ModelConfiguration.create({ researcherAccountId, document: { connections: [...], routes: {...}, extractionModels: { fields: 'instruct' } } })`. Remove `APPDATA` and `XDG_CONFIG_HOME` (the config home existed only for `model-config.json`) from `playwright.config.ts`, `playwright.base-path.config.ts` and `playwright.service.config.ts`; keep `XDG_DATA_HOME` in the service config.

- [ ] **Step 6: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e
  grep -rn "readModelConfig()\|modelConfigPath\|ConfigFileSystem\|model-config.json\|resetModelConfig\|serializeModelConfigWrite" prototypes/studio --include=*.ts --include=*.tsx --exclude-dir=node_modules
  git add prototypes/studio
  git commit -m "feat(studio): keep each researcher's model configuration in PostgreSQL and resolve calls on the owner's"
  ```
  Expected grep output: nothing.

## Task 8: Route semantics — Schema Suggestion follows the Assistant model, the NuExtract protocol is derived, the Ingestion Model Choice is stored

**Files:**
- Modify: `prototypes/studio/shared/modelConfig.contract.ts`, `shared/modelConfig.contract.test.ts`
- Modify: `api/_model_config.ts`, `api/_provider.ts`, and tests `api/_model_config.test.ts`, `api/_provider.test.ts`, `api/_model.test.ts`
- Modify: `src/providerConfig/useProviderConfigDraft.ts` (deletions only), `src/providerConfig/ProviderRoutesEditor.tsx`, `src/providerConfig/ProviderConfigPage.tsx`, `src/providerConfig/ProviderConfigPage.test.tsx`
- Modify: `e2e/model-configuration.spec.ts`, `e2e/authentication-accessibility.spec.ts`, `e2e/canonical-evidence-lifecycle.spec.ts`

**Interfaces:**
- Consumes: Task 4's `ingestionModelKeySchema`.
- Produces:
  ```ts
  export const ingestionModelChoiceSchema = z
    .object({ ocr: ingestionModelKeySchema.optional(), layout: ingestionModelKeySchema.optional() })
    .strict()
  export type IngestionModelChoice = z.infer<typeof ingestionModelChoiceSchema>
  // modelConfigSchema: routes.schemaSuggestion is routeSchema.nullable(); gains ingestionModels: ingestionModelChoiceSchema
  /** Studio uses NuExtract's own protocol exactly when a route's connection can pass NuExtract's chat-template
   *  controls (vLLM) and its model ID names NuExtract. Only Schema Suggestion runs it. Nothing stores this choice. */
  export function usesNuextractProtocol(provider: Pick<ProviderDescriptor, 'supportsNuextract'>, modelId: string): boolean {
    return provider.supportsNuextract && /nuextract/i.test(modelId)
  }
  // api/_provider.ts
  /** Schema Suggestion's own route, else the Assistant model's (the Interaction Route), else the deployment default.
   *  An explicit Schema Suggestion route stays explicit even when it equals the Interaction Route (decision 12). */
  export function selectedRoute(routes: ModelConfig['routes'], key: RouteKey, defaultRoute: Route | null): Route | null {
    return key === 'schemaSuggestion'
      ? routes.schemaSuggestion ?? routes.interaction ?? defaultRoute
      : routes.interaction ?? defaultRoute
  }
  ```
  `schemaSuggestionRouteSchema` and `SchemaSuggestionRoute` are deleted.

- [ ] **Step 1: Write the failing tests**

  `api/_provider.test.ts`:
  - `Schema Suggestion uses the NuExtract protocol exactly for a NuExtract model on a vLLM connection` — `it.each` over the four combinations (vLLM + `numind/NuExtract3-FP8` → `profile: 'nuextract'`; vLLM + `Qwen/Qwen3.8-27B-FP8` → `general`; `openai-compatible` + `numind/NuExtract3-FP8` → `general`; `openai-compatible` + Qwen → `general`).
  - `no other route ever uses the NuExtract protocol` (the Interaction Route on vLLM + NuExtract resolves `general` for `chat` and `schema-edit`).
  - `an unset Schema Suggestion route follows the Interaction Route, then the deployment default`.
  - `an explicit Schema Suggestion route is used even when the Interaction Route differs or equals it`.
  - `an inherited NuExtract target runs the protocol` (Schema Suggestion unset, Interaction vLLM + NuExtract → `nuextract`).
  `api/_model_config.test.ts`:
  - `a submitted schemaSuggestion protocol is refused as an unknown field` (400 `invalid_request`).
  - `an explicit Schema Suggestion route equal to the Interaction Route is stored as submitted` (apply, then read: still non-null).
  - `the Ingestion Model Choice is stored as submitted, and any key string is accepted` (kei refuses unknown keys at conversion; "a saved choice the listing no longer offers stays saved").
  `shared/modelConfig.contract.test.ts`: `usesNuextractProtocol` unit cases; the empty configuration parses with `ingestionModels: {}`.

- [ ] **Step 2: Implement the contract and resolver**

  Contract: add `ingestionModelChoiceSchema`, `usesNuextractProtocol`; `routes.schemaSuggestion: routeSchema.nullable()`; `ingestionModels: ingestionModelChoiceSchema` in `modelConfigSchema`; `emptyModelConfig()` in `_model_config.ts` gains `ingestionModels: {}`; delete the protocol check in `semanticIssues` (lines 115-132 keep only the dangling-route check). In `resolveCapabilityRoute`:
  ```ts
  const routeKey = operation === 'schema-suggestion' ? 'schemaSuggestion' : 'interaction'
  const route = selectedRoute(config.routes, routeKey, deployment.defaultRoute)
  if (!route) throw new ApiError(409, 'invalid_model_config', `No model is configured for ${ROUTE_LABELS[routeKey]}.`)
  …
  if (routeKey === 'schemaSuggestion' && usesNuextractProtocol(entry, route.modelId)) {
    if (connection.baseUrl === null)
      throw new ApiError(409, 'invalid_model_config', 'The NuExtract protocol requires a vLLM Model Connection.')
    return { profile: 'nuextract', … }   // as today
  }
  ```
  `automaticOutputKey` uses `routeKey`.

- [ ] **Step 3: Browser deletions**

  `useProviderConfigDraft.ts`: delete `setNuextractProtocol`, the protocol-retention branch of `setRoute`, the Schema-Suggestion-protocol rewrite in `changeProvider`, and the `protocol === undefined` condition in `configurationMode`. `ProviderRoutesEditor.tsx`: delete the checkbox and its prop; under the Schema Suggestion route, when `usesNuextractProtocol(provider, route.modelId)`, render `<p className="mt-2 text-[11px] text-ink-muted">Uses the NuExtract protocol for this model.</p>`. `ProviderConfigPage.tsx`: drop the prop. Replace the page test for the checkbox with `the NuExtract protocol is shown as automatic for a NuExtract model on vLLM and never offered as a choice`. The rest of the hook is rewritten in Task 9.

- [ ] **Step 4: Fixtures**

  Add `ingestionModels: {}` to every mocked or seeded configuration document: `e2e/model-configuration.spec.ts` (`Config` type and state), `e2e/authentication-accessibility.spec.ts` (the `model_config` mock), `e2e/canonical-evidence-lifecycle.spec.ts` (the seeded row), and Studio unit fixtures the typecheck names. Delete the e2e case `Capability Routes save mixed exact targets and the vLLM-only NuExtract protocol` checkbox assertions (keep its mixed-targets part) and the NuExtract-protocol assertion in `a draft provider change probes again, drops the NuExtract protocol, and locks once saved`.

- [ ] **Step 5: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e
  grep -rn "schemaSuggestionRouteSchema\|SchemaSuggestionRoute\|setNuextractProtocol\|protocol: 'nuextract'\|protocol === 'nuextract'" prototypes/studio --include=*.ts --include=*.tsx --exclude-dir=node_modules
  git add prototypes/studio
  git commit -m "feat(studio): derive the NuExtract protocol, let Schema Suggestion follow the Assistant model, store the Ingestion Model Choice"
  ```
  Expected grep output: nothing.

## Task 9: Keys leave the server — `hasKey`, `PUT /api/model-keys`, lazy keyed models, page-supplied probe keys, and the draft hook rewritten once

This is M2's largest task and flips the wire contract; dispatch it to an `opus-xhigh` implementer. The page's current components are adapted just enough to use the final hook; Task 13 replaces them.

**Files:**
- Modify: `shared/modelConfig.contract.ts`, `shared/modelConfig.contract.test.ts`
- Modify: `api/_model_config.ts`, `api/model_config.ts`, `api/model_probe.ts`, `api/_provider.ts`, `api/_model.ts`, `api/_deployment_models.ts`, `server/api-dispatcher.ts`
- Create: `api/model_keys.ts`, `api/model_keys.test.ts`
- Delete: `api/_keyring.ts`
- Modify tests: `api/_model_config.test.ts`, `api/model_probe.test.ts`, `api/model_auth.test.ts`, `api/_provider.test.ts`, `api/_model.test.ts`, `api/_schema_edit.test.ts` (drop `keyring_unavailable` cases), `server/api-dispatcher.test.ts`
- Modify: `src/providerConfig/providerConfig.data.ts`, `useProviderConfigDraft.ts` (rewrite), `useProbeLifecycle.ts`, `ProviderConfigPage.tsx`, `ProviderRoutesEditor.tsx`, `ProviderConnectionCard.tsx`, `ProviderConfigPage.test.tsx`
- Modify: `e2e/model-configuration.spec.ts`, `e2e/authentication-accessibility.spec.ts`, `e2e/canonical-evidence-lifecycle.spec.ts`

**Interfaces:**
- Consumes: Task 6's cache, `requireModelKey`, `keyedModel`, `studioProcess`, key store and `sendModelKeys`; Task 7's per-account storage; Task 8's contract.
- Produces (contract):
  ```ts
  export const modelConnectionSchema = z.object({
    id: uuidSchema,
    name: z.string().min(1, 'Must not be empty.'),
    provider: providerKindSchema,
    baseUrl: z.string().min(1).nullable(),
    /** Whether calls to this connection carry a key. The key stays in the researcher's browser and, while a call needs
     *  it, in Studio's memory; never in this document. Managed providers always have one; deployment connections never. */
    hasKey: z.boolean(),
  }).strict()
  export const modelConfigUpdateSchema = z.object({ config: modelConfigSchema }).strict()
  export const modelConfigStateSchema = z.object({ config: modelConfigSchema }).strict()
  export const getModelConfigResponseSchema = modelConfigStateSchema.extend({ providers: z.array(providerDescriptorSchema), deployment: deploymentModelsSchema }).strict()
  export const modelProbeRequestSchema = z.object({ connection: modelConnectionSchema, credential: z.string().min(1).max(8192).optional() }).strict()
  // deleted: credentialStateSchema, CredentialState, CredentialActions
  ```
  Server: `applyAccountModelConfig(value: unknown, options: { researcherAccountId: string; store?: ModelConfigurationStore; keys?: Pick<ModelKeyCache, 'retain'> }): Promise<ModelConfig>`; `RouteResolverDependencies` gains `researcherAccountId: string`, `keys?: ModelKeyCache`, `keyWaitMs?: number`; `NuExtractExecutionTarget.authorization` is replaced by `key: (signal: AbortSignal | undefined) => Promise<string | null>`; `PUT /api/model-keys` (Plan decision 3).
  Browser hook (final API, used unchanged by Task 13):
  ```ts
  export type KeyEdit = string | null
  export function useProviderConfigDraft(inputs: {
    accountId: string
    providers: readonly ProviderDescriptor[]
    scheduleProbe: (connection: ModelConnection, credential: string | null | undefined) => void
    cancelProbe: (connectionId: string) => void
    disposeProbe: (connectionId: string) => void
  }): {
    draft: ModelConfig | null; saved: ModelConfig | null; keyEdits: Readonly<Record<string, KeyEdit>>; dirty: boolean
    descriptor(connection: Pick<ModelConnection, 'provider'>): ProviderDescriptor | undefined
    credentialFor(connection: ModelConnection): string | null | undefined
    initialize(config: ModelConfig): void
    assign(task: RouteKey, target: Route | null): void
    setExtractionModel(role: ExtractionModelRole, key: string): void
    setIngestionModel(role: IngestionModelRole, key: string): void
    addConnection(kind: ProviderKind): string | null
    updateConnection(id: string, change: Partial<Pick<ModelConnection, 'name' | 'baseUrl'>>): void
    setKey(id: string, key: string): void
    removeKey(id: string): void
    connectWithoutKey(id: string): void
    removeConnection(id: string): void
    commit(config: ModelConfig): string[]
    discard(): void
  }
  ```

- [ ] **Step 1: Write the failing server tests**

  `api/model_keys.test.ts` (handler over `inMemoryModelConfigurations()` and a fresh `createModelKeyCache()`):
  - `caches a key only for the account's own hasKey connection at its current provider and base` (entries for: own connection at the right address → accepted; wrong base → skipped; wrong provider → skipped; `hasKey: false` connection → skipped; unknown ID → skipped; a deployment ID → skipped; response `{ accepted: [<the one>] }`)
  - `a null entry removes the cached key and is accepted`
  - `a stale tab's handoff under another signed-in account is rejected` (`account` ≠ session account → `409 account_mismatch`; nothing cached)
  - `a malformed body echoes nothing and logs nothing` (bodies: invalid JSON containing `sk-test-planted-1`; a valid shape with an extra property holding `sk-test-planted-2`; a key entry with a non-string `baseUrl`; each → `400 { error: { code: 'invalid_request', message: 'The request is invalid.' } }` with no `details`; response text excludes the planted strings; `console.error`/`warn`/`log`/`info` spies not called)
  - `the response names connection IDs only` (no key text in the body)

  `api/model_probe.test.ts` (rewrite around the new rules; `fetch` injected):
  - `a hasKey connection is probed with the key the page sent, never one Studio holds` (cache holds `sk-test-cached`; request carries `sk-test-page`; the provider sees only `Bearer sk-test-page`)
  - `a hasKey probe without a key, and a keyless probe with one, are refused before any request`
  - `a deployment connection is probed at the served address without a key` (as today)
  - `a malformed probe echoes nothing and logs nothing` (as for model keys, planting `sk-test-planted-3` under `credential` of a wrong type and under an extra property)

  `api/_model_config.test.ts`:
  - `a managed connection must have hasKey`; `a CLI connection takes no key` (Task 11 replaces this with a rejection)
  - `Apply drops cached keys of removed and re-addressed connections` (cache holds keys for C1 at base A and C2; apply with C1 at base B and C2 removed → both gone; C3 untouched)
  - `an existing connection cannot change provider` (kept)
  - delete every keyring case.

  `api/_provider.test.ts` (resolver, injected `keys` and `keyWaitMs: 50`, fake timers where useful):
  - `a hasKey route with no cached key waits, then fails with model_key_required without calling its server`
  - `a key sent during the wait is used for that attempt`
  - `a keyless connection calls its server anonymously and never reads the cache`
  - `a deployment connection is anonymous`
  - `no account's call uses another account's key` (A's key cached for the same connection ID; B's call times out with `model_key_required`)
  `api/_model.test.ts`:
  - `the NuExtract protocol reads the key inside the attempt and sends it as a bearer token`
  - `a keyed NuExtract call with no key never reaches vLLM` (`fetch` not called; `model_key_required`)
  `api/model_auth.test.ts`: replace the keyring flow with `PUT /api/model-keys` + model call: `each account's key serves only its own calls`, and `unauthenticated model-keys PUT is 401 with no side effects`.

- [ ] **Step 2: Server implementation**

  - Contract as in Interfaces; `_deployment_models.ts` `served()` sets `hasKey: false`.
  - `_model_config.ts`: delete `credentialStates`, `requireKeyring`, `updateIssues`' credential half, `requireManagedCredentials`, `clearImplicitOptionalCredentials`, the post-commit cleanup, and the `CredentialStore` import. In `semanticIssues`, per connection:
    ```ts
    const { authentication, transport } = providerTable[connection.provider]
    if (authentication === 'managed' && !connection.hasKey)
      issues.push({ path: `${at}.hasKey`, message: 'A hosted provider always uses a key.' })
    if (transport === 'cli' && connection.hasKey)
      issues.push({ path: `${at}.hasKey`, message: 'A CLI provider signs in on the server and takes no key.' })
    ```
    `updateIssues` shrinks to its provider check, renamed `providerChangeIssues`:
    ```ts
    /** A connection's provider is fixed once it is added: delete it and add a new one instead. */
    function providerChangeIssues(previous: ModelConfig, config: ModelConfig): ValidationIssue[] {
      const before = new Map(previous.connections.map((connection) => [connection.id, connection.provider]))
      return config.connections.flatMap((connection, index) =>
        before.has(connection.id) && before.get(connection.id) !== connection.provider
          ? [{ path: `config.connections.${index}.provider`, message: 'An existing connection cannot change provider kind. Delete it and create a new UUID.' }]
          : [])
    }
    ```
    and Task 7's `updateAccountModelConfig` is replaced by:
    ```ts
    export async function applyAccountModelConfig(
      value: unknown,
      options: Readonly<{ researcherAccountId: string; store?: ModelConfigurationStore; keys?: Pick<ModelKeyCache, 'retain'> }>,
    ): Promise<ModelConfig> {
      const { config } = parseModelConfigUpdate(value)
      await (options.store ?? modelConfigurations()).apply(options.researcherAccountId, (stored) => {
        const previous = stored === null ? emptyModelConfig() : storedModelConfig(stored)
        const issues = providerChangeIssues(previous, config)
        if (issues.length > 0) throw invalidSubmitted(issues)
        return config
      })
      // A removed or re-addressed connection's cached key goes now; a call already under way finishes.
      ;(options.keys ?? studioProcess.keys).retain(options.researcherAccountId, config.connections)
      return config
    }
    ```
    `parseModelProbeRequest`: on a schema failure throw `new ApiError(400, 'invalid_request', 'The request is invalid.')` with no `details` and no `cause`.
  - `model_config.ts`: GET returns `{ config, providers, deployment }`; PUT returns `{ config }`; no `credentialStore`.
  - `model_probe.ts`:
    ```ts
    export function createPostModelProbe(dependencies: ModelProbeDependencies = {}) {
      return async function POST(request: Request): Promise<Response> {
        try {
          let body: unknown
          try { body = await parseJsonRequest(request) } catch { throw new ApiError(400, 'invalid_request', 'The request is invalid.') }
          const deployed = deploymentProbe(body, dependencies)
          if (deployed) return json(await probeConnection(deployed, null, dependencies))
          const { connection, credential } = parseModelProbeRequest(body)
          // Probes carry exactly the key the page typed or holds; Studio never looks one up for a probe.
          if (connection.hasKey && credential === undefined)
            throw new ApiError(409, 'invalid_model_config', 'Probe this connection with its key.')
          if (!connection.hasKey && credential !== undefined)
            throw new ApiError(409, 'invalid_model_config', 'This connection uses no key; probe it without one.')
          return json(await probeConnection(connection, credential ?? null, dependencies))
        } catch (error) {
          return apiErrorResponse(error)
        }
      }
    }
    export function createResearcherApiHandlers(_store: Pick<ResearcherProjectStore, 'researcherAccountId'>, dependencies: ModelProbeDependencies = {}) {
      return { POST: createPostModelProbe(dependencies) }
    }
    ```
    (`deploymentProbe` still rejects a `credential` for a deployment ID.)
  - `model_keys.ts`:
    ```ts
    const invalid = () => new ApiError(400, 'invalid_request', 'The request is invalid.')

    /** `PUT /api/model-keys`: the page hands Studio its keys for the signed-in account. Write-only; entries merge and
     *  `null` removes one. A key is accepted only for one of the account's own `hasKey` connections at that
     *  connection's current provider and base; anything else is skipped. Bodies are never logged or echoed. */
    export function createPutModelKeys(researcherAccountId: string, dependencies: Readonly<{ configurations?: ModelConfigurationStore; keys?: ModelKeyCache }> = {}) {
      const keys = dependencies.keys ?? studioProcess.keys
      return async function PUT(request: Request): Promise<Response> {
        try {
          let body: unknown
          try { body = await parseJsonRequest(request) } catch { throw invalid() }
          const parsed = modelKeysRequestSchema.safeParse(body)
          if (!parsed.success) throw invalid()
          // A stale tab on a shared browser must not file one account's keys under another.
          if (parsed.data.account !== researcherAccountId)
            throw new ApiError(409, 'account_mismatch', 'These keys belong to another Researcher Account. Reload the page.')
          const own = new Map((await readAccountModelConfig(researcherAccountId, dependencies.configurations)).connections.map((c) => [c.id, c]))
          const accepted: string[] = []
          for (const [id, entry] of Object.entries(parsed.data.keys)) {
            if (entry === null) {
              keys.remove(researcherAccountId, id)
              accepted.push(id)
              continue
            }
            const connection = own.get(id)
            if (!connection?.hasKey || connection.provider !== entry.provider || connection.baseUrl !== entry.baseUrl) continue
            keys.put(researcherAccountId, id, { provider: entry.provider, baseUrl: entry.baseUrl }, entry.key)
            accepted.push(id)
          }
          return json({ accepted }, { headers: noStore })
        } catch (error) {
          return apiErrorResponse(error)
        }
      }
    }
    export function createResearcherApiHandlers(store: Pick<ResearcherProjectStore, 'researcherAccountId'>) {
      return { PUT: createPutModelKeys(store.researcherAccountId) }
    }
    ```
    `server/api-dispatcher.ts` `PARAMETERIZED`: `[/^\/api\/model-keys$/, 'model_keys']`.
  - `_provider.ts` `resolveCapabilityRoute`: delete `resolvedCredential` and the `_keyring.js` import; after finding `connection` and `entry`:
    ```ts
    const keys = dependencies.keys ?? studioProcess.keys
    // A connection without `hasKey` calls its server anonymously and one with it never does (no fallback).
    const key = (signal: AbortSignal | undefined) =>
      requireModelKey(keys, dependencies.researcherAccountId, connection, signal, dependencies.keyWaitMs)
    if (routeKey === 'schemaSuggestion' && usesNuextractProtocol(entry, route.modelId)) {
      …
      return { profile: 'nuextract', modelId: route.modelId, baseUrl: connection.baseUrl,
        key: connection.hasKey ? key : async () => null, temperatureSupported: true,
        attribution: { provider: connection.provider, modelId: route.modelId } }
    }
    …
    model = connection.hasKey ? keyedModel(createModel, connection, route.modelId, key) : createModel(connection, route.modelId, null)
    ```
  - `_model.ts`: `operationTarget` passes `researcherAccountId: caller.researcherAccountId`. In `generateWithNuExtract`, before the request:
    ```ts
    let authorization: string | null
    try {
      const key = await target.key(input.signal)
      authorization = key === null ? null : `Bearer ${key}`
    } catch (error) {
      throw asModelOperationError(error, 'NuExtract generation failed.')   // model_key_required passes through unchanged
    }
    input.signal?.throwIfAborted()
    ```
    and the header uses `authorization`. `streamChatWithModel` gains `signal?: AbortSignal` (after `temperature`), passed as `abortSignal` to `streamText`, so the key wait ends when the browser disconnects; `api/chat.ts` passes `request.signal`. Its `onError` returns `error instanceof ModelKeyRequiredError ? error.message : 'Chat failed.'`.
  - Delete `api/_keyring.ts` (`rm`).

- [ ] **Step 3: Write the failing browser tests**

  `ProviderConfigPage.test.tsx` (render inside a `ResearcherSessionContext` with account `acct-a`; stub `fetch`):
  - `Apply stores typed keys in this browser bound to the committed base and sends them to Studio` (localStorage `free.modelKeys.v1:acct-a` holds `{ provider, baseUrl, key }`; a `PUT /api/model-keys` follows the successful `PUT /api/model_config` with `{ account: 'acct-a', keys }`)
  - `a draft base change clears the typed key and never probes the new base with the old key` (fake timers: type a key, change the base within 500 ms, advance timers; no probe request carries the old key; a stored key for the old base is not sent either)
  - `Remove drops this browser's key on Apply and tells Studio; an optional connection then uses no key`
  - `a managed connection keeps hasKey when its key is removed`
  - `a hasKey connection without a key in this browser is not probed`
  - `the model_config PUT body carries no key and no credentials`
  Keep or adapt the existing route/extraction/deployment tests to the new hook; delete the credential preserve/replace/delete and mode tests.

- [ ] **Step 4: Rewrite the draft hook once, and adapt the current components**

  `useProviderConfigDraft.ts` (final; `configurationMode`, the mode state and every per-mode setter are gone):
  ```ts
  export function useProviderConfigDraft({ accountId, providers, scheduleProbe, cancelProbe, disposeProbe }: DraftInputs) {
    const [saved, setSaved] = useState<ModelConfig | null>(null)
    const [draft, setDraft] = useState<ModelConfig | null>(null)
    const [keyEdits, setKeyEdits] = useState<Readonly<Record<string, KeyEdit>>>({})
    const descriptor = (connection: Pick<ModelConnection, 'provider'>) => providers.find(({ kind }) => kind === connection.provider)
    const withoutEdit = (id: string) => setKeyEdits((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))
    const connectionOf = (id: string) => draft?.connections.find((connection) => connection.id === id)
    const replaceConnection = (next: ModelConnection) =>
      setDraft((current) => current && { ...current, connections: current.connections.map((item) => (item.id === next.id ? next : item)) })

    /** What a probe of `connection` may carry: nothing for a keyless connection; for one with a key, the key typed in
     *  this draft, else this browser's key for this account at this exact provider and base. `undefined`: not probed. */
    function credentialFor(connection: ModelConnection): string | null | undefined {
      if (!connection.hasKey) return null
      const edit = keyEdits[connection.id]
      if (typeof edit === 'string') return edit
      if (edit === null) return undefined
      return modelKeyFor(accountId, connection) ?? undefined
    }
    function initialize(config: ModelConfig): void { setSaved(config); setDraft(config); setKeyEdits({}) }
    /** The single route setter: a route is {connectionId, modelId}, or null (the deployment default; for Schema
     *  Suggestion, the Assistant model). */
    function assign(task: RouteKey, target: Route | null): void {
      setDraft((current) => current && { ...current, routes: { ...current.routes, [task]: target } })
    }
    /** '' hands the role back to the deployment's default. */
    function setExtractionModel(role: ExtractionModelRole, key: string): void {
      setDraft((current) => {
        if (!current) return current
        const extractionModels = { ...current.extractionModels }
        if (key) extractionModels[role] = key
        else delete extractionModels[role]
        return { ...current, extractionModels }
      })
    }
    /** '' hands the role back to kei's default. Applies to new ingestions and reprocessing only. */
    function setIngestionModel(role: IngestionModelRole, key: string): void {
      setDraft((current) => {
        if (!current) return current
        const ingestionModels = { ...current.ingestionModels }
        if (key) ingestionModels[role] = key
        else delete ingestionModels[role]
        return { ...current, ingestionModels }
      })
    }
    function addConnection(kind: ProviderKind): string | null {
      const provider = providers.find((item) => item.kind === kind)
      if (!provider || provider.transport === 'cli') return null
      const connection: ModelConnection = {
        id: crypto.randomUUID(), name: provider.label, provider: kind,
        baseUrl: provider.defaultBaseUrl ?? '', hasKey: provider.authentication === 'managed',
      }
      setDraft((current) => current && { ...current, connections: [...current.connections, connection] })
      scheduleProbe(connection, connection.hasKey ? undefined : null)
      return connection.id
    }
    function updateConnection(id: string, change: Partial<Pick<ModelConnection, 'name' | 'baseUrl'>>): void {
      const connection = connectionOf(id)
      if (!connection) return
      const next = { ...connection, ...change }
      replaceConnection(next)
      if (change.baseUrl === undefined || change.baseUrl === connection.baseUrl) return
      // A key belongs to one API base. A new base drops the typed key at once and supersedes the probe the old input
      // scheduled; this browser's stored key stays bound to the old base and is never sent to the new one.
      cancelProbe(id)
      withoutEdit(id)
      scheduleProbe(next, next.hasKey ? modelKeyFor(accountId, next) ?? undefined : null)
    }
    function setKey(id: string, key: string): void {
      const connection = connectionOf(id)
      if (!connection) return
      const next = { ...connection, hasKey: true }
      replaceConnection(next)
      if (key) setKeyEdits((current) => ({ ...current, [id]: key }))
      else withoutEdit(id)
      scheduleProbe(next, key || (modelKeyFor(accountId, next) ?? undefined))
    }
    function removeKey(id: string): void {
      const connection = connectionOf(id)
      if (!connection) return
      const managed = descriptor(connection)?.authentication === 'managed'
      const next = { ...connection, hasKey: managed }
      replaceConnection(next)
      setKeyEdits((current) => ({ ...current, [id]: null }))
      cancelProbe(id)
      if (!managed) scheduleProbe(next, null)
    }
    /** An optional-key connection whose key is not in this browser can be used without one instead. */
    function connectWithoutKey(id: string): void {
      const connection = connectionOf(id)
      if (!connection || descriptor(connection)?.authentication !== 'optional') return
      const next = { ...connection, hasKey: false }
      replaceConnection(next)
      withoutEdit(id)
      scheduleProbe(next, null)
    }
    function removeConnection(id: string): void {
      setDraft((current) => current && {
        ...current,
        connections: current.connections.filter((item) => item.id !== id),
        routes: {
          schemaSuggestion: current.routes.schemaSuggestion?.connectionId === id ? null : current.routes.schemaSuggestion,
          interaction: current.routes.interaction?.connectionId === id ? null : current.routes.interaction,
        },
      })
      withoutEdit(id)
      disposeProbe(id)
    }
    /** After Apply: the committed configuration is the new baseline and this browser's keys follow it. Returns the IDs
     *  whose key this browser dropped, for the handoff to remove from Studio too. */
    function commit(config: ModelConfig): string[] {
      const dropped = new Set<string>()
      for (const [id, edit] of Object.entries(keyEdits)) {
        const connection = config.connections.find((item) => item.id === id)
        if (typeof edit === 'string' && connection?.hasKey) saveModelKey(accountId, connection, edit)
        if (edit === null) { removeModelKey(accountId, id); dropped.add(id) }
      }
      for (const id of retainModelKeys(accountId, config.connections)) dropped.add(id)
      initialize(config)
      return [...dropped]
    }
    function discard(): void { if (saved) initialize(saved) }
    const dirty = draft !== null && saved !== null &&
      (JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(keyEdits).length > 0)
    return { draft, saved, keyEdits, dirty, descriptor, credentialFor, initialize, assign, setExtractionModel, setIngestionModel, addConnection, updateConnection, setKey, removeKey, connectWithoutKey, removeConnection, commit, discard }
  }
  ```
  `useProbeLifecycle.ts`: drop `credentialStates`; `canProbe(connection, credential)` is false when `credential === undefined`, the provider is unknown, the name is empty, or an HTTP base is invalid; `schedule(connection, credential)` / `refresh(connection, credential)` send `credential` only when it is a string; add `cancel(connectionId)` (supersede without scheduling).
  `providerConfig.data.ts`: `putModelConfig(config, signal?)` sends `{ config }` and parses `modelConfigStateSchema`; `getModelConfig` parses the new schema; `probeModelConnection(connection, { credential?: string; signal? })`.
  `ProviderConfigPage.tsx`: read `accountId` from `useContext(ResearcherSessionContext)`; delete the mode toggle; Apply:
  ```ts
  const state = await putModelConfig(draft)
  const dropped = commit(state.config)
  void sendModelKeys(accountId, dropped)
  ```
  `ProviderRoutesEditor.tsx`: delete the `mode` branch (the single-model editor) and `configurationMode`; each task's connection select calls `assign(task.key, value ? { connectionId: value, modelId: route?.modelId ?? '' } : null)` and its model combobox `assign(task.key, { connectionId: route.connectionId, modelId })`. `ProviderConnectionCard.tsx`: delete the provider `<select>` (the provider is fixed once added); replace the credential block with the key line: a stored key for the current address → "Key saved in this browser" with Replace (shows the input) and Remove (`removeKey`); otherwise a password-style input (`setKey`), and for an optional-key connection with `hasKey` and no key here, "Use without a key" (`connectWithoutKey`).
  E2E fixtures: `hasKey` on every connection; GET without `credentialStates`; PUT answers `{ config }`; `/api/model-keys` answered `{ accepted: [] }`. Delete e2e cases whose UI no longer exists (`Single model saves, reloads, and checks …`, the keyring-failure copy in `probe failures do not gate retryable offline Apply and pending state`) — Task 14 rewrites the spec. `authentication-accessibility.spec.ts`: drop `credentialStates`. `canonical-evidence-lifecycle.spec.ts`: the seeded Ollama connection gets `hasKey: false`.

- [ ] **Step 5: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e
  grep -rnE "_keyring|CredentialStore|credentialStates|CredentialActions|keyring_unavailable|configurationMode|setSingleConnection|setSingleModel|setRouteModel|resolvedCredential|savedCredential" prototypes/studio --include=*.ts --include=*.tsx --exclude-dir=node_modules
  git add -A prototypes/studio/api/_keyring.ts
  git add prototypes/studio
  git commit -m "feat(studio)!: keep model keys in the researcher's browser and Studio's memory only"
  ```
  Expected grep output: nothing.

## Task 10: Remove the keyring packaging

**Files:**
- Modify: `prototypes/studio/package.json`, `pnpm-lock.yaml`, `prototypes/studio/Dockerfile`, `docker/studio-entrypoint.sh`, `compose.yaml` (comments), `tests/safety.test.mjs`

- [ ] **Step 1: Write the failing safety test**

  `image: Studio installs no keyring and starts no D-Bus`: `prototypes/studio/Dockerfile` contains neither `gnome-keyring`, `dbus-daemon`, `XDG_RUNTIME_DIR` nor `DBUS_SESSION_BUS_ADDRESS`; `docker/studio-entrypoint.sh` contains neither `dbus-daemon` nor `gnome-keyring-daemon` and still checks `CODEX_HOME`; `prototypes/studio/package.json` has no `@napi-rs/keyring` and no `env-paths`. Run `pnpm test:safety`: FAIL.

- [ ] **Step 2: Remove**

  ```bash
  FREE_SKIP_PYTHON=1 pnpm --filter studio remove @napi-rs/keyring env-paths
  grep -n "napi-rs/keyring" pnpm-lock.yaml       # expect nothing; env-paths stays for packages/db
  ```
  `Dockerfile`: the apt line installs only `ca-certificates` (update its comment); delete the `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` `ENV` and its comment. `docker/studio-entrypoint.sh` becomes:
  ```sh
  #!/bin/sh
  # Studio owns what a container starts without: Codex's persistent home, the authored database schema replayed
  # before the production Node host starts, and the Parsing Service's restricted database role.
  set -eu

  : "${CODEX_HOME:?CODEX_HOME must be set}"
  : "${DATABASE_URL:?DATABASE_URL must be set}"
  : "${FREE_KEI_POSTGRES_PASSWORD:?FREE_KEI_POSTGRES_PASSWORD must be set}"

  install -d -m 700 "$CODEX_HOME"

  # Hosted startup replays the authored migration history. It never updates the
  # schema directly or seeds an account; the first successful OIDC callback
  # creates the Researcher Account just in time.
  pnpm --filter db db:init

  # kei (the Parsing Service's DBOS worker from M3) logs in with its own role, which owns only kei_dbos.
  pnpm --filter db db:kei-role

  exec "$@"
  ```
  `compose.yaml`: the `studio-config` volume comment becomes "CODEX_HOME (Codex CLI login state)"; the `CLAUDE_CODE_OAUTH_TOKEN` comment no longer mentions `model-config.json` (say "if the operator enables the Claude Code deployment connection").

- [ ] **Step 3: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio test && pnpm --filter studio build
  pnpm test:safety
  docker build -f prototypes/studio/Dockerfile -t free-studio-m2-check .   # when Docker can build; report if not
  git add prototypes/studio/package.json pnpm-lock.yaml prototypes/studio/Dockerfile docker/studio-entrypoint.sh compose.yaml tests/safety.test.mjs
  git commit -m "chore(studio): remove the OS keyring, D-Bus and their packages"
  ```

## Task 11: CLI providers become deployment connections

**Files:**
- Modify: `shared/modelConfig.contract.ts`, `api/_deployment_models.ts`, `api/_model_config.ts`, and tests `api/_model_config.test.ts`, `api/model_probe.test.ts`, `api/_provider.test.ts`, a new `api/_deployment_models.test.ts`
- Modify: `src/providerConfig/ProviderConfigPage.tsx`, `src/providerConfig/ProviderConfigPage.test.tsx`
- Modify: `compose.yaml`, `compose.override.yaml`, `.env.example`, `tests/safety.test.mjs`

**Interfaces:**
- Produces: `DEPLOYMENT_CONNECTION_IDS.codexCli = '00000000-0000-4000-8000-00000000d003'`, `DEPLOYMENT_CONNECTION_IDS.claudeCode = '00000000-0000-4000-8000-00000000d004'`; `deploymentModels(env)` lists enabled CLI kinds as `{ provider: 'codex-cli' | 'claude-code', baseUrl: null, hasKey: false }`. `DEPLOYMENT_IDS` includes them automatically.

- [ ] **Step 1: Write the failing tests**

  - `_deployment_models.test.ts`: `FREE_DEPLOYMENT_CLI_PROVIDERS enables each CLI kind as a read-only deployment connection` (`'codex-cli,claude-code'` → both, in that order; `' claude-code '` → one; `'codex-cli,unknown'` → Codex only; unset → none); `the vLLM servers are listed as before`.
  - `_model_config.test.ts`: `Apply rejects a researcher-defined CLI connection` (409 at `config.connections.0.provider`, for both kinds); `a researcher connection may not reuse a CLI deployment ID`; delete the one-per-kind test.
  - `model_probe.test.ts`: `Probe rejects a researcher-defined CLI connection before running any CLI`; `an enabled CLI deployment connection is probed through its deployment ID` (injected `codexListModels` called; a disabled one → 409 "This deployment does not serve that connection.").
  - `_provider.test.ts`: `a route may name an enabled CLI deployment connection` (resolves with `claude-code`'s factory; no key read).
  - `ProviderConfigPage.test.tsx`: `CLI kinds are not offered for a new connection; enabled CLI deployment connections are listed read-only`.
  - `tests/safety.test.mjs`: `development enables both CLI deployment connections; the base file leaves them to the operator` (rendered dev Compose → `services.studio.environment.FREE_DEPLOYMENT_CLI_PROVIDERS === 'codex-cli,claude-code'`; `compose.yaml` text contains `FREE_DEPLOYMENT_CLI_PROVIDERS: "${FREE_DEPLOYMENT_CLI_PROVIDERS:-}"`).

- [ ] **Step 2: Implement**

  `_deployment_models.ts`:
  ```ts
  const CLI_DEPLOYMENTS = [
    { provider: 'codex-cli', id: DEPLOYMENT_CONNECTION_IDS.codexCli, name: 'Codex CLI on this server' },
    { provider: 'claude-code', id: DEPLOYMENT_CONNECTION_IDS.claudeCode, name: 'Claude Code on this server' },
  ] as const

  /** CLI providers run on the server's own CLI login (the CLI auth homes), so only the operator enables them, with
   *  FREE_DEPLOYMENT_CLI_PROVIDERS; every researcher can then route to them. Unknown entries are ignored. */
  function cliConnections(value: string | undefined): ModelConnection[] {
    const enabled = new Set((value ?? '').split(',').map((entry) => entry.trim()))
    return CLI_DEPLOYMENTS.filter(({ provider }) => enabled.has(provider))
      .map(({ provider, id, name }) => ({ id, name, provider, baseUrl: null, hasKey: false }))
  }
  ```
  appended to `connections` in `deploymentModels`. `_model_config.ts` `semanticIssues`: replace the CLI branch and `cliCounts` with
  ```ts
  if (providerTable[connection.provider].transport === 'cli') {
    issues.push({ path: `${at}.provider`, message: 'CLI providers run on the server\'s own login; the operator enables them as deployment connections.' })
    return
  }
  ```
  (Task 9's CLI `hasKey` rule goes with it.) `ProviderConfigPage.tsx`: the "New connection" list is `providers.filter(({ transport }) => transport !== 'cli')`; a deployment connection with `baseUrl === null` shows "Runs on this server's CLI login" instead of a URL. `compose.yaml` `studio.environment`: `FREE_DEPLOYMENT_CLI_PROVIDERS: "${FREE_DEPLOYMENT_CLI_PROVIDERS:-}"` with a comment; `compose.override.yaml`: `FREE_DEPLOYMENT_CLI_PROVIDERS: codex-cli,claude-code`; `.env.example`: a commented `# FREE_DEPLOYMENT_CLI_PROVIDERS=codex-cli,claude-code` line explaining that every researcher's calls then run on this server's CLI login and billing.

- [ ] **Step 3: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm test:safety
  git add prototypes/studio compose.yaml compose.override.yaml .env.example tests/safety.test.mjs
  git commit -m "feat(studio): make the Codex and Claude Code CLIs operator-enabled deployment connections"
  ```

## Task 12: App-wide key handoff

**Files:**
- Modify: `src/modelKeys/modelKeyHandoff.ts` (+ test), `src/auth/AuthApplication.tsx` (+ test), `src/auth/AuthForms.tsx` (+ `AuthApplication.test.tsx` sign-out case), `src/api.ts` (+ test), `src/ChatTab.tsx` (+ test), `src/projectContexts/batchExtractions.ts` (+ test), `src/projectContexts/BatchExtractionsPanel.tsx` (+ test)
- Modify: `api/_batch_schema_suggestions.ts` (+ test)

**Interfaces:**
- Consumes: Task 6's `sendModelKeys`, `subscribeToModelKeyResend`, `clearModelKeys`.
- Produces:
  ```ts
  export function setModelKeyAccount(accountId: string | null): void
  /** Awaited before a POST that starts model work: resolves once this browser's keys reached Studio (best effort). */
  export function ensureModelKeysSent(): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

  - `AuthApplication.test.tsx`: `an authenticated app sends this browser's keys on load`; `a new Studio boot ID resends them once`; `unmounting stops the resends`; `signing out clears this account's keys in this browser and leaves another account's`.
  - `api.test.ts`: `requestSchema and requestSchemaEdit hand the keys to Studio before their POST` (the recorded fetch order is `PUT /api/model-keys`, then the POST; a failing PUT still lets the POST go).
  - `ChatTab.test.tsx`: `a chat message is sent after the keys`.
  - `batchExtractions` test: `creating and retrying a batch suggestion send the keys first` (and `run`, which starts no Studio model work, does not).
  - `_batch_schema_suggestions.test.ts`: `a missing key is recorded as model_key_required`.
  - `BatchExtractionsPanel.test.tsx`: `a model_key_required source failure reads "Model key not available"`.
  - `modelKeyHandoff.test.ts`: `ensureModelKeysSent does nothing before an account is set`.

- [ ] **Step 2: Implement**

  `modelKeyHandoff.ts`:
  ```ts
  let activeAccount: string | null = null
  export function setModelKeyAccount(accountId: string | null): void { activeAccount = accountId }
  export function ensureModelKeysSent(): Promise<void> {
    return activeAccount ? sendModelKeys(activeAccount) : Promise.resolve()
  }
  ```
  `AuthApplication.tsx`, in `AuthenticatedProject`:
  ```ts
  useEffect(() => {
    const accountId = session.account.id
    setModelKeyAccount(accountId)
    void sendModelKeys(accountId)
    const stop = subscribeToModelKeyResend(() => void sendModelKeys(accountId))
    return () => {
      stop()
      setModelKeyAccount(null)
    }
  }, [session.account.id])
  ```
  `AuthForms.tsx` `SignOutButton`: read `useContext(ResearcherSessionContext)`; `onSubmit` calls `markSessionSignedOut()` then, when a session is present, `clearModelKeys(session.account.id)` (Studio's copy is evicted by Task 6's logout handler).
  `src/api.ts`: `await ensureModelKeysSent()` at the start of `requestSchema` and `requestSchemaEdit`. `ChatTab.tsx`: the transport's `fetch` is `async (input, init) => { await ensureModelKeysSent(); return authenticatedFetch(input, init) }`. `batchExtractions.ts`: `await ensureModelKeysSent()` before the create and retry POSTs.
  `_batch_schema_suggestions.ts` `sourceSuggestionFailure`: add `'model_key_required'` to the code union and the accepted `ApiError` codes. `BatchExtractionsPanel.tsx` `suggestionFailureCategories`: `model_key_required: 'Model key not available'`.

- [ ] **Step 3: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e
  git add prototypes/studio
  git commit -m "feat(studio): hand the browser's keys to Studio on load, before model work and after a restart"
  ```

## Task 13: The Model Configuration page (variant B1)

**Files:**
- Rewrite: `src/providerConfig/ProviderConfigPage.tsx`, `src/providerConfig/ProviderConfigPage.test.tsx`
- Create: `src/providerConfig/ModelsTab.tsx`, `src/providerConfig/ConnectionsTab.tsx`, `src/providerConfig/ModelPicker.tsx`, `src/providerConfig/ModelPicker.test.tsx`
- Modify: `src/providerConfig/useProbeLifecycle.ts`, `src/providerConfig/providerConfig.data.ts`
- Delete: `src/providerConfig/ProviderRoutesEditor.tsx`, `ProviderConnectionCard.tsx`, `ModelCombobox.tsx`, `ModelCombobox.test.tsx`, `ExtractionModelSelect.tsx`
- Delete: `e2e/model-configuration.spec.ts` (every remaining case drives the old layout; Task 14 writes the new spec)

**Interfaces:**
- Consumes: Task 9's hook (unchanged), Task 4's `readIngestionModels`, `readExtractionModels`, Task 8's `usesNuextractProtocol` and `selectedRoute` semantics, Task 11's deployment list.
- Produces:
  ```ts
  export type PickerOption = { value: string; label: string; hint?: string; disabled?: boolean }
  export type PickerGroup = { key: string; label: string; status?: ReactNode; note?: string; options: PickerOption[]; freeText?: (typed: string) => string }
  export function ModelPicker(props: { ariaLabel: string; value: string; display: ReactNode; groups: PickerGroup[]; reset?: { value: string; label: string }; onChange(value: string): void }): JSX.Element
  // useProbeLifecycle gains:
  refreshAll(entries: readonly { connection: ModelConnection; credential: string | null | undefined }[]): void
  ```

The page (read `VariantB1.tsx`, `VariantB.tsx` `BShell`/`ConnectionsTab`, and `parts.tsx` on the prototype branch for layout and copy; do not copy their draft or fake server):
- **Shell:** header "Model Configuration"; `role="tablist"` with tabs "Models" and "Connections · N" (`aria-selected`); the close button keeps `aria-label="Close Model Configuration"`, `initialFocusRef` and `autoFocus` (the accessibility e2e depends on them); an error alert; footer "Discard" (`discard()`, disabled when not dirty) and "Apply" (disabled while applying or not dirty). Models and Connections share the one draft and the one Apply.
- **Load:** `getModelConfig`, `readExtractionModels` and `readIngestionModels` in parallel; a listing failure only leaves that listing empty. After the configuration arrives, `refreshAll` probes every eligible connection once, immediately: deployment connections and keyless ones with no credential, `hasKey` ones with `credentialFor(connection)` (this browser's key for this account, provider and base), and none without such a key.
- **Models tab:** an ordered list of three steps. A step at its defaults is one sentence with "Change"; once changed (or opened) it shows its pickers and "Use defaults", which removes the step's stored choice. One faint line per step says where the options come from: "Choose among the models this deployment runs." (steps 1 and 3; step 1 adds "Applies to new uploads and reprocessing.") or "Choose any model from your connections." (step 2).
  1. *Reading documents* — summary "Scanned pages are read by X, page regions found by Y." from the ingestion listing's defaults (or "the deployment's default models" when the listing failed). Pickers "Text recognition" and "Page regions" over the listing; an OCR model with `serving: false` is shown disabled with the hint "Not loaded on the OCR server"; a saved key the listing no longer offers stays selected and is labelled "(not offered by this deployment)". "Use defaults" → `setIngestionModel('ocr', '')` and `('layout', '')`.
  2. *Schema & chat* — summary "Chat, schema editing and Schema Suggestion use M, the deployment's model." (or "No model is configured yet." when there is no default route). Open: the **Assistant model** picker (`assign('interaction', target)`). Below it, when `routes.schemaSuggestion === null`: "Schema Suggestion uses the assistant model." and a "Use a different model" button that reveals a Schema Suggestion picker whose reset option reads "Use the assistant model"; picking a target calls `assign('schemaSuggestion', target)` and it stays explicit even when equal to the Assistant model. When `routes.schemaSuggestion !== null`: the picker plus a "Use the assistant model" button (`assign('schemaSuggestion', null)`). There is no equality-based linking (the prototype's `sameTarget` logic is superseded). When the route Schema Suggestion would run (explicit or inherited) satisfies `usesNuextractProtocol`, show "Schema Suggestion uses the NuExtract protocol for this model." — never a control. "Use defaults" → `assign('interaction', null)` and `assign('schemaSuggestion', null)`.
  3. *Extracting data* — summary "F reads field values, R reasons over the source." from the extraction listing's defaults; pickers "Field values" and "Reasoning" filtered by role, non-serving models disabled with "Not serving", unlisted saved keys kept. "Use defaults" → both roles `''`.
- **Route picker:** one `ModelPicker` per route over every routable connection (deployment first, then the researcher's), grouped by connection with a status dot and the probe note ("Listing models…", or the probe message on failure); options are the probe catalog plus the current model; search; free text offers "Use <typed id>" for each connection. Encode a target as `JSON.stringify([connectionId, modelId])`, never with a separator character.
- **Connections tab:** a list (deployment connections first with a lock marker and "Deployment", then the researcher's) and a detail pane. "Add connection" opens a menu of non-CLI kinds (managed: "Hosted API · needs a key"; optional: "Your own server"). A deployment connection's pane is read-only: name, base URL or "Runs on this server's CLI login", probe status, model list. A researcher's pane: name, base URL (HTTP kinds; the provider is fixed once added), the key line (saved in this browser with Replace and Remove, or an input, and "Use without a key" for an optional kind with `hasKey` and no key here), probe status, "Delete connection".
- **Edits:** name/base/key edits schedule a debounced probe (500 ms, superseding) through the hook; a base change cancels and clears as the hook does.

- [ ] **Step 1: Write the failing tests**

  `ModelPicker.test.tsx`: `groups options by connection, searches, and offers an exact model ID`; `disabled options cannot be chosen`; `Escape closes it and returns focus to the trigger`.
  `ProviderConfigPage.test.tsx` (rewrite; jsdom; `ResearcherSessionContext`; `fetch` stub routing `/api/model_config`, `/api/model_probe`, `/api/model-keys`, `/api/extraction-models`, `/api/ingestion-models`):
  1. `opens on Models with each step as one sentence at its defaults`
  2. `probes every eligible connection once on open with exactly the credential the rules allow` (connections: a deployment vLLM, a keyless Ollama, an OpenAI with a key in this browser for its base, an OpenAI with a key stored for another base, a vLLM with `hasKey` and no key; assert the probe request bodies: deployment and Ollama without `credential`, the first OpenAI with its key, the other two not probed)
  3. `Change opens a step and Use defaults removes its stored choice` (for each step; the next PUT body has the routes `null`, `extractionModels: {}`, `ingestionModels: {}`)
  4. `an unset Schema Suggestion route follows the Assistant model, and Use a different model stores an explicit route even when it equals it` (pick the same target → PUT body has `schemaSuggestion` equal to `interaction`; reopen the page with that saved document → the explicit picker is shown, not the "uses the assistant model" sentence; "Use the assistant model" → `null`)
  5. `the NuExtract protocol is shown as automatic for a NuExtract model on vLLM and never offered as a control`
  6. `the ingestion step cannot choose an OCR model the OCR server does not serve, and keeps a saved choice the listing no longer offers`
  7. `a failed ingestion or extraction listing blocks no other edit` (both listings 503; Apply of a route change succeeds)
  8. `deployment connections are read-only, CLI kinds are not offered, and a saved connection's provider cannot change`
  9. `the key line offers Replace and Remove for a key saved in this browser, or an input`
  10. `a draft base change clears the typed key and never probes the new base with the old key` (fake timers)
  11. `Apply sends the configuration without keys, then this browser's keys; Discard restores the saved draft`
  12. `the close button keeps its name and initial focus`

- [ ] **Step 2: Implement** the components above, `refreshAll` in `useProbeLifecycle.ts`, and delete the five old files and `e2e/model-configuration.spec.ts` (`rm`). Remove `ROUTABLE_TASKS` from `providerConfig.data.ts` if nothing uses it.

- [ ] **Step 3: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:e2e       # authentication-accessibility still opens and closes the dialog by keyboard
  grep -rn "ProviderRoutesEditor\|ProviderConnectionCard\|ModelCombobox\|ExtractionModelSelect" prototypes/studio/src prototypes/studio/e2e
  git add -A prototypes/studio/src/providerConfig/ProviderRoutesEditor.tsx prototypes/studio/src/providerConfig/ProviderConnectionCard.tsx prototypes/studio/src/providerConfig/ModelCombobox.tsx prototypes/studio/src/providerConfig/ModelCombobox.test.tsx prototypes/studio/src/providerConfig/ExtractionModelSelect.tsx prototypes/studio/e2e/model-configuration.spec.ts
  git add prototypes/studio/src/providerConfig
  git commit -m "feat(studio): redesign the Model Configuration page around the researcher's three steps"
  ```
  Expected grep output: nothing.

## Task 14: Rewrite `e2e/model-configuration.spec.ts` once

**Files:**
- Create: `prototypes/studio/e2e/model-configuration.spec.ts`

Two groups. The first runs against the real Studio server and PostgreSQL of the Playwright stack (no configuration mocks) with a fresh account per test (`loginResearcher(page, randomUUID())`; `e2eIdentity` accepts any canonical object ID), so it never collides with other specs; it routes only `/api/model_probe` (fulfilled with a catalog, bodies recorded) and the two listings. The second mocks `/api/model_config` too where a fixture is simpler. Read the signed-in account ID from `GET /api/auth/session` and seed browser keys with `page.evaluate((key, value) => localStorage.setItem(key, value), 'free.modelKeys.v1:' + accountId, JSON.stringify({...}))` before opening the dialog.

- [ ] **Step 1: Write the spec**

  Real server (`test.describe.configure({ mode: 'serial' })`):
  - `two accounts: each sees and changes only its own configuration` — account A adds a vLLM connection, sets the Assistant model, applies; account B (another browser context) opens the page: no researcher connections, step 2 at its default; B applies its own route; A reloads: still A's.
  - `an explicit Schema Suggestion model stays explicit across a reload even when it equals the Assistant model` — and "Use defaults" on step 2 then reloads to one sentence.
  - `Apply hands this browser's key to Studio for the connection's current base only` — add an OpenAI-compatible connection with a key, apply; the recorded `PUT /api/model-keys` response lists that connection ID; change the base, apply; the next handoff sends `null` for it and no entry for the new base.
  - `a stale tab's key handoff under another signed-in account is rejected` — in one context sign in as A, record A's ID, sign out, sign in as B; `page.request.put('/api/model-keys', { headers: { origin: E2E_ORIGIN }, data: { account: A, keys: {} } })` → 409 `account_mismatch`.
  - `a malformed key handoff echoes nothing` — `data: { account, keys: { [id]: { key: 'sk-test-e2e-planted', provider: 'openai', baseUrl: 7 } } }` → 400; the body excludes the planted string.
  Mocked configuration:
  - `opening the page probes each connection with exactly the credential the rules allow` (same five connections as the unit test; inspect `/api/model_probe` request bodies).
  - `a draft base change never probes the new base with the old key`.
  - `the ingestion step marks OCR models the OCR server does not serve and cannot choose them; a listing failure blocks no other edit`.
  - `the extraction and ingestion steps keep a saved choice the listing no longer offers`.

- [ ] **Step 2: Run and commit**

  ```bash
  pnpm --filter studio exec playwright test e2e/model-configuration.spec.ts
  pnpm --filter studio test:e2e
  git add prototypes/studio/e2e/model-configuration.spec.ts
  git commit -m "test(studio): cover the Model Configuration steps, key rules and two accounts end to end"
  ```

## Task 15: Verification and bookkeeping

**Files:**
- Create: `docs/validation/<YYYY-MM-DD>-dbos-m2-verification.md`
- Modify: `docs/plans/2026-09-24-unified-durable-execution.md` (the M2 heading only), this plan's `Status:` line

- [ ] **Step 1: Residue search**

  ```bash
  grep -rnE "configurationMode|setSingleConnection|setSingleModel|setRouteModel|setNuextractProtocol|protocol: 'nuextract'|schemaSuggestionRouteSchema|credentialStates|CredentialActions|credentialStateSchema|_keyring|napi-rs/keyring|keyring_unavailable|ConfigFileSystem|model-config\.json|serializeModelConfigWrite|resetModelConfig|readModelConfig\(|dbus-daemon|gnome-keyring|PromptRevision|SchemaSuggestionInput|ConversationalSchemaEdit|retryRecordStartBlockIds" \
    prototypes packages scripts docker compose*.yaml tests .github .env.example --exclude-dir=node_modules --exclude-dir=.venv
  ```
  Expected: only the 422 request-body test in `prototypes/studio/api/extractions.test.ts` (`retryRecordStartBlockIds`, a stale-page body). `docs/operations/deployment.md:320` still names `model-config.json`; that is M6's documentation (Deferred table).

- [ ] **Step 2: Run every tier**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety
  # fresh disposable databases (Global Constraints), plus PARSING_TEST_DATABASE_URL for the parsing tier:
  pnpm test:postgres
  pnpm test:e2e
  pnpm test:service
  pnpm --filter studio build
  ```
  Expected: all pass. `test:service` needs Docling models and the real parsing worker; if this host cannot run it, record why. Never report a tier as passed without its output.

- [ ] **Step 3: Record**

  Write the verification record (tested commit, commands, results, skips, and a pointer to the traceability table below). In the DBOS plan change `**M2: platform, baseline and configuration.**` to `**M2: platform, baseline and configuration — done YYYY-MM-DD.** Task plan: [2026-09-26-dbos-m2-platform-configuration.md](2026-09-26-dbos-m2-platform-configuration.md).` Set this plan's status to `done YYYY-MM-DD`.
  ```bash
  git add docs/validation/<file> docs/plans/2026-09-24-unified-durable-execution.md docs/plans/2026-09-26-dbos-m2-platform-configuration.md
  git commit -m "docs(plans): record DBOS M2 completion"
  ```

## Traceability: M2 acceptance → tests

| Spec M2 acceptance bullet | Test(s) | Task |
|---|---|---|
| A key sent for one API base is never used for another | `api/_model_keys.test.ts` › `a key sent for one API base is never read for another`; `api/model_keys.test.ts` › `caches a key only for the account's own hasKey connection at its current provider and base`; `api/_model_config.test.ts` › `Apply drops cached keys of removed and re-addressed connections` | 6, 9 |
| A draft base change never probes the new base with the old key | `ProviderConfigPage.test.tsx` › `a draft base change clears the typed key and never probes the new base with the old key`; `e2e/model-configuration.spec.ts` › same name | 9, 13, 14 |
| Sign-out and key removal clear the cache | `server/app.test.ts` › `sign-out evicts the signed-in account's keys`; `api/model_keys.test.ts` › `a null entry removes the cached key and is accepted`; `AuthApplication.test.tsx` › `signing out clears this account's keys in this browser …` | 6, 9, 12 |
| Opening the page sends each probe exactly the credential the rules allow (inspecting requests) | `ProviderConfigPage.test.tsx` › `probes every eligible connection once on open with exactly the credential the rules allow`; `e2e/model-configuration.spec.ts` › `opening the page probes each connection with exactly the credential the rules allow` | 13, 14 |
| A stale tab's handoff under another signed-in account is rejected | `api/model_keys.test.ts` › `a stale tab's handoff under another signed-in account is rejected`; `e2e/model-configuration.spec.ts` › same | 9, 14 |
| A malformed key or probe request echoes nothing | `api/model_keys.test.ts` › `a malformed body echoes nothing and logs nothing`; `api/model_probe.test.ts` › `a malformed probe echoes nothing and logs nothing`; `e2e/model-configuration.spec.ts` › `a malformed key handoff echoes nothing` | 9, 14 |
| No account's call uses another account's key or connection | `api/_model_keys.test.ts` › `one account never reads another account's key`; `api/_provider.test.ts` › `resolving a route that names another account's connection is 409`, `no account's call uses another account's key`; `api/model_auth.test.ts` › `each account reads only its own configuration`, `each account's key serves only its own calls`; `e2e` › `two accounts …` | 6, 7, 9, 14 |
| One account's concurrent applies serialize | `packages/db/src/model-configuration.postgres.check.ts` › `concurrent applies of one account serialize and the second sees the first's document` | 2 |
| A `hasKey` connection with no cached key never calls its server anonymously | `api/_provider.test.ts` › `keyedModel` › `never calls the server when the key is missing …`, resolver › `a hasKey route with no cached key waits, then fails with model_key_required without calling its server`; `api/_model.test.ts` › `a keyed NuExtract call with no key never reaches vLLM` | 6, 9 |
| Apply and Probe reject a researcher-defined CLI connection | `api/_model_config.test.ts` › `Apply rejects a researcher-defined CLI connection`; `api/model_probe.test.ts` › `Probe rejects a researcher-defined CLI connection before running any CLI` | 11 |
| The app shell's CSP allows the PDF viewer and its worker, and refuses inline script | `e2e/app-shell-csp.spec.ts`; `server/contentSecurityPolicy.test.ts`; `server/static.test.ts` › `the index response carries the app shell policy …`; `tests/safety.test.mjs` › `app shell: …` | 5 |
| kei's role is denied on `public` and `dbos` | `packages/db/src/kei-role.postgres.check.ts` › `kei logs in with its own role, owns only kei_dbos, and is denied on public and dbos` | 3 |
| A NuExtract model on a vLLM connection runs Schema Suggestion with the NuExtract protocol, no other route uses it; all four combinations | `api/_provider.test.ts` › `Schema Suggestion uses the NuExtract protocol exactly for a NuExtract model on a vLLM connection` (4 cases), `no other route ever uses the NuExtract protocol` | 8 |
| An unset Schema Suggestion route follows the Assistant model | `api/_provider.test.ts` › `an unset Schema Suggestion route follows the Interaction Route, then the deployment default`; `ProviderConfigPage.test.tsx` case 4 | 8, 13 |
| An explicit one stays explicit across a reload, even when equal | `api/_model_config.test.ts` › `an explicit Schema Suggestion route equal to the Interaction Route is stored as submitted`; `e2e` › `an explicit Schema Suggestion model stays explicit across a reload …` | 8, 14 |
| "Use defaults" removes a step's stored choice | `ProviderConfigPage.test.tsx` › `Change opens a step and Use defaults removes its stored choice`; `e2e` › explicit-reload case | 13, 14 |
| The ingestion listing marks OCR models the OCR server does not serve, and the page cannot choose one | `tests/test_ingestion_models.py` › `…marks only the loaded ocr model serving`, `an unreachable ocr server serves no ocr model …`; `ProviderConfigPage.test.tsx` case 6; `e2e` › ingestion case | 4, 13, 14 |
| A saved choice it no longer lists stays saved, and a listing failure blocks no other edit | `api/_model_config.test.ts` › `the Ingestion Model Choice is stored as submitted …`; `ProviderConfigPage.test.tsx` cases 6–7; `api/ingestion_models.test.ts` › `answers 503 …`; `e2e` › listing cases | 4, 8, 13, 14 |

Other M2 items and where they are built: baseline (1); per-account storage and lock (2, 7); kei role and `kei_dbos` in the entrypoint, `FREE_KEI_POSTGRES_PASSWORD` (3); dev watch `sync+restart`/`sync` (3); kei `GET /api/ingestion-models` and Studio's forward (4); CSP (5); key cache, boot header, browser key store, `authenticatedFetch` resend (6); researcher-scoped `model_config`/`model_probe`, owner-scoped resolution and Extraction Model Choice readers, accountless fallbacks and `DELETE /api/model_config` removed (7); Schema Suggestion inheritance, derived protocol, `ingestionModels` stored (8); `hasKey`, `PUT /api/model-keys`, lazy keyed wrapper, 60 s wait, `model_key_required`, credential actions and `credentialStates` dropped, fixed validation errors, draft key clearing, single route setter (9); keyring packaging (10); CLI deployment connections and `FREE_DEPLOYMENT_CLI_PROVIDERS` (11); handoff on load, before model work, on a new boot ID, after `model_key_required`, sign-out clearing (12); the page (13); the e2e rewrite with the two-account case (14).
