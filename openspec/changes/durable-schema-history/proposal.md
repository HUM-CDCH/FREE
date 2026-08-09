## Why

Schema edits currently live only in browser state even though PostgreSQL already models immutable, append-only Schema Revisions. Humanities Researchers need durable schema history that survives a fresh browser context and Project Context reopen, and they need to restore an earlier revision without rewriting that history or introducing a second ledger.

## What Changes

- Append researcher edits as immutable Schema Revisions with optimistic concurrency through `ProjectStore`.
- Persist a generated first schema as revision 1 before making it editable.
- Carry the durable Schema Revision identity and number through save, conflict, queued-save, conversational-edit, reopen, and Extraction flows.
- Expose bounded, ownership-validated list and get operations through same-origin Studio endpoints.
- Add a revision timeline whose older entries restore their exact tree as a new Current Schema Revision.
- Derive concise structural summaries from adjacent ordered `SchemaNode[]` trees.
- Verify append-only restoration with PostgreSQL, Studio, and a fresh browser context.
- Exclude history rewriting, rollback-in-place, undo/redo, failed attempt history, persisted prose summaries, branches, tags, and arbitrary revision comparison.

## Capabilities

### New Capabilities

- `schema-revision-history`: Durable append-only Schema Revision persistence, bounded browsing, and one-click restoration as a new revision.

### Modified Capabilities

- `schema-node-persistence`: The current ordered `SchemaNode[]` and stable ids are durably pinned to an explicit Schema Revision identity and number.
- `schema-chat-edit`: Conversational editing selects the acknowledged Current Schema Revision as its base and waits for queued researcher edits to persist first.

## Impact

`packages/db` gains the narrow Schema Revision methods on the existing `ProjectStore` interface. Studio gains shared DTO validation, same-origin schema revision handlers, autosave coordination, timeline/restore UI, and focused tests. PostgreSQL and the existing Prisma models remain authoritative; no dependency or database schema change is expected.
