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
this worktree's `src`; PostgreSQL tiers used new databases
`free_test_unify_extraction` and `free_test_unify_parsing` on the loopback test
server (nothing else on it was touched); browser tiers used their own Compose
projects and ports.

| Command | Result |
| --- | --- |
| Parsing Service fast tier (`pytest -m "not postgres and not live_model"`) | 1,154 passed, 72 skipped (baseline 1,102); includes 46 unified, 4 legacy golden/clipping tests |
| Parsing Service PostgreSQL tier (`-m "postgres and not live_model"`, worker recovery included) | 58 passed |
| `pnpm --filter extraction test` | 123/123 |
| `pnpm --filter extraction test:postgres` | 85/85, including 5 gated unified admission cases |
| Studio `vitest` (full) | 1,678/1,682 before the last Studio additions; the 4 failures were `_pdf_pages` worker timeouts that pass alone (8/8); every changed suite passes |
| `pnpm typecheck`, `pnpm lint` | pass; 2 pre-existing hook warnings in `useExtraction.ts` |
| `pnpm test:safety` | 19/19 |
| Playwright, gate off (default config) | 64 passed, 3 skipped (the gated spec), 1 mock-OIDC sign-in failure that passes on rerun (6/6) |
| Playwright, `FREE_CATALOG_METHOD=unified`, `e2e/unified-catalog.spec.ts` | 3/3: Catalog group, keyboard issue focus, migration kept until Apply and replaced by it, 360 px and required viewports |

Not run: the recovery Playwright config, `test:live-model`, `test:system`, and
any live-model extraction; the real-service tier is reported in the final
report.

## Remaining release gates

- **1.4 / 6.2** — no independent labelled document families or registered
  thresholds exist in this repository; the German numbered catalogue is a
  regression fixture only. The manifest is drafted, not frozen.
- **6.3** — deterministic part done (field renames, non-Latin labels, recipe
  import check); held-out perturbations need the corpus.
- **6.4** — the gate stays off; no legacy drain was inventoried.
- **6.5** — legacy executors, the recipe picker and recipe imports remain until
  admitted legacy work is drained.
- **6.6** — the ADR and spec sync/archive wait for the evaluation.
