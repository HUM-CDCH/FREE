## RENAMED Requirements

- FROM: `### Requirement: Schema chat changes names and types only`
- TO: `### Requirement: Schema chat changes names, types, descriptions and allowed values`

## MODIFIED Requirements

### Requirement: Schema chat changes names, types, descriptions and allowed values
Schema chat MAY propose a field's name, type, description and allowed values,
and new fields with those properties. A null description or allowed-values list
SHALL leave that property unchanged; an empty one SHALL clear it. Retypes SHALL
be sanitised before change records are produced so that closed sets stay strings
and container-crossing retypes remove metadata they orphan.

#### Scenario: Closed-set field is renamed and retyped
- **WHEN** a field with allowed values receives a new name and a non-string type
- **THEN** the proposed rename is retained
- **AND** the type remains `string`
- **AND** the rejected retype is reported as a conflict on that node

#### Scenario: Retype crosses the container boundary
- **WHEN** a leaf becomes an object or array, or a container becomes a leaf
- **THEN** `children` is materialised or removed to match the proposed type
- **AND** orphaned description or allowed-value metadata is removed
- **AND** an applied change carries a researcher-facing note with no failure reason

#### Scenario: Description proposed
- **WHEN** the model proposes a new description for `date` and null for its
  allowed values
- **THEN** the proposal changes the description and leaves allowed values as
  they were

## ADDED Requirements

### Requirement: An edit request may carry the researcher's corrections
A schema-edit request MAY name a Sample Extraction the researcher owns and the
schema nodes whose corrections should inform the proposal. The server SHALL load
those corrections and their Evidence text itself, bounded to at most 20
corrections with truncated passages, and give them to the model as data. The
stored instruction SHALL NOT contain the Evidence text. The reply SHALL use the
existing proposal review and Apply flow, and the request SHALL use the
acknowledged Current Schema Revision like any conversational edit.

#### Scenario: Suggest a description from corrections
- **WHEN** the researcher corrected two `date` values and asks for a suggestion
- **THEN** the model receives both corrections with their passages
- **AND** the proposal appears for review like any schema chat proposal

#### Scenario: Another researcher's Extraction
- **WHEN** the request names a Sample Extraction of another Researcher Account
- **THEN** it is refused and no model call is made
