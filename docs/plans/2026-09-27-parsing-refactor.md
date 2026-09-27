# Parsing and extraction refactor — 2026-09-27

Status: slices 1–2 committed as `87f26533`; slice 3 in progress. Base: `377cd050`.
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
- [ ] Baseline before any edit: a throwaway script (outside the repo, e.g.
      under `/tmp`) runs `run.extract` with deterministic fake chats/counters
      over test fixtures for: version 1 Catalog, Article reference
      (`method=None`), Article with `grounding` = semantic, quoted and off
      (bounded contexts where the options require them), and a recipe
      Catalog; it writes canonical JSON of each artifact minus
      `started`/`seconds`. The same script after the change produces
      byte-identical files.
- [ ] A focused test proves the seam: substituting a different grounding
      function through the lookup's result changes grounding output without
      editing `run.py` (e.g. monkeypatching the lookup to a recording fake,
      asserting it received each verification group once per record).
- [ ] `stages.py` no longer defines the moved names;
      `kei_exp.kie.extract.stages.verify` raises `AttributeError`/ImportError.
- [ ] Focused tests (stages, article, methods, structure fixes, table cells,
      workflow, selection replay, study) and the full fast suite pass.
- [ ] Record the verification receipt in this file.

## Next candidates, reassessed after this slice

1. Separate the three extraction implementations in `run.extract` (Article,
   version 1 Catalog, recipe Catalog) behind one call shape.
2. Resolve Article techniques once (execution and `study.preflight`).
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

Undo: reverse the slices' source/test/doc edits and remove their new files.
No database, workflow step, deployment, running checkout or study artifact changed.
Live-model and PostgreSQL/recovery tiers were not run; no claims are made for them.
