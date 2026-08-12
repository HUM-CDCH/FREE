## ADDED Requirements

### Requirement: Article-strategy results display without a singleton records wrapper

When the researcher's chosen Extraction Strategy is Article (not Catalog), the Results tab SHALL display, export, and evidence-highlight-match the Extraction Result as a flat object of the researcher's own top-level schema fields, with no visible `records` array or `Item 1` wrapper around them.

#### Scenario: Article-strategy result has no records/Item 1 layer

- **WHEN** an extraction completes for a schema whose Extraction Strategy is Article
- **THEN** the Review tree's top level shows the researcher's own field names directly, not a single `records` entry
- **AND** navigating into that top level does not show an intermediate `Item 1` node

#### Scenario: Copy JSON and Download export the unwrapped shape

- **WHEN** the researcher uses Copy JSON or Download for an Article-strategy result
- **THEN** the exported JSON is the flat object of top-level fields, not `{ "records": [ { ... } ] }`

#### Scenario: Catalog-strategy results are unaffected

- **WHEN** an extraction completes for a schema whose Extraction Strategy is Catalog
- **THEN** the Results tab continues to display the `records` array with one entry per detected record, unchanged from today

#### Scenario: Unexpected response shape falls back to the wrapped display

- **WHEN** an Article-strategy extraction response does not contain a non-empty `records` array (an unexpected shape)
- **THEN** the Results tab falls back to displaying the response exactly as received, rather than raising an error or discarding data
