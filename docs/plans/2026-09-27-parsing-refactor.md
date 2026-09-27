# Parsing and extraction refactor — 2026-09-27

Status: slices 1–2 implemented and locally verified; uncommitted. Base: `377cd050`.
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

## Next candidates, reassessed after this slice

1. Extract one interchangeable grounding or context component using existing arms.
2. Split Postgres persistence by transaction responsibility.

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
