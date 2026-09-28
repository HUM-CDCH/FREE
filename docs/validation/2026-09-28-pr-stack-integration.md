# Extraction PR stack integration — 2026-09-28

The reporting base (#147), span grounding (#145), and compact labels (#146)
are being integrated into `feat/kei-exp-parser` in that order, as authorized.
Work is isolated in `FREE-worktrees/pr-stack-integration`; existing checkouts,
frozen runtime archives, manifests, captures and supervisors are untouched.

## Review and conflict resolution

Reviewed the reporting delta: missing token costs remain unavailable and paired
token effects use their own denominator. Ten table tests and eight observation
accounting tests pass. The reporting base merges current integration head
`35cfdebb` cleanly.

Reviewed #145 against the already-merged #144 module boundaries. Six conflicting
files required reconciliation. `run.py` retains only strategy dispatch;
`article.py` owns Article orchestration; `grounding.py` owns verification and the
semantic/quoted/spans/off technique lookup; `assembly.ground_records` is the one
policy/scheduling owner for serving and fixed-upstream experiments. Routing
receives the selected technique. Canonical passages stay in `kie.passages`.
Call sites, tests and current reporting helpers follow the relocated owners.
No compatibility aliases or duplicate verification implementation were retained.

Bloat audit: pass; no blockers. The independently selectable experimental factors
and exhaustive unresolved routing are explicit study requirements. The scanner
reported no unstaged signals; the substantive review used the full diff against
the integrated reporting base. No default grounding choice changed.

## Local validation of integrated #145

- 345 focused extraction, grounding, reporting and module-boundary tests pass;
  18 process/database/live tests deselected.
- Complete fast Python suite: 1,181 passed, 72 skipped, 75 deselected.
- All four package typechecks, Node unit suites and 18 safety checks pass.
- Lint passes with the two existing `useExtraction.ts` dependency warnings.
- Six scripted Article methods (reference, semantic, quoted, off, spans and
  unresolved spans) produce byte-identical requests and artifacts compared with
  original #145 head `3f14340f`, excluding clocks. No live model calls were made.
- GitHub deterministic verification, including its PostgreSQL/browser/recovery
  tiers, must pass on the updated PR heads before merging.

The full R5 matrix remains deferred. The completed development pilot and compact
label admission results do not establish independent semantic quality. Span v2
needs a fresh, separately pinned comparison including a previously refused source
and canonical tables before a default change. The original study and final report
remain separate obligations; no collector is restarted by this integration.
