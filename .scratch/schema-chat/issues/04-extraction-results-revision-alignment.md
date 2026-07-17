# 04 — Keep Extraction Results aligned with schema revision

Status: ready-for-agent
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

- [ ] Every approved schema transition invalidates old Extraction Results
- [ ] Extraction identity includes schema revision (and document epoch)
- [ ] A delayed completion for an older revision cannot commit results
- [ ] Focused tests added; test, lint, and build green

## Blocked by

- 03-rename-and-remove-schema-fields
