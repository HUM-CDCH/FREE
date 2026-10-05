<!-- markdownlint-disable MD013 -->

# canonical-evidence-lifecycle Specification

## Purpose
Canonical Evidence keeps durable owned identity from extraction through durable corrections, named finalization, reopen, and geometry failure.

## Requirements

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

### Requirement: Reviewed occurrence ownership fails closed

A correction MAY link Evidence; Evidence is optional. Every linked Evidence
Anchor SHALL exist in the Extraction's pinned Source Representation Revision,
and every selected occurrence ID SHALL be owned by that anchor there. A
correction that names an unknown anchor or an occurrence its anchor does not own
SHALL be rejected without saving a decision or advancing the decision version,
and without retargeting Evidence. Model Evidence and correction Evidence SHALL
remain distinct.

#### Scenario: Occurrence belongs to another anchor

- **WHEN** a correction selects an occurrence not owned by its Evidence Anchor in
  the pinned representation generation
- **THEN** the whole correction is rejected without retargeting Evidence
- **AND** the Project's decision version is unchanged

#### Scenario: Correction without Evidence

- **WHEN** a researcher saves a correction of a saved value and links no Evidence
- **THEN** the correction is saved as ungrounded and remains reviewable

### Requirement: Reopen preserves canonical review identity

A fresh browser session SHALL reopen an Extraction on a named result snapshot
version and decision version with the same Source Representation Revision,
saved value IDs, producer Evidence Anchor IDs and correction Evidence occurrence
IDs, without depending on array order or transient renderer state. "Latest
reviewed" SHALL open the most recently finalized result/decision pair, not that
Extraction's later live cut; ordinary inspection SHALL open the live cut.

#### Scenario: Browser session is recreated

- **WHEN** a reviewed result is reopened in a new browser context on its named
  result and decision versions
- **THEN** its saved values, their Evidence anchors and the corrections'
  occurrences resolve exactly

#### Scenario: Latest reviewed after later work

- **WHEN** an Extraction finalized results 1 · decisions 2, later saved results 3
  and decisions 4, and another Extraction is the latest attempt
- **THEN** opening "Latest reviewed" from the same source or from another source
  shows results 1 · decisions 2 and names the newer saved versions

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

Each Review Decision SHALL be an explicit researcher correction of one saved
value, bound to that value's stable ID and producing field type, and guarded by
the value's expected correction revision; a stale revision SHALL be refused as a
conflict. Undo SHALL append the value's previous decision as a new revision
under the same guard, or PENDING only when no earlier decision existed; it SHALL
NOT erase history. Finalization SHALL be a
separate explicit action naming one result snapshot version and one decision
version; it SHALL be refused unless every saved value in that snapshot has a
non-pending decision at that decision version. The view SHALL always name the
selected pair and any newer saved result or decision version before
finalization. A deliberately older pair MAY be finalized when named, and earlier
finalizations SHALL be retained. Polling, reconnect, export, processing and the
last decision SHALL NOT finalize, resume or freeze the Extraction.

#### Scenario: Researcher finalizes a reviewed pair

- **WHEN** every saved value of results 3 has a decision at decisions 7 and the
  researcher chooses "Finalize results 3 · decisions 7"
- **THEN** a finalization of exactly that pair is recorded and later work
  continues independently

#### Scenario: Newer decisions exist before finalization

- **WHEN** another session saves decisions 8 while the view shows results 3 ·
  decisions 7
- **THEN** the view states that decisions 8 exist and the action still names
  results 3 · decisions 7

#### Scenario: Concurrent correction of the same value

- **WHEN** two views save a correction of one value against the same expected
  revision
- **THEN** one is saved and the other is refused as a conflict

### Requirement: The accepted Extraction keeps its Schema Revision

Admission SHALL pin the Extraction to the Schema Revision, Source Representation
Revision and method the caller selected, and SHALL reject a Schema Revision
belonging to another Project Context without writing anything. Saved values and
their review SHALL use the producing input selection's schema, settings and
pinned Source Representation, not the current Schema head or account settings.

#### Scenario: Schema head advanced after extraction

- **WHEN** the Schema head moves past the revision an Extraction used
- **THEN** its saved values are still reviewed, corrected and finalized against
  their producing schema and pinned source

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
- **THEN** that value keeps no producer Evidence Anchor
- **AND** it remains a saved, visibly ungrounded value that the researcher can
  review
