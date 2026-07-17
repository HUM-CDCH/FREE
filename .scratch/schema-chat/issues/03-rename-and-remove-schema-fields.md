# 03 — Safely rename and remove schema fields

Status: resolved
Type: task
Blocked by: 02

## What to build

Migrate the remaining manual operations (`rename`, `remove`) to explicit
validated `SchemaChange`s through the shared engine, then delete the old
mutation seam (`transformField`-style callbacks). `rename` migrates dependent
`_schema_metadata` and Evidence paths atomically; `remove` prunes them.
Invalid or orphaned system references reject the entire change set. Changes
apply sequentially to one immutable working copy — any failure rolls back
everything. Applying a change to a pinned Extraction Schema creates an
editable browser-owned copy and leaves the pinned source unchanged. Name
normalization applies only on rename.

## Acceptance criteria

- [x] Rename migrates dependent metadata and Evidence; remove prunes them
- [x] Atomic rollback: one failing change rejects the whole change set
- [x] Root `remove` and root `rename` are invalid with typed issues
- [x] Editing a pinned schema produces an editable copy; pinned source untouched
- [x] Old mutation seam deleted; all manual edits use the shared engine
- [x] Focused tests added; test, lint, and build green

## Blocked by

- 02-add-and-retype-schema-fields

## Answer

Implemented validated `rename` and `remove` Schema Changes in the shared immutable engine. Rename migrates dependent `_schema_metadata` and Evidence keys; remove prunes them. Every step validates system references and rolls the complete change set back on failure, including typed root-operation and missing-field issues. Manual schema editing now emits only Schema Changes, supports editable browser-owned copies of pinned Extraction Schemas, and no longer exposes the callback-based mutation seam. Field edits emit `set` only when the selected type changes, so object and repeated-array renames preserve their complete contents and references. Added focused engine, field-transition, and pinned-schema UI tests; Studio test, lint, and build pass.
