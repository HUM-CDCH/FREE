## ADDED Requirements

### Requirement: Schema revision has a stabilised state

Every `SchemaRevision` SHALL have a `stabilisedAt` timestamp that is `null`
by default when the revision is created, regardless of how it was created
(chat-drafted schema suggestion, spreadsheet upload, or a schema-issue-flag
driven edit).

#### Scenario: New revision starts unstabilised

- **WHEN** a researcher commits a new `SchemaRevision` for an
  `ExtractionSchema`, by any entry path
- **THEN** the new revision's `stabilisedAt` is `null`

### Requirement: A collection-scale batch requires a stabilised revision; a pilot-sized one does not

The system SHALL reject a request to create a `BatchExtraction` whose
selection exceeds the pilot batch size limit against a `SchemaRevision`
whose `stabilisedAt` is `null`, returning an error the frontend can render
as a "stabilise this schema first" prompt. The system SHALL allow a request
at or under that limit regardless of `stabilisedAt` — a pilot round is
itself a batch extraction at pilot scale, not a separate mechanism.

#### Scenario: Collection-scale batch against unstabilised revision is rejected

- **WHEN** a researcher requests a batch extraction whose selection exceeds
  the pilot batch size limit, using a `schemaRevisionId` whose
  `stabilisedAt` is `null`
- **THEN** the system returns an error and creates no `BatchExtraction`

#### Scenario: Pilot-sized batch against unstabilised revision succeeds

- **WHEN** a researcher requests a batch extraction whose selection is at
  or under the pilot batch size limit, using a `schemaRevisionId` whose
  `stabilisedAt` is `null`
- **THEN** the system creates the `BatchExtraction`

#### Scenario: Batch request against stabilised revision succeeds regardless of size

- **WHEN** a researcher requests a batch extraction using a
  `schemaRevisionId` whose `stabilisedAt` is set
- **THEN** the system creates the `BatchExtraction` regardless of selection
  size

### Requirement: Stabilise action requires at least one reviewed pilot round

The system SHALL allow a researcher to stabilise the current
`SchemaRevision` only if at least one `Extraction` against that revision has
`reviewedAt` set (i.e., at least one pilot round has been reviewed).

#### Scenario: Stabilise rejected before any pilot review

- **WHEN** a researcher attempts to stabilise a `SchemaRevision` that has no
  `Extraction` with `reviewedAt` set
- **THEN** the system rejects the action and the revision's `stabilisedAt`
  remains `null`

#### Scenario: Stabilise succeeds after a reviewed pilot round

- **WHEN** a researcher attempts to stabilise a `SchemaRevision` that has at
  least one reviewed `Extraction`
- **THEN** the system sets `stabilisedAt` to the current time on that
  revision

### Requirement: Existing schema entry paths remain unchanged

The system SHALL treat both the chat-drafted schema suggestion path and the
direct spreadsheet upload path as valid, unmodified ways to produce a
`SchemaRevision` that then enters the piloting state described above.

#### Scenario: Spreadsheet-seeded schema enters piloting like any other

- **WHEN** a researcher commits a `SchemaRevision` produced from a
  spreadsheet upload
- **THEN** that revision's `stabilisedAt` is `null` and it is subject to the
  same pilot-before-batch gating as a chat-drafted revision
