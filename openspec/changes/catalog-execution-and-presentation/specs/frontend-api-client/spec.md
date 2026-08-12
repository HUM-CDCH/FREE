## ADDED Requirements

### Requirement: Studio submits and restores Extraction strategy

The frontend API boundary SHALL strictly encode and decode `ARTICLE | CATALOG` on Extraction requests and attempts. The selected strategy SHALL be included in the request identity, and a reopened attempt SHALL render from its persisted strategy rather than a client default.

#### Scenario: Catalog is submitted

- **WHEN** the researcher selects Catalog and starts a run
- **THEN** the client submits `strategy: "CATALOG"` with the UUID and pinned revision IDs

#### Scenario: Catalog attempt is reopened

- **WHEN** the server returns a persisted Catalog attempt
- **THEN** the client decodes and presents it as Catalog
- **AND** does not reinterpret it as the default Article strategy

### Requirement: Catalog retry requests preserve child identity and selection

The frontend API SHALL encode a targeted Catalog retry as a new Extraction UUID with only its immediate `retryOfId` and selected document, discovery, and canonical record components. It SHALL not send caller pins or silently change strategy, and it SHALL decode the returned child diagnostics and parent identity without copying review state.

#### Scenario: Targeted Catalog retry is submitted

- **WHEN** the researcher submits selected failed Catalog components
- **THEN** the client sends a new UUID with `retryOfId` and the selected retry flags/record start block IDs
- **AND** it omits fresh-run pins and strategy so the server enforces the immediate parent's durable identity
