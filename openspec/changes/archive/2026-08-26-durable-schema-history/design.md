## Context

PostgreSQL already stores immutable `SchemaRevision` rows and relationships to `ExtractionSchema`, `ConversationalSchemaEdit`, and `Extraction`. Studio can reopen a persisted revision but direct edits only change React state, clear the Extraction pin, and disappear in a fresh browser context. `ProjectStore` is the existing server persistence seam; browser code uses validated same-origin DTOs.

## Goals / Non-Goals

**Goals:**

- Make every acknowledged direct schema edit an append-only Schema Revision.
- Reject stale writes atomically and keep the acknowledged revision identity explicit.
- Browse a bounded timeline and restore an exact historical ordered tree as a new Current Schema Revision.
- Preserve current schema-chat proposal review, stable node ids, and Extraction pinning.

**Non-Goals:**

- History rewriting, rollback-in-place, undo/redo, failed-attempt history, persisted prose summaries, branches, tags, named versions, or arbitrary revision comparison.
- A browser history ledger, a second persistence interface, or a database schema change.

## Decisions

### Keep the persistence seam at ProjectStore

Add three methods to the existing `ProjectStore` interface: atomically append against an expected revision number, list a bounded newest-first revision window, and get one revision by identity. The append result is either the created revision or the current head on conflict; missing owners remain distinct from conflicts. This keeps transaction and database details server-side. A new repository or generic event store would duplicate the existing seam.

### Let PostgreSQL arbitrate concurrent appends

Within one transaction, read the owner and current head, compare the expected revision number, and create exactly `head + 1`. The owner-scoped unique revision constraint is the final race arbiter. A uniqueness race is mapped to a conflict by rereading the head; the failed transaction leaves no partial revision. No compatibility path or migration is needed.

### Use one narrow same-origin route family

`POST /api/schema-revisions` appends a researcher-authored revision. `GET /api/schema-revisions?projectContextId=...&extractionSchemaId=...&limit=...` returns bounded timeline metadata with derived adjacent-tree summaries. `GET /api/schema-revisions/{id}?projectContextId=...&extractionSchemaId=...` returns one exact tree for restoration. The handler validates identity syntax, Project Context ownership, bounds, and `SchemaNode[]`; it never returns model output, internal provenance, or failure records.

### Keep one acknowledged head and one latest draft in Studio

The workspace owns the acknowledged `{schemaRevisionId, revisionNumber, nodes}` and the latest editable nodes. A 1.5-second idle save allows one request in flight and retains only the newest queued draft. Success acknowledges only the submitted tree, then saves a different queued draft. Conflict keeps the current draft visible, exposes the server head, and blocks Extraction and conversational editing until the researcher reloads current. This is the smallest coordinator that makes queued saves and stale heads explicit.

### Persist the first generated schema before exposing it

When a durable Project Context has no Extraction Schema, the revision route creates the shared Extraction Schema and suggestion revision 1 in one transaction. Studio installs that returned identity before exposing the generated nodes as editable, so later direct and conversational edits use the same save coordinator as reopened schemas.

### Restore through the existing editable-draft seam

The schema panel receives history state separately from the editable current nodes. Selecting an older revision loads its exact tree, flushes any pending current draft, installs the historical nodes through `onNodesChange`, and flushes again immediately. This preserves stable ids and order, appends through the existing optimistic coordinator, and never mutates an old row. Selecting the current or an identical tree is a no-op. The history control is disabled while restoration is active; load or pre-flush failure leaves the current tree unchanged, while append failure retains the restored tree as the visible failed or conflicted draft.

### Derive summaries from adjacent trees

A pure helper beside the existing schema-change logic compares stable node ids and order to report concise additions, removals, renames, type/description changes, and moves. Timeline list handling derives summaries from the bounded database rows and omits trees from list DTOs; exact trees remain available through get.

## Risks / Trade-offs

- **A tab can close before a debounced save completes** → warn while dirty/saving/queued and flush before Extraction or conversational editing; browser shutdown persistence is not guaranteed.
- **The bounded window cannot describe a first row whose predecessor lies outside the window** → fetch one extra predecessor internally and return only the requested limit.
- **A uniqueness error can also indicate malformed data** → map only the owner/revision unique constraint to conflict; surface other persistence failures through the existing sanitized error contract.
- **A restore can overlap pending edits** → load the immutable target first, flush the latest current draft, then install and immediately flush the restored tree through the same coordinator.

## Migration Plan

No schema migration or seed is required. Deploy store methods, route/DTOs, then Studio coordination and UI. Reverting the code leaves existing append-only rows valid and readable by reopen.

## Open Questions

None for this slice.
