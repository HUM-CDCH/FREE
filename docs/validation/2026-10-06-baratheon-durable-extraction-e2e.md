# Baratheon durable extraction E2E — 2026-10-06

Status: independently reviewed fix; release acceptance is tracked in
[PR #190](https://github.com/HUM-CDCH/FREE/pull/190). Base: deployed
PR #188, `aeac8cf38b91f69ac5f5c7c83c6a679737b7cdf0`. User requested manual
complete extraction, every new job feature, fixes, `free-deploy release` on
Baratheon and retesting. Local serving with Baratheon models was explicitly authorized.

## Isolation and real execution

An isolated worktree and guarded disposable PostgreSQL (`free_test_real_service`)
served Studio, mock OIDC using the real authorization-code flow, and the actual
Python API and DBOS worker. No production session was forged, production data
reset, or production database used for tests. Native two-page Article and Catalog
PDFs were generated as test inputs. Qwen `nvidia/Qwen3.8-27B-NVFP4`, NuExtract
`numind/NuExtract3-FP8`, GLiFormer and OCR endpoints were forwarded from
Baratheon without restarting model services. A task-owned proxy held one real
Qwen generation or returned 503 to exercise durable call boundaries; successful
inference came from the real models.

Evidence (ignored, local): `artifacts/manual-baratheon/`, including screenshots,
exports, before/after recovery histories and worker/verification logs. External
harness scripts live under the parent `artifacts/baratheon-e2e/`; none enters the
product source or commit.

## Reproduced defects and fixes

| Defect | Reproduction and fix | Regression evidence |
| --- | --- | --- |
| Completed Results stayed empty | A Results rail mounted while hidden at admission pinned snapshot 0. Completion had six grounded values but the visible rail kept zero. An automatic empty page now follows publication until populated or explicitly selected; named cuts and review drafts remain stable. | `bug-completed-empty-initial-cut.png`; added hidden-admission regression; fresh Article batch opens two values. |
| Revised inputs could not save defaults | Pinned null method defaults and unified `{defaults:1}` were passed to account-preference validation. Canonicalize through the existing settings boundary; show only the current Extraction strategy and prevent irrelevant Article presets in Catalog. | Eight Article/Generic/Recipe/unified default and customized cases; live pending settings/model changes and discard/apply. |
| Natural worker recovery failed | Killing a real worker during a saved call caused DBOS recovery before the old 30-second lease expired, then `55P03` and `execution_interrupted`. Retry only lease contention for up to 40 seconds without holding a connection or taking a live epoch. | Native recovery test failed before, all five crash cases passed after; the commit-output case no longer edits leases. Real Qwen batch member recovered and prior capture/output digests stayed identical. |
| Project progress stayed stale | Batch members reached 3/3 while the project summary remained 2/3. Notify the existing project refresh callback only when batch/member progress changes. | All 49 panel tests; focused polling regression checks refresh once and no repeat on unchanged data. |

## Manual feature matrix

- Authentication, new Project, native PDF ingestion, parsing reload and saved evidence.
- Real schema generation, guidance, invalid nested edit refusal, manual schema edits
  and pinned revisions; document Article and unified record Catalog.
- Single extraction, nested object-array Article values, three-document Batch
  Extraction, member navigation, `Run again` and fresh single-member batch.
- Pause during a real generation: Pausing survives reload, reserved output saves,
  Paused has no in-flight work, and Resume retains the Extraction identity.
- Pending Resume canceled by input editing, boundary refusal, pending selection
  save/apply/discard, model and advanced-setting changes, explicit reprocessing.
  Completing the final reserved call can legitimately finish a Pausing Extraction.
- Stop during a reserved call reaches terminal Stopped; reload offers no Resume
  or Retry. Real provider 503 becomes Failed; restoring the provider and Retry
  finishes the same Extraction with retained prior results.
- Worker SIGKILL and natural restart; immutable saved calls/output checkpoints.
- Grounded evidence navigation, string/integer edits, invalid fractional integer
  refusal, approve/reject/undo and one-by-one keyboard review.
- Two-tab stale-review 409 retains the whole local draft; reload and retry work.
  Partial finalization refuses; all six reviewed values finalize the exact pair
  (results 5 / decisions 7), surviving reload and later reprocessing.
- Historical producing settings/schema/call input/output inspection; earlier
  corrections and finalization retained across revised inputs.
- CSV and XLSX single/batch downloads, paused and stopped CSVs. Manifests pin
  the intended status/snapshot/decision cut; batch export contains all three
  completed members. Empty stopped results remain valid. Recall is unmeasured.
- Desktop and 390×844 mobile Results: visible controls and no horizontal document
  overflow; completed Article has title and two sites, including page-2 countries.

## Verification

- Typecheck and lint passed; db 88, extraction 97, export 10 checks passed.
- Complete Studio unit suite: 175 files / 1,953 checks, bounded to two workers.
  Final changed-area run after adding customized input cases: 3 files / 78 checks.
- Native durable recovery wrapper: five Python crash scenarios passed under the
  guarded disposable PostgreSQL contract with actual DBOS worker processes.
- Parser unit tier: 1,397 passed / 72 skipped / 86 deselected. Executed with
  the isolated `.venv/bin/python -m pytest -q -m "not postgres and not live_model"`
  after adding the missing locked tracing and grammar packages.
- Final typecheck and lint passed after removing temporary harness source.
- Bounded simplify/harden self-review: no further changes or unresolved findings.
- Independent Standards review: PASS, zero findings. Independent Spec review:
  PASS, zero findings. Both reviewed commit `6b32d646` against `aeac8cf3`,
  verified named-cut/draft stability, canonical settings, SQL epoch fencing,
  unchanged workflow sequences, and stable progress refresh callbacks.

Failed verification attempts are retained in logs: initial `/tmp` quota failures,
an unbounded Studio run starving PDF-worker deadlines (the unchanged PDF tests
then passed alone and in the bounded full suite), and copied Python entry-point
scripts referring to the original worktree with missing tracing/grammar packages.
These are not counted as successful checks or unexplained product defects.
The proxy initially intercepted tokenization rather than generation; corrected
before control assertions. Browser-driver download timeout/cancellation and a
transient development-module load were retried successfully and remain failed
harness attempts, without speculative product changes.

## Review and release outcome

Both independent code reviews passed. CI, release SHA and post-release acceptance
are recorded in [PR #190](https://github.com/HUM-CDCH/FREE/pull/190).
Production uses real Entra: authenticated manual execution above is
local with real Baratheon models. Deployment verification must separately record
release SHA, healthy runtime/auth protection, data preservation, model container
identity preservation, and a fresh live-model extraction after release.
