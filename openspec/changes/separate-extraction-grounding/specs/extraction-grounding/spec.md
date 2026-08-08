## ADDED Requirements

### Requirement: Value extraction and Evidence grounding are separate model operations

One browser Extraction action SHALL first request values against the clean Extraction Schema and SHALL only after that result succeeds request canonical Evidence grounding. The value-extraction template MUST NOT contain `anchor_id` wrappers, and grounding failure MUST NOT require the value-extraction operation to run again.

#### Scenario: Values are extracted before grounding

- **WHEN** a researcher runs Extraction with a canonical parsed document
- **THEN** the first model operation receives the clean value schema and produces the value result
- **AND** the second model operation receives immutable claims derived from that result and selects canonical Evidence labels

#### Scenario: Grounding is retried independently

- **WHEN** value extraction succeeds and grounding fails
- **THEN** the extracted values remain available
- **AND** retrying grounding does not invoke value extraction again

### Requirement: Grounding uses exact call-scoped claim and anchor labels

The grounding module SHALL deterministically enumerate each populated scalar result path as a prompt-local claim label and each candidate parser-published Evidence Anchor as a prompt-local anchor label. Model output SHALL contain one compact map with exactly the expected claim-label keys and either one anchor label or the explicit `NONE` abstention for each value. Both label sets MUST resolve by exact lookup within that grounding call.

#### Scenario: Grounding selects a published anchor

- **WHEN** grounding returns a known claim label and a known anchor label
- **THEN** the claim is linked to that anchor's canonical generation-scoped ID

#### Scenario: Grounding abstains

- **WHEN** grounding returns `NONE` for a known claim
- **THEN** the value remains visible without an Evidence link, PDF highlight, or Review Decision

### Requirement: Invalid grounding output fails closed

Unknown claim labels, unknown anchor labels, duplicate claim selections, malformed selections, and labels from another grounding call MUST NOT attach Evidence. A failed or inconsistent selection SHALL remain ungrounded and MUST NOT be repaired by matching claim text to source text.

#### Scenario: Model returns an unknown anchor label

- **WHEN** a grounding selection names an anchor label absent from the call-scoped dictionary
- **THEN** the claim remains ungrounded
- **AND** no canonical anchor is guessed or retargeted

#### Scenario: Model returns one claim twice

- **WHEN** grounding returns conflicting or duplicate selections for one claim label
- **THEN** that claim remains ungrounded
- **AND** neither selection becomes a Review Decision

#### Scenario: Known selection conflicts with exact candidates

- **WHEN** the grounding call contains one or more canonical candidates that exactly contain the claim value
- **AND** the model selects a different known anchor
- **THEN** the claim remains ungrounded with a conflict issue
- **AND** the resolver does not replace the model selection with an exact candidate

### Requirement: Grounding never manufactures Evidence or geometry

The grounding prompt, output, and resolver MUST NOT request or accept `_evidence`, snippets, page numbers, bounding boxes, text offsets, table coordinates, headers, or fuzzy matches. Geometry SHALL remain exclusively the geometry owned by the selected parser-published canonical occurrence.

#### Scenario: Grounded value is highlighted

- **WHEN** a valid claim-to-anchor selection is reviewed
- **THEN** the browser resolves highlights only from occurrences already owned by that canonical anchor
- **AND** no model-generated location data crosses the grounding seam

### Requirement: Extraction stores values and canonical links separately

The successful Extraction aggregate SHALL store the clean value result and validated canonical Evidence links as separate JSON members. Each link SHALL identify one scalar result path and one canonical anchor ID, result paths MUST be unique, and the write MUST validate that every path exists in the immutable result. Review acceptance SHALL remain pinned to the Source Representation Revision and Schema Revision that produced the run, and `reviewedOccurrenceIds` SHALL remain explicit audit state.

#### Scenario: Researcher accepts a grounded result

- **WHEN** the researcher accepts a result containing valid canonical links
- **THEN** the atomic Extraction and Review Decision write persists the clean result and validated links against the pinned revisions
- **AND** a fresh browser reopen resolves the same anchors and reviewed occurrences

#### Scenario: Researcher has only ungrounded values

- **WHEN** grounding produces no valid canonical links
- **THEN** the result cannot manufacture a Review Decision merely from its values

#### Scenario: Link names a non-scalar or absent result path

- **WHEN** an accepted Extraction contains an Evidence link whose result path is absent or does not resolve to a scalar value
- **THEN** the entire write is rejected without persisting the Extraction or a partial Review Decision

### Requirement: Grounding source projection avoids duplicate logical tables

The canonical grounding projection SHALL render each selected logical table row once even when producer observations place that table on multiple physical pages. Every rendered candidate table cell SHALL retain one exact prompt-local label for its canonical anchor.

#### Scenario: Continued table spans pages

- **WHEN** one logical table is referenced by more than one parsed page
- **THEN** grounding sends its logical rows once
- **AND** the selected canonical cell still owns every parser-published physical occurrence

### Requirement: Candidate retrieval is non-authoritative and fails closed

Grounding SHALL batch claims by deterministic top-level record path. Candidate retrieval MAY normalize case, Unicode compatibility forms, and whitespace for exact containment and MAY expand a seeded table cell to its complete canonical logical row. Retrieval MUST NOT publish, repair, or retarget an Evidence link. A batch with no seed SHALL use the complete canonical source.

#### Scenario: Retrieval omits a supporting anchor

- **WHEN** a supporting canonical anchor is absent from a grounding call's candidate dictionary
- **THEN** the model cannot link that hidden anchor
- **AND** an unknown label is rejected rather than resolved through value or text matching

#### Scenario: No claim value seeds a candidate

- **WHEN** normalized exact containment finds no parser-published candidate for a claim batch
- **THEN** that grounding call receives the complete canonical source projection

### Requirement: Schema Revision field order survives persistence

Schema Revisions SHALL store their recursive sibling collections as ordered `SchemaNode` arrays inside the existing JSONB value. Reopen SHALL validate and return those ordered nodes, and value extraction SHALL compile its model template from the same sequence. Object-shaped stored templates MUST NOT be accepted as a compatibility representation.

#### Scenario: Ordered schema reopens through PostgreSQL

- **WHEN** a Schema Revision containing non-alphabetical root and nested field order is persisted and reopened
- **THEN** every sibling sequence equals the persisted sequence
- **AND** the value-extraction request renders its template fields in that same order

#### Scenario: Obsolete object schema is stored

- **WHEN** a persisted Schema Revision contains an object-shaped schema tree
- **THEN** reopen fails closed as unreadable durable state
- **AND** the browser does not silently sort or synthesize field order
