## ADDED Requirements

### Requirement: Review attention describes pinned scalar occurrences

Studio SHALL use one shared calculation for API and UI attention over the
Extraction's pinned schema and actual scalar occurrences. Presence SHALL be
grounded, ungrounded or missing independently of a saved explicit/carried
decision. Prepared default approvals SHALL NOT count as decisions. Empty arrays
SHALL create no phantom cells. Only grounded paths SHALL require decisions for
finalization; optional concrete corrections SHALL require canonical reviewed
Evidence, with no confirmed-absence action. Finalization SHALL leave descriptive
missing/ungrounded attention visible. Filters and navigation SHALL NOT decide a
cell. Historical samples SHALL retain their revision and physical-page labels.

#### Scenario: Grounded review with missing cells

- **WHEN** all grounded paths are decided and three scalar cells are missing
- **THEN** required remaining is zero, finalization is allowed, and three missing
  cells remain separately labelled after finalization
- **AND** a supplied missing value requires canonical researcher-picked Evidence

#### Scenario: Nested arrays and carried drafts

- **WHEN** actual nested items include grounded undecided and carried decisions
- **THEN** the API and UI classify the same paths, preserving both axes and
  carried provenance; an empty array contributes no occurrence

### Requirement: Field navigation preserves the current editor

Edit this field SHALL carry the Extraction ID, pinned Schema Revision, stable
node ID and source paths as transient context. It SHALL resolve that identity in
the current editor without replacing unsaved edits, show old/current types and
revision context, and explain removal with a historical-view action. It SHALL
NOT guess by field name. Save and re-run these pages SHALL flush edits, use the
acknowledged revision and exact sorted pages and saved method, and admit a new
identity for deliberate repetition. Source reprocessing SHALL require choosing
a fresh scope; uncertain-admission retry SHALL retain its identity.

#### Scenario: Renamed field in a dirty editor

- **WHEN** navigation comes from an older revision of a renamed/retyped node
- **THEN** that same node receives focus and its changed type is shown
- **AND** unsaved edits remain intact; a removed identity is explained

#### Scenario: Edit then repeat the sample

- **WHEN** pending edits save successfully and the researcher repeats the pages
- **THEN** the run uses the acknowledged revision, same physical pages and saved
  method under a new Extraction ID; failed admission remains recoverable

### Requirement: Guidance and sample coverage remain factual

Guidance SHALL derive from current read facts and existing execution capabilities,
with no persisted phase, readiness score or new admission gate. Account-owned
coverage SHALL be bounded to the selected Schema Revision and at most fifty
selected sources under their current Source Representation pins. It SHALL
separate admitted samples, saved drafts, finalized samples and whole-source
results; deduplicate physical pages per source pin, then sum sources. Historical
schema/source runs SHALL remain readable but excluded. Unavailable reads SHALL
say sample coverage unavailable. Collection start SHALL refresh its selected
pins without gating admission on sample counts.

#### Scenario: Five samples of two pages

- **WHEN** five samples use pages 12–13 of one current source pin
- **THEN** coverage is two pages, with separate draft/finalized counts

#### Scenario: Sampled and unsampled sources

- **WHEN** three sources are selected, one sampled and two unsampled
- **THEN** facts show those three pins and their sum, excluding project history
- **AND** reprocessing removes old-pin coverage; failed reads show unavailable
- **AND** ordinary/suggested collection admission retains its existing guards

#### Scenario: Empty sample

- **WHEN** a successful sample extracts no records
- **THEN** Studio says no records extracted on these pages, without inferring
  source-wide absence, completeness or accuracy

### Requirement: Excel schema import is bounded and explicitly confirmed

An authenticated account SHALL preview an owned project's `.xlsx` workbook
transiently, choosing a worksheet and header row explicitly. The server SHALL
bound compressed bytes to 5 MiB, actual expanded ZIP bytes to 25 MiB, columns to
200, data rows to 5,000 and decoded cell bytes to 64 KiB before schema writes.
Malformed/encrypted/macro ZIPs, conflicting entry names, invalid XML and merged
headers SHALL be refused with client validation errors. The preview SHALL expose
representable values and bounded examples, default fields to strings, and make
type/enum hints opt-in. Lossy identifiers SHALL remain strings. Prototype paths,
blank/duplicate paths and leaf/group collisions SHALL be refused. Flat headers
SHALL stay literal; nesting SHALL use the researcher's separator and edited
unambiguous paths. Preview edits SHALL retain stable node identities.

Confirmation SHALL require a record description and use ordinary schema
initialization or an expected-head revision append. An uncertain initialization
SHALL read/reconcile the acknowledged tree before retrying. Preview/cancel SHALL
write no schema, workbook slot, gold record or model call. Confirmation SHALL
enter the ordinary sample/review flow. An editor changed during preview SHALL
remain intact and require a fresh preview.

#### Scenario: Resource boundaries

- **WHEN** a valid workbook has exactly 200 columns and 5,000 data rows
- **THEN** it previews; column 201, row 5,001 and oversized compressed, actual
  expanded or decoded-cell payloads fail explicitly, including lying ZIP sizes

#### Scenario: Preview then confirm

- **WHEN** the researcher previews, renames fields, selects types/constraints
  and confirms with a record description
- **THEN** one ordinary acknowledged revision retains the preview's node IDs
- **AND** cancellation writes nothing; stale heads and uncertain writes reconcile
- **AND** another account cannot preview or save into the project
