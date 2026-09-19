## ADDED Requirements

### Requirement: Only APPROVED and EDITED decisions produce examples

FREE SHALL derive schema-field examples only from `ReviewDecision`s whose
action is `APPROVED` (the model's original value, confirmed correct — no
change) or `EDITED` (a researcher-supplied corrected value). `REJECTED`
decisions SHALL NOT produce an example, since a `REJECTED` decision never
carries a value (`reviewedValue` is always null for `REJECTED`, enforced by
`extraction.contract.ts`) and there is no correct value to learn from.

#### Scenario: Rejected field contributes no example

- **WHEN** a researcher marks a field `REJECTED` without providing a
  replacement value
- **THEN** no example is added for that field from this decision
- **AND** the field remains eligible for a future example once it is either
  approved or edited with an actual value

#### Scenario: Approved field contributes an example without extra input

- **WHEN** a researcher approves a field whose model-extracted value is
  correct as-is
- **THEN** an example is derived from that value (and its grounding
  evidence, if any) without requiring the researcher to type anything
  beyond the existing approve action

#### Scenario: Edited field contributes the corrected value

- **WHEN** a researcher edits a field and commits a corrected value
- **THEN** an example is derived from the corrected value

### Requirement: Leaf nodes carry an optional versioned examples list

`SchemaNode` leaf nodes SHALL support an optional `examples` list, distinct
from and independent of the group-only `description` property defined by
`schema-field-descriptions`. Each example SHALL carry the corrected value
and, when available, a source excerpt providing surrounding context. Changes
to a node's `examples` SHALL be persisted as a new `SchemaRevision`, using
the same append-only revision mechanism as any other schema edit, so prior
`ExtractionAttempt`s pinned to earlier revisions are unaffected.

#### Scenario: Examples are field-scoped, not document-scoped

- **WHEN** a researcher approves or edits a field's value on one document in
  a batch
- **THEN** any resulting example is associated with that field's schema
  node (the grid column), not with the document (the grid row)
- **AND** the example becomes available as guidance for every document that
  shares that schema, not only the document it was sourced from

#### Scenario: Examples do not affect prior extraction attempts

- **WHEN** a new `SchemaRevision` is appended with updated `examples` for a
  field
- **THEN** extraction attempts already completed against an earlier
  revision are unchanged and continue to reference their original revision

#### Scenario: Leaf-level examples do not enable leaf-level descriptions

- **WHEN** a leaf node gains an `examples` entry
- **THEN** that leaf node still does not expose a `description` property or
  its authoring UI, per `schema-field-descriptions`

### Requirement: Examples are bounded and consumed by prompt compilation

FREE SHALL cap the number of examples used per field when compiling
extraction instructions, selecting a bounded, most-relevant subset rather
than including every accumulated example unconditionally.

#### Scenario: Example count exceeds the cap

- **WHEN** a field has accumulated more examples than the configured cap
- **THEN** prompt compilation includes at most the capped number of
  examples for that field
