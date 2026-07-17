# 03 — Safely rename and remove schema fields

Status: ready-for-agent
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

- [ ] Rename migrates dependent metadata and Evidence; remove prunes them
- [ ] Atomic rollback: one failing change rejects the whole change set
- [ ] Root `remove` and root `rename` are invalid with typed issues
- [ ] Editing a pinned schema produces an editable copy; pinned source untouched
- [ ] Old mutation seam deleted; all manual edits use the shared engine
- [ ] Focused tests added; test, lint, and build green

## Blocked by

- 02-add-and-retype-schema-fields
