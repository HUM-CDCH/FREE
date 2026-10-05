## Context

ADR 0017 and its 2026-10-05 durable-only amendment make the durable
coordination head the only Extraction lifecycle. Saved values carry stable IDs,
their producing input selection and field node; researcher decisions are
revisioned corrections (`extraction_runtime.correction`) that advance the
Project's decision version (`feedbackHead`). A finalization
(`extraction_runtime.finalization`) names one result snapshot version and one
decision version. This change realigns the living specifications with that implemented model.
The user then required removal of the complete admission gate.

## Goals / Non-Goals

**Goals:**
- State the review requirements the durable code enforces today, at the
  boundaries where it enforces them.
- Retire requirements whose only implementation was deleted.
- Admit durable work directly, without a release flag or environment switch.

**Non-Goals:**
- Legacy compatibility, a database migration, or production enablement.
- Independent child decisions inside composite fields, or bulk decisions.
- Rewriting dated validation evidence or archived changes.

## Decisions

- **Modify rather than remove where a durable equivalent exists.** Persistence,
  ownership, reopen, explicit action and schema pinning have direct durable
  counterparts; their requirement names are kept and their text replaced, so
  history remains traceable. Only the `ProjectStore` single-transaction accept
  write, whose concept no longer exists, is removed.
- **Evidence ownership is checked against the pinned source.** Studio's
  correction handler rejects an anchor absent from the Extraction's pinned
  Source Representation or an occurrence that anchor does not own. Duplicate
  occurrence IDs are not separately rejected, so the requirement does not claim
  that.
- **Navigator retired.** The breadcrumb/back-forward navigator was removed by
  the results-review redesign before PR #185; its spec is removed in full.

- **Admission is the durable success path.** Remove the complete gate and its
  refusal API/UI handling. Commit the public row, durable head, dispatch and
  workflow enqueue together. Keep replay and rollback checks in PostgreSQL.
  The black-box Compose test must observe admission and durable completion.

## Risks / Trade-offs

- Merging the implementation removes the admission block. Its PostgreSQL,
  browser, Compose and Spark acceptance must be recorded on the current source.
  **Exact-commit Spark acceptance is a merge prerequisite**, not only an archive
  requirement. The current Baratheon test project is authorized; production
  migration and deployment are separate actions. Keep missing checks open and
  do not merge or archive the change before they pass.
