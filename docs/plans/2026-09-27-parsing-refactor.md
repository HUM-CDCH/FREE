# Parsing and extraction refactor — 2026-09-27

Status: slices 1–2 committed as `87f26533`, slice 3 as `87671d42`; slice 4 committed after it, awaiting review.
Base: `377cd050`.
Branch: `refactor/segmentation-dependency`; isolated from running ablation jobs.

## Direction and invariants

Keep existing packages. Establish one-way dependencies, then expose replaceable
experimental components and split mixed responsibilities. Preserve canonical
identities, serialized results, fingerprints, transaction guarantees and frozen
study inputs. Detail only the next coherent change.

## Slice 1: segmentation dependency cycle

The artifact module imports the segmenter inside `obtain()`, while the segmenter
imports its artifact types and sealing helpers. Move the load/reuse/compute/publish
operation to `kie/segmentation_run.py`; migrate extraction and test callers.
The artifact reader retains validation and publication; the segmenter stays pure.
No old import facade, new dependency, workflow change or algorithm change.

Acceptance:
- [x] Baseline: 150 focused tests passed; 9 infrastructure tests deselected.
- [x] New dependency guard fails against the original function-local import.
- [x] Move the operation and migrate every source/test caller.
- [x] Verify 20 fixture artifacts are byte-identical, including fingerprints/digests.
- [x] Focused and full fast Parsing Service tests pass; local import cycle is gone.
- [x] Inspect the complete diff and run the bloat audit.

## Slice 2: shared canonical passage view

Layout, routing, segmentation and boundary scoring imported `Evidence`/`Passage`
from `kie/extract/evidence.py`, so the recipe path depended on extraction. Move
that module unchanged (docstring aside) to `kie/passages.py`, which imports only
`kei_exp.pagefile`, and migrate every source, test and experiment caller. Names
and behaviour are kept; `kie/evidence.py` remains the separate ingest-bound
`Segment` projection. The old path is removed; no facade.

Acceptance:
- [x] Baseline: evidence `repr`, `text_of` and segmentation bytes for all 20 fixtures.
- [x] Guard: the passage view imports no `kei_exp.kie` module; segmentation,
      its runner, boundaries and `kie/stages/*` import no `kei_exp.kie.extract`.
      Nested and relative imports count; it fails on the pre-slice sources.
- [x] All callers migrated; the old module path no longer imports.
- [x] Identical snapshots; focused and full fast tests pass; no local cycles.

## Task 3 (slice 3): grounding as an interchangeable technique

Grounding for the version 1 Catalog and Article paths lives inside the
`stages.py` grab-bag (`verify` and its private helpers, lines ~384-561, plus
the `GROUNDING`/`QUOTED_GROUNDING`/`_GROUNDING_RULES`/`NONE` prompts), and
`run.extract` chooses among its variants with inline conditionals
(`method.grounding == "off"` empties the groups; `quoted=method.grounding ==
"quoted"` is passed as a flag). Adding a grounding arm means editing the
orchestrator. The recipe Catalog's `grounded._verify` is a different technique
over `BlockText` and is out of scope.

Change:
- Move `verify`, `_Candidate`, `_grounding_evidence`, `_candidates`, `_hits`,
  `_siblings`, `_link` and the grounding prompts, unchanged, from
  `kie/extract/stages.py` to a new `kie/extract/grounding.py`. Shared value
  helpers (`leaves`, `normal`, `_text`, `contains`) and `Call`/`Link`/`Issue`/
  `_complete` stay in `stages.py` this slice; `grounding.py` imports them.
- In `grounding.py`, express the three existing choices as ordinary functions
  with one shared call shape: semantic (today's `verify`, `quoted=False`),
  quoted (`quoted=True`), and off (no calls, no links, no issues). One lookup
  function maps the `ArticleOptions.grounding` literal (and `None`, meaning
  the production reference, i.e. semantic) to its function. No registry
  class, plugin loader, entry points or configuration.
- `run.extract` obtains the grounding function once through that lookup and
  calls it for every verification group. It no longer branches on
  `method.grounding` for control flow; the artifact's
  `completion.grounding` label may still read the option it reports.
- Migrate every caller (source, tests, experiments, docs that name the old
  location). Remove the old names from `stages.py`; no re-export facade.

Invariants: prompts, reply schemas, batching, budget arithmetic, call order,
`before_call` placement, the lexical shortcut, `proofs` and every artifact
byte (fingerprint included; `started`/`seconds` excepted) are unchanged.
`PROMPT_VERSION`, `EXTRACTION_VERSION`, method serialization and experiment
manifests are unchanged. Frozen study registrations are not edited.

Acceptance:
- [x] Baseline before any edit: a throwaway script (outside the repo, e.g.
      under `/tmp`) runs `run.extract` with deterministic fake chats/counters
      over test fixtures for: version 1 Catalog, Article reference
      (`method=None`), Article with `grounding` = semantic, quoted and off
      (bounded contexts where the options require them), and a recipe
      Catalog; it writes canonical JSON of each artifact minus
      `started`/`seconds`. The same script after the change produces
      byte-identical files.
- [x] A focused test proves the seam: substituting a different grounding
      function through the lookup's result changes grounding output without
      editing `run.py` (e.g. monkeypatching the lookup to a recording fake,
      asserting it received each verification group once per record).
- [x] `stages.py` no longer defines the moved names;
      `kei_exp.kie.extract.stages.verify` raises `AttributeError`/ImportError.
- [x] Focused tests (stages, article, methods, structure fixes, table cells,
      workflow, selection replay, study) and the full fast suite pass.
- [x] Record the verification receipt in this file.

## Task 4 (slice 4): one call shape for the three extraction implementations

After slice 3, `run.extract` (≈`run.py:132-270`) still interleaves the
version 1 Catalog and Article implementations (`article = options.strategy ==
"article"` then ~10 `if article` / `method is not None` branches), duplicates
the per-role counter setup with `_grounded` (`run.py:~149-151` and
`~279-281`), and holds the recipe Catalog's wrapper `_grounded`. Reading
Article means reading past both Catalog paths; `run.py` has the highest churn
in the package (17 commits since 09-01).

Destination (one-way imports: `run` → implementations → shared record
assembly → `grounding`/`stages`):
- Three implementation functions with one shared call shape, each in its
  strategy's module: the recipe Catalog (today's `_grounded`) in
  `grounded.py`; Article in `article.py`; the version 1 Catalog in a new
  `kie/extract/catalog.py`, which also receives `discover` and the helpers
  and prompts only discovery uses (`DISCOVERY`, `DISCOVERY_EXAMPLES`,
  `_chunks`, `_page_size`, `_numbering_issues`, `_index`, `_NUMBERED` — move
  each only if nothing else uses it) from `stages.py`. The shape takes the
  already-loaded evidence (tests can call an implementation without patching
  `run.load`) and returns the finished artifact dict.
- What Article and the version 1 Catalog share today (document-value
  extraction over contexts, grounding each record through
  `grounding.technique`, `merge`, the common artifact fields) moves to one
  shared lower module; neither implementation imports `run.py`. Anything an
  implementation needs from `run.py` today (versions, `fingerprint`,
  `_total`, request types) moves down or is supplied by the orchestrator —
  implementer's choice, recorded in the report — without a re-export facade.
- The per-role counter setup exists once (e.g. in `tokens.py`), used by both
  Article and the recipe Catalog.
- `run.extract` keeps: `load`, the stale-generation check, `as_router`,
  choosing the implementation from the options, and nothing
  strategy-specific. Its signature, `StaleGeneration`, `Options`,
  `ExtractRequest`, `publish_extraction` and `main` keep their current
  import path (`kei_exp.kie.extract.run`) for the workflow, CLI and
  experiments.
- Extend the import guard (`tests/test_segmentation_dependencies.py` or a
  sibling test) so no module under `kie/extract` other than `run` imports
  `kei_exp.kie.extract.run`.

Invariants: exactly as Task 3 — prompts, reply schemas, call order,
`before_entry`/`before_call` placement, every artifact byte and fingerprint
(`started`/`seconds` excepted), `PROMPT_VERSION`, `EXTRACTION_VERSION`,
options serialization, frozen experiment registrations. No new behaviour, no
plugin framework (plain functions; choosing the implementation is a plain
conditional or dict in `run.extract`).

Acceptance:
- [x] Before any source edit, rerun `/tmp/free-grounding-slice/snapshot.py`
      into a fresh baseline directory (it covers version 1 Catalog incl.
      budget splitting, Article reference/semantic/quoted/off with bounded
      contexts, and recipe Catalog, and logs call/check order). Extend it,
      if needed, to also cover the published file bytes via
      `publish_extraction` and an Article case with document-level fields
      and multiple contexts. After the change the outputs are byte-identical.
- [x] `run.py` contains no `if article`, no `method.` access and no counter
      construction; `grep -n "article\|method" run.py` shows only imports,
      request types, the dispatch and `fingerprint`.
- [x] Each implementation is exercised by at least one test that calls it
      directly with in-memory evidence (no `monkeypatch` of `run.load`).
- [x] Import guard extended and failing on a probe that imports `run` from
      an implementation module.
- [x] Focused and full fast suites pass; record the receipt here.

Controller addendum (Task 4): PostgreSQL tier `tests/test_lanes.py` +
`tests/test_delete_runs.py` → 34 passed; recovery/boot tier
`tests/test_worker_recovery.py` + `tests/test_worker_boot.py` → 26 passed
(disposable `free-m1-pg`, database `free_test_parsing`). The snapshot at the
base commit equals the snapshot after (51 files).

## Task 5 (slice 5): split `grounded.py` around its pure clusters

`grounded.py` (873 lines) holds the recipe Catalog implementation, its
prompts and run state, and three clusters that need no model: candidate
acceptance (does a candidate's quote, value and field binding pass —
`_Outcome`, `_typed`, `_verify`, `_scalar`, `_after_keys`, `_bounded`,
`KEY_GAP`, and the candidate reply schemas `_candidates_schema`, `_leaf`,
`_candidate_schema`), windowing of oversized blocks (`_Unit`, `_units`,
`_windows`, `_cut`), and result shaping (`_spans`, `_raw`, `_expansions`,
`_normalized`, `_link`, `_item`, `_place`, `_record`,
`NORMALIZATION_VERSION`). Tests reach these through private names
(`test_extract_llm` → `_candidate_schema`, `test_extract_grounded` →
`_Unit`, `test_table_cells` → `_Outcome`/`_link`, `test_catalog_chunks` →
`_pieces`).

Change (within `kie/extract`, no package moves):
- Move the three clusters, unchanged in logic, into three modules named for
  what they decide (suggested: `acceptance.py`, `windows.py`,
  `catalog_result.py`; pick clearer names if the code suggests them).
  Names used across modules lose their leading underscore; names used only
  inside their new module keep it.
- `grounded.py` keeps: versions, prompts, `CatalogOptions`, `Counter`,
  bindings, `_Run` and the budgeted call, the recipe implementation
  `extract`, `extract_grounded`, `fingerprint`, chunked execution
  (`_pieces`, `_in_chunks`), per-block orchestration (`_block`, `_fitted`,
  `_label`, `_context`), merge/arbitration (`_merge`, `_arbitrate`, which
  call the model) and `_document`.
- One-way imports: `grounded` → the three new modules; none of them imports
  `grounded`, `run` or `assembly`. Extend the import guard accordingly.
- Migrate tests to the new public names; no facade in `grounded.py`.

Invariants: as Tasks 3–4 — every artifact byte and fingerprint, prompts,
reply schemas, call order, `before_entry` placement, `EXTRACTION_VERSION = 2`,
`PROMPT_VERSION = 5`, `BUDGET_VERSION`, `NORMALIZATION_VERSION` unchanged.

Acceptance:
- [x] Before any source edit: copy `/tmp/free-strategy-slice/snapshot.py` to
      `/tmp/free-grounded-slice/`, extend it with recipe Catalog cases that
      exercise each `CatalogFactors` flag off (glossary, headings, overlap,
      verification), an oversized block that is windowed, `chunks=2`, and
      replies that produce accepted, proposed and rejected values plus an
      arbitration call; capture the baseline. After: byte-identical.
- [ ] `grounded.py` is at most ~500 lines; each new module has a prose
      docstring stating what it decides, in the style of its neighbours.
      (Docstrings done. Size not met: 582 lines, which is what the keep-list
      above assigns to `grounded.py`; see the receipt.)
- [x] At least one new focused test per new module exercises it through its
      public names without a chat (acceptance over a `BlockText`; windows
      over units with a `fits` predicate; result shaping over outcomes).
- [x] Import guard extended; focused and full fast suites pass.

Verification receipt (Task 5): `grounded.py` 873 → 582 lines, beside
`acceptance.py` (188: `Outcome`, `KEY_GAP`, `typed_value`, `assess` — was
`_verify`, whose own `verify=` keyword would shadow a bare `verify` —,
`bounded`, `candidates_schema`, `candidate_schema`; private `_scalar`,
`_after_keys`, `_leaf`), `windows.py` (81: `Unit`, `units_of`, `windows_of`,
private `_cut`; `windows_of` takes `overlap: bool` in place of the run, read
from the same factor at the call site) and `catalog_result.py` (100:
`NORMALIZATION_VERSION`, `place`, `conformed_record`, `spans_json`,
`glossary_expansions`, `evidence_link`, `review_item`; private `_raw`,
`_normalized`). Plain underscore-less names were avoided where they would
collide with a local of the same name (`units`, `windows`, `record`,
`expansions` and `typed` in `grounded.py`, `spans` in `evidence_link`). Snapshot
`/tmp/free-grounded-slice/snapshot.py`: task 4's 17 cases plus 25 recipe
Catalog cases and a direct table-cell link, 127 files, identical before and
after (`diff -r` empty). Import guard
`test_the_recipe_catalogs_model_free_modules_do_not_import_what_runs_it`
fails on a probe importing `grounded`, `run` or `assembly` from each new
module. New `tests/test_recipe_catalog_modules.py` (6 tests). Full fast
suite: 1094 passed, 72 skipped, 74 deselected (base 1087 + 7 new).
Everything left in `grounded.py` is on the keep-list (versions and prompts,
bindings, `_Run`, chunking, `_block`/`_fitted`/`_label`/`_context`, merge
and arbitration, `_document`); reaching ~500 lines would mean moving one of
those groups, which this slice leaves alone.

## Task 6 (slice 6): Article techniques read from one resolved choice

After slice 4 every Article technique choice lives in `kie/extract/article.py`,
but behaviour code tests `method is not None and method.X == …` about fifteen
times (`article.py` ~65-158, 173, 201-203, 233, 269-271), because
`options.article is None` means "the production reference". The reference is
exactly `ArticleOptions()`'s defaults (full context, reference identity and
prompt, semantic grounding, no selection/rendering/grouping), so the `None`
guards only restate the defaults. `None` matters in exactly one place: whether
the artifact carries the method-only fields (`method_version`, `contexts`,
`value_contexts`, `quoted_support`, versions, `selections`, `conflicts`,
`completion`) and the fingerprint's method versions.

Change:
- `kie/extract/method.py` gains `REFERENCE = ArticleOptions()` (frozen, the
  production reference choices) and a shared alias for the grounding choice
  literal; `ArticleOptions.grounding` and `grounding.technique` both use that
  alias (resolves Task 3's deferred minor on the duplicated literal).
- Article's technique functions (`extract_records`, `inventory_request`,
  `source_contexts`, `inventory`, `reconcile_identities`, `identity_key`, and
  any other in `article.py` taking `method`) take `method: ArticleOptions =
  REFERENCE`; their bodies read `method.X` directly with no `None` guard.
- `article.extract` resolves `options.article or REFERENCE` once and passes
  it everywhere; it keeps `options.article is None` only to decide the
  method-only artifact fields (and `assembly.fingerprint` keeps its own
  `request.options.article is not None` tests unchanged).
- Callers keep working unchanged: `experiments/extraction/study.py` (frozen,
  passes a real `ArticleOptions`) and tests that omit `method`.

Invariants: as Tasks 3–5 — every artifact byte and fingerprint, prompts, reply
schemas, call order, `PROMPT_VERSION`, options serialization (the
`ArticleOptions` serializer and `Options.dumped()` are untouched), frozen
experiment files untouched.

Acceptance:
- [x] Before any source edit: rerun `/tmp/free-strategy-slice/snapshot.py`
      (it covers Article reference with `method=None` and every option arm the
      brief touches) into `/tmp/free-article-slice/baseline`; after the change
      the outputs are byte-identical. If an option arm (identity
      conservative, prompt schema, selection, grouping, rendering structured,
      overlap) is not covered, extend a copy of the harness under
      `/tmp/free-article-slice/` first.
- [x] `grep -n "method is not None\|method is None" article.py` shows only the
      artifact-field decision in `extract`. (It shows nothing: the decision
      reads `options.article is not None`, the unresolved option itself.)
- [x] Focused (article, methods, selection, rendering, grounding,
      implementations, study, selection replay) and full fast suites pass.

Verification receipt (Task 6): `method.py` gains `GroundingChoice` (the
grounding literal, now shared by `ArticleOptions.grounding` and
`grounding.technique`, which keeps `| None` for Catalog's `choice=None`) and
`REFERENCE = ArticleOptions()`. `article.extract` resolves `method =
options.article or REFERENCE` once; `options.article is not None` alone
decides the method-only artifact fields; `assembly.fingerprint` is untouched.
Twelve guards removed in `article.py` (bounded counters/contexts, document
rendering, grounding choice, record rendering, prompt, bounded record
contexts, selection, inventory identity, inventory rendering, inventory
prompt, inventory output tokens, inventory identity key). `extract_records`,
`inventory_request`, `inventory`, `identity_key` and `reconcile_identities`
default `method` to `REFERENCE`; `source_contexts` keeps `method` required
(positional between `schema` and `counter`, as `study.py` calls it) and gains
annotations. Snapshot: copy `/tmp/free-article-slice/snapshot.py` = the
strategy-slice harness's 17 cases plus 12 Article arms taken one at a time
(conservative identity complete and partial, full and bounded; schema prompt,
structured rendering, full and bounded; selection; grouping; overlap 1;
overlap 2 with grouping), 87 files, baseline captured twice (stable) before
any edit, identical after (`diff -r` empty); the original harness's 51 files
also match. Focused suites (article, methods, selection, rendering,
grounding, grounded, implementations, study, selection replay): 98 passed.
Full fast suite: 1094 passed, 72 skipped, 74 deselected. `experiments/`
untouched; ruff findings on the three files unchanged from base (import order
and B023 in `extract_records`, pre-existing).

Controller ruling (Task 6): `source_contexts` keeps `method` required. The
brief also requires the frozen `study.py` positional call to keep working, and a
default before `counter`/`check` would force a parameter reorder.

## Task 7 (slice 7): light modules stop loading the OCR stack

Measured at `c40c6413`: `import kei_exp.transcription.types` loads docling,
torch, transformers and cv2 (≈3,300 modules, 1.7 s); `import kei_exp.api` and
`import kei_exp.workflows.extract` do the same, while `import
kei_exp.kie.extract.run` loads 414 modules in 0.1 s. Two edges cause it:
- Crop data lives inside the layout detector: `Region`, `Crop`,
  `region_info`, `DEFAULT_LAYOUT_MODEL` and `LAYOUT_MODELS` are defined in
  `cut.py`, which imports Docling at module level. `transcription/types.py`,
  `result.py`, `api.py`, `workflows/convert.py` and every transcription
  adapter import them from there.
- Transcriber metadata is reached through the live registry:
  `api.py` imports `kie.stages.ocr.TRANSCRIBERS` (which constructs
  `DoclingVlm()`, `SuryaOcr()`, `NativeText()` at import) only to read
  `.knobs`; the knobs themselves are class attributes of the adapters
  (`transcription/vlm.py` `KNOBS`, `surya.py:~283`, `native.py:~217`).

Change (inside `kei_exp`, no package moves):
- A new data-only module `kei_exp/regions.py` owns `Region`, `Crop`,
  `region_info`, `DEFAULT_LAYOUT_MODEL` and `LAYOUT_MODELS`; `cut.py` imports
  them from it and keeps the detector, `CutError`, `png_stream` and the cut
  itself. Every caller that needs only the data imports from `regions`; no
  re-export from `cut`.
- `transcription/types.py` owns one kind → knobs table; each adapter's
  `knobs` class attribute reads its row. `api.py` reads the table instead of
  `TRANSCRIBERS`. `kie/stages/ocr.py`'s registry and checks keep working (the
  worker needs the adapters anyway).
- No new function-local ("lazy") imports to dodge a dependency; move data
  instead. If another edge still pulls a heavy package into `api` or
  `transcription.types` after these two moves, report it rather than hiding
  it.

Invariants: conversion results, page files, manifests, reports and hashes
unchanged (`region_info` output, `LAYOUT_MODELS` order and values); the API's
model listing response unchanged (knobs sorted as today); `ocr.TRANSCRIBERS`
keys and each adapter's `knobs` unchanged.

Acceptance:
- [ ] A fast test imports, each in a fresh subprocess, `kei_exp.api`,
      `kei_exp.transcription.types`, `kei_exp.result` and `kei_exp.regions`,
      and asserts none of `docling`, `torch`, `transformers`, `cv2` is in
      `sys.modules`. It fails at the base commit.
- [ ] A fast test asserts each registered transcriber's `knobs` equals the
      table's row for its kind, and the table has no extra kinds.
- [ ] The import guard forbids `kei_exp.regions` and
      `kei_exp.transcription.types` from importing `kei_exp.cut` or
      `kei_exp.kie.stages`.
- [ ] Focused (cut, convert, native, surya/vlm fakes, api, models,
      ingestion models, convert workflow, result, report) and full fast
      suites pass; record import timings before/after in the receipt.

## Next candidates, reassessed after this slice

1. One budgeted-call module (`stages._complete`, `grounded._Run.call`,
   `LimitedCounter`) with the budget policy as its variant.
2. TypeScript `packages/extraction`: workflow toolkit + one owner for the
   `extract:<id>` workflow ID; pure review rules; persistence split.
3. `kie/model.py` split by consumer group; runner generation cache.
