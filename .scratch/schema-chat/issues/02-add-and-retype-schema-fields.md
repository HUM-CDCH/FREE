# 02 — Safely add and retype schema fields

Status: resolved
Type: task
Blocked by: none

## What to build

Expand the schema engine beside the existing helpers and route manual field
addition and type changes through immutable `set` operations from the schema
domain contract (record-relative paths, repeated-item array traversal at
index `0`, leaf-only creation, typed `applied`/`stale`/`invalid` results).
Reject malformed, duplicate, reserved (`_evidence`, `_meta`,
`_schema_metadata`), prototype-pollution, and overwriting changes.

Derive the accepted grammar from fixture-based tests of existing pinned
Extraction Schemas before implementing mutation behavior — the validator must
accept the full recursive grammar, not a `FIELD_TYPES` reduction. New fields
receive the required local Evidence shape. Name normalization applies only to
newly created fields.

## Acceptance criteria

- [x] Fixture tests from existing pinned schemas pass validation before mutation code lands
- [x] Manual field add and type change flow through immutable `set` via the shared engine
- [x] Duplicate keys, reserved names, and `__proto__`/`constructor`/`prototype` rejected with typed issues
- [x] Adding a field cannot overwrite an existing key
- [x] New fields carry the required Evidence structure
- [x] Focused tests added; test, lint, and build green

## Blocked by

None - can start immediately.

## Answer

Delivered a DOM-free shared Extraction Schema validator and immutable `set`
engine with typed applied, stale, and invalid outcomes. Manual add and retype
now use that engine, including repeated-item traversal, protected-name checks,
non-overwriting normalized creation, and required local Evidence. The validator
recursively checks field nodes, Evidence shapes, system metadata values, and
reference integrity; rejected manual changes no longer report a success toast.

Verified with `pnpm --filter studio test`, `pnpm --filter studio lint`, and
`pnpm --filter studio build` (141 tests passed; two live smoke suites skipped as
configured). Residual risk: the existing Vite large-chunk warning remains; rename
and remove continue through the legacy seam for ticket 03.
