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

