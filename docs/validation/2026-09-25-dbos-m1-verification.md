# DBOS M1 verification — 13eb18e — 2026-09-25

Status: executed at `13eb18e`. The unit, static, safety, PostgreSQL, build,
real-service and Python smoke tiers pass. `test:e2e` and `test:e2e:base-path`
fail. Every failure is classified below: none is attributed to M1, but two
causes predate M1 and keep both browser tiers red. No code was changed for this
record. This is not an all-green certification.

## Scope and environment

- Commit: `13eb18ea78acbea47e7fe38b4af513d039cd5c7a` on `chore/dbos-m1-dead-code`,
  the last code commit of the [M1 plan](../plans/2026-09-25-dbos-m1-dead-code.md).
  Change boundary: `7461937..13eb18e`. Task numbers follow that plan; Tasks 11
  and 12 are its "Catalog action" and "Missing legacy cases" review items.
- Working tree: clean apart from an uncommitted, docs-only edit of the M1 plan.
- Host: Ubuntu 24.04.5 LTS, Linux 6.8.0, x86_64, 24 CPUs, 62 GiB RAM, one NVIDIA
  RTX 4090. `test:service` pins `CUDA_VISIBLE_DEVICES=''`. The Python smoke's
  worker may use the GPU.
- Versions: Node 24.21.0, pnpm 10.9.0, Docker 29.8.1 with Compose 5.5.1,
  uv 0.12.17, Python 3.13.13, docling 2.127.0, torch 2.14.0, FastAPI 0.141.1,
  pytest 9.1.1, Vite 8.2.0, Vitest 4.1.10, Playwright 1.62.1 (Chromium
  151.0.7922.34), TypeScript 6.0.3, ESLint 10.8.0.
- Disposable PostgreSQL: the container described in the M1 plan's Global
  Constraints (`postgres:17`, PostgreSQL 17.11 on tmpfs, user `postgres` on
  `127.0.0.1:5432`):
  - `free_test_parsing` (`PARSING_TEST_DATABASE_URL`): the Parsing tiers'
    maintenance database. Each test creates and drops its own
    `free_test_parsing_*` database.
  - `free_test_extraction` (`EXTRACTION_TEST_DATABASE_URL`): migrated with
    `pnpm --filter db db:init` earlier in M1; no M1 commit adds a migration.
  - `free_test_project_store` (`PROJECT_STORE_POSTGRES_URL`): created for this
    record with `createdb` and migrated with
    `DATABASE_URL=<its URL> pnpm --filter db db:init` (10 migrations). The check
    reads the schema directly, and `scripts/test-ci.mjs` migrates the same
    target before `test:all`.
  - The Playwright harnesses started and removed their own Compose stacks
    (`postgres:17`, `ghcr.io/navikt/mock-oauth2-server:2.2.1`), with
    `free_test_studio`, `free_test_studio_base_path` and `free_test_real_service`.
- Docling weights were already in the Hugging Face cache
  (`docling-project/docling-layout-heron`, `-heron-101`, `-egret-xlarge`,
  `docling-models`).
- Upstream fixture PDFs (`Beier1988_GAC_02_Catalogue7.pdf`, `main.pdf`) were
  read in place from a local kei-exp checkout through `PARSING_FIXTURE_DIR`,
  only in the runs that name it below. CI never has them.
- The model boundary was scripted or absent in every run. No live model took
  part; see [Live-model gaps](#live-model-gaps).

## Results

"Run now" means run at `13eb18e` for this record. pytest counts exclude marker
deselection, which is the tier boundary rather than a skip.

| Tier | Command | Commit | Result | Evidence |
| --- | --- | --- | --- | --- |
| Scripts | `node --test scripts/free.test.mjs scripts/test-ci.test.mjs` | 13eb18e | 48/48 pass | run now |
| Studio configuration | `pnpm --filter studio-configuration test` | 13eb18e | 4/4 pass | run now |
| Studio unit | `pnpm --filter studio test` | 13eb18e | 94 files, 1059/1059 pass | run now; Task 12 recorded the same counts |
| db unit | `pnpm --filter db test` | 13eb18e | 55/55 pass | run now |
| Extraction unit | `pnpm --filter extraction test` | 13eb18e | 37/37 pass | run now |
| Result export unit | `pnpm --filter extraction-result-export test` | 13eb18e | 33/33 pass | run now |
| Parsing fast | `pnpm --filter parsing-service test` | 3e3f888 | 809 passed, 73 skipped, 127 deselected | reused from Task 5's run at `3e3f888`: `git diff --stat 3e3f888..13eb18e -- prototypes/parsing_service` prints nothing. The skip-reason listing at `13eb18e` (same command, `PYTEST_ADDOPTS=-rs`) reproduced the same counts. |
| Studio typecheck | `pnpm --filter studio typecheck` | 13eb18e | clean | run now |
| db typecheck | `pnpm --filter db typecheck` | 13eb18e | clean | run now |
| Extraction typecheck | `pnpm --filter extraction typecheck` | 13eb18e | clean | run now |
| Result export typecheck | `pnpm --filter extraction-result-export typecheck` | 13eb18e | clean | run now |
| Lint | `pnpm --filter studio lint` | 13eb18e | 0 errors, 3 warnings | run now |
| Safety | `pnpm test:safety` | 13eb18e | 14/14 pass, none skipped | run now |
| db PostgreSQL | `PROJECT_STORE_POSTGRES_URL=… pnpm --filter db test:postgres` | 13eb18e | 3/3 pass (one test, two subtests) | run now |
| Extraction PostgreSQL | `EXTRACTION_TEST_DATABASE_URL=… pnpm --filter extraction test:postgres` | 13eb18e | 28/28 pass | run now; Task 12 recorded the same counts |
| Parsing PostgreSQL | `PARSING_TEST_DATABASE_URL=… PARSING_FIXTURE_DIR=… pnpm --filter parsing-service test:postgres` | 13eb18e | 107 passed, 0 skipped, 902 deselected | run now |
| Studio build | `pnpm --filter studio build` | 13eb18e | pass: `tsc -b`, client and SSR bundles; no inspector strings in `dist/` | run now |
| Browser E2E | `pnpm test:e2e` | 13eb18e | run 1: 48 passed, 2 failed, 1 did not run; run 2: 49 passed, 1 failed, 1 did not run (51 tests) | run now, twice: [F1](#f1--e2e-run-1-mock-oidc-sign-in-failed), [F2](#f2--e2e-run-1-the-lifecycle-fixture-port-was-taken), [F3](#f3--e2e-run-2-stale-extraction-snapshot-expectation) |
| Base-path E2E | `pnpm --filter studio test:e2e:base-path` | 13eb18e | 0 passed, 1 failed, 1 did not run (2 tests) | run now: [F4](#f4--base-path-studio-and-the-lifecycle-fixture-share-12700141750) |
| Real service | `pnpm test:service` | 13eb18e | 2/2 pass | run now |
| Python smoke | `PARSING_TEST_DATABASE_URL=… uv run --no-sync pytest -q tests/test_service_smoke.py` (from `prototypes/parsing_service`) | 13eb18e | 1/1 pass | run now |

Together these cover the components of `pnpm typecheck`, `pnpm lint`,
`pnpm test:unit`, `pnpm test:safety` and `pnpm test:postgres`. `pnpm test:all`
would stop at `test:e2e`.

The real-service spec rewritten in M1 (Task 2: boot probe on `/api/models`;
Task 5: extraction ids read from disk) passed both tests: 19.9 s and 12.4 s. It
used the real Python API and worker, native Docling parsing, restarts, and the
harness's scripted model server. The Python smoke converted the generated
eight-page native PDF with a real `kei-jobs worker` in 16.4 s, with no model
server.

Supplementary runs, recorded for classification or coverage and not counted as
tier results:

| Run | Command | Result |
| --- | --- | --- |
| Parsing fast with fixtures | `PARSING_FIXTURE_DIR=… pnpm --filter parsing-service test` | 876 passed, 6 failed, 127 deselected. The 73 fixture-gated tests ran: 67 pass, 6 fail ([F5](#f5--fixture-gated-golden-equivalence-test)). |
| Base-path diagnostic | `FREE_PLAYWRIGHT_PORT=41760 KEI_EXP_URL=http://127.0.0.1:41750 pnpm --filter studio test:e2e:base-path` | 1 failed at the F3 line, 1 did not run ([F4](#f4--base-path-studio-and-the-lifecycle-fixture-share-12700141750)) |
| Parsing live model | `PARSING_FIXTURE_DIR=… pnpm --filter parsing-service test:live-model` | 7 passed, 9 skipped ([Live-model gaps](#live-model-gaps)) |
| Untiered PostgreSQL + live model | `PARSING_TEST_DATABASE_URL=… PARSING_FIXTURE_DIR=… uv run --no-sync pytest -q -m "postgres and live_model" --deselect tests/test_service_smoke.py::test_a_document_is_parsed_and_its_evidence_served_over_http` | 2 passed, 1 skipped |

Known pre-existing items:

- Third-party pytest deprecation warnings recur, all raised from site-packages:
  - in every pytest run: the `StarletteDeprecationWarning` (httpx with
    `starlette.testclient`) and anyio's `BlockingPortal` alias;
  - in the fast tier: surya's `PydanticDeprecatedSince20`;
  - whenever fixture-backed or Docling live tests run: Docling's
    `force_full_page_ocr` and `generate_table_images` deprecations. These make
    the Parsing PostgreSQL tier report 5 warnings instead of 2.
- The 3 `react-hooks/exhaustive-deps` lint warnings recur, unchanged:
  `useBatchExtractionReviewGrid.ts:133`, `useExtraction.ts:257` and `:369`.
- Vite's chunk-size warning recurs: `App-*.js` is 673.70 kB (200.38 kB gzip),
  over the 500 kB limit.
- The `src/auth/AuthApplication.test.tsx` cross-file `sessionStorage` flake did
  not recur in this record's one Studio unit run.

## Failures

### F1 — e2e run 1: mock OIDC sign-in failed

`e2e/authentication-accessibility.spec.ts:27` "mock OIDC sign-in establishes a
real Studio session" timed out after 30 s in `completeMockOidcLogin`
(`e2e/auth.ts:122`). After the callback, the page showed Studio's own "Sign-in
failed" page, which `/auth/callback` returns when state verification, code
redemption, the nonce check or `backend.signIn` fails. The test passed in run 2.

Classification: **environmental timing flake**, not attributable to M1. It
occurred once, at cold start, while 12 workers signed in at the same moment.
M1 changed nothing on this path: `server/auth.ts`, `entraIdentityProvider.ts`,
`entraTransaction.ts`, `authCookie.ts`, `e2e/auth.ts`, `packages/db` and the
callback handler are unchanged. M1's `server/app.ts` edit is limited to the
development asset list and the dispatcher choice. The root cause is not
established: the handler discards the error, and Playwright does not capture
Studio's stdout.

### F2 — e2e run 1: the lifecycle fixture port was taken

`e2e/canonical-evidence-lifecycle.spec.ts:106` (ARTICLE) failed after 48 ms
with `listen EADDRINUSE: address already in use 127.0.0.1:41750`. The CATALOG
test, in the same serial group, did not run.

Classification: **environmental**. The spec hard-codes its fake Parsing
Service on `127.0.0.1:41750` (line 200), and nothing else in the default suite
binds that port. The port was free before and after the run, and run 2 bound
it. It lies inside this host's ephemeral port range (32768–60999). The holder
was not identified.

### F3 — e2e run 2: stale "Extraction snapshot" expectation

The same ARTICLE test ran for 21.7 s and failed at
`canonical-evidence-lifecycle.spec.ts:600`:
`getByLabel('Extraction snapshot')` was not found. The CATALOG test did not
run. At the failure, the page showed **Open latest reviewed** and no snapshot
select.

Classification: **pre-existing on the base `7461937`**. It was established from
code and history; it was not re-run on a base checkout.

- `36d9f50` (2026-09-24, an ancestor of `7461937`) changed `App.tsx`: when the
  latest reviewed Extraction is on another Source Representation
  (`reviewedOnAnotherSource`), it now offers **Open latest reviewed** instead of
  the snapshot select. It did not update this spec.
- The spec sets up exactly that case: its own assertions at lines 586–597 pass,
  with the latest reviewed Extraction on the first representation and the latest
  attempt on the second. Lines 600–601 still expect the select; they were last
  changed on 2026-08-11 (`6c87ffc`).
- The render condition and its inputs are identical on the base
  (`App.tsx:570-572`, `:728`, `:733`) and at `13eb18e` (`:571-573`, `:740`,
  `:745`). M1's `App.tsx` change only adds the run-action strategy label, and
  the reopen path (`api/document_reopen.ts`, its contract, `packages/db`) is
  unchanged.

Consequence: in both strategies the spec stops at line 600. So three of Task
11's four label edits in this spec have not executed on any host: lines 609,
643–647 and 787–788. They are only typechecked. The edit at line 562 executed
and passed, in run 2 and in the base-path diagnostic.

### F4 — base-path: Studio and the lifecycle fixture share 127.0.0.1:41750

`test:e2e:base-path` runs only the lifecycle spec. Its ARTICLE test failed after
40 ms with `listen EADDRINUSE: address already in use 127.0.0.1:41750`, and the
CATALOG test did not run.

Classification: **pre-existing on the base, and deterministic on any host**:

- `playwright.base-path.config.ts` starts Studio on port 41750 (since `8adf68f`,
  2026-08-29), and `vite.config.ts` binds `127.0.0.1`.
- `e88b08f` (2026-09-22) pinned the spec's fixture to `127.0.0.1:41750` and
  pointed `KEI_EXP_URL` at it only in the default config.
- The base-path config sets no `KEI_EXP_URL`, so Studio would fall back to
  `http://127.0.0.1:8001` (`api/_extraction_runtime.ts:87`).
- None of these files changed in M1.

The diagnostic run moved Studio with the harness's `FREE_PLAYWRIGHT_PORT`
(`e2e/playwrightStack.ts:135`) and pointed `KEI_EXP_URL` at the fixture. The
ARTICLE test then ran for 21.0 s under `/free` (sign-in, the Studio shell,
extraction, review, export) and failed only at F3's line 600. Nothing failed
before that line.

### F5 — fixture-gated golden equivalence test

This appeared only in the supplementary fast run with `PARSING_FIXTURE_DIR`.
All six cases of
`tests/test_equivalence.py::test_version_4_writes_what_version_3_wrote`
(`surya-ingest-catalogue7`, `surya-pdf-catalogue7`, `native-main`,
`hand-built`, `capped`, `whole-pages`) fail with "page 1 differs from the
version 3 golden": the segments differ.

Classification: **pre-existing on the base**:

- The test, its helpers, its goldens and recorded inputs, and `pagefile.py`,
  `result.py`, `pages.py`, `segments.py` and `transcription/` are byte-identical
  at `7461937` and `13eb18e`.
- Importing the test module loads none of the modules M1 changed
  (`kei_exp.api`, `kei_exp.boxes`, `kei_exp.runs`).
- The goldens were last changed in `b07741d` (2026-09-22), and the writer and
  reader in `36d9f50` (2026-09-24).

Without the private fixtures the test skips, which is why the canonical tier
and CI do not see it.

## Skips

- Parsing fast (the reused result): 73 skipped, every one with "optional
  upstream fixture … is absent; set PARSING_FIXTURE_DIR to supply the
  originals". 72 need `Beier1988_GAC_02_Catalogue7.pdf` and one needs `main.pdf`.
  By file: `test_models.py` 33, `test_pages.py` 19, `test_equivalence.py` 7,
  `test_cut.py` 6, `test_native.py` 3, `test_replay.py` 3, `test_geometry.py` 1,
  `test_result.py` 1. With the fixtures supplied, none skip (see F5).
- Parsing PostgreSQL, run with the fixtures: none skipped. The opt-in database
  outage test is not in this tier; it is marked `live_model`.
- Browser E2E and base-path: the CATALOG lifecycle test "did not run" in every
  run, because its serial group had already failed.
- Node and tsx tiers: none skipped.
- Live-model and untiered runs: see below.

## Live-model gaps

- `pnpm --filter studio test:live-model` was **not run**. It needs an
  OpenAI-compatible vLLM endpoint at `FREE_LIVE_VLLM_URL` (default
  `http://127.0.0.1:8002/v1`) serving `FREE_LIVE_VLLM_MODEL` (default
  `Qwen/Qwen3.8-27B-FP8`). Its NuExtract case also needs `FREE_LIVE_NUEXTRACT_URL`
  (model `numind/NuExtract3-FP8`). Nothing listens on port 8002 here. The host's
  only local model endpoint, Docker Model Runner on `127.0.0.1:12434`, serves an
  unrelated quantized GGUF model through llama.cpp, not the configured model.
- `pnpm --filter parsing-service test:live-model` was **run in part**. Seven
  Docling-backed tests passed: `test_cut.py` 4 and `test_native.py` 3. Nine were
  skipped with "set FREE_REAL_EXTRACT_URL and FREE_REAL_EXTRACT_MODEL":
  `test_extract_grounded_live.py` 1 and `test_extract_tokens_live.py` 8. They
  need the deployed extraction model on a vLLM chat-completions endpoint; the
  token tests compare counts with the prompt count that endpoint reports.
- `test:service` against a real model (`FREE_REAL_EXTRACT_URL` and
  `FREE_REAL_EXTRACT_MODEL`) was not run, for the same reason.
- No tier selects the four tests marked both `postgres` and `live_model`:
  - `tests/test_service_smoke.py` is the Python smoke above.
  - `tests/test_native.py::test_the_native_api_run_reads_the_pdf_without_a_server_a_cut_or_ocr`
    and
    `tests/test_jobs_recovery.py::test_a_killed_worker_is_replaced_and_its_job_resumed`
    passed in the untiered run.
  - `tests/test_jobs_recovery.py::test_a_paused_database_does_not_disturb_a_running_conversion`
    skipped. It needs `PARSING_TEST_POSTGRES_CONTAINER` naming an isolated
    container labelled `free.test=parsing`, which it pauses. The shared
    disposable container has no such label and was not paused.

These gaps need a host running the deployment's vLLM instruction and extraction
models, such as the GPU Compose overlay.

## Residue search

The repository-wide search from the M1 plan's Task 10 Step 2:

```bash
grep -rnE "llm_inspector|inspectTarget|retryExtraction|RetryExtractionInput|invalid_retry|extraction_in_progress|ExtractionValueCheckpoint|page_geometry|render_page|run_page_boxes|run_events|list_runs|list_extractions|server_info|list_layout_models|run_debug|result_version == 4" \
  prototypes packages scripts docker compose*.y*ml docs/architecture --exclude-dir=node_modules
```

It prints seven lines, and none is a caller of removed code:

| Hit | Classification |
| --- | --- |
| `prototypes/studio/server/api-dispatcher.test.ts:90`, `:184` | Expected: Task 9's `/api/llm_inspector` 404 guard assertions. |
| `prototypes/parsing_service/tests/test_result.py:356` | Not residue. `test_v4_result_keeps_original_bytes_and_hash_verification` deliberately rewrites a result to version 4 and checks that it still loads and verifies; the current version is 5 (`pagefile.py:25`). The test is unchanged by M1. The pattern targeted the smoke test's hard-coded version assertion, which Task 3 replaced with `RESULT_VERSION`. |
| `prototypes/parsing_service/docs/superpowers/specs/2026-09-21-canonical-evidence-design.md:47`, `:81` | Historical record, not a caller: a dated design imported from kei-exp that "retains the original internal design", naming `boxes.page_geometry` as it was. Unchanged by M1. |
| `prototypes/parsing_service/src/kei_exp/jobs/store.py:49`, `:419` | Frozen comments: `list_runs` as a threadpool-sizing example, and `api.run_page_boxes` in the `events_after` docstring. The M1 Global Constraints keep `kei_exp/jobs/` and its comments as they are until M3 deletes them. |

The legacy-row test fixtures kept on purpose in Tasks 7, 8 and 12 match none
of these patterns. Historical records under `docs/plans/`, `docs/validation/`
and `openspec/changes/archive/` are outside the search.

## Final state

- Every harness removed its own Compose containers, volumes and network. No
  `.playwright-stack-*` lifecycle state remains.
- `free_test_project_store` remains on the disposable tmpfs container.
- Test output is retained, git-ignored: `prototypes/studio/test-results/` holds
  the last lifecycle failure's context, and `artifacts/service-tests/` holds the
  real-service results and logs.
- The command logs for this record are kept, git-ignored, under
  `.superpowers/sdd/2026-09-25-dbos-m1-dead-code/task-10-logs/` in the M1
  worktree.
- No product or test code was changed.
