## Why

A researcher starting a new Project Context in FREE often already has a
spreadsheet of manually-extracted values from prior work — columns are the
fields they care about, rows are records. Today the only way to seed a
schema is a single LLM call over parsed document text plus a free-text
instruction (`prototypes/studio/api/generate_schema.ts`); there is no way to
hand FREE a structured starting point derived from the researcher's own
prior work, even though the pieces to do so — a template-to-schema
converter and a suggestion draft/edit/confirm flow — already exist and are
reused by other schema-generation paths today.

## What Changes

- Add a project-level, versioned spreadsheet slot: uploading appends a new
  version (never replaces one, mirroring `SchemaRevision`), and every
  action that wants a spreadsheet — deriving a schema suggestion now, and
  later `extraction-quality-evaluation`'s gold-record population — reads
  whichever version is current, rather than each action carrying its own
  one-off upload. This also fixes a real gap the original per-request
  design had: confirming a suggestion happens later, asynchronously, after
  a researcher reviews/edits the draft, and the raw spreadsheet data must
  still be readable at that point for `SCHEMA_AND_VALIDATE` — a request-
  scoped upload would have already discarded it by then.
- Add spreadsheet upload as a schema-seeding input, usable before any
  Extraction Schema exists for a Project Context (documents/schemas/
  extractions are already independent tabs, so this fits the existing
  structure rather than requiring one).
- Add column-value type inference: given a column's non-empty cell values,
  infer `number`/`integer` (all parse as numbers), a `string` field with
  `allowedValues` (a small, repeated set of distinct strings), or plain
  `string` otherwise. This is new — nothing in the codebase infers a type
  from example values today.
- Add an optional, researcher-specified hierarchy separator (e.g. `.` or
  `_`) so column headers that already encode nested structure (e.g.
  `measurement.temperature`, `measurement.unit`) produce a nested schema
  object instead of two unrelated flat fields. Defaults to no splitting.
- Feed the inferred columns into the existing `templateToNodes`
  (`packages/extraction/src/schema.ts:241-265`) — the same flat-object-to-
  `SchemaNode[]` converter already used for LLM-generated schemas and the
  manual "Edit as JSON" textarea — producing a draft schema, no new
  template-to-schema conversion logic needed.
- Route that draft through the existing batch-suggestion draft/edit/confirm
  flow (`useBatchSchemaSuggestion.ts`/`batchSchemaSuggestionMachine.ts`,
  confirming via `postgres-suggested-batch.ts`) as an alternative suggestion
  *source*, so a researcher reviews/edits a spreadsheet-derived suggestion
  exactly as they already do a model-generated one.
- Track column-to-field identity (a stable id, not header text) through the
  draft/edit step, so a field renamed before confirming can still be traced
  back to the column that produced it — needed by any downstream consumer
  that wants to know "which column became this field," not only by this
  change itself.

## Capabilities

### New Capabilities

- `project-spreadsheet-storage`: a project-scoped, versioned spreadsheet
  slot (upload appends a version; every consumer reads the current one).
- `spreadsheet-schema-suggestion`: derives a schema suggestion from the
  project's current spreadsheet's columns (type-inferred), routed through
  the existing batch-suggestion draft/edit/confirm flow, with column-to-
  field identity tracked through edits.

### Modified Capabilities

(none — `templateToNodes`, the batch-suggestion state machine, and the
confirm-to-`SchemaRevision` path are all reused as-is; this change only
adds a new suggestion source ahead of them)

## Open Questions For Review

1. **Column-type inference thresholds**: exact cutoffs for "small, repeated
   set of distinct strings → enum" (how small, how repeated) are a tuning
   decision, not an architectural one — pick a conservative default and
   adjust after trying it on a real spreadsheet.
2. **Separator choice risk**: choosing `_` as the separator will over-split
   any snake_case header that wasn't meant to encode hierarchy (e.g.
   `temp_value` → a `temp` object with a `value` child). No automatic
   mitigation is proposed beyond the draft-review step where this is
   correctable (design.md D1b) — confirm that's acceptable, or whether the
   upload flow should warn when the chosen separator appears inside many
   single-level-looking headers.
3. **Relationship to `openspec/changes/extraction-quality-evaluation`**:
   that change's `gold-standard-corpus` capability wants to populate
   `GoldRecord`s from the project's spreadsheet's row values once a
   suggestion here is confirmed (its `SCHEMA_AND_VALIDATE` upload purpose).
   This change owns `project-spreadsheet-storage` and the suggestion flow,
   and exposes the confirmed column-to-field mapping plus the
   `projectSpreadsheetVersionId` a suggestion was built from; it does
   **not** own filename-to-document resolution or `GoldRecord` creation —
   that stays in `extraction-quality-evaluation`, which reads the pinned
   version by id rather than duplicating storage or parsing.

## Impact

- New spreadsheet-parsing dependency (e.g. `exceljs`/SheetJS — none exists
  in the repo today).
- New column-value-to-type inference module.
- New `ProjectSpreadsheetVersion` storage (Prisma model + `project-store.ts`
  methods `appendProjectSpreadsheetVersion`/`getCurrentProjectSpreadsheet`)
  and a new `/api/project-spreadsheets` route (upload/read), independent of
  suggestion creation.
- `BatchSchemaSuggestion` gains `projectSpreadsheetVersionId`, pinning which
  version a spreadsheet-derived suggestion was built from.
- The `from-spreadsheet` suggestion-creation route no longer accepts an
  inline file upload — it reads the project's current spreadsheet version
  and takes only `{projectContextId, separator?}`.
- `useBatchSchemaSuggestion.ts`/`batchSchemaSuggestionMachine.ts`:
  generalized to accept a spreadsheet-derived template as an alternative
  suggestion source alongside the existing model-generated one.
- No changes to `templateToNodes` or the confirm-to-`SchemaRevision` path —
  both reused unmodified.
- `openspec/changes/extraction-quality-evaluation` depends on this change's
  output (confirmed schema + column-to-field mapping +
  `projectSpreadsheetVersionId`) for its `SCHEMA_AND_VALIDATE` upload
  purpose — sequencing note, not owned here.
