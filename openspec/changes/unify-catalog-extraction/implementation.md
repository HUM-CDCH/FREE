# Implementation record

Date: 2026-09-29. Status: **implemented behind its rollout gate; release gates
open.** New Catalog admissions stay on the legacy generic and recipe Catalog
unless a deployment sets `FREE_CATALOG_METHOD=unified`, and no deployment may
set it before the held-out evaluation in [evaluation-manifest.md](evaluation-manifest.md)
passes.

## Baseline and concurrent work (task 1.1)

- Branch `feat/unify-catalog-extraction`, a separate worktree based on
  `origin/dev` at `287ccb42` (PR #151 merged). The plan's baseline
  `80686ec4` is its parent; #151 touched `catalog.py`, `grounding.py`,
  `llm.py` and Studio's model-output repair, none of which this change edits.
- The planning directory was untracked in the main checkout
  (`feat/sample-extraction-workbench`); it was copied into this branch, which
  holds the authoritative copy. The main checkout's copy and its uncommitted
  `pnpm-lock.yaml`/`prototypes/studio/package.json` edits were left untouched.
- Integration duties, not done here:
  - **PR #150** (open, `fix/overfitting-audit`) edits the legacy generic
    `catalog.py` and its omission diagnostics. This change never edits
    `catalog.py`; merging #150 must keep `test_legacy_catalog_golden.py`
    green or deliberately re-capture its goldens in that PR.
  - **`75aac918`** (`options.pages`, sample workbench, not on `dev`) narrows
    `evidence.passages` in `run.extract` before dispatch. The unified path
    reads only `evidence.passages` and `evidence.withheld`, so it inherits the
    admitted page scope; when both land, `Options.dumped()` must keep both the
    `pages` and `unified` exclusions, and the ledger then covers the admitted
    scope only.
  - `grounded-numbered-catalogue` and `modular-extraction-ablation-study`
    remain as they are: the numbered recipe is a legacy executor and regression
    fixture here.

## What was built

| Area | Change |
| --- | --- |
| Parsing Service | `kie/extract/discovery.py` (source units, counted windows, general discovery, continuation, ledger) and `kie/extract/unified.py` (options, execution and discovery records, entry and document windows, candidate checks, verification, arbitration, conservative merging, version-3 artifact). `run.py` dispatches `options.unified`; `files.publish_once` writes records write-once; `models.ROLE` gains `verification`; the workflow maps `BudgetRefused` to the new `budget_refused` code and `RecordConflict` to `extraction_failed`. |
| Extraction package | The unified method is the `{unified: {defaults, ...overrides}}` settings member (no database migration: the member key is the discriminator, `catalogRecipe` stays null). Admission uses it for Catalog where the gate is on; legacy Catalog preferences refuse with `catalog_migration_required`. `acceptKeiArtifact` pairs unified requests with version 3 only and verifies the embedded records' canonical digests, pins and evidence anchors. |
| Studio | Deployment flag in the model-configuration response; one Catalog group of five controls on the Advanced tab with retired values explained and never converted; start summaries without a recipe selector; migration notice; `CatalogReview` for accounting, processing and evidence; the Catalog guide topic. |
| Deployment | `FREE_CATALOG_METHOD` in Compose (empty by default), `.env.example` and the deployment runbook; a safety test pins the default. |

Legacy executors (`catalog.py`, `grounded.py`) and every module they import
were not edited, except `models.ROLE` (one added stage) and `run.Options`
(an excluded optional member). `test_legacy_catalog_golden.py` proves their
scripted artifacts byte-equal on every run.

## Deviations from the design, with evidence

1. **Declared deployment cap.** Auto input is the served context
   (`max_model_len` from `/tokenize`) minus the stage's reply reserve; no
   separate operator cap was added. The served context is the only cap the
   deployment declares today; an explicit custom ceiling above what the
   context can hold is refused, never clamped
   (`test_an_input_ceiling_beyond_the_served_context_is_refused_not_clamped`).
2. **Entry overlap.** Overlap applies between windows of one entry; text of
   neighbouring entries is never shown as overlap. The record-free lines
   before an entry (at most three, recorded as its `context` in the discovery
   record) are its heading context. A quote found only outside the entry is
   rejected (`test_a_value_quoted_from_a_neighbouring_record_is_rejected`).
3. **Partial item, defined mechanically.** Only for an entry read in several
   windows: an unmatched object item is partial when its evidence or
   occurrence touches the units where it could continue unseen — the context
   shown on that side when there is overlap, otherwise the window's edge unit.
   Items seen alike in distinct windows with one located occurrence are one;
   scalar list items are never partial (a literal value cannot be cut and
   still be located). Tests: `_merged` unit tests in `test_unified_catalog.py`.
4. **List positions** are made dense over items that kept an accepted value,
   after verification, so that evidence names its item after `conform`
   compacts lists (`test_an_item_whose_values_were_all_refused_leaves_no_gap_in_the_list`).
5. **Strict options.** Python validates `options.unified` in strict mode, so
   `"yes"` is not a boolean on either side (shared fixture
   `unified-catalog-options.json`).
6. **Records hold no floats.** Calls kept in the discovery record carry whole
   `milliseconds`, so Studio can recompute the canonical digest in
   TypeScript; checked against a Python-produced fixture with non-ASCII text
   (`extract.result.v3.json`).
7. **No numbering-gap diagnostics** (deferred by the design).

## Versioned defaults (task 1.5)

`unified.DEFAULTS[1]`, mirrored by `UNIFIED_CATALOG_DEFAULTS` and pinned by
`tests/fixtures/contracts/unified-catalog-options.json`:

| Setting | Value | Basis |
| --- | --- | --- |
| Input ceiling | Auto: served context − stage reserve; custom 512–1,048,576 | Capacity policy, no benchmark claim |
| Reply reserves | discovery 4,096; entry 4,096; verification 2,048; arbitration 512; document 2,048; custom 64–65,536 for all | Engineering choice |
| Overlap | 1 source line; custom 0–4 | Engineering choice |
| Heading context | on (≤ 3 record-free lines before the entry) | Engineering choice |
| Verification | on | Required for accepted evidence |
| Recovery | a failed or cut-off window is halved at most 6 times; a single-unit window is then unresolved; no identical retries | Engineering choice |
| Context omission | heading, then later, then earlier context is dropped before primary text; each dropped range is reported in `context_omitted` | Contract |

None of these values has measured support yet; the evaluation must register
them before its held-out run.

## Verification (2026-09-29, this worktree)

Python ran on the main checkout's locked environment with `PYTHONPATH` set to
this worktree's `src`. PostgreSQL tiers used new `free_test_unify_*`
databases: first on the loopback test server another session had started
(nothing else on it was touched; that session later removed the server and
these databases with it), then, for the HEAD reruns, on a private disposable
`postgres:17` container on loopback 5432 that was removed afterwards. Browser
tiers used their own Compose projects and ports.

| Command | Revision | Result |
| --- | --- | --- |
| Parsing Service fast tier (`pytest -m "not postgres and not live_model"`) | `578ebd08` | 1,156 passed, 72 skipped (baseline 1,102) |
| Parsing Service PostgreSQL tier (`-m "postgres and not live_model"`, worker recovery included) | `24ab8a90` | 58 passed |
| `tests/test_extract_workflow.py` on PostgreSQL (3 unified cases, DBOS retry after discovery) | `578ebd08` | 39 passed |
| `pnpm --filter extraction test` | `578ebd08` | 124/124 |
| `pnpm --filter extraction-result-export test` | `578ebd08` | 36/36 |
| `pnpm --filter extraction test:postgres` | `578ebd08` | 85/85, including 5 gated unified admission cases |
| Studio `vitest` (full) | `578ebd08` | 1,686/1,693; the 7 failures (`_pdf_pages` worker timeouts, one DBOS-free import check, workflow registration) ran beside the service tier and pass alone (27/27) |
| `pnpm typecheck`, `pnpm lint` | `c1d34063` | pass; 2 pre-existing hook warnings in `useExtraction.ts` |
| `pnpm test:safety` | `24ab8a90` | 19/19 |
| Playwright, gate off (default config) | `24ab8a90` | 64 passed, 3 skipped (the gated spec), 1 mock-OIDC sign-in failure that passes on rerun (6/6) |
| Playwright, `FREE_CATALOG_METHOD=unified`, `e2e/unified-catalog.spec.ts` | `24ab8a90` | 3/3 |
| `pnpm test:service` (real API, worker and Docling; gate off) | `578ebd08` | 12/15; the legacy call count (10 for 8), the recipe Catalog's page-2 evidence focus and the GC-lane sweep failed; see the Spark rows |

Production code after `24ab8a90` changed only by `e636649e` (discovery takes
two callables), covered by the HEAD reruns above.

### On the DGX Spark (`baratheon`, aarch64 GB10)

Branch `578ebd08` plus the uncommitted `tests/test_unified_catalog_live.py`,
in a separate clone (`~/free-unify`, from a git bundle; nothing pushed). The
comparison tree `~/free-dev` is `origin/dev` at `287ccb42`. Python ran in
throwaway `free-unify-*` containers of the production `free-parsing_worker`
image on `free_app` (the branch's `src` mounted over `/app/src`; no dependency
changes since the image's `80686ec4`), against the production vLLM servers
`extraction_model` (`Qwen/Qwen3.8-27B-FP8`) and `nuextract_model`
(`numind/NuExtract3-FP8`), both idle before each run. No production container
was touched.

| Command | Result |
| --- | --- |
| `tests/test_unified_catalog_live.py` (new; `continuations`, 4 entries) | 2/2. Deployment routing (NuExtract fields, Qwen reasoning): 9 calls, 2,890 input tokens, 64 s. Qwen for every role: 9 calls, 2,444 tokens, 122 s. Both: labels `40.`–`43.`, `entry_no`, `site_name`, `fundart` right in every record, every call within its stage's ceiling, the re-execution reuses the published discovery |
| rest of `test:live-model` (Python) | 11 passed, 5 skipped (optional upstream fixtures), 1 failed: `test_extract_grounded_live.py` asserts a tokenizer `model_digest`, which `tokens.py` has reported as `None` since `8813b1d8`; this branch changes neither |
| `test:live-model` (Studio, `free-studio` image on `free_app`) | 2/3; the NuExtract schema suggestion does not mention "grave". Fails identically on `origin/dev` |
| `pnpm test:system` | 16/16 |
| `pnpm test:service` | 14/16; `origin/dev` 14/16 with the same two failures (call count 10 for 8; page-2 evidence focus). The GC-lane sweep passed in both runs and 5/5 on its own (`--repeat-each 5`) |
| recovery Playwright config (`test:e2e:recovery`) | 5/5 |
| 200-entry `big` catalogue (rev-8 generator), deployment routing, `chunks=4` | Discovery: 11 Qwen calls in about 83 minutes (legacy did the whole extraction in 435 s), 5 of them cut off at the 4,096-token reply cap and halved; 251 entries for 200: all 200 found, plus 51 find-list lines (`1. Scherben.`) split off as entries; 3 ends unresolved. Whole run 5,556 s (about 13× legacy): 251 NuExtract entry calls (918 model-seconds) and 251 Qwen verifications (1,267). Of the 200 true records, `site_name` right in 196 and `fundart` in 200, no accepted value wrong; `bezirk` and `kreis` empty in all (heading context, plus 133 `type_mismatch`); 55 `site_name` and 33 `fundart` rejected by verification. The 51 false records carry accepted values such as `fundart: "Scherben"`. Result: `~/free-unify-evidence/big-default.json` on the Spark |

Live-model findings (smoke evidence, not the evaluation of 1.4 / 6.2):

- **Heading-inherited fields are never accepted.** `bezirk` and `kreis` are
  rejected as `quote_not_in_source` in every record: an entry's quotes are
  located only in its own text, so a value quoted from its heading context
  cannot be accepted or proposed. The legacy recipe path gets all of them.
- **The last entry of an excerpt ends `beyond_scope`.** Entry 43 is followed
  only by a page header, and discovery says it may continue past the
  offered text, so `completeness.boundaries` is false on `continuations`.
- **Dense windows overflow the discovery reply.** Windows are packed to the
  input ceiling (28,672 tokens at a 32,768 served context), but a dense
  catalogue's boundary list does not fit the 4,096-token reply reserve, so
  the window is cut off and halved; each attempt costs minutes at the
  Spark's ~7.8 generated tokens/s, and discovery calls run one at a time.
- **Nested numbered lists are split inconsistently.** In `big`, 51 of 200
  one-item find lists (`1. Scherben.`) became entries of their own; the
  same line shape stayed inside its record elsewhere.

## Remaining release gates

- **1.4 / 6.2** — no independent labelled document families or registered
  thresholds exist in this repository; the German numbered catalogue is a
  regression fixture only. The manifest is drafted, not frozen.
- **5.5** — in a browser: untouched defaults, custom controls, invalid values
  by keyboard, migration through Customize, Discard and service defaults, and
  360 px to 1,280 px layouts. Not in a browser: old results, failed windows,
  lost-response replay and single/batch parity, because the TypeScript kei
  stand-in cannot yet answer with version-3 artifacts. They are covered by
  jsdom (start payloads, review panel), PostgreSQL (replay, batch pins) and
  Python tests instead.
- **6.3** — deterministic part done (field renames, non-Latin labels, recipe
  import check); held-out perturbations need the corpus.
- **6.4** — the gate stays off; no legacy drain was inventoried.
- **6.5** — legacy executors, the recipe picker and recipe imports remain until
  admitted legacy work is drained.
- **6.6** — the ADR and spec sync/archive wait for the evaluation.
