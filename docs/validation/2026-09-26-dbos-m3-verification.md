# DBOS M3 verification — 0db9f1f — 2026-09-26

Status: every component tier of M3 passes at `0db9f1f`. `pnpm test:service`
fails as the plan expects (Ruling 1): Studio's real-service harness still
starts the deleted `kei_exp.jobs.cli`, which M4 rewrites. The Spark measurement
(Task 14) is still pending. No live-model tier ran against a model server: the
live tier ran on CPU with Docling weights, and its model-server tests skipped.

## Scope and environment

- Tested commit: `0db9f1f5e5341347e3094917bd7a66302d91376a`. M3's change
  boundary is `c543aeb..0db9f1f`. It includes M2 through its Task 12 (`83b2918`,
  merged in `3a45b07`). Task numbers follow the
  [M3 plan](../plans/2026-09-26-dbos-m3-kei-on-dbos.md).
- Task 13 made nine commits before the tiers ran (`89b8248..0db9f1f`). They are
  deferred cleanups from the task reviews:
  - `79ea95c`: comments no longer name the deleted admission API or
    `jobs/tasks.py`.
  - `d613bad`: the contract-fixture helpers moved to
    `tests/helpers/contracts.py`.
  - `ac74386`: the model-stack import test is renamed. kei's boot timestamp is
    now restored after each test.
  - `20f4d4e`: DBOS is destroyed when launch or lane registration fails.
  - `2871ced`: the worker prints a startup error as its type and a redacted
    message, never the database password.
  - `7d50458`: the test database URL quotes reserved characters and brackets
    IPv6 hosts.
  - `7a7a6ba`: `deleteRuns` keeps a run it cannot remove and checks that
    `params.json` is an object. It also deletes each history ID only once.
  - `a8f0738`: the safety test refuses a database URL in any variable of the
    parsing API.
  - `0db9f1f`: a Compose comment notes that `NUEXTRACT_MAX_NUM_SEQS` above 64
    stops kei's worker at boot.
- Working tree: clean for every run. The only exception was the uncommitted
  plan status edits that this record's commit adds.
- Host: Ubuntu 24.04.5 LTS, Linux 6.8.0, x86_64, 24 CPUs. No GPU was used.
- Versions: Node 24.21.0, pnpm 10.9.0, Docker 29.8.1 with Compose 5.5.1,
  uv 0.12.17, Python 3.13.13, dbos 3.1.0, psycopg 3.3.6, pytest 9.1.1,
  PostgreSQL 17.11.
- Python environment: the shared M3 venv
  (`UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv`), synced from this worktree.
- Disposable PostgreSQL: the `free-m1-pg` container (tmpfs, user `postgres`,
  `127.0.0.1:5432`). Task 13 used only databases it created and dropped:
  - `free_test_m3_13_maint`: the parsing tiers' maintenance database
    (`PARSING_TEST_DATABASE_URL`). Each test creates and drops its own
    `free_test_parsing_*` database.
  - `free_test_m3_13_extraction` and `free_test_m3_13_store`: new databases,
    migrated with `DATABASE_URL=<url> pnpm --filter db db:init`, for
    `EXTRACTION_TEST_DATABASE_URL` and `PROJECT_STORE_POSTGRES_URL`.
  - URLs are written `postgres:***@` here, and no log contains the password.
- `PARSING_FIXTURE_DIR` was unset. Tests that need the optional upstream
  originals (`Beier1988_GAC_02_Catalogue7.pdf`, `main.pdf`) skip with that
  reason.

## Results

| Tier | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | clean |
| Lint | `pnpm lint` (Studio ESLint) | clean |
| Unit (every package) | `UV_PROJECT_ENVIRONMENT=… pnpm test:unit` | pass. Scripts 58/58, studio-configuration 4/4, Studio 1196/1196 (102 files), db 52/52, extraction 38/38, extraction-result-export 33/33, parsing fast as below |
| Parsing fast | `uv run --no-sync pytest -q -m "not postgres and not live_model"` | 939 passed, 72 skipped, 65 deselected. Every skip is an absent optional upstream fixture |
| Parsing PostgreSQL (incl. `slow`) | `PARSING_TEST_DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/free_test_m3_13_maint uv run --no-sync pytest -q -m "postgres and not live_model"` | 47 passed, 1029 deselected (132.8 s) |
| Parsing live (CPU, Docling weights) | `uv run --no-sync pytest -q -m "live_model and not postgres"` | 3 passed, 14 skipped. Skips: absent upstream fixtures (`test_cut.py`, `test_native.py`) and no extraction server (`FREE_REAL_EXTRACT_URL`/`FREE_REAL_EXTRACT_MODEL` unset, for `test_extract_grounded_live.py` and `test_extract_tokens_live.py`) |
| Service smoke through DBOS | `PARSING_TEST_DATABASE_URL=… uv run --no-sync pytest -q tests/test_service_smoke.py` | 1/1 pass. A real `kei-worker worker` child took its slot and launched in `kei_dbos`. A portable `DBOSClient` enqueue of `convert` then succeeded, and the result was served over HTTP (8.7 s) |
| Safety | `pnpm test:safety` | 18/18 pass (Docker renders every overlay) |
| Scripts | `node --test scripts/free.test.mjs` | 44/44 pass |
| Node PostgreSQL | `EXTRACTION_TEST_DATABASE_URL=… PROJECT_STORE_POSTGRES_URL=… pnpm test:postgres:node` | pass. db 19/19, extraction 36/36 |
| Browser e2e | `pnpm test:e2e` | 50 passed (1.5 min). kei is the in-test HTTP fake, so this tier does not exercise M3 |
| Real service | `pnpm test:service` | **expected red until M4** (Ruling 1). See below |

### `pnpm test:service`: expected red

Both specs of `e2e/real-service.spec.ts` fail at the same place. The harness,
`prototypes/studio/e2e/realService.ts:219`, runs
`python -m kei_exp.jobs.cli schema --apply`. The service log reports
`ModuleNotFoundError: No module named 'kei_exp.jobs'`, and the harness throws
`Service migration failed`. Task 10 deleted `kei_exp.jobs`. M4 replaces the
harness together with Studio's HTTP submission (`KEI_DATABASE_URL`,
`kei_exp.jobs.cli worker` at lines 165 and 198).

The harness spawns `prototypes/parsing_service/.venv/bin/python`. This host
keeps the venv outside the worktree, so for this run `.venv` was a temporary
symlink to the shared venv, removed afterwards. Without it, the tier fails
earlier, with `spawn … ENOENT`.

### Not run

- Studio's live-model tier and the parsing tiers that call a real extraction
  or OCR server. This host has no model server. Task 14 measures on the Spark.
- `postgres and live_model` (untiered). The smoke above is its one test that
  the plan names.

## Residue search

Command (brief, Step 2), from the worktree root:

```bash
grep -rnE "procrastinate|kei_exp\.jobs|kei-jobs|DurableEmit|tokens\.jsonl|parsing_db|parsing_migrate|parsing-postgres|FREE_PARSING_POSTGRES_PASSWORD|KEI_DATABASE_URL|KEI_ADMISSION_LIMIT|cancel_requested|KEI_EXP_MODEL" \
  prototypes packages scripts docker compose*.y*ml tests .env.example --exclude-dir=node_modules
```

The search returned 15 hits, with no binary-file matches. None is in Compose,
`docker/` or `.env.example`. Each hit stays for the reason given:

| Hit | Milestone | Why it stays |
|---|---|---|
| `prototypes/studio/e2e/realService.ts:165` (`KEI_DATABASE_URL`), `:198` and `:219` (`kei_exp.jobs.cli`) | M4 | The real-service harness. M4 rewrites it together with the handoff (the expected-red tier above) |
| `prototypes/studio/api/source_documents.ts:472` (`process.env.KEI_EXP_MODEL ?? DEFAULT_MODEL`) | M4 | Studio's HTTP submission. It still sends an OCR model and polls kei over HTTP. Compose no longer sets `KEI_EXP_MODEL`, so it falls back to `surya` (`DEFAULT_MODEL`). M4 deletes the submission and polling |
| `prototypes/studio/api/source_documents.test.ts:661` (`vi.stubEnv('KEI_EXP_MODEL', …)`) | M4 | The test of that submission. It goes with it (F5) |
| `prototypes/parsing_service/src/kei_exp/models.py:89` (comment: "until then Studio's KEI_EXP_MODEL … is sent") | M4 | M2's comment (F5). Studio still sends `KEI_EXP_MODEL` until M4 removes the submission |
| `prototypes/parsing_service/docs/job-backend.md:33` (`procrastinate_finish_job_v1`) | M6 | The imported Procrastinate study, a historical record. M6 marks it superseded (DBOS plan, M6 *ADRs*) (F5) |
| `prototypes/parsing_service/tests/test_convert_workflow.py:127`, `tests/test_service_smoke.py:202` (`tokens.jsonl`) | — | The plan's own tests assert that no token log is written. Excluded (F5) |
| `prototypes/parsing_service/tests/test_api_reads.py:16` (`KEI_DATABASE_URL`), `:26` (`procrastinate`) | — | The plan's own tests assert that the API reads no database URL and imports no job backend. Excluded (F5) |
| `tests/safety.test.mjs:169-171` (`parsing_db`, `parsing_migrate`, `parsing-postgres`, `KEI_EXP_MODEL`) | — | The plan's own safety assertions that these are gone. Excluded (F5) |
| `scripts/free.test.mjs:607` (`FREE_PARSING_POSTGRES_PASSWORD`) | — | The plan's own assertion that `free.mjs` no longer asks for it. Excluded (F5) |

`packages/extraction/src/kei-exp.ts` no longer matches: it is off the expected
list, as F5 says. The Studio submission side that M4 rewrites is still present
(`source_documents.ts` HTTP submission and polling, `KEI_EXP_MODEL`). This is
expected residue, not an M3 defect. Outside the search's paths,
`docs/operations/*.md` (M6) and the historical records under `docs/plans/`,
`docs/validation/` and `openspec/changes/archive/` are not residue.

## Carried forward

- M4: Studio enqueues `convert`, `extract` and `deleteRuns` by name, reads the
  run ID from kei's output, and gets extraction status from DBOS. The route
  `/api/runs/{id}/extractions/{xid}` now returns the raw artifact only. M4 also
  rewrites `realService.ts` and deletes `KEI_EXP_MODEL`/`DEFAULT_MODEL`.
- Task 14: the Spark measurement (conversion deadline per page, Catalog
  chunks, OOM behaviour of long books).
