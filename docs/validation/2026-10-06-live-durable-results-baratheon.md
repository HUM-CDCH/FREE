# Live durable results on Baratheon

Date: 2026-10-06 (Europe/Rome). Status: **all tiers passed apart from failures
dev already has; the live results acceptance passed three times, the last on
the committed test.** Production deployment is separate.

Branch feat/live-extraction-ux restores the live results loop recorded in ADR
0017 (*Live results amendment*):

- the record starts discovery finds, shown while it runs;
- each record's values and Evidence while the run reads;
- Pause, Resume and Stop on the run button;
- corrections as guidance for later calls.

## Candidates and isolation

| Candidate | Content |
| --- | --- |
| 29636298 | The feature, on dev 3559372f. |
| bc89ae56 | 29636298 merged with open PR #194, which contains #193. Tiers 1–5 ran on it. |
| 3eba0606 | 29636298 plus the committed live results test; no product change. |

Baratheon is spark-a892, ARM64. Private checkout:
/home/geba/Projects/FREE-live-ux-20261006, with Node 24.21.0, pnpm 12.8.1 and
Python 3.13.

**Browser tiers.** Every browser tier owned its Compose project, loopback
ports, PostgreSQL/mock-OIDC containers and volumes.

**PostgreSQL checks.** These used the disposable verification server on
127.0.0.1:5432, which the disposable-target guards require. They used only
their own databases: free_test_liveux_store, free_test_liveux_extraction and
free_test_liveux_parsing, plus the random free_test_* databases the checks
create. All were dropped, and the tier recorded no leftover test database.

- PARSING_TEST_POSTGRES_CONTAINER was unset, so no test could pause the
  shared server. No current test does.
- The native lifecycle and recovery checks ran the worker image
  free-pr188-test-worker:a7a0919b with this checkout's parsing service
  mounted.

**Models and production.** The existing Qwen (nvidia/Qwen3.8-27B-NVFP4) and
GLiFormer endpoints were used only for inference; no model was restarted.
Production's checkout, services and database were not changed, and no
task container, network or volume remains.

## Executed acceptance

| Check | Result | Candidate / evidence |
| --- | --- | --- |
| Typecheck / lint | Passed | bc89ae56; typecheck.log, lint.log |
| Node scripts / Studio configuration | 66 / 4 passed | bc89ae56; node-scripts.log, studio-configuration.log |
| Studio unit | 1971 passed, 3 skipped, **5 failed (dev)** | bc89ae56; studio-unit.log |
| db / extraction / export unit | 93 / 97 / 10 passed | bc89ae56; db-unit.log, extraction-unit.log, export-unit.log |
| Python unit | 1438 passed, 72 skipped | bc89ae56; python-unit.log |
| Safety | 29 passed | bc89ae56; safety.log |
| db PostgreSQL | 56 passed, **2 failed (dev)** | bc89ae56; db-postgres.log |
| extraction PostgreSQL | 15 passed (native lifecycle and process-death recovery) | bc89ae56; extraction-postgres.log |
| Studio PostgreSQL | 63 passed | bc89ae56; studio-postgres.log |
| Python PostgreSQL | 45 passed; the 20 skipped are the lifecycle and recovery cases the extraction checks run | bc89ae56; python-postgres.log |
| Standard browser | 71 passed, 5 conditional skips | bc89ae56; browser-standard.json |
| Unified Catalog browser (FREE_CATALOG_METHOD=unified) | 3 passed on rerun | bc89ae56; browser-unified-rerun.json |
| Recovery / durable / base-path browser | 5 / 18 / 1 passed | bc89ae56; browser-recovery.json, browser-durable.json, browser-base-path.json |
| Service browser | 13 passed, 3 conditional skips | bc89ae56; browser-service.json |
| Live results acceptance | Passed ×2 | bc89ae56 with the then-uncommitted live-ux.spec.ts; live-ux.json, live-ux2.log |
| Live results acceptance, committed | 1 passed, 99 s | 3eba0606; live-results.json |
| Live Article and unified Catalog providers | 2 passed | bc89ae56; live-provider.json |
| Python live model | 14 passed, 7 skipped, **1 failed (dev)** | bc89ae56; python-live.log |
| Root pnpm test:system | 15 passed, no skips | bc89ae56; system.log |

Paths are under the private checkout's artifacts/live-ux/; tier1–5.sh and
live-results.sh hold the exact commands.

- The Playwright JSON reports have zero unexpected and zero flaky cases.
- Conditional skips are not counted as passes.
- The first unified Catalog attempt ran no test: its stack found lease port
  35036 already taken. The rerun under another Compose project passed.
- live-ux.spec.ts became the last case of e2e/durable-service.spec.ts. The
  inputs are the same, now seeded through its seedNative. The case is skipped
  unless FREE_REAL_EXTRACT_URL is set.

## Failures dev already has

All three are independent of this branch.

| Failure | Cause | Fix |
| --- | --- | --- |
| ProjectNavigation.test.tsx, 5 cases | caab2410's Evaluation rounds panel adds a fetch on every Project Context open. Reproduced on 3559372f and fc7d0353. | [#195](https://github.com/HUM-CDCH/FREE/pull/195) |
| durable-extraction.postgres.check.ts, 2 cases | caab2410 added migrations 20261006T0829 and 20261006T0837, but not to the checks' expected lists. | [#195](https://github.com/HUM-CDCH/FREE/pull/195) |
| test_extract_grounded_live.py, 1 case | The live server reports no tokenizer model_digest. Also fails on plain dev on Baratheon. | None yet |

## Live results acceptance

Setup:

- a 16-entry, 5-page catalogue (a heading and three entries, then four a page);
- a unified Catalog with the reasoning server also reading the fields;
- a real worker.

The three runs agreed.

| | Run 1 | Run 2 | Run 3 (3eba0606) |
| --- | --- | --- | --- |
| Record starts shown before the plan | 2 | 3 | 2 |
| Mid-run: status, highlights, read / waiting records | RUNNING, 1, 1 / 15 | RUNNING, 1, 1 / 15 | RUNNING, 1, 1 / 15 |
| Values when paused / at completion / linked | 6 / 48 / 44 | 6 / 48 / 44 | 6 / 48 / 44 |
| Calls carrying the mid-run edit | 27 | 27 of 32 | 27 of 32 |

**Calls and guidance**

- Runs 2 and 3 made 32 calls: 1 discovery, 16 entry and 15 verification.
- The 5 calls without the edit were all sent before it was saved (feedback
  version 0): discovery, the entries of records 1–3, and record 1's
  verification.
- Every call sent afterwards carried the edit, and each carried feedback
  version 1 or later.
- Run 1's evidence file predates the per-call list; it records the same 27
  guided calls.

**Discovery streaming**

- Each run wrote one discovery event on the attempt workflow and one places
  event on the discovery call workflow.
- The captured discovery request has no stream option. Only the transport
  asked for the stream.

**Pause and Resume.** Both worked from the run button.

Evidence: live-ux-results/, live-ux2-results/ and live-results-results/. They
hold each run's evidence JSON (timeline, call list, events, values),
screenshots of every step, and run 3's worker log. All three evidence files
were inspected locally.

## Findings

- **Empty records.** In all three runs, record 2's three values and record 3's
  site came back null, so the run saved them as absent. Both entry calls ran
  before the edit, without examples. The evidence files do not keep their
  requests, so the cause is not established.
- **Status lag.** While pausing, the rail's status line can still show
  Pausing after the run button offers Resume and the tab says paused
  (05-paused.png). They are separate reads.
- **Misleading summary.** Record 2, all of whose values are absent, shows
  "all checked", although it holds nothing to check. While the run goes on,
  its absent values are marked "checking" (05-paused.png, 06-completed.png).

## Production defaults

Production Studio sets FREE_CATALOG_METHOD=unified. The production worker
configures both NuExtract and GLiFormer. With NuExtract configured,
`defaults()` reads fields with NuExtract, and those values carry verification
links.

This comes from reading production's configuration and code, not from a live
NuExtract run: these runs had the reasoning server read the fields. An
account that chooses GLiFormer for fields gets no Evidence links, by design.
