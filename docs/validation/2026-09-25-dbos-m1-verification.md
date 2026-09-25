# DBOS M1 verification — fa62304 — 2026-09-25

Status: verification is complete for every deterministic tier at `fa62304`.
Each tier passes there, either run at that commit or carried forward to it
because its package is unchanged. `fa62304` is the product-code fix for
[F6](#f6--resolved-in-fa62304-the-historical-review-offered-a-new-run-on-its-superseded-source).
At `ec8820d`, `test:e2e` and `test:e2e:base-path` failed at one lifecycle
assertion, which exposed a pre-existing product behaviour; at `fa62304` both
pass. The fix wave before it resolved F3 and F4, and it changed only tests and
the Playwright harness. The live-model tiers remain gaps; see
[Live-model gaps](#live-model-gaps). The one later code commit, `4ab1ac4`,
changes only a comment (see [Scope and environment](#scope-and-environment)).

## Scope and environment

- Tested commit: `fa62304d772069bf0125bbc2c3fae4ea0f129098` on
  `chore/dbos-m1-dead-code`, the last commit the tiers ran on. Change boundary:
  `7461937..fa62304`. Task numbers follow the
  [M1 plan](../plans/2026-09-25-dbos-m1-dead-code.md); Tasks 11 and 12 are its
  "Catalog action" and "Missing legacy cases" review items, Task 13 is the F6
  fix, and Task 14 is this re-verification.
  - `fa62304` (Task 13) changes product code, unlike the fix wave before it.
    All of it is under `prototypes/studio`: the reopen handler and its
    contract, `App.tsx`, `AppFrame.tsx`, `RightRail.tsx`, `ResultsTab.tsx`,
    their tests and the README. `git diff --stat 10836ba..fa62304` lists 12
    files, all there.
  - Earlier tested commits, kept so that the record stays reproducible:
    - `13eb18e` was this record's first tested commit, and the last commit
      before `fa62304` that changes product code. `93028ab` and `10836ba`
      changed only documentation.
    - `ec8820d` was its second, after the final-review fix wave. That wave
      changed only Studio tests and the Playwright harness;
      `git diff --name-only 13eb18e..ec8820d` lists, under Studio's `src/`,
      `api/`, `server/` and `shared/`, only `*.test.*` files:
      - `eb14a28`: the lifecycle spec follows the historical-review flow;
      - `7d2ea8a`: base-path ports and fixture URL;
      - `ec8820d`: unit-test assertions for the running state and the
        NuExtract transport.
  - After the tested commit, `4ab1ac4` changes one harness comment and nothing
    else; its diff ends this section. The commit that adds this revision of
    the record changes only documentation.
- Working tree: clean for every run at `fa62304` and at `ec8820d`. The
  `13eb18e` runs had only an uncommitted, docs-only edit of the M1 plan.
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
- Playwright harness ports, unchanged since `7d2ea8a`:
  - default suite: Studio 41749, mock OIDC 41748, PostgreSQL 45432, lifecycle
    fixture 41750;
  - base-path: Studio 41751, mock OIDC 41752, PostgreSQL 45433, lifecycle
    fixture 41753;
  - real service: Studio 41761, mock OIDC 41762, PostgreSQL 45435, Python API
    41764.

  Each config declares its lifecycle fixture URL once. It passes that URL to
  Studio as `KEI_EXP_URL` and to the spec as `FREE_PLAYWRIGHT_KEI_EXP_URL`.
  The default and base-path suites' ports are distinct, but both suites write
  to `prototypes/studio/test-results/` and `test-results/config-home`, so they
  must run sequentially. The real-service harness writes to
  `artifacts/service-tests/` instead. Every browser run this record cites ran
  on its own.
- Docling weights were already in the Hugging Face cache
  (`docling-project/docling-layout-heron`, `-heron-101`, `-egret-xlarge`,
  `docling-models`).
- Upstream fixture PDFs (`Beier1988_GAC_02_Catalogue7.pdf`, `main.pdf`) were
  read in place from a local kei-exp checkout through `PARSING_FIXTURE_DIR`,
  only in the runs that name it below. CI never has them.
- The model boundary was scripted or absent in every run. No live model took
  part; see [Live-model gaps](#live-model-gaps).

After the tested commit, `4ab1ac4` (`test(e2e): say the base-path harness must
run sequentially`) corrects the base-path config's comment, which said that
the two suites could run side by side. The change is comment-only, so no tier
ran again for it:

```diff
--- a/prototypes/studio/playwright.base-path.config.ts
+++ b/prototypes/studio/playwright.base-path.config.ts
@@ -18,5 +18,6 @@ const basePath = '/free'
 process.env.FREE_PLAYWRIGHT_BASE_PATH = basePath
 // The lifecycle spec's fake kei-exp listens here, and Studio's KEI_EXP_URL points at it. The default suite's
-// fixture keeps 41750, so both suites can run side by side.
+// fixture keeps 41750, so the two suites' ports are distinct. The suites still share the output directories
+// test-results/ and test-results/config-home, so they must run sequentially.
 const keiExpUrl = 'http://127.0.0.1:41753'
 process.env.FREE_PLAYWRIGHT_KEI_EXP_URL = keiExpUrl
```

## Results

Each row holds for `fa62304` in one of three ways. The log directories are
listed under [Final state](#final-state).

- **Reused:** Task 13 ran the tier at `fa62304` on a clean tree, and its log is
  in `task-13-logs/`. Each such log's header reads
  `# commit: fa62304d772069bf0125bbc2c3fae4ea0f129098` with an empty
  `# worktree status (short):` line, and each run started between 19:52:48 and
  19:57:30, after the commit at 19:52:23
  (`task-14-logs/reused-logs-provenance.log`).
- **Run now:** run at `fa62304` on a clean tree for this revision, with the log
  in `task-14-logs/`.
- **Carried forward:** the run at the row's commit stays valid, because
  `git diff --stat <its commit>..fa62304 -- <package>` prints nothing
  (`task-14-logs/carry-forward-diff-stat.log`, one command per row). Nothing
  outside `prototypes/studio` and `docs` changed since `13eb18e`.

pytest counts exclude marker deselection, which is the tier boundary rather
than a skip.

| Tier | Command | Commit | Result | Evidence |
| --- | --- | --- | --- | --- |
| Scripts | `node --test scripts/free.test.mjs scripts/test-ci.test.mjs` | 13eb18e | 48/48 pass | carried forward: `scripts` unchanged (`carry-forward-diff-stat.log`) |
| Studio configuration | `pnpm --filter studio-configuration test` | 13eb18e | 4/4 pass | carried forward: `packages/studio-configuration` unchanged (`carry-forward-diff-stat.log`) |
| Studio unit | `pnpm --filter studio test` | fa62304 | 94 files, 1081/1081 pass | reused: `task-13-logs/final-studio-test.log` (`# commit: fa62304d77…`, clean tree). `ec8820d` had 1061; `fa62304` adds 20 tests: 4 API, 9 App, 6 ResultsTab and 1 ProjectNavigation. |
| db unit | `pnpm --filter db test` | 13eb18e | 55/55 pass | carried forward: `packages/db` unchanged (`carry-forward-diff-stat.log`) |
| Extraction unit | `pnpm --filter extraction test` | 13eb18e | 37/37 pass | carried forward: `packages/extraction` unchanged, and so are the three Studio files its `module.test.ts` imports (`carry-forward-diff-stat.log`, S1) |
| Result export unit | `pnpm --filter extraction-result-export test` | 13eb18e | 33/33 pass | carried forward: `packages/extraction-result-export` unchanged (`carry-forward-diff-stat.log`) |
| Parsing fast | `pnpm --filter parsing-service test` | 3e3f888 | 809 passed, 73 skipped, 127 deselected | carried forward from Task 5's run at `3e3f888`: `prototypes/parsing_service` unchanged since then (`carry-forward-diff-stat.log`). The skip-reason listing at `13eb18e` (same command, `PYTEST_ADDOPTS=-rs`) reproduced the same counts. |
| Studio typecheck | `pnpm --filter studio typecheck` | fa62304 | clean | reused: `task-13-logs/final-studio-typecheck.log` (`# commit: fa62304d77…`, clean tree) |
| db typecheck | `pnpm --filter db typecheck` | 13eb18e | clean | carried forward: `packages/db` unchanged (`carry-forward-diff-stat.log`) |
| Extraction typecheck | `pnpm --filter extraction typecheck` | 13eb18e | clean | carried forward: `packages/extraction` and the three Studio files it imports unchanged (`carry-forward-diff-stat.log`, S1) |
| Result export typecheck | `pnpm --filter extraction-result-export typecheck` | 13eb18e | clean | carried forward: `packages/extraction-result-export` unchanged (`carry-forward-diff-stat.log`) |
| Lint | `pnpm --filter studio lint` | fa62304 | 0 errors, 3 warnings | reused: `task-13-logs/final-studio-lint.log` (`# commit: fa62304d77…`, clean tree) |
| Safety | `pnpm test:safety` | fa62304 | 14/14 pass, none skipped | run now (`task-14-logs/test-safety.log`). It reads `prototypes/studio/Dockerfile`, so its result could not be carried forward. |
| db PostgreSQL | `PROJECT_STORE_POSTGRES_URL=… pnpm --filter db test:postgres` | 13eb18e | 3/3 pass (one test, two subtests) | carried forward: `packages/db` unchanged (`carry-forward-diff-stat.log`) |
| Extraction PostgreSQL | `EXTRACTION_TEST_DATABASE_URL=… pnpm --filter extraction test:postgres` | 13eb18e | 28/28 pass | carried forward: `packages/extraction` unchanged (`carry-forward-diff-stat.log`) |
| Parsing PostgreSQL | `PARSING_TEST_DATABASE_URL=… PARSING_FIXTURE_DIR=… pnpm --filter parsing-service test:postgres` | 13eb18e | 107 passed, 0 skipped, 902 deselected | carried forward: `prototypes/parsing_service` unchanged (`carry-forward-diff-stat.log`) |
| Studio build | `pnpm --filter studio build` | fa62304 | pass: `tsc -b`, client and SSR bundles; no inspector strings in `dist/` | run now (`task-14-logs/studio-build.log`). The inspector-string scan has its own log, `studio-dist-inspector-scan.log`: grep exit 1, no match in the 33 files the build wrote. |
| Browser E2E | `pnpm test:e2e` | fa62304 | 51/51 pass | reused: `task-13-logs/final-test-e2e.log` (`# commit: fa62304d77…`, clean tree). At `ec8820d`: 49 passed, 1 failed, 1 did not run ([F6](#f6--resolved-in-fa62304-the-historical-review-offered-a-new-run-on-its-superseded-source)). At `13eb18e`, two runs: [F1](#f1--e2e-run-1-mock-oidc-sign-in-failed), [F2](#f2--e2e-run-1-the-lifecycle-fixture-port-was-taken), [F3](#f3--resolved-in-eb14a28-stale-extraction-snapshot-expectation). |
| Base-path E2E | `pnpm --filter studio test:e2e:base-path` | fa62304 | 2/2 pass | reused: `task-13-logs/final-test-e2e-base-path.log` (`# commit: fa62304d77…`, clean tree). At `ec8820d`: 0 passed, 1 failed, 1 did not run ([F6](#f6--resolved-in-fa62304-the-historical-review-offered-a-new-run-on-its-superseded-source)). At `13eb18e`: [F4](#f4--resolved-in-7d2ea8a-base-path-studio-and-the-lifecycle-fixture-shared-12700141750). |
| Real service | `pnpm test:service` | fa62304 | 2/2 pass | run now (`task-14-logs/studio-test-service.log`). The spec drives Studio and parses its reopen response with the strict contract, to which `fa62304` added a required field. |
| Python smoke | `PARSING_TEST_DATABASE_URL=… uv run --no-sync pytest -q tests/test_service_smoke.py` (from `prototypes/parsing_service`) | 13eb18e | 1/1 pass | carried forward: `prototypes/parsing_service` unchanged (`carry-forward-diff-stat.log`) |

Together these cover every component of `pnpm test:all` (`typecheck`, `lint`,
`test:unit`, `test:safety`, `test:postgres`, `test:e2e` and `test:service`),
and also the base-path suite, the build and the Python smoke. `pnpm test:all`
itself was not run as one command.

`git diff --stat 13eb18e..fa62304` prints nothing outside `prototypes/studio`
and `docs`. That covers `packages/*`, `prototypes/parsing_service`, `scripts`,
`tests`, `docker`, the Compose files, and the root package manifest and
lockfile. It also prints nothing for the three Studio files that
`packages/extraction/src/module.test.ts` imports: `api/_kei_exp.ts`,
`test/fixtures/kei-exp/ellekilde-table-v5.json` and
`src/assets/parsed_document.v2.json`. Every deterministic tier of
`prototypes/studio`, and the safety tier that reads its Dockerfile, ran at
`fa62304`: Task 13 ran typecheck, lint, unit and both browser suites, and this
revision ran the build, the real-service spec and safety.

The real-service spec rewritten in M1 (Task 2: boot probe on `/api/models`;
Task 5: extraction ids read from disk) passed both tests at `fa62304`: 17.6 s
and 12.3 s (17.8 s and 12.3 s at `ec8820d`; 19.9 s and 12.4 s at `13eb18e`). It
used the real Python API and worker, native Docling parsing, restarts, and the
harness's scripted model server. It parses Studio's reopen response with the
strict contract, so it also checks the field that `fa62304` added. The Python
smoke, carried forward from `13eb18e`, converted the generated eight-page
native PDF with a real `kei-jobs worker` in 16.4 s, with no model server.

Supplementary runs at `13eb18e`, recorded for classification or coverage and not
counted as tier results:

| Run | Command | Result |
| --- | --- | --- |
| Parsing fast with fixtures | `PARSING_FIXTURE_DIR=… pnpm --filter parsing-service test` | 876 passed, 6 failed, 127 deselected. The 73 fixture-gated tests ran: 67 pass, 6 fail ([F5](#f5--fixture-gated-golden-equivalence-test)). |
| Base-path diagnostic | `FREE_PLAYWRIGHT_PORT=41760 KEI_EXP_URL=http://127.0.0.1:41750 pnpm --filter studio test:e2e:base-path` | 1 failed at the F3 line, 1 did not run ([F4](#f4--resolved-in-7d2ea8a-base-path-studio-and-the-lifecycle-fixture-shared-12700141750)) |
| Parsing live model | `PARSING_FIXTURE_DIR=… pnpm --filter parsing-service test:live-model` | 7 passed, 9 skipped ([Live-model gaps](#live-model-gaps)) |
| Untiered PostgreSQL + live model | `PARSING_TEST_DATABASE_URL=… PARSING_FIXTURE_DIR=… uv run --no-sync pytest -q -m "postgres and live_model" --deselect tests/test_service_smoke.py::test_a_document_is_parsed_and_its_evidence_served_over_http` | 2 passed, 1 skipped |

Diagnostic runs of the fix wave are not counted as tier results either. Each run
changed the spec in the worktree only, and the change was never committed:

- In the four soft runs, the F6 assertion became `expect.soft`, so that the
  rest of the lifecycle ran.
- In the probe, a temporary step replaced that assertion.

`--grep` ran one strategy at a time, because the serial group skips CATALOG
after any ARTICLE failure. The `/` runs used `eb14a28`'s spec, and the `/free`
runs used `7d2ea8a`'s content, each before it was committed. Commands run from
`prototypes/studio`:

| Run | Command | Result |
| --- | --- | --- |
| Lifecycle under `/`, ARTICLE | `pnpm exec playwright test e2e/canonical-evidence-lifecycle.spec.ts --grep ARTICLE` | Only the soft F6 assertion failed; every later step passed (`dev2-lifecycle-default-soft615-article.log`). |
| Lifecycle under `/`, CATALOG | the same with `--grep CATALOG` | the same (`dev3-lifecycle-default-soft615-catalog.log`) |
| Lifecycle under `/free`, ARTICLE | `pnpm exec playwright test --config playwright.base-path.config.ts --grep ARTICLE` | the same (`dev7-base-path-soft619-article.log`) |
| Lifecycle under `/free`, CATALOG | the same with `--grep CATALOG` | the same (`dev8-base-path-soft619-catalog.log`) |
| Probe of the historical route's run, ARTICLE | the first command, with a temporary step in place of the F6 assertion. It clicks the offered run, records the POST, waits for the Extraction and reopens the document. | See F6 (`dev4-historical-run-action-probe-article.log` and `.json`). |

Known pre-existing items:

- Third-party pytest deprecation warnings recur in the `13eb18e` runs, all
  raised from site-packages:
  - in every pytest run: the `StarletteDeprecationWarning` (httpx with
    `starlette.testclient`) and anyio's `BlockingPortal` alias;
  - in the fast tier: surya's `PydanticDeprecatedSince20`;
  - whenever fixture-backed or Docling live tests run: Docling's
    `force_full_page_ocr` and `generate_table_images` deprecations. These make
    the Parsing PostgreSQL tier report 5 warnings instead of 2.
- The 3 `react-hooks/exhaustive-deps` lint warnings recur at `fa62304`,
  unchanged: `useBatchExtractionReviewGrid.ts:133`, `useExtraction.ts:257` and
  `:369`.
- Vite's chunk-size warning recurs: at `fa62304`, `App-zTBYmDvH.js` is
  673.96 kB (200.49 kB gzip), over the 500 kB limit. At `13eb18e` and
  `ec8820d` it was `App-DwcYMXj5.js`, 673.70 kB (200.38 kB gzip); `fa62304`
  changes product code, so the bundle's hash changed.
- The `src/auth/AuthApplication.test.tsx` cross-file `sessionStorage` flake did
  not recur in the one Studio unit run at `13eb18e`, nor in the one at
  `ec8820d`, nor in Task 13's final run at `fa62304`.

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

It did not recur at `ec8820d` or at `fa62304`, in the one tier run of the
default suite at each.

### F2 — e2e run 1: the lifecycle fixture port was taken

`e2e/canonical-evidence-lifecycle.spec.ts:106` (ARTICLE) failed after 48 ms
with `listen EADDRINUSE: address already in use 127.0.0.1:41750`. The CATALOG
test, in the same serial group, did not run.

Classification: **environmental**. At `13eb18e` the spec hard-coded its fake
Parsing Service on `127.0.0.1:41750` (line 200), and nothing else in the default
suite binds that port. The port was free before and after the run, and run 2
bound it. It lies inside this host's ephemeral port range (32768–60999). The
holder was not identified.

It did not recur at `ec8820d` or at `fa62304`. The default suite keeps this
port; `7d2ea8a` declares it once, in `playwright.config.ts`, and the spec now
reads it from `FREE_PLAYWRIGHT_KEI_EXP_URL`.

### F3 — resolved in eb14a28: stale "Extraction snapshot" expectation

At `13eb18e`, the same ARTICLE test ran for 21.7 s and failed at
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
  attempt on the second. Lines 600–601 still expected the select; they were last
  changed on 2026-08-11 (`6c87ffc`).
- The render condition and its inputs are identical on the base
  (`App.tsx:570-572`, `:728`, `:733`) and at `13eb18e` (`:571-573`, `:740`,
  `:745`). M1's `App.tsx` change only adds the run-action strategy label, and
  the reopen path (`api/document_reopen.ts`, its contract, `packages/db`) is
  unchanged.

At `13eb18e`, the spec therefore stopped at line 600 in both strategies. Three
of Task 11's four label edits in this spec (lines 609, 643–647 and 787–788)
had not executed on any host, and were only typechecked. The edit at line 562
executed and passed.

**Resolution.** `eb14a28` makes the spec follow the current flow at both
transitions:

- At the first (lines 600–601 at `13eb18e`), it checks that no snapshot select
  is offered and chooses **Open latest reviewed**. It then asserts the route
  (`?extractionId=` of the reviewed Extraction) and that the first
  representation's PDF loads. The pinned-source, schema and review assertions
  that follow are unchanged.
- At the second (line 619 at `13eb18e`), it goes back in the browser history.
  It asserts the plain document route and that **Open latest reviewed** is
  offered again.

In the tier runs at `ec8820d`, the ARTICLE test passes the first transition
under `/` and `/free`. It then stops at F6's assertion, which is line 619 at
`ec8820d` and was line 609 at `13eb18e`. That assertion is the fourth Task 11
label edit, and it now executes. In the diagnostic runs, both transitions
passed in both strategies under `/` and `/free`, and so did Task 11's other
label edits (lines 566, 656–660 and 800–801 at `ec8820d`). At `fa62304`, with
the spec unchanged since `ec8820d`, both tier runs pass all of these steps,
F6's assertion included, in both strategies under `/` and `/free`.

### F4 — resolved in 7d2ea8a: base-path Studio and the lifecycle fixture shared 127.0.0.1:41750

At `13eb18e`, `test:e2e:base-path` ran only the lifecycle spec. Its ARTICLE test
failed after 40 ms with
`listen EADDRINUSE: address already in use 127.0.0.1:41750`, and the CATALOG
test did not run.

Classification: **pre-existing on the base, and deterministic on any host**:

- `playwright.base-path.config.ts` started Studio on port 41750 (since
  `8adf68f`, 2026-08-29), and `vite.config.ts` binds `127.0.0.1`.
- `e88b08f` (2026-09-22) pinned the spec's fixture to `127.0.0.1:41750` and
  pointed `KEI_EXP_URL` at it only in the default config.
- The base-path config set no `KEI_EXP_URL`, so Studio would fall back to
  `http://127.0.0.1:8001` (`api/_extraction_runtime.ts:87`).
- None of these files changed in M1.

The `13eb18e` diagnostic run moved Studio with the harness's
`FREE_PLAYWRIGHT_PORT` (`e2e/playwrightStack.ts:135`) and pointed `KEI_EXP_URL`
at the fixture. The ARTICLE test then ran for 21.0 s under `/free` (sign-in, the
Studio shell, extraction, review, export) and failed only at F3's line 600.
Nothing failed before that line.

**Resolution.** `7d2ea8a` changes three things:

- Base-path Studio moves to 41751 and its lifecycle fixture to 41753. No other
  Playwright config or harness in `prototypes/studio` uses either port (see
  [Scope and environment](#scope-and-environment)). Neither can collide with a
  Compose project lease, which the harness hashes into 30000–39999.
- The base-path config sets `KEI_EXP_URL` to its fixture, as the default config
  does.
- Each config declares its fixture URL once and exports it as
  `FREE_PLAYWRIGHT_KEI_EXP_URL`. The spec listens on that URL instead of a
  hard-coded port. The default suite keeps 41750, so the two suites' ports no
  longer collide. The suites still share `prototypes/studio/test-results/` and
  `test-results/config-home`, so they must run sequentially; `4ab1ac4`
  corrects the config comment that said they could run side by side.

At `ec8820d`, the base-path ARTICLE test starts cleanly and runs under `/free`
until F6: sign-in, the Studio shell, extraction, review, export and the
historical-review navigation. In the diagnostic runs, both strategies passed
every other step under `/free`. At `fa62304` the base-path tier passes both
strategies (2/2).

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
  at `7461937` and `13eb18e`. The fix wave changed nothing in
  `prototypes/parsing_service`.
- Importing the test module loads none of the modules M1 changed
  (`kei_exp.api`, `kei_exp.boxes`, `kei_exp.runs`).
- The goldens were last changed in `b07741d` (2026-09-22), and the writer and
  reader in `36d9f50` (2026-09-24).

Without the private fixtures the test skips, which is why the canonical tier
and CI do not see it.

### F6 — resolved in fa62304: the historical review offered a new run on its superseded source

Resolved by `fa62304`; see **Resolution** below. At `ec8820d`, `test:e2e` and
`test:e2e:base-path` failed at `canonical-evidence-lifecycle.spec.ts:619` in
the ARTICLE test, and the CATALOG test, in the same serial group, did not run.
After **Open latest reviewed**, the assertion expects no
`Run … extraction with current schema` action for the reviewed Extraction. The
page offered one: "Run Article extraction with current schema".

What the product did up to `ec8820d` (unchanged since `13eb18e`; line numbers
at `ec8820d`):

- **Open latest reviewed** (`App.tsx:745-752`) navigates to the document route
  with the reviewed Extraction's `?extractionId=` (`AppFrame.tsx:230-235`).
  - That route reopens the reviewed Extraction on its original Source
    Representation Revision, as the document's working attempt.
  - The inspected attempt and the latest attempt are then the same, so the view
    is not read-only (`App.tsx:583`).
- For a completed result on a previous Schema Revision, the Extraction status
  offered this run unless the view was read-only (`ResultsTab.tsx:455-469`).
  The header also offered `↻ Re-run extraction`. Both call `runExtraction`,
  which posts the open route's Source Representation Revision
  (`App.tsx:627-656`).
- The probe clicked the offered run:
  - The POST named Source Representation Revision 1, which Revision 2
    supersedes, with the current Schema Revision 2.
  - The new Extraction completed successfully.
  - Reopening the document without an Extraction identity then showed Revision 2
    and the older, unreviewed attempt. The document's latest attempt is chosen
    on its current revision only
    (`packages/extraction/src/postgres-persistence.ts:449-462`), so ordinary
    navigation did not show the new result while it stayed unreviewed. Once
    reviewed, it would surface through **Open latest reviewed**. After
    `fa62304`, the historical view offers no such run at all.
- The Studio README said that "opening a historical Extraction uses its
  original source. Run a new Extraction to use upgraded cell Evidence." A run
  started from this view used the superseded source instead.

Classification: **pre-existing product behaviour on the base `7461937`**, not
caused by M1. It was established from code and history; it was not re-run on a
base checkout.

- The assertion dates from `2f59838` (2026-09-07). The reviewed Extraction was
  then inspected read-only through the snapshot select, which offered no run.
- `36d9f50` replaced that case with the navigation above, where the run was
  offered. The spec could not reach the assertion until F3 was fixed.
- On the base, the same condition offered "Run with current schema", with the
  same read-only rule and run target. M1's Task 11 only renamed the action, and
  this assertion's label, to name the strategy.

The fix wave left the assertion failing on purpose: it could not change product
code, and removing or inverting the assertion would have dropped its purpose.
With the assertion made soft, every later lifecycle step passed in both
strategies, under `/` and `/free` (the diagnostic runs above). The user then
chose a product fix over accepting the behaviour.

**Resolution.** `fa62304` (Task 13) offers no new run on a historical
Extraction whose Source Representation Revision is no longer the document's
current one. Line numbers are at `fa62304`:

- The reopen response states whether the pinned revision is current, in a
  strict, required `sourceRepresentation.current`
  (`shared/projectContext.contract.ts:194`). `api/document_reopen.ts:130-131`
  sets it by comparing the pinned revision with the document's current one.
- When it is false, `App.tsx` disables the toolbar's run button, whose title
  says why (`:691`, `:856`). The Results tab gets no run handler, so it renders
  no run action (`:926`). The hint says to go back to the current Source
  Representation instead of pressing Run extraction (`:720`), and
  `runExtraction` returns early (`:634`).
- Review, cancel, export and the schema views are unchanged. A view on the
  current revision, including an `?extractionId=` pin of a current batch
  member, keeps its run actions.
- The README (`:81-83`) now says: "Run a new Extraction on the current revision
  to use upgraded cell Evidence; an Extraction opened on an earlier revision
  offers no new run."

The spec is unchanged (`git diff 10836ba..fa62304 -- prototypes/studio/e2e` is
empty), and line 619 still expects no run action. Both browser tiers pass at
`fa62304` (Results: `test:e2e` 51/51, `test:e2e:base-path` 2/2). Task 13 also
ran the lifecycle spec on its own, from the worktree root on a clean tree, as
acceptance evidence that is not counted as a tier result:

| Run | Command | Result | Log |
| --- | --- | --- | --- |
| Lifecycle under `/` | `pnpm --filter studio exec playwright test e2e/canonical-evidence-lifecycle.spec.ts` | 2 passed: ARTICLE 37.0 s, CATALOG 36.6 s | `task-13-logs/final-e2e-lifecycle-default.log` |
| Lifecycle under `/free` | the same, with `--config playwright.base-path.config.ts` | 2 passed: ARTICLE 39.9 s, CATALOG 39.4 s | `task-13-logs/final-e2e-lifecycle-base-path.log` |

Two limits stay outside the decided scope, which covers runs only and relies on
a flag the server reports at reopen:

- The flag is a reopen-time fact. An `?extractionId=` view opened on the
  current revision keeps offering runs if its document is reprocessed in the
  same session, until the view is reopened.
- `POST /api/extractions` still accepts a superseded revision; only Studio's UI
  stops offering it.

## Skips

- Parsing fast (the carried-forward result): 73 skipped, every one with "optional
  upstream fixture … is absent; set PARSING_FIXTURE_DIR to supply the
  originals". 72 need `Beier1988_GAC_02_Catalogue7.pdf` and one needs `main.pdf`.
  By file: `test_models.py` 33, `test_pages.py` 19, `test_equivalence.py` 7,
  `test_cut.py` 6, `test_native.py` 3, `test_replay.py` 3, `test_geometry.py` 1,
  `test_result.py` 1. With the fixtures supplied, none skip (see F5).
- Parsing PostgreSQL, run with the fixtures: none skipped. The opt-in database
  outage test is not in this tier; it is marked `live_model`.
- Browser E2E and base-path: the CATALOG lifecycle test "did not run" in every
  tier run, at `13eb18e` and at `ec8820d`, because its serial group had already
  failed. The fix wave's diagnostic runs ran it on its own (`--grep CATALOG`).
  At `fa62304` it ran and passed in both tiers. Neither browser tier nor the
  real-service spec skipped anything there.
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

The repository-wide search from the M1 plan's Task 10 Step 2, run again at
`ec8820d`:

```bash
grep -rnE "llm_inspector|inspectTarget|retryExtraction|RetryExtractionInput|invalid_retry|extraction_in_progress|ExtractionValueCheckpoint|page_geometry|render_page|run_page_boxes|run_events|list_runs|list_extractions|server_info|list_layout_models|run_debug|result_version == 4" \
  prototypes packages scripts docker compose*.y*ml docs/architecture --exclude-dir=node_modules
```

It prints the same seven lines as at `13eb18e`, and none is a caller of removed
code:

| Hit | Classification |
| --- | --- |
| `prototypes/studio/server/api-dispatcher.test.ts:90`, `:184` | Expected: Task 9's `/api/llm_inspector` 404 guard assertions. |
| `prototypes/parsing_service/tests/test_result.py:356` | Not residue. `test_v4_result_keeps_original_bytes_and_hash_verification` deliberately rewrites a result to version 4 and checks that it still loads and verifies; the current version is 5 (`pagefile.py:25`). The test is unchanged by M1. The pattern targeted the smoke test's hard-coded version assertion, which Task 3 replaced with `RESULT_VERSION`. |
| `prototypes/parsing_service/docs/superpowers/specs/2026-09-21-canonical-evidence-design.md:47`, `:81` | Historical record, not a caller: a dated design imported from kei-exp that "retains the original internal design", naming `boxes.page_geometry` as it was. Unchanged by M1. |
| `prototypes/parsing_service/src/kei_exp/jobs/store.py:49`, `:419` | Frozen comments: `list_runs` as a threadpool-sizing example, and `api.run_page_boxes` in the `events_after` docstring. The M1 Global Constraints keep `kei_exp/jobs/` and its comments as they are until M3 deletes them. |

The legacy-row test fixtures kept on purpose in Tasks 7, 8 and 12 match none
of these patterns. Historical records under `docs/plans/`, `docs/validation/`
and `openspec/changes/archive/` are outside the search.

Both searches ran in a shell whose `grep` skips git-ignored paths and binary
files: ugrep with `--ignore-files -I` (`residue-grep-ignore-files.log`). GNU
grep also descends into the git-ignored `prototypes/parsing_service/.venv/` and
`__pycache__/` directories. There it matches only third-party site-packages
(Docling, torch, pygments, surya) and compiled bytecode. Its hits in tracked
files are the same seven (`residue-grep.log`).

## Final state

- Every harness removed its own Compose containers, volumes and network. No
  `.playwright-stack-*` lifecycle state remains.
- `free_test_project_store` remains on the disposable tmpfs container, beside
  `free_test_parsing` and `free_test_extraction`.
- Test output is retained, git-ignored:
  - `prototypes/studio/test-results/` holds the lifecycle spec's screenshots
    from Task 13's base-path tier run at `fa62304`, which passed; the F6
    failure context is gone.
  - `artifacts/service-tests/` holds the real-service results and logs of the
    `fa62304` run.
- The command logs for this record are kept, git-ignored, in the M1 worktree
  under `.superpowers/sdd/2026-09-25-dbos-m1-dead-code/`:
  - `task-10-logs/` for the `13eb18e` runs;
  - `final-fix-logs/` for the `ec8820d` runs, that wave's carry-forward proof
    and its diagnostic runs;
  - `task-13-logs/` for Task 13's runs at `fa62304`: the reused tiers and the
    lifecycle acceptance runs;
  - `task-14-logs/` for this revision's runs at `fa62304`, the carry-forward
    proof, the provenance of the reused logs and the diff of `4ab1ac4`.
- Since `13eb18e`, product code changed only in `fa62304`, the F6 fix, under
  `prototypes/studio`. The fix wave changed test code and the Playwright
  harness only (`eb14a28`, `7d2ea8a`, `ec8820d`), and `4ab1ac4` changes one
  harness comment. No product code was changed for this record.
