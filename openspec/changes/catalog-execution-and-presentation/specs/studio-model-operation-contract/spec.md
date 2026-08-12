## ADDED Requirements

### Requirement: Extraction strategy is strict durable identity

The Extraction contract SHALL accept exactly `ARTICLE` or `CATALOG`. Strategy SHALL be part of the idempotent Extraction identity and SHALL be persisted and returned by reopen. Reusing an Extraction UUID with a different strategy or different pins SHALL return `409`.

#### Scenario: UUID is reused with another strategy

- **WHEN** a UUID bound to an Article request is submitted with Catalog and otherwise identical pins
- **THEN** the server returns `409`
- **AND** performs no new model plan

### Requirement: Field source is declared only at the schema top level

A top-level Schema Node MAY declare `valueSource: "document" | "source-filename"`; omission SHALL mean record-scoped content. A declaration SHALL apply to the node's complete subtree. A `valueSource` physically present on a nested node SHALL be rejected by strict schema validation.

#### Scenario: Top-level source applies to a subtree

- **WHEN** a top-level object or array declares `valueSource: "document"`
- **THEN** that node and all descendants are extracted as one document-scoped subtree

#### Scenario: Nested declaration is rejected

- **WHEN** a non-top-level node contains `valueSource`
- **THEN** strict schema validation rejects the schema

### Requirement: Content and package values have deterministic provenance

Catalog SHALL extract document-scoped content once and record-scoped content per canonical record slice. Article SHALL include both content scopes in its one whole-source values call. Both strategies SHALL restore extracted subtrees to their original top-level schema positions and then overlay `source-filename` from canonical package metadata last. Unexpected model keys SHALL be rejected. Package-origin values SHALL require no model call and no Evidence Anchor; every populated document- or record-scoped content scalar SHALL be canonically grounded.

#### Scenario: Source filename is requested

- **WHEN** a top-level node declares `valueSource: "source-filename"`
- **THEN** its value comes from the canonical package's original filename
- **AND** it causes no model call or Evidence Anchor

#### Scenario: Document content is populated

- **WHEN** a document-scoped content scalar is present in the assembled result
- **THEN** it requires canonical grounding in the same way as record-scoped content
