# 0032: A suggestion is saved as an ordinary Extraction Schema

Date: 2026-11-11. Status: proposed.

## Context

Batch Extraction preparation had two ways to reach a Run. A chosen Extraction Schema was edited through the ordinary
durable editor, which appends immutable Schema Revisions. A Batch Schema Suggestion was edited as a second, mutable
draft stored on the suggestion row (`PATCH …/draft` with its own version check), and ran through its own path
(`POST …/run`), which saved that draft as a Schema Revision and opened a batch in one step. So there were two editors,
two save protocols and two Run paths. A suggestion's Run also pinned the Source Representations the suggestion had
been generated from, not the current ones. The spreadsheet template's Confirm used the suggestion Run, which always
refused it (409): a spreadsheet suggestion has no sources.

## Decision

1. **A suggestion is an operation that produces a definition.** `POST /api/batch-schema-suggestions/<id>/apply`
   saves the attempt's settled result as an ordinary Extraction Schema and its revision 1 (origin SUGGESTION, no
   Record Scope). It is named once, at creation, after its sources ("Suggested from <first document> +N") or its
   spreadsheet's file name, with " (2)", " (3)"… when the project already has that name; "Suggested fields" when no
   source is left. Under the project and suggestion row locks it requires the attempt the client read,
   phase READY, a valid result and no active attempt. Its IDs are keyed by the suggestion and the result's semantic
   tree, so a repeated or concurrent apply (two tabs, an uncertain POST, a row confirmed by earlier code) returns the
   same schema. It starts no workflow and no batch; `suggestSchemaBatch` is unchanged.
2. **One editor, one save protocol, one Run.** The saved schema is edited by the ordinary durable editor (default
   debounce, immutable revisions, conflict check) and run by the ordinary Run, which waits for the editor's pending
   save and admits the revision it acknowledged, whose Record Scope decides the strategy. Every intermediate revision
   stays recoverable from the editor's history whether or not it ever ran.
3. **The model never writes into an existing schema.** Retrying after a result was saved clears the suggestion's
   pointer; the next result is saved as another schema. The earlier one, with every revision the researcher made,
   stays theirs.
4. **A spreadsheet template is saved with its suggestion row**, in the same transaction. The spreadsheet's inline
   editor and its Confirm are removed; the template is listed and edited like any other.

Rejected: a mutable draft snapshotted only at Run. It keeps a second persistence whose intermediate states are not
recoverable.

## Consequences

- Removed: `PATCH …/draft`, `POST …/run`, `updateBatchSchemaSuggestionDraft`, `persistSuggestedBatch` and
  `scheduleSuggestedBatch`, and the client's suggestion state machine and suggested-schema editor.
- A suggested schema starts with no Record Scope: choosing Article or Catalog appends revision 2. It starts
  unstabilised, so the existing gate applies to it as to any schema.
- "Regenerate" becomes "Suggest again", which creates another schema.
- A project now routinely holds several schemas, so a codebook import no longer initializes "the" schema (refused once
  the newest schema had a revision): `POST /api/extraction-schemas` creates a new schema, revision 1 the imported
  definition.
- The project summary no longer counts "schema drafts": suggestion drafts no longer exist.
- A saved suggested schema is deleted like any other. Its suggestion then reads as unsaved, and suggesting fields for
  the same selection saves the same result again, under the same IDs.
- No row is deleted or rewritten. Schema Revisions, Batch Extractions, Extraction Results, Evidence and Review
  Decisions stay where they are. A row confirmed by earlier code reads as saved through `confirmedSchemaRevisionId`. A
  row never confirmed is saved from its `draft` on apply, which for such rows holds the researcher's own edits; the
  removed draft endpoint validated them with the same parser apply uses, so every stored draft can be saved and no
  data migration is needed. The `draftVersion` and `batchExtractionId` columns are no longer written or read; a later
  migration can drop them.

## Decided alongside, not required by the unification

**A Batch Extraction pins its members' current Source Representations at admission**, as every other Batch
Extraction does; a suggestion's sources stay on its row as provenance only. The alternative was to let admission
accept a suggestion's pin set, so a suggested schema's first run read exactly what the fields were suggested from.
That would keep a second admission input (pins chosen by an operation rather than by the selection) for one entry
point. The visible effect: a Source Document reprocessed between the suggestion and the Run now runs on its new
representation.

## Not decided here

These are independent of this change and behave as before: the stabilisation gate for selections above the pilot
size, the implicit replay of an identical selection and `force`, whether one command should start one or many
documents, and whether the pilot is optional.
