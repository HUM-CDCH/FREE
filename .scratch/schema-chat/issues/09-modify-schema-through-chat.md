# 09 — Modify an approved Extraction Schema through chat

Status: resolved
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

- [x] Chat proposes nested set/rename/remove; Apply mutates only through the shared engine
- [x] Stale Apply and invalid Apply never change the schema, with visible states
- [x] Metadata and Evidence remain valid after applied operations
- [x] Applying to a pinned schema creates an editable copy
- [x] Demoable: converse → proposal card → apply → schema updates → Extraction Results invalidated
- [x] Focused tests added; test, lint, and build green

## Answer

Implemented validated nested `set`, `rename`, and `remove` proposal parts
using the shared schema engine for server validation and App-owned application.
Approved schemas reject root replacement proposals, while schema-chat request,
message, part, annotation, proposal, and operation objects reject unknown keys.
Nested proposal cards describe each operation, and stale proposals remain visibly
disabled with a reason that covers both document and schema freshness. Invalid
application remains non-mutating with the existing visible toast. Focused
transition coverage verifies metadata/Evidence preservation, pinned-schema
copying, revision increment, invalid atomic rejection, root-set rejection, and
strict route boundaries.

Verification: `pnpm --filter studio test`, `pnpm --filter studio lint`, and
`pnpm --filter studio build` pass (192 tests passed, 2 smoke tests skipped;
Vite reports only its existing chunk-size warning).

## Blocked by

- 08-create-schema-through-chat
