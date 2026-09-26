# DBOS M4 verification — 2026-09-26

**Scope.** `feat/dbos-m2-m6` through `d8be8fa` (Tasks 11–14 and earlier M4 commits). This record concerns M4 only. The [M4 acceptance traceability table](../plans/2026-09-26-dbos-m4-studio-background.md#traceability-m4-acceptance--tests) maps each binding-spec item to its test. No deployment or Spark run was performed.

## Automated gates

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Passed after the final service test changes. |
| `pnpm lint` | Passed; three existing React hook dependency warnings, no errors. |
| `pnpm test:unit` | Passed: Studio 1,354, DB 60, extraction 67, export 33, scripts 58, config 4, parsing 949. The later scope-cancellation change passed its focused 5/5 test. Parsing reported 72 skipped and 66 deselected. |
| `pnpm test:safety` | 18/18 passed after the Compose port parameterization. |
| `pnpm test:postgres` | Passed on freshly recreated disposable M4 databases: DB 41/41, extraction 55/55, Studio 26/26, parsing 48/48. The parsing marker selected 48 and deselected 1,039 tests. |
| `FREE_PLAYWRIGHT_KEI_EXP_PORT=29752 pnpm --filter studio exec playwright test --workers=4` | 56/56 passed. The alternate fake-kei port avoided another checkout's listener on 29750. The initial full run encountered that collision and a picker timeout; the next run found a narrow-viewport resize race in an accessibility test, which was fixed and passed in isolation before this full green run. |
| `pnpm --filter studio test:e2e:base-path` | 2/2 passed. |
| `pnpm test:service` | 9/9 passed with the real kei DBOS worker, native Docling/PDFium parsing, and a scripted instruction-model boundary. The cancellation case waits for the released model response and recorded `extract_run` step completion before checking for late publication. A test-only barrier at native conversion entry proves that a small conversion and extraction finish while the large lane remains occupied, and that a worker killed inside the native runner recovers. The focused two-case run also passed 2/2. |
| `pnpm test:system` | 15/15 passed against an isolated Compose project (`free-system-m4`) on ports 41843, 41844 and 45445. The system overlay scripts only the external instruction-model response; authentication, Studio, PostgreSQL, DBOS, parsing, grounding, review, restart and deletion use the built stack. |
| `pnpm --filter studio build` | Passed. |

The black-box system suite used a one-day self-signed local certificate because `mkcert` was absent in this checkout; its harness disables TLS validation for that local test. The initial system attempt stopped before startup for missing `mkcert`, then the certificate-backed run passed. The real-service environment was repaired earlier with `uv sync --locked`, which installed the pinned `dbos==3.1.0` into this worktree's `.venv`; that repair was outside the plan's no-`uv sync` constraint and changed no dependency declaration or lockfile.

## Production-bundle smoke

Created only `free_test_m4_bundle` on the disposable `free-m1-pg` container and migrated it with `DATABASE_URL=.../free_test_m4_bundle pnpm --filter db db:init`. With a throwaway Entra key and SHA-256 certificate thumbprint, started `node prototypes/studio/dist/server/index.js` in loopback production mode. The server logged `FREE Studio listening on 127.0.0.1:41901`. An external `DBOSClient` for application `studio` enqueued `runExtraction` on queue `studio` for an absent Extraction ID; the workflow reached `SUCCESS`. It was then stopped with SIGTERM.

The same client queried `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()` on the bundle database: **6 connections idle** before enqueue and **7 during admission** immediately after enqueue. These are observed counts with the smoke's measuring client included, not a capacity bound or a full Studio-plus-kei load measurement. M6 should use them as an input to its pool measurement.

## Residue and limits

The M4 residue search found no live `ExtractionJob`, lease worker, suggestion pump, ingestion-key admission or Studio HTTP-kei submission path. Remaining literal names occur in negative contract tests (`ingestionKey`, `retryOfId`, `KEI_EXP_MODEL`) and current batch-member view types, which are not the removed table. Older operations and architecture documents are deferred to M6 by the [task plan](../plans/2026-09-26-dbos-m4-studio-background.md).

The real-service model is scripted, and the system model fixture answers the contract PDF deterministically. These gates do not establish real-model behavior or scanned-book/GPU concurrency; the binding spec reserves those checks for later verification. The bundle smoke exercises startup and DBOS dispatch with a missing domain row, not a complete hosted extraction.
