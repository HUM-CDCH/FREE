# Bring selected workflow features into the sample workbench

Date: 2026-09-30. Status: historical; superseded by dev integration and the
2026-10-02 sample workbench removal. Reconciled with dev on 2026-10-03.
This document preserves the original plan and its two Claude Code Fable 5.1
advisory rounds; it is not an active implementation handoff.
The original plan extended
[the now archived workbench change](../../openspec/changes/archive/2026-10-02-sample-extraction-workbench/proposal.md).
Current behavior follows the [removal design](../superpowers/specs/2026-10-02-sample-workbench-removal-design.md)
and [upgrade runbook](../operations/deployment.md#upgrade-sample-workbench-removal).

**Planning evidence**

- Legacy donor: workflow `ba3e7cc105faa5a4ea021c4906d749a329fd914d`.
- Workbench inspected for the first advisory round:
  `9b87c30792207a7a5aadff24df1e0c515f9824b0`; development is continuing
  concurrently. Recheck the final workbench/dev heads before implementation.
- Current remote dev at inspection:
  `287ccb4245b95654821849f91e067bbbd057c040`.
- The reviewed workbench began from dev `80686ec4`; the inspected branch
  needs the subsequent dev changes integrated. Old workflow code predates
  DBOS and the included Parsing Service.
- Final seam checks used local workbench HEAD
  `54c22483adc25d1bd56a26cde7300d14b9fefaa6`, including the additional transfer
  safeguards in `2cc29cfe`. Re-fetch dev and freeze the implementation baseline
  before starting; these inspected hashes are evidence, not branch locks.
- Both advisory rounds ran the requested `claude-fable-5-1` through Claude Code
  with tools disabled, after approval to share the prepared brief and draft.
  The [brief](2026-09-30-workbench-workflow-integration-evidence/advisor-brief.md),
  [first advice](2026-09-30-workbench-workflow-integration-evidence/round1-advice.md),
  [second critique](2026-09-30-workbench-workflow-integration-evidence/round2-advice.md)
  and [adjudication](2026-09-30-workbench-workflow-integration-evidence/advisory-decisions.md)
  are retained. The second verdict was ITERATE; this document addresses it.
  Claude did not re-review these final revisions or validate runtime behavior.
- The [donor review](2026-09-30-workbench-workflow-integration-evidence/workflow-review.md)
  records the original branch changes, defects and 39 workflow/dev merge
  conflicts. A workflow/workbench simulation at `21e7d85f` had 38 conflicts;
  recalculate on the frozen candidate rather than using either count as current.
  The [seam checks](2026-09-30-workbench-workflow-integration-evidence/seam-checks.md)
  record the current contracts behind this plan.

**Outcome**

A researcher can create or import a schema, try it on chosen pages, review
values beside fields, use a problematic value to reach the right field,
change the schema and try the same pages again. Guidance makes the next useful
action clear, and a collection start shows the limits of the samples already
reviewed. The workbench remains the editing and review surface.

A Sample Extraction stays an Extraction over at most 30 physical pages. It
never becomes a full-document result or project-summary result. A later
whole-document Extraction runs normally and can start with matching Carried
Review Decisions as drafts. Sampling demonstrates behavior on those pages;
it proves neither source-wide absence nor extraction accuracy.

**Feature selection**

| workflow idea | Decision for this plan |
| --- | --- |
| Workflow steps and next-action prompts | Adapt to derived guidance over current data and actor state; no new lifecycle or saved completion flags |
| Field-level schema issue action | Adopt as a transient, source-labelled jump into the existing editor; no SchemaIssueFlag table |
| Review prioritisation and completion summaries | Adopt descriptive grounding/review counts and unresolved-cell navigation; no accuracy score |
| Missing/ungrounded-cell review | Use existing workbench PR3 Evidence rules and optional additional decisions; adopt classification, not legacy mandatory decisions on every empty occurrence |
| Spreadsheet schema suggestion | Adopt upload → preview → researcher confirmation → ordinary Schema Revision; do not persist a spreadsheet slot or gold data |
| Stabilised schema state and hard collection gate | Defer; show factual coverage and actionable warnings without a mandatory acknowledgment or a new server gate |
| Whole reviewed-result cloning/reuse | Defer; no copying sample outcomes and no completed-result cache redesign in this plan |
| Sample-review transfer into batch members | A separately accepted final follow-up after single transfer is validated; same matcher and existing reviewTransfer column |
| Sidebar/cancellation rewrite | Superseded by current durable Source Ingestion; retain it |
| Parallel parsing, gold corpora, evaluation dashboards, few-shot examples and retry infrastructure | Separate changes; not prerequisites or implied deliverables |

The donor provides behavior and UI references, not commit/cherry-pick
boundaries. Its commits mix features and incompatible generated migrations.

**Invariants and decisions**

1. Keep current authentication/ownership, signed sessions, origin checks,
   per-account provider configuration, pinned method/model choices, canonical
   source revisions and DBOS admission/recovery. No old app/ parser,
   ExtractionJob, BatchExtractionMember, lease worker or second queue.
2. New migrations, if actually needed, start from the integrated current
   workbench/dev chain. Never replay the donor's migrations or regenerate
   the baseline to accommodate it.
3. Grounding, review and extraction completion are separate facts. A grounded
   value may be undecided; a saved draft is not a finalized review; a reviewed
   sample is not complete for its source. No “success percentage” or inferred
   schema-readiness badge.
4. Preserve the active PR3 policy: optional decisions on ungrounded/missing
   paths use canonical researcher-picked Evidence as specified there.
   This adoption adds no “confirmed absent” decision kind, no absent-value
   transfer and no “approved elsewhere” shortcut. A missing cell is an
   attention classification; adding a value follows PR3's Evidence flow.
   Missing and ungrounded cells are excluded from the mandatory review
   completion denominator, while optional validated decisions remain allowed.
   Keep their descriptive attention counts after finalization, separately
   labelled from remaining required decisions. No dismissal state is needed.
   Existing exact decision-set rules for grounded paths still apply.
5. Current whole/batch admissions remain usable under their existing guards.
   Guidance may warn that the current revision has no reviewed samples or
   only limited page coverage. It does not demand a new acknowledgment,
   set stabilisedAt or treat review counts as a correctness guarantee.
6. Schema suggestions and changed guidance do not silently run extraction.
   Editing/description proposals keep explicit Apply and flush-before-run.
   Re-run after a changed schema uses a new Extraction ID; retry of an
   uncertain admission retains the existing identity.
7. Keep old finalized research/history readable. A new attention display
   cannot retroactively invalidate an existing review or rewrite its decisions.

**Delivery order**

The active workbench tasks remain the source of truth for existing PR1–PR4.
Freeze a clean, committed workbench candidate and create a dedicated
integration branch/worktree from it; integrate freshly fetched dev there.
The inspected `54c22483` commit, including committed transfer fixes and tool
updates, is inside the recorded baseline. Uncommitted local-development docs,
`.pi/skills` additions and `unify-catalog-extraction` are concurrent work outside
this plan; include them only through an explicit later baseline update. Do not
stash, reset or copy them into the integration candidate. Record both heads and
resolved conflicts. First validate and independently review page scope, single
transfer and hand pairing; resolve findings before extending admission.
Port selected behavior into that branch and eventually target dev with PRs
under CONTRIBUTING.md. Do not merge or cherry-pick the whole workflow branch.

Existing PR3 (Evidence and structural editing) and PR4 (description proposals
from corrections) continue as already planned. The adoption below must not
duplicate those tasks. PR5b ships field navigation using the existing manual
editor, with no PR4 correction-context hook. Whichever of PR4 and PR5b lands
second adds that hook through a small integration task; ownership and the
20-correction bound stay with PR4. This does not block manual navigation or import.

| Boundary | Dependencies | Researcher-visible completion |
| --- | --- | --- |
| PR5a: review attention | Validated PR1/PR2 and PR3 Evidence semantics | See grounded, ungrounded and missing cells with honest decision counts; navigate attention without changing a decision |
| PR5b: field-context jump and guidance | PR5a; existing manual editor/save; independent of PR4 | Reach the field, preserve edits, re-run its pages and see current-source/selected-source coverage |
| PR6: spreadsheet schema import | Existing schema-create/revision/confirmation path; independent of PR4 model calls | Upload an Excel codebook, inspect/edit its inferred tree, confirm it and run an ordinary sample |
| PR7: sample decisions in collection review | Single-transfer acceptance and independent review; PR5 labels | Full batch members extract normally and start review with safely matching sample decisions |

PR5a, PR5b and PR6 are the immediate selected-feature delivery. PR5a and PR5b
are separately mergeable, usable PRs; record their adjacent bases and merge
order. PR7 is a distinct
follow-up, not a reason to delay shipping them. Complete PR7's specification
and tests before changing batch admission.

**PR5a/PR5b — guidance and field review in the workbench**

Implementation seams:
`prototypes/studio/src/App.tsx`, `SchemaPanel.tsx`,
`projectContexts/ProjectContextPage.tsx`,
`projectContexts/BatchExtractionReviewGrid.tsx`, `ui/PhaseProgress.tsx`,
`projectNavigation.ts`, `schemaSaveCoordinator.ts`,
`packages/extraction/src/review-paths.ts`, `review-rules.ts` and the
existing extraction/project DTO mappers. Proposed new selector/read-model
modules should own the calculation rather than duplicate it across screens.

Tasks for PR5a (shared read model and attention navigation):

- [ ] Define one shared attention calculation using an Extraction's pinned
  schema and actual scalar occurrences. Keep two orthogonal axes: presence/
  grounding (present+grounded, present+ungrounded, missing), and decision state
  (none or a decision, with action and explicit/carried provenance). Review
  finalization is one Extraction-level fact, not a cell state. Default prepared
  approvals are not saved researcher decisions. Separate required grounded
  decisions remaining from optional missing/ungrounded attention counts;
  apply the accepted PR3 validation rule. Empty arrays create no phantom cells.
- [ ] Expose/consume that calculation through existing extraction read DTOs.
  API summaries and client cell ordering use the same definition.
  Historical samples stay labelled with their revision and page scope.
  Do not classify a past run against today's edited schema tree.
- [ ] Add a non-blocking attention view/filter for unresolved, changed,
  unsupported and missing cells. Reuse existing record labels and two-way PDF
  provenance; selecting a cell opens/focuses it without changing its decision.
Tasks for PR5b (field jump, re-run and derived guidance):

- [ ] Add “Edit this field” at a value/column. Carry source Extraction ID,
  pinned schema revision, node ID and selected source paths as transient
  navigation data. Resolve stable node identity into the current editor;
  show old/new types and revision context when changed. If removed, offer
  the historical view and a clear explanation; do not guess by name.
  Preserve any unsaved editor tree when focusing a field. Navigation neither
  reloads over it nor silently discards it; a conflict offers the existing save/
  reload resolution. Add the PR4 hook only in the later integration task.
- [ ] Offer “Save and re-run these pages” through the existing save/admission
  path. Preserve exact page selection, saved method and source pin checks.
  A failed save/admission remains recoverable; an explicit new run has a new
  identity. If the source was reprocessed, require a fresh scope choice.
- [ ] Add guidance selected from existing project/read data and XState actor
  snapshots/capabilities: ingest, create/import schema, run sample, review,
  change/re-run, try another source, run whole source/start batch. Keep
  authoritative existing guards; derive the suggestion rather than persisting
  a phase, readiness flag or duplicate execution state.
- [ ] Show separate admitted, saved-draft and finalized sample facts. Count
  physical pages by `(sourceDocumentId, sourceRepresentationRevisionId, page)`
  under the selected Schema Revision; deduplicate within each source revision,
  then sum source totals. Five samples of two pages cover two pages. Historical
  schema/source samples remain visible but excluded from current coverage.
  Project-wide coverage is deferred; existing project result/activity summaries
  stay sample-free.
- [ ] Add a bounded, account-owned sample-facts projection for the sources
  selected in collection start, under their current source pins and selected
  Schema Revision (at most the existing 50-member selection limit). Show per-
  source facts and their sum, distinguishing saved drafts, finalized samples and
  full-document results. If unavailable, show “sample coverage unavailable”,
  never a project total or an invented zero. Refresh changed source pins before
  start. Testing more sources remains optional; an issue rate is not readiness.

Acceptance:

- A grounded undecided cell stays grounded and undecided; finalization remains
  governed by the existing validated decision set.
- Missing/ungrounded values stay visible. A review with three missing cells
  and all required grounded decisions can finalize with zero required decisions
  remaining; three missing cells remain separately labelled attention. Canonical
  Evidence corrections use PR3; no null-anchor “approved elsewhere” action appears.
- The API summary and rendered grid classify the same fixture identically,
  including nested/reordered arrays, carried drafts and finalized reviews.
- Five reruns of pages12–13 show two unique pages on one source. Stale schema
  or source samples do not count as current coverage.
- Jumping from an older revision finds a renamed stable node, shows a type
  change, or explains a removed node. A dirty editor keeps its edits; navigation
  does not mutate or replace the schema.
- Dirty schema → save → re-run uses the acknowledged revision and the same
  sorted page list. A reload restores admitted work and persisted reviews.
- A successful zero-record result says “no records extracted on these pages”;
  it does not report source-wide completeness or accuracy.
- Selecting three sources, one sampled and two unsampled, shows facts for
  those three current pins. Reprocessing the sampled source removes its old
  pages from current coverage and updates its warning.
- A six-source batch remains admissible without a new readiness gate, on
  both existing-schema and suggested-schema paths, subject to existing guards.

**PR6 — bounded spreadsheet schema import**

Implementation seams:
`prototypes/studio/api/schema_revisions.ts`, `extraction_schemas.ts`,
`shared/schemaRevision.contract.ts`, `src/SchemaPanel.tsx`,
`schemaSaveCoordinator.ts`, current schema proposal/confirmation UI,
`packages/extraction/src/schema.ts` and the owned schema store.
Add a narrowly named authenticated import-preview route/helper if needed;
a deterministic import is not a model call or a new durable workflow.
Inspect the existing confirmation components before choosing reuse:
model-edit envelopes must not be stretched into an incompatible schema-create API.

Parser choice: server-side `.xlsx` only, using a streaming `fflate` ZIP
preflight followed by ExcelJS's streaming `WorkbookReader` adapter. Promote
`fflate` from Studio's development dependency to a runtime dependency and add
ExcelJS only to the server surface; pin the chosen versions in the PR. The
[fflate API](https://github.com/101arrowz/fflate#streaming) exposes entry streams;
[ExcelJS documents row streaming and reader options](https://github.com/exceljs/exceljs/blob/v4.4.0/README.md#streaming-xlsx-reader).
These APIs support this design; they do not supply the application's limits.

Tasks:

- [ ] Add `.xlsx` upload to the schema-entry surface. Initial limits: 5MiB
  compressed input, 25MiB cumulative expanded ZIP bytes, one explicitly
  selected worksheet, 200 columns, 5,000 data rows and 64KiB per decoded cell.
  Reject `.xls`, encrypted/macro-enabled workbooks and unsupported formats.
  Reject an exceeded bound with row/column context; do not silently inspect
  a truncated prefix and call it the whole selected worksheet.
- [ ] Complete ZIP preflight before calling ExcelJS: validate entry names and
  declared sizes when present, and count actual inflated bytes across all
  entries, stopping on the expanded bound even when sizes lie or are omitted.
  Use small input chunks and clean up/terminate streams on rejection. Reject
  duplicate/ambiguous ZIP entries. Enforce row, column and decoded-cell limits
  in the reader adapter, including shared strings; inspect selected-sheet
  merge ranges and reject merged headers before tree generation. The bounded
  metadata/XML pass is part of the adapter if the row reader omits those ranges.
  Prove guard ordering with an over-expansion fixture before adding the UI;
  byte acceptance limits are not a claim of a hard process memory bound.
- [ ] Read headers as data with safe own-property access and null-prototype
  maps (or an equivalent tested safe representation). Validate against the
  canonical schema rules. Duplicate paths and leaf/group collisions produce
  column-specific errors; reject empty/ambiguous path segments. Header row and
  nesting separator are explicit. In flat mode separators are literal; in
  nested mode a literal separator requires renaming the column before confirm.
  Dangerous property names must be safely handled as data or explicitly
  refused before mutation, never silently discarded.
- [ ] Preview flat fields or an explicit researcher-chosen nesting separator.
  Let the researcher include/exclude/rename columns and revise type hints.
  Keep leading-zero identifiers, dates, rich text and formula results explicit;
  reject unsupported cell representations instead of silently coercing them.
  Numeric inference must be lossless; enum inference is opt-in per field.
  A header named filename is not silently reserved for gold linkage.
- [ ] Build fresh stable node IDs once for the preview, retain those IDs through
  edits and confirmation, and pass the tree through current schema validation.
  Require the normal record description and explicit researcher confirmation.
  The current POST /api/schema-revisions accepts schemaNodes with their IDs;
  initialize/append stores the supplied tree. No node-ID contract extension
  is planned (see seam evidence). Require unique IDs so editor normalization
  does not repair collisions. Choose initialize for an empty project schema or
  explicit append to the selected schema under its expected-head predicate.
  Current initialization is conflict-sensitive, not an idempotent create API:
  retain the acknowledged result; after an uncertain write read/reconcile the
  head/tree before retrying, rather than blindly initializing another schema.
  Never overwrite a revision as a side effect of upload.
- [ ] Keep workbook bytes and column data transient. Persist the confirmed
  schema through existing revisions; add no project spreadsheet table,
  filename uniqueness rule, gold-record linkage or saved field-value mapping.
  Closing/reloading an unconfirmed preview may require re-upload, clearly
  communicated. No model call, API key or source Evidence claim is implied.
- [ ] After confirmation, enter the ordinary page sample/review flow from PR5.

Acceptance:

- Prototype-path, duplicate, blank, empty-segment and leaf/group-collision
  inputs cannot mutate Object.prototype or produce silently missing fields.
  Merged headers fail with column context. Literal separator headers in flat
  mode stay literal; nested mode requires an unambiguous edited path.
- Exactly 200 columns and 5,000 rows pass when otherwise valid; column201 or
  data row5,001 fails explicitly. Compressed/expanded/cell-size boundary and
  lying/omitted ZIP-size fixtures exercise the guards before schema writes.
- Numeric-looking IDs such as0012 stay strings by default. Enum hints do not
  create an allowed-values constraint until the researcher chooses it.
- Upload/preview/cancel writes no schema revision. Confirmation writes the
  expected revision with the same node IDs; stale-head conflicts surface.
- Another account cannot preview/save into the project. All failures use
  validation/client errors as appropriate, not generic storage-outage errors.
- The confirmed schema runs a normal sample, with the same Evidence and
  transfer rules as a manually created schema.

**PR7 — batch review transfer, after validation**

Implementation seams: `packages/extraction/src/postgres-admission.ts`
(`samplesReviewTransfer` and batch/suggested-batch admission),
`postgres-suggested-batch.ts`, `postgres-attempts.ts`, `postgres-batches.ts`,
`postgres-reviews.ts`, `module.ts`, `review-rules.ts`,
`prototypes/studio/api/extractions.ts`, `_batch_suggestion_workflow.ts`,
`src/projectContexts/BatchExtractionReviewGrid.tsx`,
`src/useBatchExtractionReviewGrid.ts`, `src/reviewDrafts.ts` and shared DTOs.

Tasks:

- [ ] First update the workbench review-transfer specification's explicit
  “batch pins nothing” exclusion to describe this follow-up. Extract the
  existing single-admission snapshot function behind one shared, owned
  admission seam; preserve the matcher and both `9b87c307` and `2cc29cfe`
  safeguards. Recheck newer fixes at the frozen baseline.
- [ ] At each fresh member admission, capture matching samples under that
  member's document, Source Representation Revision and Extraction Schema
  identity using the existing eligibility rule, in the same transaction as
  its Extraction row and DBOS enqueue. Keep its execution method pinned. Reuse Extraction.reviewTransfer;
  it already exists on all Extraction rows. No new snapshot column/table is
  required absent an independently demonstrated storage need.
- [ ] Cover ordinary and suggested batches through `admitBatchMember`.
  Existing ordinary equal-selection/reuse admission replays its deterministic
  batch/member IDs, retaining snapshots; `repetition: create-new` admits new
  identities and captures current decisions. DBOS restart/recovery and
  transport retries of admitted identities never recapture. Suggested-batch
  same-suggestion confirmation replays its existing identities; a retry of
  schema generation before confirmation is not a member-admission retry.
  Its newly created Extraction Schema has no eligible old samples, so null
  transfer is normal. Add no new retry route or changed repetition semantics.
- [ ] Audit the previously unexercised combination of non-null
  batchExtractionId and reviewTransfer: attempt snapshot/owned extraction
  readers, module.readReviewDraft and pairing/save/finalize, the GET Extraction
  DTO, client recoverReviewDraft and the batch grid. The current grid uses the
  common read/recovery path but does not expose transfer statuses/sources;
  update its view model rather than assuming it already handles them. Add
  non-null batch fixtures for every consumer before enabling admission.
- [ ] Seed the member's review through the existing prepare/recover-draft path,
  with its own result paths and carried provenance. Expose reviewed-in-sample,
  changed, unmatched and remaining counts in the batch grid. Saved decisions
  override carried suggestions; optimistic conflicts and explicit finalization
  remain unchanged.
- [ ] A snapshot query/validation failure aborts the whole existing batch
  admission transaction: no partial batch, member, confirmed suggestion or
  queued workflow. Do not silently admit a failed snapshot as null; null means
  no eligible sample decisions. Preserve sorted document locks and atomic enqueue.
- [ ] Restrict queries to the selected sources and existing 50-member bound.
  Share/batch snapshot reads where practical; load no whole-project sample
  history and copy no full result. With six and 50 selected-source fixtures,
  prove no queries include an unrelated source and that query counts grow
  linearly in eligible sample history rather than members times history.
  Record elapsed time, query count and snapshot bytes in the receipt for
  tuning; no arbitrary latency promise or silent decision truncation.

Acceptance:

- A mixed batch includes sampled and unsampled sources. Every source is
  freshly extracted in full; only matching values begin with carried drafts.
- Unexpected value/Evidence changes, a different source representation,
  removed/disallowed fields, ambiguous automatic record matches and invalid
  or stale manual pairings do not carry. Valid one-to-one manual pairings and
  the existing correction/same-mistake cases keep their validated semantics.
- Two samples on different page sets of one source both contribute. If they
  conflict on an aligned record/node, the existing union's newer-sample
  precedence and deterministic tie-break apply; unaligned decisions remain.
- Later sample-review edits cannot change admitted member snapshots.
  Recovery/replay do not refresh them; create-new captures the changed set.
- A snapshot failure on member4 of six rolls back all batch/member rows and
  enqueue records, including suggested-schema confirmation. Retrying the
  uncommitted admission can capture current samples because no pins committed.
- A wholly carried member still requires explicit review finalization, and its
  extraction identity is readable in grid, document and results endpoints.
- A cross-owner source/sample is refused without partial rows/workflows.
- Suggested-batch admission obeys the same behavior; no special route can
  bypass snapshot/pin/ownership checks.

**Verification and recording**

Before each PR, add the applicable OpenSpec scenarios and run targeted unit/UI
checks, then typecheck and lint. Persistence/admission changes also require
guarded PostgreSQL integration, fresh/upgraded forward-migration checks when
schema changes occur, DBOS restart/replay and draft-conflict scenarios.
Use only caller-provisioned loopback port5432 postgres free_test_* databases.

Before the combined adoption is accepted, run pnpm test:all with its documented
infrastructure and the authenticated browser flow:
import/create → sample → review → field jump/edit → same-pages re-run →
whole-document extraction → collection review. Run local Parsing Service and
test:service tiers as required by touched contracts; hosted CI skips Python.
Record a dated validation receipt and obtain the required independent review.
This planning task claims no runtime validation for the proposed features.

**Remaining decisions**

Spreadsheet limits above are initial product defaults with executable
boundary cases; confirm representative codebooks and resource use before
release. Dependency versions and the adapter's precise XML pass are settled
in PR6's bounded-parser implementation and tested before adding upload UI.
Capture any adjustment in the import spec. PR7 is gated on
completed single-transfer validation, not on a claim that the legacy reuse
feature was safe. A future mandatory collection readiness rule, whole-result
reuse, project spreadsheet storage or absent-value decisions needs its own
explicit requirements and evidence before broadening this plan.
