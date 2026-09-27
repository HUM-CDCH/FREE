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

## Next candidates, reassessed after this slice

1. Resolve Article techniques once inside `src` (the scattered
   `method.X ==` checks in `article.py`/`assembly.py`/`stages.py`); the
   frozen `study.preflight` stays as it is.
2. One budgeted-call module (`stages._complete`, `grounded._Run.call`,
   `LimitedCounter`) with the budget policy as its variant.
3. TypeScript `packages/extraction`: workflow toolkit + one owner for the
   `extract:<id>` workflow ID; pure review rules; persistence split.
