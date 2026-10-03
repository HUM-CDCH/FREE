# Workbench integration seam checks

Date: 2026-09-30. Status: source inspection complete; proposed behavior unimplemented.
Inspected HEAD: `54c22483adc25d1bd56a26cde7300d14b9fefaa6`.
Outcome: [integration plan](../2026-09-30-workbench-workflow-integration.md).

CodeGraph was used first. Targeted reads supplied details that its queries did
not return. These observations constrain the plan; they are not runtime tests.

**Schema IDs and confirmation**

- [revision contract](../../../prototypes/studio/shared/schemaRevision.contract.ts),
  lines90–110: initialize and append accept schemaDefinitionSchema, including
  schemaNodes. [schema validation](../../../packages/extraction/src/schema.ts),
  lines29–79: node IDs are part of the validated node shape.
- [POST revision route](../../../prototypes/studio/api/schema_revisions.ts),
  lines142–154: forwards the supplied recordDescription/schemaNodes.
- [owned store](../../../packages/db/src/project-store.ts), initialize at1919,
  append at2037: persists the supplied schemaTree. Initialization refuses an
  existing head; append uses expectedRevisionNumber. The server generates
  revision/schema identities, not replacements for unique supplied node IDs.
- [editor](../../../prototypes/studio/src/currentSchemaRevision.ts), lines80–91:
  duplicate IDs can be repaired by normalization. Generate unique IDs once
  and retain them through import editing so that no repair is necessary.
- The current listing/rename route extraction_schemas.ts is not the schema-tree
  confirmation endpoint. PR6 uses schema_revisions.ts. New import-preview
  parsing must remain separate from model-operation envelopes.

**Admission and snapshots**

- [admission](../../../packages/extraction/src/postgres-admission.ts),
  samplesReviewTransfer at218: captures samples of the same source document,
  Source Representation Revision and Extraction Schema inside admission;
  orders samples before unionReviewTransfer. Finalized decisions take precedence
  over each sample's saved draft. A shared batch caller must preserve that rule.
- Single admission at296–308 already stores the snapshot in reviewTransfer.
  Batch member admission at528–545 currently writes no snapshot, although the
  field exists on the same Extraction table.
- Ordinary batch at348–402 chooses deterministic equal-selection identity unless
  repetition is create-new, which generates a fresh batch identity. Existing
  selections replay before consulting today's settings. The transaction owns
  batch/member rows and enqueues; source locks are sorted.
- [suggested admission](../../../packages/extraction/src/postgres-suggested-batch.ts),
  lines168–207: creates its own schema identity and calls the shared
  admitBatchMember. No samples of that new schema are normally eligible.
- [selection bound](../../../packages/extraction/src/batch.ts), line2: 50.
- Final workbench baseline includes `9b87c307` and `2cc29cfe` matcher/draft
  fixes. The first advisor brief predates the latter; implementation must
  preserve the final baseline's safeguards, not just the older brief.

**reviewTransfer consumers to test for batch members**

| Consumer | Existing behavior and required check |
| --- | --- |
| [postgres-attempts.ts](../../../packages/extraction/src/postgres-attempts.ts), lines57/176; [postgres-ownership.ts](../../../packages/extraction/src/postgres-ownership.ts), lines94–101 | Reads/preserves reviewTransfer in owned succeeded Extraction snapshots. Test correct batch member identity and ownership |
| [module.ts](../../../packages/extraction/src/module.ts), prepareReview38; readReviewDraft97–113 | Loads canonical pinned source; transfer presence seeds version-zero draft under destination paths and returns transfer/sources. Test batch with non-null snapshot |
| module.ts, saveReviewDraft115–143; [postgres-reviews.ts](../../../packages/extraction/src/postgres-reviews.ts) | Validates Evidence/values, pairing updates, version conflicts, reset and explicit finalization. Test direct override and pairing without cross-member decisions |
| [extractions.ts](../../../prototypes/studio/api/extractions.ts), lines106–118; [extraction contract](../../../prototypes/studio/shared/extraction.contract.ts) | Common member read exposes prepared decisions and draft. Test transfer/status/source DTO round trip |
| [reviewDrafts.ts](../../../prototypes/studio/src/reviewDrafts.ts), recover29–60 | Reconciles server/local decisions by path, Evidence and version. Test batch auth recovery and conflict retaining local changes |
| [useBatchExtractionReviewGrid.ts](../../../prototypes/studio/src/useBatchExtractionReviewGrid.ts), lines187–191; [grid](../../../prototypes/studio/src/projectContexts/BatchExtractionReviewGrid.tsx) | Already calls common member read/recovery, but its state/view does not expose transfer/sources. PR7 must add those labels and source context |

Presence of the shared read path does not prove all non-null batch consumers
are safe. PR7 keeps the spec exclusion until fixtures, integration and review
validate the extension. A snapshot failure must abort the existing whole
transaction, including suggested-schema confirmation.

**Spreadsheet parser basis**

Studio currently has fflate as a development dependency and has no ExcelJS
runtime dependency. The selected server design promotes the former and adds
the latter in PR6. The [fflate streaming API](https://github.com/101arrowz/fflate#streaming)
allows entry-by-entry output; declared ZIP sizes can be absent, so count actual
inflation. [ExcelJS's v4.4.0 reader documentation](https://github.com/exceljs/exceljs/blob/v4.4.0/README.md#streaming-xlsx-reader)
describes row streaming and shared-string/style options. This supports the
planned adapter; it does not validate a specific lockfile version, merged-header
handling or the chosen limits. Those must be exercised in PR6 before UI work.

**Concurrent baseline**

The inspected branch is feat/sample-extraction-workbench. Committed work through
54c22483 is the recorded source baseline. The then-uncommitted
docs/operations/local-development.md, .pi/skills additions and
openspec/changes/unify-catalog-extraction belong to concurrent work, outside
this plan. Only the new dated plan/evidence and the additive section6 task
reference are owned by this planning task. Recheck clean committed heads before
creating an implementation integration worktree.
