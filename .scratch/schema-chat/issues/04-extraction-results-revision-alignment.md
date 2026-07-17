# 04 — Keep Extraction Results aligned with schema revision

Status: resolved
Type: task
Blocked by: 03

## What to build

Invalidate obsolete Extraction Results after each approved schema transition.
`App` owns a monotonic schema revision that increments together with each
committed schema change; extraction identity includes that revision, and
delayed extraction completions for an older revision must not restore stale
results. Revision is always paired with document epoch in identity and
completion guards.

## Acceptance criteria

- [x] Every approved schema transition invalidates old Extraction Results
- [x] Extraction identity includes schema revision (and document epoch)
- [x] A delayed completion for an older revision cannot commit results
- [x] Focused tests added; test, lint, and build green

## Blocked by

- 03-rename-and-remove-schema-fields

## Answer

Added App-owned schema revision and document epoch state. Every currently approved schema transition increments the revision, while opening a Source Document starts revision zero in a new epoch. Extraction snapshots and invocation guards now identify work by document epoch and schema revision alongside task, schema, and strategy, immediately projecting obsolete results as idle and preventing delayed older completions from committing. Added focused tests for revision and epoch invalidation; Studio test, lint, and build pass.
