# 09 — Modify an approved Extraction Schema through chat

Status: ready-for-agent
Type: task
Blocked by: 08

## What to build

Let chat propose nested `set`, `rename`, and `remove` operations against the
approved Extraction Schema. Fresh proposals apply through the same shared
engine and App-owned transition as manual edits; stale or invalid proposals
are rejected without mutating the approved schema. System-managed metadata
and Evidence remain valid after applied operations (migration on rename,
pruning on remove, synthesis on new fields). Applying to a pinned schema
creates an editable copy.

## Acceptance criteria

- [ ] Chat proposes nested set/rename/remove; Apply mutates only through the shared engine
- [ ] Stale Apply and invalid Apply never change the schema, with visible states
- [ ] Metadata and Evidence remain valid after applied operations
- [ ] Applying to a pinned schema creates an editable copy
- [ ] Demoable: converse → proposal card → apply → schema updates → Extraction Results invalidated
- [ ] Focused tests added; test, lint, and build green

## Blocked by

- 08-create-schema-through-chat
