## ADDED Requirements

### Requirement: A document's display name is unique within its project

FREE SHALL reject an upload whose `originalName` already belongs to
another `SourceDocument` in the same `ProjectContext`, independent of the
existing content-hash (`contentSha256`) and `ingestionKey` dedup checks.
This applies to every upload, not only ones later referenced by a gold
spreadsheet (see `gold-standard-corpus`, whose filename resolution depends
on this holding).

#### Scenario: Uploading a different-content file under an existing name is rejected

- **WHEN** a researcher uploads a PDF whose sanitized display filename
  matches an existing `SourceDocument.originalName` in the same project,
  and its content differs from that existing document
- **THEN** FREE rejects the upload with an error naming the collision,
  rather than creating a second document under the same display name

#### Scenario: The same display name is allowed in a different project

- **WHEN** two different `ProjectContext`s each have a `SourceDocument`
  with the same `originalName`
- **THEN** FREE allows both — uniqueness is scoped per project

#### Scenario: Existing content/ingestion-key dedup is unaffected

- **WHEN** an upload matches an existing document's `contentSha256` or
  `ingestionKey`, as already handled before this requirement
- **THEN** FREE's existing dedup behavior for that case is unchanged by
  the new name-uniqueness check
