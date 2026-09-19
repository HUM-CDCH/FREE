## Context

Schema generation today is a single LLM call: `generate_schema.ts` loads
parsed document markdown plus a free-text instruction and asks a model to
return a `{"template": {...}}` object, converted to `SchemaNode[]` via
`templateToSchemaDefinition` → `templateToNodes`
(`packages/extraction/src/schema.ts:241-274`). `templateToNodes` itself is
generic — it infers a node's shape from any flat/nested example object,
regardless of where that object came from. It's already reused by the
manual "Edit as JSON" textarea (`SchemaPanel.tsx:1517`) and by batch schema
suggestions (`_batch_schema_suggestions.ts`), so feeding it a spreadsheet-
derived template rather than an LLM- or hand-authored one is a natural
extension, not a new mechanism.

The batch-suggestion flow (`useBatchSchemaSuggestion.ts` +
`batchSchemaSuggestionMachine.ts`, confirmed via
`postgres-suggested-batch.ts`) already implements exactly the "propose →
researcher edits a draft → confirm becomes a real `SchemaRevision`" pattern
this needs; today its only suggestion source is a model call over selected
documents.

Documents can already be uploaded to a Project Context with no Extraction
Schema present (`projectNavigation.ts:18-21`: sources/schemas/extractions
are independent tabs), so "upload before a schema exists" requires no
change to that structure.

A Project Context's schema is meant to stay consistent for that project, so
its spreadsheet should be an upload-once, reuse-many-times artifact of the
project itself — not a one-off input to a single suggestion-creation
request. Confirming a suggestion also happens asynchronously (a researcher
reviews/edits the draft before confirming), so the raw spreadsheet data
needs to still be readable at confirm time for `SCHEMA_AND_VALIDATE`'s
later `GoldRecord` population — a request-scoped upload would already have
discarded it by then.

## Goals / Non-Goals

**Goals:**
- Let a project's uploaded spreadsheet be reused across multiple actions
  (suggestion creation now, gold-record population later) without
  re-uploading, versioned so a later re-upload never loses history.
- Let a spreadsheet's columns seed a schema suggestion, reviewed/edited
  through the same UI researchers already use for model-generated
  suggestions.
- Let a researcher-specified separator turn flat column headers into
  nested schema structure, so a spreadsheet that already encodes hierarchy
  in its headers (`measurement.temperature`) doesn't get flattened.
- Reuse `templateToNodes` and the confirm-to-`SchemaRevision` path
  unmodified.
- Expose a stable column-to-field mapping through the edit step, so a
  downstream consumer (namely `extraction-quality-evaluation`'s
  `gold-standard-corpus`) can map the same spreadsheet's row values onto
  the confirmed schema without this change needing to know anything about
  gold records, evaluation runs, or document-filename resolution.

**Non-Goals:**
- Populating any gold-standard/evaluation data from the spreadsheet's row
  values — that's `extraction-quality-evaluation`'s concern, consuming this
  change's output.
- Resolving a spreadsheet row to a specific `SourceDocument` — this change
  only needs column headers and enough sample values to infer types; it
  doesn't need to know which document a row belongs to.

## Decisions

### D0. One versioned, project-scoped spreadsheet slot, decoupled from suggestion creation

Uploading a spreadsheet is its own action (`POST /api/project-spreadsheets`),
independent of creating a suggestion. It appends a new
`ProjectSpreadsheetVersion` — mirroring `SchemaRevision`'s append-only
pattern — rather than replacing a prior upload, and stores the parsed
`{columnName, values}[]` columns (not the separator: that's applied later,
at suggestion-creation time, so a researcher can retry with a different
separator without re-uploading). Creating a suggestion
(`POST /api/batch-schema-suggestions/from-spreadsheet`) then just takes
`{projectContextId, separator?}` and reads whichever version is current via
`getCurrentProjectSpreadsheet`. The resulting `BatchSchemaSuggestion` pins
`projectSpreadsheetVersionId`, so `extraction-quality-evaluation`'s later
`GoldRecord` population step can read the exact same rows by id, however
long after confirmation that happens.

*Alternative considered*: bundle the file upload into the suggestion-
creation request (the original design). Rejected — two problems: (1) it
can't be reused across multiple suggestion attempts against the same
project without re-uploading identical bytes each time; (2) confirming a
suggestion is a separate, later, asynchronous action, so by the time
`SCHEMA_AND_VALIDATE` needs the row data to populate `GoldRecord`s, a
request-scoped upload would already be gone.

*Alternative considered*: let a project hold multiple named spreadsheets.
Rejected — the intended use is "the project's schema should be consistent
with the project's spreadsheet," i.e. one slot; a single append-only
version history per project is enough, and avoids a naming/identity layer
`ExtractionSchema` has for a different reason (multiple named schemas).

### D1. Column-value type inference, then hand off to the existing `templateToNodes`

For each column, inspect its non-empty cell values: all parse as numbers →
`number`/`integer`; a small, repeated set of distinct strings → `string`
with `allowedValues` set to that distinct set; otherwise → plain `string`.
Assemble one representative `{columnName: inferredExampleValue}` object
(or, for enum columns, the distinct-value array in the shape
`templateToNodes` already reads as an `allowedValues` marker) and call
`templateToNodes` unmodified.

*Alternative considered*: write a dedicated spreadsheet-to-`SchemaNode[]`
converter, bypassing `templateToNodes`. Rejected — `templateToNodes`
already handles every shape this needs (scalar, enum-via-array-of-strings,
nested object, array-of-objects); duplicating it would be pure risk for no
benefit.

### D1b. A researcher-specified separator splits column headers into hierarchy

At suggestion-creation time (not upload time — D0) the researcher
optionally specifies a hierarchy separator (e.g. `.` or `_`; default: none
— columns stay flat), so the same uploaded columns can be retried with a
different separator without re-uploading. Column names are
split on that separator into a path (`measurement.temperature` →
`['measurement', 'temperature']`), and columns sharing a path prefix are
grouped into a nested object *before* assembling the example object handed
to `templateToNodes` — that function already turns a nested example object
into an `object` node, so no change to `templateToNodes` itself, only to
how D1's flat column list is assembled into the object it receives.

A column name that is both a complete path on its own and a strict prefix
of another column's path (e.g. both `measurement` and
`measurement.temperature` present) can't be represented — one wants to be
a scalar leaf, the other implies it's an object. FREE reports this as an
upload-time error listing the conflicting columns, rather than silently
picking one interpretation.

*Alternative considered*: auto-detect the separator by scanning headers for
a common repeated punctuation character. Rejected — cheap to get wrong (a
column literally named with a period or underscore as part of a normal
word, not a hierarchy marker, would falsely trigger splitting); the
researcher already knows their own convention, and asking costs one field.

*Alternative considered*: no separator support, always flat. Rejected per
explicit ask — spreadsheets that already encode structure this way (e.g.
`measurement.temp_c`, `measurement.temp_unit`) would otherwise produce a
flat schema that loses grouping the researcher already had.

### D2. Spreadsheet suggestion is a new *source* into the existing suggestion flow, not a new flow

`useBatchSchemaSuggestion.ts`/`batchSchemaSuggestionMachine.ts` gains a
second way to produce a draft (spreadsheet-derived, alongside model-
generated) but the state machine itself — draft, edit, confirm — is
unchanged. Confirming still goes through `postgres-suggested-batch.ts`
unmodified.

*Alternative considered*: a separate, spreadsheet-specific review UI.
Rejected — the researcher-facing task (review inferred fields, fix a wrong
type, confirm) is identical to reviewing a model suggestion; a second UI
for the same task is pure duplication.

### D3. Column-to-field identity is tracked by a stable id through edits

Each inferred field carries the id of the column that produced it,
threaded through the draft's edit operations (rename, retype, delete),
independent of the field's current name. This is exposed as part of the
suggestion's confirmed result so a downstream consumer can map spreadsheet
columns to the *final* field names/ids, not the original header text.

*Alternative considered*: let a downstream consumer re-match columns to
fields by name after confirmation. Rejected — a rename during review would
silently break that match; tracking identity through the edit step is the
only way to survive a rename correctly.

## Risks / Trade-offs

- [Two-step flow (upload, then create-from-current) means a researcher
  could create a suggestion against a stale or wrong spreadsheet version if
  they forget they already uploaded one] → `getCurrentProjectSpreadsheet`
  always resolves to the latest version by construction, and the confirmed
  suggestion pins which version it used — there's no way to silently use
  the wrong one, only "forgot to re-upload before retrying," which is
  visible in the UI (show the current version's filename/upload time
  wherever the create-suggestion action lives).
- [Type-inference heuristic will sometimes guess wrong] → It only ever
  produces a draft; the researcher corrects it in the existing review step
  before anything is confirmed.
- [A separator character that also occurs inside ordinary header words
  (e.g. `_` chosen as separator, but headers are `temp_value`-style
  snake_case with no intended hierarchy) would over-split] → No automatic
  mitigation beyond the researcher's own choice of separator and the
  existing draft-review step, where an incorrectly split field can be
  merged/renamed back before confirming; document the risk where the
  separator is entered, don't silently guess a "safer" default.
- [Generalizing the suggestion-source machinery touches code shared with
  the existing model-generated path] → Keep the new source behind a clear
  seam (something that produces "a draft + column-identity map", same
  shape regardless of source) so the model-generated path's behavior is
  unaffected; add a regression test confirming model-generated suggestions
  are unchanged.
- [This change's only consumer today is `extraction-quality-evaluation`'s
  `SCHEMA_AND_VALIDATE` purpose, which doesn't exist until that change
  lands] → This change is still independently useful (`SCHEMA`-only
  purpose: bootstrap a schema from a spreadsheet, no evaluation involved),
  so it doesn't need to wait for the sibling change to ship first.
