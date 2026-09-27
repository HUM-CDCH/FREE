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
      `sys.modules`. It fails at the base commit. (The test exists and fails
      at base; `regions` and `transcription.types` pass. Not met for `api`
      and `result`: they pass only with two further, named edges
      (`kei_exp.models` and the PDFium lock) stood in; see the receipt.)
- [x] A fast test asserts each registered transcriber's `knobs` equals the
      table's row for its kind, and the table has no extra kinds.
- [x] The import guard forbids `kei_exp.regions` and
      `kei_exp.transcription.types` from importing `kei_exp.cut` or
      `kei_exp.kie.stages`.
- [x] Focused (cut, convert, native, surya/vlm fakes, api, models,
      ingestion models, convert workflow, result, report) and full fast
      suites pass; record import timings before/after in the receipt.

Verification receipt (Task 7): new `kei_exp/regions.py` (40 lines, imports
only `PIL.Image` and `kei_exp.geometry`) owns `Region`, `Crop`,
`region_info`, `DEFAULT_LAYOUT_MODEL` and `LAYOUT_MODELS`, moved verbatim;
`cut.py` imports them and keeps the detector, `CutError`, `png_stream`,
`find_regions`, `cut_pages` and `whole_pages`, with no re-export. Callers
migrated: `transcription/{types,native,surya,vlm}.py` (vlm keeps `png_stream`
from `cut`), `result.py`, `api.py`, `workflows/convert.py`,
`kie/stages/ocr.py` (`Crop` only), `tests/helpers/{fake,replay,synthetic}.py`,
`test_cut.py`, `test_convert.py`, `test_convert_workflow.py`,
`test_ingestion_models.py`; comments in `pagefile.py` and
`workflows/contracts.py`. `transcription/types.py` gains `TRANSCRIBER_KNOBS`
(vlm, surya, native); each adapter's `knobs = TRANSCRIBER_KNOBS[kind]`, and
`vlm.KNOBS` is gone. `api.list_models` reads the table and no longer imports
`kie.stages.ocr`; `ocr.TRANSCRIBERS` and `check_knobs` are unchanged.
`experiments/` untouched. Import timings (cold, fresh process, same venv;
seconds / modules loaded / heavy packages present):

| module | before (`7121e8dd`) | after |
|---|---|---|
| `kei_exp.transcription.types` | 1.67 s / 3300 / all four | 0.06 s / 253 / none |
| `kei_exp.regions` | (absent) | 0.06 s / 231 / none |
| `kei_exp.result` | 1.67 s / 3302 / all four | 1.35 s / 2380 / all four |
| `kei_exp.api` | 1.71 s / 3432 / all four | 1.40 s / 2575 / all four |
| `kei_exp.workflows.extract` | 1.84 s / 3626 / all four | 0.33 s / 920 / none |
| `kei_exp.models` | 1.24 s / 2336 / all four | unchanged |
| `kei_exp.kie.extract.run` | 0.11 s / 414 / none | unchanged |

Remaining edges, reported rather than hidden: `kei_exp.models` imports
`docling.datamodel.pipeline_options_vlm_model` (and `stage_model_specs`) to
build its records' `VlmModelSpec`s, and that module alone loads torch,
transformers and cv2; `api` and `result` name `MODELS`. With `kei_exp.models`
stubbed, `api` loads none of the four (618 modules) and `result` loads only
the `docling` package root, through `kei_exp.pages` → `kei_exp._pdfium`,
whose PDFium lock is `docling.utils.locks`. Removing either is a design
change to the model records or the lock, not a data move, so
`test_light_modules_load_the_ocr_stack_only_through_accepted_edges` names
them as each module's accepted edges (see the fix round below). API listing (`/api/models` and
`/api/ingestion-models`, server probe stubbed) captured before and after to
`/tmp/free-layering-slice/`: byte-identical (sha256 `04f66712…`). Focused
suites (cut, convert, native, streaming, replay, api reads, models, ingestion
models, convert workflow, result, report, evidence, pages, guard): 218 passed,
64 skipped (base 212 passed, 64 skipped). Full fast suite: 1100 passed,
72 skipped, 74 deselected (base 1094 + 6 new). Ruff findings on the touched
files unchanged from base (`native.py` import order, pre-existing).

Fix round 1 (Task 7): the first version marked the `api` and `result` import
cases as strict xfails over the whole test, which would also have accepted an
import error or a failed subprocess. They have no expected-failure mark now.
Each case runs a fresh interpreter with the module's accepted edges
(`kei_exp.models` for both; `kei_exp._pdfium` for `result`) replaced by
`MagicMock` stand-ins and asserts none of the four packages loads. That
catches any third edge. A second probe without stand-ins asserts the module
still imports each edge and each edge alone still loads some of the stack, so
an edge that goes away must be dropped from the list. Import failures fail
with the child's stderr. At base all four cases fail: `regions` because it
cannot be imported, the other three on the heavy-package assertion. Two probes against the fix were
reverted: `import kei_exp.cut` added to `api.py` fails with "loads [...]
beyond its accepted edges"; a raised `ImportError` fails with the traceback.

Fix round 2 (Task 7): the stand-ins changed how the importers ran. A
module-level loop over a mocked `MODELS` iterates nothing, so a heavy import
inside it went unseen. The probe now makes one real import of the target in a
fresh interpreter, with no substitution. A hook on `builtins.__import__` and
`importlib.import_module` sees every import, including packages already
loaded. It attributes each import of docling, torch, transformers or cv2 to
the nearest `kei_exp` module on the stack. The recorded importers must be
exactly the accepted edges: none for `regions` and `transcription.types`,
which must also leave the four packages unloaded; `kei_exp.models` for `api`;
`kei_exp.models` and `kei_exp._pdfium` for `result`. Probes, all reverted:
- At base, `regions` fails as not importable; `types`, `result` and `api`
  each fail naming the `kei_exp.cut` edges.
- `import kei_exp.cut` added to `api.py` fails, naming `kei_exp.cut`.
- `import torch` inside a module-level loop over `MODELS.values()`, added to
  `runtime.py`, fails with `('kei_exp.runtime', 'torch')`, although torch was
  already loaded.

## Task 8 (slice 8): the shared workflow toolkit leaves `runExtraction`'s module

TypeScript, `packages/extraction` (+ its Studio consumers). Studio's
ingestion, reprocessing, garbage-collection, suggestion and schema-edit
workflows import `WorkflowSteps`, `dbosSteps`, `ARTIFACT_READ_RETRY`,
`isWorkflowCancellation` and `keiRunOf` from `extraction/workflows`, the
module that defines `runExtraction` and therefore imports `kei-artifact`,
`schema` and `parsed-document`. Separately, the Studio workflow ID
`extract:<extractionId>` is written by hand in production code at
`packages/extraction/src/postgres-persistence.ts:69`,
`packages/extraction/src/testing/dbos-test-app.ts:66`,
`prototypes/studio/api/_extractions.ts:42`,
`prototypes/studio/api/_scope_cancellation.ts:41` (prefix test + slice) and
`prototypes/studio/api/_garbage_plan.ts:37,58` (prefix list + rebuild).

Change (no logic moves between packages):
- New module `packages/extraction/src/workflow-steps.ts` owns
  `WorkflowSteps`, `dbosSteps`, `ARTIFACT_READ_RETRY` and
  `isWorkflowCancellation`, exported as `extraction/workflow-steps` in
  `packages/extraction/package.json`. It imports only the DBOS SDK.
- `keiRunOf` (and the `KEI_PREPROCESS` pattern it uses) moves to
  `kei-handoff.ts`, which already owns the kei run-id rules and
  `keiExtractWorkflowId`.
- `kei-handoff.ts` also gains the one owner of Studio's extraction workflow
  ID: the prefix constant, `extractWorkflowId(extractionId)` and its inverse
  (`extractionIdOfWorkflow(workflowId): string | null` or similar, named to
  read well at the call sites). Every production site listed above uses them.
  Tests keep literal `extract:` strings where they pin the format.
- `workflows.ts` keeps `runExtraction` and its own types and imports the
  toolkit from `workflow-steps.ts`; no re-export of moved names from
  `workflows.ts`. Studio imports migrate to `extraction/workflow-steps` /
  `extraction/kei-handoff`.
- `packages/db/src/project-store.ts:1182,1284` keep their literal
  `extract:` strings: `db` sits below `extraction` and cannot import it.
  Add a one-line comment at each naming the owner
  (`extraction/kei-handoff` `extractWorkflowId`).

Invariants: workflow IDs, queue names, step names/configs, retry settings,
DBOS registration and every workflow's step sequence unchanged (no
`DBOS.patch()` needed because nothing about steps changes). Studio's
`STUDIO_WORKFLOW_PREFIXES` value unchanged.

Acceptance:
- [x] `grep -rn "extract:" --include=*.ts packages/extraction/src
      prototypes/studio/api prototypes/studio/server` finds literal
      `extract:` only in tests, comments and the owner in `kei-handoff.ts`.
- [x] No Studio module imports `extraction/workflows` except for
      `runExtraction`-specific names; `workflow-steps.ts` imports nothing
      from the package.
- [x] A focused test pins `extractWorkflowId` / its inverse round trip and
      rejects non-extraction IDs (`kei-extract:…`, `suggest:…`).
- [x] `tsc --noEmit` in `packages/extraction` and `tsc -b` in
      `prototypes/studio` pass; extraction's fast tests
      (`packages/extraction` `test` script's file list) and Studio's vitest
      files for the touched modules pass.

Verification receipt (Task 8): new `packages/extraction/src/workflow-steps.ts`
(22 lines, imports only `@dbos-inc/dbos-sdk`) owns `WorkflowSteps`,
`dbosSteps`, `ARTIFACT_READ_RETRY` and `isWorkflowCancellation`, moved
verbatim and exported as `extraction/workflow-steps`; `index.ts` re-exports
`dbosSteps` from it. `keiRunOf` and `KEI_PREPROCESS` moved verbatim to
`kei-handoff.ts`, with their test (now in `kei-handoff.test.ts`).
`kei-handoff.ts` gains `STUDIO_EXTRACT_PREFIX`, `extractWorkflowId` and
`extractionIdOfWorkflow` (`/^extract:([^:]+)$/`, the rule `_garbage_plan.ts`
already used). `workflows.ts` imports both and re-exports neither. Call sites:
`postgres-persistence.ts` (its private `extractWorkflowId` removed),
`testing/dbos-test-app.ts`, Studio `_extractions.ts`, `_scope_cancellation.ts`,
`_garbage_plan.ts` (prefix list, `keiParentOf`, `rowGone`, `settled`,
`scopeIdsOf`) and `_garbage_workflow.ts` (`workflow_id_prefix`, not in the
list above but a production literal). Eleven Studio files moved their import
to `extraction/workflow-steps`; no Studio file imports `extraction/workflows`.
`packages/db/src/project-store.ts` keeps its two literals, each with an owner
comment. One edge: `_scope_cancellation.ts` used `startsWith('extract:')`, so
`extract:` or `extract:a:b` would have cancelled a `kei-extract:` child; the
owner's stricter rule skips those IDs, which Studio never writes. Checks:
extraction `tsc --noEmit` and Studio `tsc -b` clean; extraction fast tests
73 pass (base 72, +1 round-trip test); Studio vitest for the nine touched
modules' test files 100 pass (base 100).

Controller addendum (Task 8): extraction `tsc --noEmit` passes; extraction
PostgreSQL tier (`extraction-module.integration.test.ts` +
`kei-handoff.postgres.test.ts`) 56/56 on disposable
`free_test_refactor_extraction` (migrated with `prisma-next migrate`).

## Task 9 (slice 9): Review Decision rules in one pure module

`packages/extraction`. Deciding whether submitted Review Decisions are valid
for an Extraction is split across two files and partly repeated:
- `module.ts` `finalizeReview` (~44-131) checks, against a read snapshot,
  reviewability, the pinned document and schema, the grounding coverage
  invariant (evidence ∪ ungrounded paths = populated reviewable paths, no
  overlap, no duplicates), and that the decisions match the evidence links
  one to one and the schema (`reviewDecisionMatchesSchema` ~210-233,
  `occurrenceOwnership` ~204, `extractionRecords` ~200, `parsePinnedSchema`).
- `postgres-persistence.ts` `finalizeReview` (~1241-1322) re-checks inside
  its transaction, against the locked row, with `normalizeDecisions` (~896)
  and `reviewAuthorityMatchesExtraction` (~907-957), which repeat the
  action/value rule and the evidence-path matching and add occurrence
  ownership. `ReviewAuthority` (`dependencies.ts:51`) ferries
  `occurrenceIdsByAnchor` and `evidenceResultPathKeys` from one to the other.
- `postgres-persistence.ts` also builds the domain module
  (`createExtractions`, ~1608, importing `createExtractionModule` from
  `module.ts`), so the Postgres adapter imports the module it sits behind.

Change (inside `packages/extraction`):
- A new pure module (suggested `review-rules.ts`) owns every rule above:
  the snapshot-side validation that returns either the review authority or
  the exact `ExtractionError` code/message it fails with, and the
  in-transaction revalidation (`normalizeDecisions`,
  `reviewAuthorityMatchesExtraction`, the action/value rule shared by both
  sides instead of written twice). It imports no persistence, DBOS or
  database module.
- `module.ts` `finalizeReview` keeps the reads and the calls to
  `persistence.finalizeReview`, and delegates every rule to the pure module.
- `postgres-persistence.ts` keeps the transaction, the claim, the digest and
  the writes; it calls the pure revalidation. **The in-transaction
  revalidation stays** — it is what makes the check hold against the locked
  row; only its code moves.
- `createExtractions` moves to its own small composition module (suggested
  `extractions.ts`); `index.ts` re-exports it from there under the same
  public name (the package's public interface is unchanged).
  `postgres-persistence.ts` no longer imports `module.ts`.

Invariants: every `ExtractionError` code and message and the ORDER of checks
(the first failing check decides the message) unchanged; `finalizeReview`
dispositions (`reviewed`/`replayed`/`conflict`/`invalid`/`not-found`),
the decision digest (`JSON.stringify(normalizeDecisions(...))`) byte-for-byte,
transaction boundaries, and the package's public exports unchanged.

Acceptance:
- [x] Focused pure tests of the new module without a database: coverage
      mismatch, duplicate evidence path, decision/evidence mismatch, EDITED
      with and without a value, allowed-values and numeric types, occurrence
      ownership mismatch in revalidation, and digest stability for
      reordered decisions and occurrence ids.
- [x] `grep -n "import .*module.js" postgres-persistence.ts` is empty; the
      action/value rule exists once.
- [ ] `tsc --noEmit` (extraction) and `tsc -b` (Studio) pass; extraction fast
      tests pass; the controller runs the extraction PostgreSQL tier.
      (Typecheck and fast tests pass, see the receipt; the PostgreSQL tier
      is the controller's.)

Verification receipt (Task 9): new `packages/extraction/src/review-rules.ts`
(250 lines; imports only `errors`, `review-paths`, `schema`, and types from
`types` and `parsed-document`) owns the Review Decision rules:
`reviewableExtraction` (the first check, before the pinned reads),
`reviewAuthority` (schema parses, records match it, grounding coverage,
decisions match the Evidence one to one and the schema; returns the
`ReviewAuthority` or throws the unchanged ExtractionError of the first broken
rule), `parsePinnedSchema`, `occurrenceOwnership`,
`reviewDecisionMatchesSchema`, `normalizeDecisions` and
`reviewAuthorityMatchesExtraction`, all moved verbatim. The action/value rule
is one private function, `actionMatchesReviewedValue`, used by
`reviewDecisionMatchesSchema` (snapshot side, also saved drafts) and
`reviewAuthorityMatchesExtraction` (in-transaction side). The in-transaction
reviewability check (`outcome`/`reviewable`/evidence array), which returned
`invalid` just before the revalidation, is folded into
`reviewAuthorityMatchesExtraction`: same result, same place in the
transaction. `ReviewAuthority` moved, unchanged, from `dependencies.ts` to
`review-rules.ts` (so the rules module imports no persistence port);
`dependencies.ts` imports it for the `ExtractionPersistence` signature.
`module.ts` `finalizeReview` keeps the reads and read-null checks, in their
order, and calls `reviewableExtraction` then `reviewAuthority`.
`postgres-persistence.ts` keeps the digest, transaction, claim and writes and
no longer imports `module.ts`; `createExtractions` moved to the new
`extractions.ts` (9 lines), re-exported by `index.ts` under the same name.
Checks: extraction `tsc --noEmit` and Studio `tsc -b` clean; extraction fast
tests 85 pass (base 73, +12 in `review-rules.test.ts`, added to the `test`
script), including a pinned digest string.

Controller addendum (Task 9): extraction `tsc` OK, fast 85/85, extraction
PostgreSQL tier 56/56 on `free_test_refactor_extraction`.

## Task 10 (slice 10): split `postgres-persistence.ts` by cluster

`packages/extraction/src/postgres-persistence.ts` is 1,592 lines holding one
shared core and several independent clusters, plus the researcher-scoped
class whose methods carry large bodies (`ownedInputs` ~977-1034,
`ownedRepresentation` ~1035-1072, `finalizeReview` ~1177-1252,
`scheduleBatch` ~1270-1407). `postgres-suggested-batch.ts:12` imports the
types `AdmitBatchMember` and `DurableBatchExtraction` back from it — the
package's only import cycle. Every per-run setting and every batch change
has edited this file (fdbd94a5, 40c02e08, e517fd37, 27155167, 7d74caef).

Change — flat modules in `packages/extraction/src`, named like the existing
`postgres-suggested-batch.ts`; logic moves verbatim:
- `postgres-ownership.ts`: `ownsResearcherExtraction`,
  `ownsResearcherDocument`, `ownsResearcherBatch`,
  `loadResearcherExtraction` (the guards every cluster uses).
- `postgres-attempts.ts`: attempt reads and status derivation
  (`readAttemptRows`, `AttemptRow`, `DerivedAttempt`, `settledAttempt`,
  `deriveAttempts`, `pinsOf`, `extractionSnapshot`, `attemptSnapshot`,
  `loadAttempts`, `failureMessage`, and the reviewed-value codec if the
  snapshots need it).
- `postgres-admission.ts`: identities and admission (`canonicalIds`,
  `selectionId`, `batchMemberExtractionId`, `AdmissionPins`,
  `resolveAdmission`, `AdmittedIdentity`, `sameAdmission`,
  `workflowIdInUse`, `admitInteractiveExtraction`,
  `BatchMemberAdmission`, `admitBatchMember`, `AdmitBatchMember`, the
  `scheduleBatch` body as a function) and the `DurableBatchExtraction` type
  if admission owns it; `postgres-suggested-batch.ts` imports its two types
  from here, which removes the cycle.
- `postgres-batches.ts`: batch read model and results (`BatchMember`,
  `snapshot`, `loadBatches`, `loadBatch`, `ResultDecision`,
  `applyReviewDecisionsToResult`, `setAtPath`, `loadFinalizedDecisions`,
  `loadResults`, `readBatchForResearcher`'s body).
- `postgres-reviews.ts`: review storage (`reviewDigest`, stored drafts,
  `resetStoredReview`, the `finalizeReview` transaction body as a function
  that still calls `review-rules.ts` inside the transaction).
- `postgres-workflow-store.ts`: `settleExtraction`, `createExtractionStore`.
- `postgres-persistence.ts` keeps the researcher-scoped class as a thin
  assembly whose methods delegate, `createResearcherExtractionPersistence`,
  and whatever small helpers only it uses. `index.ts` re-exports the public
  names from their new modules (public interface unchanged).
- Place each remaining helper (`semanticSuggestionTree`, `withoutNodeIds`,
  `ownedInputs`, `ownedRepresentation`, `decodeReviewedValue`, …) with its
  cluster; record every placement in the report.

Invariants: every SQL statement, transaction boundary, lock
(`withPoolClientTransaction`, row locks), retry and error path, and every
public export unchanged; the moved code is text-identical apart from
`this.` → explicit parameters where a method body became a function.

Acceptance:
- [x] `postgres-persistence.ts` ≤ ~350 lines; no new module > ~450 lines.
- [x] No import cycle among `packages/extraction/src` modules (a small script
      or `tsc`-based check in the report; the controller re-checks).
- [ ] `index.ts` / `package.json` exports and every Studio import of
      `extraction` resolve unchanged: extraction `tsc --noEmit` and Studio
      `tsc -b` pass; extraction fast tests pass; the controller runs the
      extraction PostgreSQL tier.
      (Typecheck and fast tests pass, see the receipt; the PostgreSQL tier
      is the controller's.)

Verification receipt (Task 10): `postgres-persistence.ts` 1,592 → 320 lines
(the researcher-scoped class, whose methods delegate, `cancelInteractiveExtraction`,
`SUPERSEDED_MESSAGE` and `createResearcherExtractionPersistence`), beside
six new modules: `postgres-ownership.ts` (214; the three `ownsResearcher*`
guards, `loadResearcherExtraction`, `ownedInputs`, `ownedRepresentation`
and `readResearcherExtraction`, the former `readExtraction` method body),
`postgres-attempts.ts` (259; attempt rows, status derivation, snapshots,
`failureMessage`, the reviewed-value codec and `loadDocumentExtractions`),
`postgres-admission.ts` (422; identities, `JUST_ADMITTED`, the constraint
keys and `SUGGESTED_BATCH_KEYS`, interactive admission, `admitBatchExtraction`
— the `scheduleBatch` body — and `admitBatchMember`), `postgres-batches.ts`
(284; the batch read model and results, `DurableBatchExtraction` and
`readBatchForResearcher`), `postgres-reviews.ts` (139; drafts, reset and
`finalizeStoredReview`, the `finalizeReview` body, still revalidating with
`review-rules.ts` inside its transaction) and `postgres-workflow-store.ts`
(114; `settleExtraction`, `createExtractionStore`). `semanticSuggestionTree`
and `withoutNodeIds` moved into `postgres-suggested-batch.ts` (226), which
now imports `AdmitBatchMember` from admission and `DurableBatchExtraction`
from batches: the batch read model owns that type, because admission reads
the batch back and a type in admission would close a batches ↔ admission
cycle. Moved code is line-for-line identical apart from `export`, `this.` →
parameters, and `readBatchForResearcher`'s `statuses` default
(`this.execution.statuses`) made explicit at its two callers; every
transaction, `withPoolClientTransaction` body, row lock, enqueue, retry and
error path is where it was. `index.ts` re-exports
`createResearcherExtractionPersistence` and `createExtractionStore` from
their modules; the integration test's dynamic import gained
`./postgres-workflow-store.js`. Checks: a Tarjan SCC scan of relative
imports in `packages/extraction/src` finds the old cycle at 1f3cb1c4 and
none after (39 modules, 147 imports); extraction `tsc --noEmit` and Studio
`tsc -b` clean; extraction fast tests 85/85.

Controller addendum (Task 10): cycle checker 39 modules / 147 imports / no
cycles; extraction + Studio `tsc` OK; extraction PostgreSQL tier 56/56.

## Task 11 (slice 11): split `kie/model.py` by layer and consumer

Python, `prototypes/parsing_service/src/kei_exp/kie/model.py` (779 lines)
serves two unrelated consumer groups and several layers at once:
- recipe stages and extraction (`segmentation`, `stages/route`,
  `stages/segment`, `extract/*`) import only `Span`, `HeadingEvent`,
  `GlossaryEntry`, `Diagnostic`, `Block`;
- ingest, `pages`, `artifacts`, `runner`, `cli`, `evidence`, `ocr` import the
  page geometry, ingest configuration/artifact/reports and run reports.
Its internal references form a clean order (docstring mentions aside):
primitives (the `Annotated` aliases, validators, `_Base`, `IngestError`,
`MIN_AXIS_PT`) → ingest (`Placement`, `Source`, `GutterEvidence`, `Page`,
`IngestConfig`, `Envelope`, `SpreadReport`, `IngestReport`,
`IngestArtifact`, `_check_spread_pages`, `_distance_px`) and blocks (`Span`,
`HeadingEvent`, `GlossaryEntry`, `Diagnostic`, `Block`) → document
(`EvidenceRef`, `Segment`, `Document`, `_check_spans`,
`_check_primary_ownership`; needs `Page`, `Source`, `Block`) → run
configuration and reports (`OcrConfig`, `PipelineConfig`, `Rejected`,
`EvidenceReport`, `IngestStep`, `RunReport`).

Change (inside `kei_exp/kie`, no package moves): split into one module per
layer following that order (suggested names: `kie/primitives.py`,
`kie/ingest_model.py`, `kie/blocks.py`, `kie/document.py`,
`kie/run_model.py` — choose clearer names if the vocabulary in
`prototypes/parsing_service/CONTEXT.md` suggests them; avoid clashing with
the existing `kie/evidence.py`, `kie/stages/ingest.py`, `kie/artifacts.py`).
Code moves verbatim; `model.py` is removed and every importer (src, tests,
tests/helpers, experiments if any) migrates — no facade. Extend the import
guard: `blocks` imports only `primitives`; neither `primitives` nor `blocks`
imports ingest/document/run modules; modules under `kie/extract` and
`kie/stages/{route,segment,layout}` do not import the ingest, document or
run-model modules.

Invariants: every model's fields, validators, defaults, `model_config` and
JSON schema unchanged; every artifact, report, page file and extraction
artifact byte unchanged; `IngestError` identity unchanged for `except`
clauses.

Acceptance:
- [x] Before editing: dump `model_json_schema()` (canonical JSON) of every
      pydantic model in `kie/model.py` keyed by class name to
      `/tmp/free-model-slice/baseline/`; after: identical under the new
      modules.
- [x] Rerun `/tmp/free-grounded-slice/snapshot.py` (extraction artifacts
      over `Block`/`Span`) and the runner/ingest/evidence fast tests;
      snapshot byte-identical (threaded `chunks>1` event order excepted, as
      recorded in Task 5).
- [x] `grep -rn "kie.model\b\|kie import model" src tests experiments`
      finds nothing; import guard extended; full fast suite passes.

Verification receipt (Task 11): `kie/model.py` (779 lines) removed, split
in its own dependency order into `kie/primitives.py` (98; the `Annotated`
and `Literal` aliases, their validators, `_unique`, `_Base`, `IngestError`,
`MIN_AXIS_PT`), `kie/blocks.py` (91; `Span`, `HeadingEvent`,
`GlossaryEntry`, `Diagnostic`, `Block`, `_ENTRY_LABEL`; imports only
`primitives`), `kie/ingest_model.py` (407; `Placement` through
`IngestArtifact`, `_distance_px`, `_check_spread_pages`),
`kie/document.py` (170; `EvidenceRef`, `Segment`, `Document`,
`_check_inside`, `_check_spans`, `_check_primary_ownership`) and
`kie/run_model.py` (91; `OcrConfig`, `PipelineConfig`, `Rejected`,
`EvidenceReport`, `IngestStep`, `RunReport`). Every line below the old
imports appears exactly once in the new modules; only module docstrings and
import blocks are new. 15 src and 11 test/helper importers migrated, no
facade; `geometry.Placed`'s docstring now names
`kie.ingest_model.Placement`. The `Source → Document` and
`_timestamp → Envelope` edges are docstring mentions and create no import.
Checks: the canonical `model_json_schema()` of all 24 models (23 plus
`_Base`) byte-identical before and after; the grounded snapshot (127 files)
byte-identical, run from a scratch copy whose `direct()` imports `Span` from
`kie.blocks` (the only change; the frozen harness imported `kie.model`);
`grep -rn "kie\.model\b\|kie import model" src tests experiments` empty
(the brief's unescaped `.` also matches the spec file name
`kie-model-and-ingest-design.md` in docstrings); two new guards in
`tests/test_segmentation_dependencies.py`, each seen failing on an injected
import; fast suite 1102 passed, 72 skipped, 74 deselected.

## Next candidates, reassessed after this slice

1. `kie/runner.py`: pull the ingest-generation cache (`_recover`,
   `_proven`, `_skippable`, `_produce`, `_publish`, `_discard`) out of the
   orchestration.
2. Split `extraction-module.integration.test.ts` (2,515 lines) by cluster.
3. One owner for the extraction method value (strategy, recipe, models).
