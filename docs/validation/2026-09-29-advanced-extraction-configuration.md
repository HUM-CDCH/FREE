# Advanced extraction configuration — validation receipt, 2026-09-29

Status: OpenSpec task 4.1 (validation receipt) for
[advanced-extraction-configuration](../../openspec/changes/advanced-extraction-configuration/verification.md),
implemented on `feat/advanced-extraction-configuration` from
[the plan](../plans/2026-09-28-advanced-extraction-configuration.md).
Candidate: commit `97388f9cc8ff20a4e5b3029fdcc1f6e268940a24`, tree
`77f7a27539e9a047d0b79c1656e58c4b691c28d8`. This receipt's own commit changes
only this file.

Task 4.2's independent whole-branch review has **not** run: both review seats
were rate-limited when this receipt was written (see "Not run"). Nothing below is
an independent review.

## Commands and outcomes

All on the candidate, local Linux host, 2026-09-29. Disposable PostgreSQL
targets were fresh `free_test_aec_acc_*` databases on loopback 5432, migrated
with `prisma-next migrate --yes` where required, and dropped afterwards. Python
ran in a worktree venv that imports this checkout's `src` over the primary
checkout's installed dependencies.

| Tier | Command | Outcome |
| --- | --- | --- |
| Types | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0; 2 warnings, both pre-existing `react-hooks/exhaustive-deps` in `prototypes/studio/src/useExtraction.ts` |
| Fast | `pnpm test` | exit 0; Studio 1,660/1,660; every Node tier 0 failures; Parsing Service 1,192 passed, 72 skipped, 75 deselected, 3 pre-existing warnings |
| PostgreSQL | `pnpm test:postgres` | exit 0; db 51/51; extraction 78/78; Studio 67/67 (includes the restart cases); Parsing Service 57 passed |
| Browser | `pnpm test:e2e` | exit 0; 65 passed, then the recovery configuration 5 passed |
| Real service | `pnpm test:service` | exit 0; 16 passed (real Python API and workers; model boundary scripted) |
| Focused Python | `pytest tests/test_extraction_methods.py tests/test_extraction_span_grounding.py tests/test_extraction_routing.py tests/test_grounding_study.py tests/test_serving_imports.py -m 'not postgres and not live_model'` | 71 passed |

Browser artifacts: `prototypes/studio/test-results/` (Playwright output, not
committed). The Advanced screenshots at 360×800, 390×844, 859×800, 1024×768,
1280×800 and 640×400 (200% zoom) were inspected. After the header fix below, no
control is clipped and nothing scrolls sideways. The zoom capture shows a tab
underline mid-transition (`transition-colors`), not a selection defect.

## Acceptance matrix

| IDs | Evidence |
| --- | --- |
| U1 | Component tests (opening Advanced and Explain saves and generates nothing); e2e "opening, explaining and switching strategies saves nothing" |
| U2 | Draft hook and page tests (Discard restores both tabs); e2e second account sees `extractionSettings: {}` |
| U3 | API tests plus `model_config.postgres.test.ts`; e2e reload survives Apply; e2e failed Apply keeps draft and saved document |
| U4 | Component test and keyboard e2e: an invalid child is kept, announced, counted, focusable, and resolved by the parent |
| U5 | 19 contract cases and 6,144 categorical inputs (1,560 accepted / 4,584 rejected); TS and Python agree through shared fixtures under `prototypes/parsing_service/tests/fixtures/contracts/`; UI reachability over the same inventory |
| U6 | Configuration contract and Python method tests (minima, non-integers, duplicate/empty keys, unknown factors; no partial save) |
| U7 | Single and batch admission integration tests: a missing, nested, non-scalar or filename-sourced identity field is refused before enqueue |
| U8 | Keyboard e2e; reflow e2e at 360 px, the required viewports and 200% zoom, including a dialog-level horizontal-overflow check; screenshots inspected |
| U9 | Page tests: starting point, Undo (number text included), then service defaults restoring the request shape |
| P1 | Service tier: kei receives the saved Article options byte for value; the Extraction records them |
| P2, P3 | Studio PostgreSQL restart tests (kill before submit, settings changed, recovery uses the pinned method); batch integration test (no member reads new defaults) |
| P4 | Batch equality tests: equal method reuses; a changed schedule does not; a change to the other strategy still reuses |
| P5 | Admission test: a lost response replays after a settings change; the same ID with another method conflicts |
| P6 | Barrier tests in both lock orders, observed through `pg_stat_activity`; a stale preview is refused before enqueue |
| P7 | Wire tests: omitted settings and explicit reference stay distinct, and omission adds no invented values |
| E1–E3, E5 | Adapter tests (policy skips, all-leaf versus eligible denominators, not applicable, Unicode support proofs, precision pass-through, proposals); Python span, routing and grounding regressions |
| E4 | Content tests and review of the guide against the dated reports (no entailment claim; semantic review named as outstanding per study) |
| F1 | Service tier: an oversized recipe reserve is refused with `budget_exceeds_context`, `output_tokens` stays 16,000, no links |
| F2 | Method used component tests: "Not recorded" for historical runs; "Effective method unavailable" for a failure before a service result |
| M1 | db PostgreSQL check on pre-release-shaped, malformed and already-migrated documents; pre-release `loadAdmitted` checkpoint test |
| A1 | `extraction_boundaries.test.ts` import checks (mutation-tested) and `test_serving_imports.py` |

## Found during validation

- **Signed-out page regression, fixed in `d296b8cd`.** The public signed-out
  module list included `shared/modelConfig.contract.ts`, which began importing
  the extraction package. A signed-out browser cannot load that package's
  source, so the sign-out pages rendered blank. Baseline `4e2a5820` passed the
  same three browser cases. Connection and key primitives moved to
  `shared/modelConnection.contract.ts`, which is now allowlisted instead.
  `server/signedOutModules.test.ts` now fails if an allowlisted module imports a
  module the signed-out page cannot load.
- **360 px dialog overflow, fixed in `765d8c18`.** With three tabs, the header
  scrolled sideways inside the dialog. The tabs now wrap to their own row below
  the `sm` breakpoint.

## Not run, and evidence boundaries

- Task 4.2's fresh independent review and the maintenance probe have not run.
  During implementation, Codex reviewed Tasks 1–9 and a Claude reviewer
  reviewed Task 10. Task 10's fix round and Tasks 11–14 were implemented inline
  without per-task independent review.
- No live-model smoke. The service tier scripts the model boundary; it is not
  provider execution.
- `pnpm test:safety` was not run: no deployment or safety configuration changed.
- Categorical parity establishes request compatibility, not output quality. No
  accuracy, speed or cost claim follows from configuration coverage. The
  guide's study findings are dated development evidence, as labelled there.
