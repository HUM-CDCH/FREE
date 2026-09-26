# DBOS M2 verification — b64bc56 — 2026-09-26

Status: every deterministic tier passes at `b64bc56`: typecheck, lint, unit
(five consecutive runs), safety, PostgreSQL (Node and Parsing), e2e (five
consecutive runs), base-path e2e, real service and the Studio build.
`test:system` could run here only with a verification overlay, and it passes
11 of 15. The 4 failures come from one stale assertion that predates M2
(see [System contract](#system-contract-testsystem)). The Task 15 fix wave
changed only tests, harness ports and one README paragraph (see
[Fix wave](#fix-wave-task-15)). Acceptance mapping: the plan's
[Traceability table](../plans/2026-09-26-dbos-m2-platform-configuration.md#traceability-m2-acceptance--tests).

## Scope and environment

- Tested commit: `b64bc56` on `feat/dbos-m2-m6`. M2 range: `0ccf7ea..b64bc56`,
  where `0ccf7ea` adds the plan and the plan is based on `84013ee`.
  - Tasks 1–14: `567c891` … `b19bfde`.
  - Task 15 fix wave: `55a1256`, `00c4d05`, `ded280d`, `775860f`, `44db7c9`,
    `b64bc56`.
- Tier commits:
  - `b64bc56`: typecheck, lint, e2e runs 4–8, base-path e2e, real service,
    Studio build, Docker image and `test:system`.
  - `44db7c9`: the five unit runs. `b64bc56` changes only an e2e spec, which
    Vitest excludes.
  - `775860f`: safety and PostgreSQL. After it, only Studio test files
    changed, and neither tier reads them.
- Working tree: clean for every run. The one untracked directory belongs to
  another stream (`docs/plans/2026-09-24-unified-durable-execution-evidence/m3-spark/`)
  and was not touched.
- Host: Ubuntu 24.04, Linux 6.8.0, x86_64, 24 CPUs, one NVIDIA RTX 4090.
- Versions: Node 24.21.0, pnpm 10.9.0, Docker 29.8.1 with Compose 5.5.1,
  uv 0.12.17, Vitest 4.1.10, Playwright 1.62.1.
- Disposable PostgreSQL: container `free-m1-pg` on `127.0.0.1:5432`.
  `free_test_m2_store`, `free_test_m2_extraction` and `free_test_m2_parsing`
  were dropped and recreated before the PostgreSQL tier. The first two were
  initialized with `pnpm --filter db db:init`.

## Tiers

| Tier | Command | Commit | Result |
|---|---|---|---|
| Typecheck | `pnpm typecheck` | b64bc56 | exit 0 (studio, db, extraction, extraction-result-export) |
| Lint | `pnpm lint` | b64bc56 | exit 0; 0 errors, 3 warnings, all pre-existing `react-hooks/exhaustive-deps` |
| Unit | `pnpm test:unit` ×5 | 44db7c9 | 5/5 exit 0. Every run: scripts 57/57, studio-configuration 4/4, Studio 1200/1200 (102 files), db 52/52, extraction 38/38, extraction-result-export 33/33, Parsing fast 813 passed, 73 skipped, 127 deselected |
| Safety | `pnpm test:safety` | 775860f | 18/18 pass, 0 skipped |
| PostgreSQL | `pnpm test:postgres` (`PROJECT_STORE_POSTGRES_URL`, `EXTRACTION_TEST_DATABASE_URL`, `PARSING_TEST_DATABASE_URL`) | 775860f | db 19/19, extraction 36/36, Parsing 103 passed, 4 skipped, 906 deselected |
| E2E | `pnpm test:e2e` (12 workers) | 775860f runs 1–3; b64bc56 runs 4–8 | runs 1–2: 56/56; run 3: 55 passed, 1 failed (see [F2](#f2--lifecycle-re-run-left-the-page-before-studio-started-it)); runs 4–8 after the fix: 56/56 each |
| Base-path E2E | `pnpm --filter studio test:e2e:base-path` | b64bc56 | 2/2 pass (1 worker) |
| Real service | `pnpm test:service` | b64bc56 | 2/2 pass |
| Studio build | `pnpm --filter studio build` | b64bc56 | exit 0 |
| System contract | `pnpm test:system` with a verification overlay | b64bc56 | 11 pass, 4 fail; see below |

Skips:

- Parsing fast: 73 skipped.
- Parsing PostgreSQL: 4 skipped.
- All of them are the optional upstream fixtures gated on
  `PARSING_FIXTURE_DIR` (`tests/conftest.py:13-15`). As in M1, it was left
  unset.
- `pnpm test:live-model` was not run: no live model is configured on this
  host.

### Extra checks the controller routed here

- **Studio image without a keyring.**
  - Built with `docker build -f prototypes/studio/Dockerfile -t free-studio-m2-t15 .`
    (exit 0).
  - `docker run --rm --entrypoint pnpm free-studio-m2-t15 --filter studio exec codex login status`
    wrote `Not logged in` to stderr and exited 1. That is the expected state:
    no login has been done.
  - `codex --version` reports `codex-cli 0.153.4`.
  - Inside the image:
    - `CODEX_HOME=/root/.config/codex` (mode 700);
    - there is no `dbus-daemon` or `gnome-keyring-daemon`;
    - there is no `DBUS_*` or `XDG_RUNTIME_DIR` variable.
  - No keyring or D-Bus error was printed.
  - The binary is package-local; there is no `codex` on `PATH`, as the
    Dockerfile's comment says.
- **Residue search** (the plan's Task 15 Step 1 command). Remaining hits:
  - `prototypes/studio/api/extractions.test.ts:341` (`retryRecordStartBlockIds`):
    expected. It is the 422 stale-page request-body test.
  - `tests/safety.test.mjs:481,482,489,496`: excluded by ruling F10. These
    assertions check on purpose that the keyring packages are absent.
  - `prototypes/studio/README.md:50` (`model-config.json`): documentation.
    The ledger defers the Studio README's configuration and keyring
    paragraphs (`:50`, `:68`) to M6, together with
    `docs/operations/deployment.md:320`. See the plan's Deferred table.

### System contract (`test:system`)

`tests/contract.test.mjs` needs the full local Compose stack at
`https://localhost:8443`. It was run once. Three host and harness facts had to
be worked around first, all outside the repository:

1. **No `mkcert`.** No `.certs/` existed, and `ensureCertificates` fails
   without mkcert.
   - Workaround: a throwaway self-signed certificate made with `openssl` in
     the gitignored `.certs/`.
   - The suite sets `NODE_TLS_REJECT_UNAUTHORIZED=0`.
   - The certificate was removed afterwards.
2. **Port 5432.** The dev `db` service publishes `127.0.0.1:5432`
   (`compose.override.yaml:26-27`), which `free-m1-pg` holds. That container
   must not be stopped.
   - Workaround: an overlay passed through `COMPOSE_FILE` that sets
     `db.ports: !reset []`.
   - The suite never dials the dev database from the host.
3. **The mock issuer never starts from the helper.**
   - `tests/helpers.mjs` runs `docker compose up` without
     `--profile mock-oidc`.
   - `developmentComposeEnvironment` deletes `COMPOSE_PROFILES`.
   - So on a cold start the mock issuer never runs, and sign-in fails with
     `ECONNREFUSED 127.0.0.1:8444`. This was seen on the second attempt.
   - The suite only works against a stack that `pnpm dev` already started.
   - The same overlay sets `mock-oidc.profiles: !reset []`.
   - This harness gap predates M2: `tests/helpers.mjs` is unchanged since
     `2e4b874`.

Result: 11 pass, 4 fail.

- **Passing.** These include:
  - sign-in through the mock issuer;
  - projects;
  - PDF ingestion through the real parsing worker (57 s);
  - schema storage;
  - deletion.
- **The M2 edit passes.** The request body that Tasks 8 and 9 changed is
  `PUT /api/model_config` with `hasKey` and `ingestionModels`, and without
  `credentials`. The extraction test asserts it first, and it answered 200.
  `POST /api/extractions` then answered 201.
- **The failing assertion.** The extraction test then asserts
  `outcome === 'SUCCEEDED'` on the 201 response. That response has
  `outcome: null`: since `3e91df9` (2026-09-01, before M2) an Extraction
  starts in the background, and the 201 carries its execution status.
- **The other 3 failures follow from it:**
  - both review tests read the missing result;
  - the durability test repeats the outcome assertion.
- The suite's extraction step also needs Ollama at
  `host.docker.internal:11434` with `qwen3.8:latest`, which this host does not
  run.
- The stack was taken down with `down -v` afterwards.

## Fix wave (Task 15)

- **`55a1256` — two unit flakes.**
  - *`AuthApplication.test.tsx` › "renders the public signed-out landing …".*
    - Symptom: `expected 'stale' to be null`.
    - Cause: a race inside the test, not state leaking between tests.
      - The landing commits, and `findByRole` resolves, before the
        `useEffect` that calls `clearSessionRecovery` runs.
      - A probe confirmed that the value is still `'stale'` when the heading
        first appears.
      - The assertion depended on Testing Library's single `setTimeout(0)`
        drain.
    - Fix: the test now waits for the value to clear.
  - *`ProjectNavigation.test.tsx` › "places the narrow navigation toggle …".*
    - Cause: the same kind of race. The tab strip commits after the
      "Opened …" announcement.
    - Fix: the test waits for the tablist.
  - Before the fix: 2 failures in 16 Studio suite runs, one per test. The
    `AuthApplication` file alone passed 10/10 serially and 12/12 in parallel,
    so the suite runs are the real evidence.
  - After the fix: the file passed 15/15 and the Studio suite 15/15.
- **`00c4d05` — resolver tests.**
  - The CLI rows of "constructs the exact … general target" now route to the
    reserved CLI deployment connections. So does "rejects unsupported
    temperature …".
  - A new test checks that a route to a disabled CLI deployment connection is
    refused with 409 before any model is built.
  - The `_deployment_models.test.ts` `&&` assertion is split in two.
  - Not changed: the `probeConnection` tests (`_provider.test.ts:317,371,424`).
    They hand a CLI connection straight to the probe function, which ignores
    ownership.
- **`ded280d` — README.** `prototypes/studio/README.md` now says "Recreate the
  database from the baseline". It no longer names the removed migration
  `20260923T1946_source_reprocessing`.
- **`775860f` — kei-exp fixture port.**
  - The fixture ports are now 29750 (default suite) and 29753 (base-path
    suite).
  - F1 below explains the move.
- **`44db7c9` — lifecycle teardown test.**
  - Symptom: a third unit flake appeared in 1 of the first 5 whole-suite
    runs. `server/playwrightStack.test.ts` › "waits for the exact generation
    …" timed out at 5 s.
  - Cause: the teardown polls its completion marker with real file I/O
    between fake-timer sleeps. A read still in flight when the last
    `advanceTimersByTimeAsync` returned schedules a sleep that nothing
    advances. This was found by reading the code. The test alone passed 30/30
    under parallel load and did not reproduce it.
  - Fix: the test keeps advancing until the teardown settles, with a
    deadline far beyond the test's fake time.
  - After the fix, all 5 whole-suite runs passed.
- **`b64bc56` — lifecycle e2e.** See F2.

### F1 — the fixture port was inside the ephemeral range

- Seen at M1 (`2026-09-25-dbos-m1-verification.md`, F2) and at Task 12: once
  each, as `listen EADDRINUSE 127.0.0.1:41750`. The holder was never
  identified.
- The mechanism is shown here. On this host, `listen()` on a port that an
  outbound socket holds as its source port fails with `EADDRINUSE`. A script
  reproduced it twice, on ports 33204 and 51358.
- 41750 and 41753 lie inside Linux's ephemeral range (32768–60999). The
  lifecycle fixture binds mid-run, while 12 browser workers hold many
  outbound sockets.
- The new ports lie below both that range and the Compose lease range
  (30000–39999).
- No `EADDRINUSE` occurred in the 8 full e2e runs, the base-path run or the
  serial `--repeat-each=4` run of the lifecycle spec.
- Harness note: `--repeat-each` with more than one worker runs copies of the
  lifecycle spec in parallel, and they collide on the one fixture port. Run
  it with `--workers=1`.
- Residual risk: the other fixed e2e ports are also in the ephemeral range:
  - application 41749 / 41751 / 41761;
  - OIDC 41748 / 41752 / 41762;
  - PostgreSQL 45432 / 45433 / 45435;
  - service fixture 41764.

  They bind at stack start, not mid-run, and none has failed so far.

### F2 — lifecycle re-run left the page before Studio started it

- E2E run 3 failed in
  `canonical-evidence-lifecycle.spec.ts:635` (CATALOG):
  - after "↻ Re-run extraction", the spec navigated away and back;
  - it expected "Running extraction…";
  - the page showed the previous completed run instead.
- Cause: the page shows the running state before its `POST /api/extractions`
  reaches Studio, so leaving at once can abort the request before the
  Extraction exists.
- The spec lines predate M2. Since Task 7, Studio reads the owner's Extraction
  Model Choice from PostgreSQL before it creates the run, which may widen the
  window.
- Fix: the spec now waits until the kei fixture holds the run's result before
  it leaves. The spec already uses this pattern for its values gate.
- After the fix, e2e passed 5/5 at 12 workers, and the spec alone passed 4/4
  serially.

### Flake watch: mock-OIDC login timeouts

- `completeMockOidcLogin` timed out waiting for `/projects` in 0 of the 8 full
  e2e runs at 12 workers.
- That is 8 × 56 tests, nearly all of which sign in, plus the base-path and
  service runs.
- Earlier sightings were at Task 7 (first wave, cold start, while a parallel
  stream loaded the host) and Task 14 (twice, under 12 workers).
- No timeout was raised: there is no failure here to size it against.
