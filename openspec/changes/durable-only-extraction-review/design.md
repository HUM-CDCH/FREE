## Context

ADR 0017 and its 2026-10-05 durable-only amendment make the durable
coordination head the only Extraction lifecycle. Saved values carry stable IDs,
their producing input selection and field node; researcher decisions are
revisioned corrections (`extraction_runtime.correction`) that advance the
Project's decision version (`feedbackHead`). A finalization
(`extraction_runtime.finalization`) names one result snapshot version and one
decision version. This change only realigns two living specifications with that
implemented model.

## Goals / Non-Goals

**Goals:**
- State the review requirements the durable code enforces today, at the
  boundaries where it enforces them.
- Retire requirements whose only implementation was deleted.

**Non-Goals:**
- New behavior, legacy compatibility, a migration, or enabling admissions.
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

## Risks / Trade-offs

- The durable model's PostgreSQL, browser and Spark acceptance remains unrun for
  the durable-only diff → tasks keep those checks open; this change must not be
  archived until they pass on an exact commit.
