# Parsing and extraction refactor — 2026-09-27

Status: slices 1–2 committed as `87f26533`; slice 3 committed after it, awaiting review. Base: `377cd050`.
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
- [ ] Before any source edit, rerun `/tmp/free-grounding-slice/snapshot.py`
      into a fresh baseline directory (it covers version 1 Catalog incl.
      budget splitting, Article reference/semantic/quoted/off with bounded
      contexts, and recipe Catalog, and logs call/check order). Extend it,
      if needed, to also cover the published file bytes via
      `publish_extraction` and an Article case with document-level fields
      and multiple contexts. After the change the outputs are byte-identical.
- [ ] `run.py` contains no `if article`, no `method.` access and no counter
      construction; `grep -n "article\|method" run.py` shows only imports,
      request types, the dispatch and `fingerprint`.
- [ ] Each implementation is exercised by at least one test that calls it
      directly with in-memory evidence (no `monkeypatch` of `run.load`).
- [ ] Import guard extended and failing on a probe that imports `run` from
      an implementation module.
- [ ] Focused and full fast suites pass; record the receipt here.

## Next candidates, reassessed after this slice

1. Resolve Article techniques once (execution and `study.preflight`).
2. Split `grounded.py` around verification/arbitration, windowing and
   chunked execution.
3. Split Postgres persistence by transaction responsibility.

## Verification receipt

Run from `prototypes/parsing_service`, with `PYTHONPATH=src` and the existing
`/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest`:

Slice 1:

- Baseline: `-q -m 'not postgres and not live_model' tests/test_kie_segment.py tests/test_kie_boundaries.py tests/test_extract_grounded.py tests/test_catalog_chunks.py tests/test_extract_workflow.py`
  → 150 passed, 9 deselected. Add `tests/test_segmentation_dependencies.py` after
  the move → 151 passed, 9 deselected. The guard failed on the old nested import.
- Full fast suite: `-q -m 'not postgres and not live_model'`
  → 1,073 passed, 72 skipped, 74 deselected; 3 dependency deprecation warnings.
- A static local-import scan of all 66 source modules, including nested imports,
  found zero cycles. The boundary test prevents the removed reverse dependency.
- All 20 catalogue fixtures were computed and published into fresh directories
  before/after the move; exact artifact bytes matched. Local evidence is at
  `/tmp/free-segmentation-refactor-jcv3w51d/{baseline,after}`.
- `git diff --check`, `bloat-scan-diff --json`, and manual review of new files passed.
  No blockers or compatibility glue; the retained invalid-artifact recomputation
  is the existing tested contract. One orchestration module replaces one reverse
  dependency; no duplicate function or new dependency/configuration was added.

Slice 2 (all `-q -m 'not postgres and not live_model'`):

- Implemented by Claude Code with `claude-opus-5-5`, session
  `4b077fb8-461f-41cc-ac20-33953daa3f9c`; the parent agent reviewed the diff and
  independently reran the full fast suite with the same result below.
- Focused: 19 evidence, stage, segmentation, extraction, experiment and replay
  test files → 373 passed, 9 deselected before; 374 passed, 9 deselected after.
- Full fast suite → 1,074 passed, 72 skipped, 74 deselected; the same 3 warnings.
- Snapshots of all 20 fixtures before/after (evidence `repr` plus `text_of`, and
  published segmentation bytes) are identical; the 20 segmentation snapshots
  also equal slice 1's baseline. The parent independently compared all 40 files;
  `/tmp/free-evidence-refactor-opus55/{before,after}`.
- The guard's checks report the old import in each of the five pre-slice
  modules and in a nested relative probe. Imports resolve into this worktree;
  `kei_exp.kie.extract.evidence` raises `ModuleNotFoundError`; 66 modules, 0 cycles.
- `git diff --check` and manual review passed; only the module docstring differs.
- Parent bloat audit passed, including manual review of untracked files: no
  blockers, new fallbacks, compatibility facades, or replacement frameworks.
- Experiment registrations pin `src/**/*.py`; new ones pin the moved file.
  Existing registrations, frozen manifests, dated plans/specs and their scripts
  are unchanged.

Slice 3 (all `-q -m 'not postgres and not live_model' -p no:cacheprovider`):

- Implemented by Claude Code with `claude-opus-5-5` from the Task 3 brief.
- Baseline captured before any source edit by `/tmp/free-grounding-slice/snapshot.py`
  (deterministic scripted chats and word counters from the test helpers). Thirteen
  cases: version 1 Catalog over hand-built passages with a table (lexical, model and
  cell links), the same with `record_chars=1000` (split batches and
  `grounding_exceeds_budget`), version 1 over the `two-in-one-segment` fixture;
  Article reference (`method=None`), semantic, quoted and off with full and bounded
  contexts, plus quoted with structured rendering, structural grouping and selection;
  recipe Catalog `two-in-one-segment` and `headings`. Each case writes the canonical
  artifact minus `started`/`seconds` and an ordered log of every `before_entry` check
  and model request (system, user, schema, `max_tokens`). A repeated baseline was
  identical; after the change all 26 files are byte-identical, fingerprints included:
  `/tmp/free-grounding-slice/{baseline,after}`.
- Focused: 14 stage, grounding, article, method, structure, table-cell, workflow,
  selection, replay, study, rendering, recipe, model and fixture test files → 225 passed,
  9 deselected before; with `tests/test_extraction_grounding.py` 231 passed, 9 deselected.
- Full fast suite → 1,080 passed, 72 skipped, 74 deselected; the same 3 warnings.
- The seam test replaces `grounding.technique` with a recording substitute: bounded
  Article receives each context once per record and publishes the substitute's links
  with no grounding call; the version 1 Catalog receives each record's slice with no
  counter or record context.
- The moved code and prompts are textually identical to their `stages.py` originals.
  `kei_exp.kie.extract.stages.verify` raises `AttributeError` and the `from` import
  raises `ImportError`; none of the moved names remain in `stages.py`. 67 modules, 0 cycles.
- `git diff --check` and manual review passed. Experiment registrations, manifests and
  dated plans/specs are unchanged; `docs/extraction-experiments.md` names the new module.

Undo: reverse the slices' source/test/doc edits and remove their new files.
No database, workflow step, deployment, running checkout or study artifact changed.
Live-model and PostgreSQL/recovery tiers were not run; no claims are made for them.
