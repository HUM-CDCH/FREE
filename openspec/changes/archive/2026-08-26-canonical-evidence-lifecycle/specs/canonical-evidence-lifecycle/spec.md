## ADDED Requirements

### Requirement: Canonical occurrences have durable owned identity

Every canonical Evidence Anchor SHALL own one or more generation-scoped
occurrences with unique deterministic occurrence IDs. A table-cell anchor SHALL
retain every producer observation for the logical cell. No occurrence ID SHALL
be owned by two anchors in one document.

#### Scenario: Continued table cell has multiple observations

- **WHEN** one logical table cell is observed in more than one physical fragment
- **THEN** its one canonical anchor owns every ordered producer occurrence

### Requirement: Retained Source Representations expose strict v2

Both supported Parsing Service document reads and the Studio Source
Representation resource SHALL return the same strict `parsed_document.v2`
payload. The lifecycle SHALL NOT use a v1 projection or `/parsed-document`
compatibility route.

#### Scenario: Reopened representation reads its parsed document

- **WHEN** Studio reopens a retained Source Representation Revision
- **THEN** it decodes the complete strict v2 payload associated with that exact
  revision

### Requirement: Extraction review persists atomically

`ProjectStore` SHALL persist a successful Extraction Result and its Review
Decision in one transaction. The Review Decision SHALL reference the Extraction
and MAY store `reviewedOccurrenceIds` for each reviewed canonical Evidence
Anchor.

#### Scenario: Accepted row is reviewed

- **WHEN** row `24-1` and its three canonical anchors are accepted
- **THEN** the Extraction Result and reviewed occurrence selections are durable
  together

### Requirement: Reviewed occurrence ownership fails closed

A review write SHALL reject duplicate, unknown, cross-generation, or foreign
occurrence IDs. Rejection SHALL persist neither the Review Decision nor a
partial successful Extraction.

#### Scenario: Occurrence belongs to another anchor

- **WHEN** a Review Decision selects an occurrence not owned by its Evidence
  Anchor in the pinned representation generation
- **THEN** the whole write is rejected without retargeting Evidence

### Requirement: Reopen preserves canonical review identity

A fresh browser session SHALL reopen the same Source Representation Revision,
Extraction Result, Evidence Anchor IDs, and reviewed occurrence IDs without
depending on array order or transient renderer state.

#### Scenario: Browser session is recreated

- **WHEN** the reviewed Ellekilde result is reopened in a new browser context
- **THEN** all three row `24-1` anchors and their reviewed occurrences resolve
  exactly

### Requirement: Canonical Evidence geometry fails safely

Every canonical Evidence occurrence SHALL carry finite, ordered, page-bounded
geometry in displayed top-left physical-page space. The Parsing Service and
Studio decoder SHALL reject invalid, absent, or out-of-page Evidence geometry.
The browser SHALL repeat the bounds check and render valid geometry even when
the physical page is rotated.

#### Scenario: Valid rotated geometry is reopened

- **WHEN** a reopened canonical occurrence has valid displayed-page geometry
  on a rotated physical page
- **THEN** its Evidence identity resolves and its geometry is highlighted

#### Scenario: Unsafe geometry reaches a strict boundary

- **WHEN** an occurrence has absent, non-finite, unordered, or out-of-page
  geometry
- **THEN** the strict v2 payload is rejected before unsafe geometry can render

### Requirement: Review is an explicit action bound to what produced the result

The researcher SHALL accept a successful Extraction Result through an explicit
browser action that posts the result, the Schema Revision the extraction used,
and one Review Decision per canonical Evidence Anchor the result cites. The
action SHALL NOT be offered once the Extraction Schema in the browser is no
longer that Schema Revision, and an anchor the Parsing Service did not publish
SHALL NOT become a Review Decision.

#### Scenario: Researcher accepts a result

- **WHEN** the researcher accepts an Extraction Result citing canonical anchors
- **THEN** the write carries the pinned Schema Revision and one Review Decision
  per cited anchor, with that anchor's published occurrences reviewed

### Requirement: The accepted Extraction keeps its Schema Revision

A review write SHALL persist the Extraction against the Schema Revision the
caller pinned, not the Schema head at write time, and SHALL reject a Schema
Revision belonging to another Project Context without writing anything.

#### Scenario: Schema head advanced after extraction

- **WHEN** an accepted result pins a Schema Revision the head has moved past
- **THEN** the Extraction is persisted against the pinned revision

### Requirement: The model cites published Evidence, never its own

An extraction SHALL read the canonical content of the pinned Source
Representation with one citation label per published Evidence Anchor, and SHALL
ask only for a value and the label it came from. A returned label SHALL resolve
to its Evidence Anchor by exact lookup; a label the document never published
SHALL resolve to no Evidence. Text matching against the PDF SHALL NOT be used
to attach Evidence.

#### Scenario: Model answers with an unpublished label

- **WHEN** an extraction returns a citation label that is not in the pinned
  generation
- **THEN** that value keeps no Evidence Anchor and no Review Decision is offered
  for it
