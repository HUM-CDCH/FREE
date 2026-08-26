## 1. Durable Store Seam

- [x] 1.1 Add failing `ProjectStore` tests for atomic append success, stale-write conflict, race conflict, exact get, bounded deterministic list, and Project Context ownership
- [x] 1.2 Implement minimal Schema Revision DTOs and append/list/get methods on `ProjectStore`
- [x] 1.3 Verify focused database tests and no partial write on conflict

## 2. Same-Origin Revision Commands

- [x] 2.1 Add failing route tests for validated append, bounded list, exact get, ownership mismatch, stale conflict, and sanitized browser DTOs
- [x] 2.2 Add shared Schema Revision contracts and the narrow `/api/schema-revisions` route family
- [x] 2.3 Add browser client commands and verify focused API tests

## 3. Durable Current Revision

- [x] 3.1 Add failing coordinator tests for debounce, one in-flight save, latest queued draft, acknowledged identity, conflict blocking, and flush
- [x] 3.2 Implement the minimal schema-save coordinator and wire acknowledged revision identity through reopen, edits, conversational-edit base selection, and Extraction
- [x] 3.3 Verify existing schema-chat proposal review and current-schema Extraction tests remain green

## 4. Revision Timeline

- [x] 4.1 Add failing pure tests for adjacent-tree structural summaries including order and stable ids
- [x] 4.2 Add failing schema-panel tests for bounded timeline metadata, exact read-only preview, explicit return to current, and zero mutation callbacks
- [x] 4.3 Implement the History entry point and bounded timeline loading

## 5. Lifecycle Verification

- [x] 5.1 Run focused database and Studio tests, lint, build, OpenSpec validation, and `git diff --check`
- [x] 5.2 Run the real PostgreSQL/Prisma, Studio API, and Vite stack; save a schema edit and confirm the append-only rows
- [x] 5.3 Open a fresh browser context, reopen the Project Context, verify the same timeline and exact historical tree, return to current, and confirm the head did not move
- [x] 5.4 Exercise a stale concurrent write and confirm one append plus one conflict with no partial revision

## 6. Generated-first Regression

- [x] 6.1 Add failing store, route, browser-client, and workspace tests for creating revision 1 and enabling history
- [x] 6.2 Persist the first generated schema and install its acknowledged revision identity in Studio
- [x] 6.3 Relax the schema-edit prompt so broad translation instructions apply to all relevant field names

## 7. Append-only Historical Restoration

- [x] 7.1 Replace Historical Preview coverage with one-click restore ordering, current/same-tree no-op, and failure-state tests
- [x] 7.2 Remove preview state and restore through the existing load, flush, edit, and immediate-flush seams
- [x] 7.3 Run focused/static checks and a real PostgreSQL, Vite, and fresh-browser restoration lifecycle
