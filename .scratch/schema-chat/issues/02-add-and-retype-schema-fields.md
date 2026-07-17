# 02 — Safely add and retype schema fields

Status: ready-for-agent
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

- [ ] Fixture tests from existing pinned schemas pass validation before mutation code lands
- [ ] Manual field add and type change flow through immutable `set` via the shared engine
- [ ] Duplicate keys, reserved names, and `__proto__`/`constructor`/`prototype` rejected with typed issues
- [ ] Adding a field cannot overwrite an existing key
- [ ] New fields carry the required Evidence structure
- [ ] Focused tests added; test, lint, and build green

## Blocked by

None - can start immediately.
