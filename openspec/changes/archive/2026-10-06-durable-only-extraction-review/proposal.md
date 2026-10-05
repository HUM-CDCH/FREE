## Why

The pre-production durable-only follow-up to PR #185 deleted the non-durable
`runExtraction` execution path, its `ProjectStore` accept-and-review write, the
path/anchor Review Draft machinery and the old `ResultsTab` review sub-view
(ADR 0016 superseded; ADR 0017 durable-only amendment). Two living
specifications still describe that removed implementation as normative:
`canonical-evidence-lifecycle` (its review requirements) and
`result-tree-navigator` (whose breadcrumb navigator had already been removed by
the results-review redesign before PR #185). They must describe the durable
review model the code now implements, with no legacy compatibility obligation.

## What Changes

- **BREAKING** (pre-production, authorized): remove the requirement that
  `ProjectStore` persists a successful Extraction Result and its Review Decision
  in one accept transaction. Review Decisions are now revisioned corrections of
  stable saved values in the Project's numbered decision versions.
- Replace "review is an explicit accept action" with explicit finalization of one
  named result/decision pair, which never happens implicitly and may name a
  deliberately older pair.
- Replace reviewed-occurrence ownership on the accept write with source-checked,
  optional correction Evidence against the Extraction's pinned Source
  Representation.
- Replace reopen of an accepted result with reopen of a named saved result and
  decision cut, including "Latest reviewed" opening its finalized pair.
- Restate that an Extraction keeps its producing Schema Revision and settings for
  review regardless of the current Schema head.
- Correct "the model cites published Evidence": a value whose label resolves to
  no published anchor keeps no producer Evidence but remains a reviewable saved
  value.
- **BREAKING**: remove the `result-tree-navigator` capability; the breadcrumb and
  back/forward navigator no longer exists in Studio.
- Unchanged: durable occurrence identity, strict `parsed_document.v2`, geometry
  safety, and the unrelated configuration, ingestion and schema capabilities.

## Capabilities

### New Capabilities

- `durable-extraction-admission`: successful admission commits durable work
  directly, with no release gate.

### Modified Capabilities

- `canonical-evidence-lifecycle`: review persistence, ownership, reopen, explicit
  action and Schema Revision requirements move from the removed accept write to
  durable corrections and named finalization; the cited-label scenario no longer
  forbids reviewing an ungrounded value.
- `result-tree-navigator`: all requirements removed; the capability is retired.

## Impact

- Specs: `openspec/specs/canonical-evidence-lifecycle/spec.md`,
  `openspec/specs/durable-extraction-admission/spec.md`,
  `openspec/specs/result-tree-navigator/spec.md` (removed).
- Code already implementing the new requirements: `packages/extraction/src/durable-repository.ts`
  (`saveCorrection`, `finalize`, `page`), `prototypes/studio/api/durable_extractions.ts`
  (pinned-source Evidence check), `prototypes/studio/src/DurableResults.tsx`,
  `App.tsx`/`AppFrame.tsx`/`projectNavigation.ts` (review-cut routing).
- Drop the unused `extraction` workspace dependency from
  `extraction-result-export`; no external dependency or database migration
  change. Remove the disabled-admission
  error and its API/UI handling. Valid requests admit durable work directly.
  Merging this implementation removes the admission block. The current source
  requires PostgreSQL, browser, Compose and exact-commit Spark acceptance
  before merge. Deployment remains a separate action.
