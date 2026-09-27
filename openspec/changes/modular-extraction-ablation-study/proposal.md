# Proposal

## Why

The researched extraction design requires bounded context and independently measurable
stages, but Article now repeats the complete source and the latest accuracy comparison
combines code, schema, model and conversion changes. Implement explicit stage variants
and a reproducible study so their effects can be measured and the architecture understood.

## What Changes

- Refactor extraction into visible stage owners while preserving canonical evidence and
  worker contracts; retain the existing Article as a reproducible reference arm.
- Add bounded source/context handling, conservative identity reconciliation and explicit
  grounding choices for Article; expose existing Catalog context techniques independently.
- Add a validated experiment manifest, pinned execution/capture, resume and analysis CLI.
- Run controlled live ablations with a frozen schema/model/source per comparison, preserve
  failed cells and extra predictions, and report document-level paired effects and cost.
- Keep development-corpus evidence distinct from unseen, human-adjudicated evaluation.

## Capabilities

### New Capabilities

- `modular-extraction-experiments`: explicit, fingerprinted stage choices and bounded,
  source-backed experimental execution over Article and recipe-based Catalog.
- `extraction-ablation-study`: pinned experiment matrices, faithful captures, controlled
  comparisons, reproducible metrics and honest incomplete/held-out status.

### Modified Capabilities

None. Existing canonical-evidence ownership, authentication, persistence and review
requirements remain in force. Research outputs do not finalize researcher review.

## Impact

Primary code: `prototypes/parsing_service/src/kei_exp/kie/extract/`, existing Catalog
segmentation/recipes, and a small `kie/study/` package with configs and tests. Shared
contracts/adapters change only where effective settings or diagnostics must propagate.
No new runtime service or queue. Durable execution plan:
`docs/plans/2026-09-27-modular-extraction-ablation-study.md`.
