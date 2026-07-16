<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Catalog extraction identifies the reference primary repeated array

Catalog extraction SHALL infer the primary repeated array using the behavior pinned from `FREE-technical`, then derive the per-record item schema and matching `_schema_metadata` for that array. For `Burial_Finds.json`, the primary array SHALL resolve to `record.entries`.

#### Scenario: Burial Finds schema is supplied

- **WHEN** Catalog extraction receives `Burial_Finds.json`
- **THEN** it selects `record.entries` as the primary repeated array
- **AND** each Catalog section is extracted with the corresponding item schema and metadata

#### Scenario: Document-level fields surround the primary array

- **WHEN** an Extraction Schema contains fields outside the selected repeated array
- **THEN** Catalog extraction preserves the reference behavior of leaving those document-level fields empty

### Requirement: Catalog boundaries are resolved and sliced in source order

Catalog extraction SHALL request top-level record boundaries over canonical LLM Markdown, resolve returned boundary markers against that Markdown, discard unresolved boundaries, and slice resolved sections in Source Document order.

#### Scenario: All boundary markers resolve

- **WHEN** the model returns valid markers for multiple Catalog records
- **THEN** each marker is resolved against canonical LLM Markdown
- **AND** the resulting sections remain in source order

#### Scenario: Some boundary markers do not resolve

- **WHEN** at least one marker resolves and another marker does not
- **THEN** extraction uses the resolvable boundaries in source order
- **AND** it does not create a section from an unresolved marker

### Requirement: Unresolved Catalog boundaries use one whole-document fallback

When no returned Catalog boundary can be resolved, Catalog extraction SHALL treat the complete canonical LLM Markdown as one section and add exactly one `boundary_fallback` warning.

#### Scenario: No boundary marker resolves

- **WHEN** boundary detection returns no marker that can be found in canonical LLM Markdown
- **THEN** one section containing the complete canonical LLM Markdown is extracted
- **AND** the response contains exactly one `boundary_fallback` warning

#### Scenario: At least one boundary resolves

- **WHEN** one or more boundary markers resolve
- **THEN** Catalog extraction uses the resolved sections
- **AND** it does not emit `boundary_fallback`

### Requirement: Each Catalog section is conformed and suspicious results retry once

Catalog extraction SHALL invoke the model once per section, recursively conform every response, classify failed or suspicious records with the pinned reference heuristics, and retry each classified section no more than once.

#### Scenario: First result is acceptable

- **WHEN** a section's first conformed result is neither failed nor suspicious
- **THEN** Catalog extraction retains that result
- **AND** it does not retry the section

#### Scenario: First result is failed or suspicious

- **WHEN** the pinned heuristics classify a section's first result as failed or suspicious
- **THEN** Catalog extraction invokes the model one additional time for that section
- **AND** it does not perform a second retry

#### Scenario: Retry remains suspicious

- **WHEN** the one retry also produces a failed or suspicious record
- **THEN** Catalog extraction completes according to the pinned reference selection behavior
- **AND** it does not introduce additional recovery calls

### Requirement: Catalog results merge in source order with reference deduplication

Catalog extraction SHALL merge section results into the selected repeated array in source order and apply the pinned scalar-fingerprint deduplication behavior. It SHALL preserve nested arrays such as `fundliste` and SHALL NOT enable phased nested extraction.

#### Scenario: Multiple unique records are extracted

- **WHEN** source-ordered sections produce distinct record fingerprints
- **THEN** their conformed records appear in the merged array in the same source order

#### Scenario: Records share a scalar fingerprint

- **WHEN** multiple extracted records match under the pinned scalar-fingerprint rule
- **THEN** the merge applies the reference deduplication behavior
- **AND** it may collapse similar records exactly as the pinned implementation does

#### Scenario: Record contains nested fundliste entries

- **WHEN** a conformed Catalog record contains nested `fundliste` values
- **THEN** those values remain nested in the merged record
- **AND** no separate phased nested model call is performed
