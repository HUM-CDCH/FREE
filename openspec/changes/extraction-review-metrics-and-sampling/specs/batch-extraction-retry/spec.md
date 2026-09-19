## ADDED Requirements

### Requirement: Batch/member-scoped extraction retry

FREE SHALL support retrying extraction for an individual member of an
existing batch, creating a new retry-linked extraction attempt for that
member (mirroring the existing single-document `retryOfId` pattern) without
overwriting or deleting the member's prior extraction attempt.

#### Scenario: Retrying one member preserves history

- **WHEN** a researcher triggers a retry for one member of a batch
- **THEN** a new extraction attempt is created for that member, linked to
  the prior attempt via a retry relation
- **AND** the prior attempt remains queryable and unmodified

#### Scenario: Retry runs against the current schema revision

- **WHEN** a member retry is triggered after the batch's schema has advanced
  to a newer `SchemaRevision`
- **THEN** the retry attempt is pinned to the schema revision active at
  retry time, independent of which revision the original attempt used

### Requirement: Bulk retry of not-yet-reviewed members

FREE SHALL support triggering retry for all not-yet-reviewed members of a
batch in one action, so that members a researcher has not yet approved can
be re-run against an updated schema revision without individually retrying
each one. This bulk retry action SHALL remain available at any time — it is
never automatically invoked.

#### Scenario: Bulk retry skips already-reviewed members

- **WHEN** a researcher triggers a bulk retry on a batch that has both
  reviewed and not-yet-reviewed members
- **THEN** only the not-yet-reviewed members are retried
- **AND** already-reviewed members' approved results are left unchanged

### Requirement: Retry action is surfaced when priority-flagged review is done, not on every decision

FREE SHALL NOT prompt for or trigger a bulk retry automatically after each
individual `ReviewDecision` is saved. Instead, FREE SHALL surface (e.g.
highlight or suggest) the bulk retry action once every member flagged
"priority review" by `review-grid-prioritization` (the forced tier plus the
sampled-floor tier) has a non-null `reviewedAt` — not once every succeeded
member in the batch has been reviewed, since `review-grid-prioritization`
deliberately does not require every member to be reviewed.

#### Scenario: Retry is not offered after a single edit

- **WHEN** a researcher saves one `ReviewDecision` (approve, reject, or
  edit) on one field of one document
- **THEN** no retry prompt is shown as a direct result of that save

#### Scenario: Retry is suggested once priority-flagged members are reviewed

- **WHEN** every member flagged "priority review" in the batch now has a
  non-null `reviewedAt`, while some non-flagged members remain unreviewed
- **THEN** FREE surfaces the bulk retry action as a suggestion
- **AND** the action remains available regardless of whether the researcher
  acts on the suggestion immediately

#### Scenario: Non-flagged members left unreviewed do not block the suggestion

- **WHEN** a batch has members that were never flagged "priority review" and
  remain unreviewed
- **THEN** FREE does not wait for those members to be reviewed before
  surfacing the retry suggestion
