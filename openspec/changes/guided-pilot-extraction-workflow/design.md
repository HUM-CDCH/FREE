## Context

Today, `ProjectContext.phase` (`prototypes/studio/shared/projectContext.contract.ts:24`,
computed in `packages/db/src/project-store.ts:1256-1267`) is
`ingest → chat → approve → extract → validate`, where `approve` means
"a `SchemaRevision` exists." Once a revision exists, both single-document
extraction and full batch/collection-level extraction
(`packages/extraction/src/batch.ts`) are equally reachable — there is no
concept of "tried on a few documents" versus "trusted for the whole
collection." `BatchExtractionReviewGrid.tsx` reviews one extraction attempt
at a time and has no notion of pilot rounds, schema-level flags, or reuse of
prior results in a later batch.

This design adds a lightweight state machine around `SchemaRevision`
(piloting → stabilised), a small new data shape for schema-issue flags, and
extends the existing review grid and batch-creation path to support guided,
multi-round pilot review before unlocking batch extraction — without
touching extraction internals, the schema-editing chat flow, or
`extraction-review-metrics-and-sampling`'s in-flight work (which this change
depends on but does not modify; see proposal.md).

## Goals / Non-Goals

**Goals:**
- Make "good enough to test" and "good enough to batch" two distinct,
  explicit states, with batch extraction gated on the latter.
- Let a researcher flag a schema field as problematic from inside the review
  grid and jump to the schema editor with that context, without conflating
  "edit a value" and "edit the schema" in one screen.
- Support reviewing multiple pilot rounds without losing visibility into
  already-reviewed documents, and without forcing re-review of settled work.
- Avoid re-extracting documents in the full batch run that were already
  piloted and reviewed under the schema revision being batched.
- Guide the researcher at each decision point with in-context copy, not
  silent state changes.

**Non-Goals:**
- Building the few-shot "correction examples" or batch-retry mechanisms —
  owned by `extraction-review-metrics-and-sampling` (phase 3), depended on
  but not built here.
- Reviving the dead annotation-feeds-schema-suggestion path.
- A hard cap or hard gate on how many pilot rounds a researcher may run.
- Changing how extraction itself is computed, grounded, or scored.

## Decisions

**D1. Stabilised state lives on `SchemaRevision`, not `ExtractionSchema`.**
Add `stabilisedAt Timestamptz6?` to `SchemaRevision` (nullable, default
null). Every new revision starts unstabilised — including one created by
committing a schema-issue fix — so there is no separate transition logic
needed on `ExtractionSchema` itself, and no risk of a stale "stabilised"
flag silently surviving a schema edit. Alternative considered: a status enum
on `ExtractionSchema` (`PILOTING`/`STABILISED`); rejected because it would
need explicit resetting on every new revision, duplicating what falls out
for free from scoping the flag to the revision row that batch extraction
already references (`schemaRevisionId` is already the FK on `Extraction`,
`BatchExtraction`, and `ExtractionJob`).

**D2. Batch extraction gate — revised: a pilot round *is* a small Batch
Extraction, not a separate concept.** Earlier revisions of this design (and
the first implementation pass) treated "pilot" as independent single-document
`Extraction`s outside the batch system entirely, requiring a new pilot-mode
grid, a new "list Extractions by schema revision" query, and a bespoke
round-grouping heuristic (see the superseded D4 below). That turned out to
be solving a problem the existing `BatchExtraction` machinery already
solves: `BatchExtractionReviewGrid.tsx`, `useBatchExtractionReviewGrid.ts`,
issue-score sorting, and `listBatches` (already filterable by
`schemaRevisionId`, since every `BatchExtraction` carries one) all work
unmodified for a 2-5-document batch — there is no need to build a second
grid or a second query.

So: `scheduleBatch`'s gate is **size-based, not batch-vs-non-batch**. A
request with `sourceDocumentIds.length <= PILOT_BATCH_SELECTION_LIMIT`
(`packages/extraction/src/batch.ts`, currently 5) is allowed to create a
`BatchExtraction` regardless of `stabilisedAt` — that *is* how a pilot round
runs, as an ordinary small Batch Extraction. A larger, collection-scale
request is rejected with `schema_not_stabilised` unless
`schemaRevision.stabilisedAt` is set. A "stabilise" action (small API route)
sets `stabilisedAt = now()` on the current revision; it requires at least
one pilot round to have been reviewed (see D5) — enforced server-side, not
just hidden client-side, since this is the one hard gate in the whole
design.

"Round list" in the frontend (§3, revised) is then simply
`listBatches({ projectContextId })` filtered to `schemaRevisionId ===
current` and `members.length <= PILOT_BATCH_SELECTION_LIMIT` — each row
links to the existing single-batch view. Clicking through to see a round's
documents ("点击跳转才显示", per product discussion) is exactly that
existing batch-detail navigation; no new stacked-grid rendering is needed.

**D3. Schema-issue flags are field-scoped and revision-scoped, not
value-scoped.** New small table `SchemaIssueFlag` (`schemaRevisionId`,
`fieldPath`, `note?`, `createdAt`), one row per flagged field per revision.
Flagging is idempotent per `(schemaRevisionId, fieldPath)` (re-flagging
updates `createdAt`/`note`, doesn't duplicate). The "jump to schema editor"
action reads open flags for the current revision and passes
`{ fieldPath, note, sampleEvidence }` as initial context into the existing
conversational schema-edit entry point (`schema-chat-edit` capability) —
this is a client-side navigation/context hand-off (e.g. router state or a
short-lived query param), not a new persisted "session" concept. Flags are
cleared (not deleted, marked `resolvedAt`) when a new `SchemaRevision` is
committed for that `ExtractionSchema`, since the fields they pointed at may
no longer exist as described.

**D4. Superseded by D2's revision — kept here for history.** This design
originally proposed deriving pilot "rounds" from timestamp-clustering over
independent single-document `Extraction`s, since there was no explicit
grouping unit for "the 2-3 documents picked together." Under D2's revision,
a round *is* a `BatchExtraction` row — an explicit, unambiguous grouping
that already exists — so no derivation, clustering, or new persistence is
needed at all. `prototypes/studio/src/pilotRounds.ts`'s `groupIntoPilotRounds`
(and its `PILOT_ROUND_GAP_MS` tolerance, needed only because timestamps
alone can't disambiguate independent single-document Extractions) is dead
code under the revised design — round listing is `listBatches` filtered by
`schemaRevisionId` and size, full stop. `suggestReadyToStabilise` (D5)
survives, recomputed per-batch instead of per-derived-round.

**D5. Soft "ready to stabilise" signal reuses `review-grid-prioritization`'s
issue score unchanged.** Compute, client-side, the mean issue score of the
active round versus the mean issue score of the immediately preceding round
(both already computable from existing per-document diagnostics); if it has
not increased, show a dismissible "this round looks cleaner — you may be
ready to stabilise" banner. This is advisory only, consistent with that
capability's existing "advisory, never gates approval" requirement — it
does not gate the stabilise action itself (D2's gate is the one hard rule:
at least one round reviewed, not "issue score below X").

**D6. Batch-extraction pilot-reuse — clone, never re-point.** When creating
a `BatchExtraction`, for each selected source document: if an `Extraction`
already exists for that `(schemaRevisionId, sourceDocumentId,
sourceRepresentationRevisionId, strategy)` tuple with `reviewedAt` set,
**clone** it into a new `Extraction` row scoped to the new batch (copying
`outcome`/`complete`/`modelAttribution`/`diagnostics`/`failure`/
`resultPayload`/`evidenceLinks`/`reviewable`/`reviewedAt`, plus its
`ExtractionReview`/`ReviewDecision` trail so the reviewed value still reads
back correctly), linked via `retryOfId` to the original for lineage;
otherwise create a fresh `Extraction` as today.

Earlier drafts of this decision (and the first implementation pass)
**re-pointed** the existing Extraction's `batchExtractionId` at the new
batch instead of cloning. That is unsafe now that a pilot round is itself a
`BatchExtraction` (D2): `Extraction.batchExtractionId` is a single FK
(`extraction_batch_pin_fkey` requires exactly one owning
`(batchExtractionId, schemaRevisionId, strategy)` per row) — re-pointing it
away from the pilot batch that originally owned it makes that pilot batch's
own `loadBatch` read fail (`"Completed Batch Extraction member is missing
its Extraction"`), since the Extraction it expects to find by
`batchExtractionId` no longer references it. Cloning avoids this entirely:
each batch (pilot or final) always owns its own Extraction row, and both
remain independently readable. The storage cost (a duplicated
result/evidence payload per reuse) is accepted as strictly preferable to a
broken historical view; nothing else in the schema needed to change (no
many-to-many join table) because `retryOfId`'s existing composite FK
already requires — and the reuse query already guarantees — matching
`sourceRepresentationRevisionId`/`schemaRevisionId`/`strategy` between the
clone and its origin.

## Risks / Trade-offs

- [Deriving rounds instead of storing them (D4) makes the grid's grouping
  logic depend on `createdAt` ordering being meaningful] → acceptable since
  `Extraction` rows are already created in request order and never
  reordered; add a test pinning this assumption.
- [Field-path-based flags (D3) can go stale if a field is renamed rather
  than removed between revisions] → mitigated by clearing flags on every new
  revision (D3); a renamed field simply loses its flag, same as a removed
  one — acceptable, this is advisory triage data, not an audit record.
- [Gating batch extraction only on "≥1 pilot round reviewed" (D2/D5), not on
  issue-score quality] → intentional: the researcher, not the system, judges
  quality; a hard quality gate would need a validated threshold this change
  has no basis for setting. Mitigation is the visible soft signal (D5), not
  an automated block.
- [This change's value for multi-round pilot review is partly aspirational
  until `extraction-review-metrics-and-sampling` phase 3 lands] → the
  pilot-round UX (selecting new documents, reviewing, stacking) is fully
  functional without it; only the "your corrections improve the next
  round's extraction" causal benefit is deferred. Copy should say "review
  the new round" rather than promise improved accuracy until that
  dependency ships.

## Migration Plan

- Additive-only DB changes: `stabilisedAt` nullable column on
  `SchemaRevision` (existing rows get `null`, i.e. "not yet stabilised" —
  see rollout note below), new `SchemaIssueFlag` table. No backfill
  required; both are safe as a standard additive migration.
- **Rollout note**: because `stabilisedAt` defaults to `null` for all
  existing `SchemaRevision` rows, every Project Context with an
  already-approved schema will appear "not stabilised" immediately after
  deploy, blocking batch extraction until someone clicks "stabilise" — even
  though they may already be past pilot-testing in practice. Ship a
  one-time backfill alongside the migration that sets `stabilisedAt =
  createdAt` for any `SchemaRevision` that already has a prior
  `BatchExtraction` referencing it (i.e., it was already trusted for batch
  use under the old, ungated flow), so this change does not retroactively
  block existing researchers' in-progress collections.
- No API breaking changes: `batch_extractions.ts`'s create route gains a new
  failure mode (409 when not stabilised) that did not exist before; existing
  successful-path response shapes are unchanged.
- Rollback: drop the gating check in the batch-creation route first (feature
  flag or revert that one check) if the gate needs to be disabled quickly;
  the schema/table additions are backward-compatible and don't need to be
  rolled back to restore old behavior.

## Open Questions

- Exact copy/wording for the guided CTAs at each decision point (flag
  action, "ready to stabilise" banner, batch reuse explanation) — needs
  product/UX sign-off, not a technical decision; placeholder copy will ship
  in tasks and can be revised without further design changes.
- Whether the stabilise action should be reversible (an "unstabilise" to
  force back into piloting) — not required by the current product spec;
  deferred until a real need surfaces.
