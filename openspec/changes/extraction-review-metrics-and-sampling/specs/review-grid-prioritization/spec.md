## ADDED Requirements

### Requirement: Per-member issue score

The review grid SHALL compute an issue score for each batch member equal to
its `ungroundedWithValue` count plus its `missing` count (from
`extraction-result-classification`), derived from that member's already-loaded
diagnostics and result data.

#### Scenario: Score reflects both categories

- **WHEN** a member has 2 ungrounded-with-value fields and 3 missing fields
- **THEN** its issue score is 5

### Requirement: Grid rows sorted by issue score

The review grid SHALL default to sorting rows by issue score in descending
order, so documents with the most ungrounded-with-value and missing fields
appear first.

#### Scenario: Highest-issue document appears first

- **WHEN** the grid loads a batch whose members have varying issue scores
- **THEN** the member with the highest issue score is rendered as the first
  row
- **AND** rows are ordered by non-increasing issue score thereafter

### Requirement: Two-tier review-priority flagging

The review grid SHALL flag a subset of members as "priority review" using
two tiers: (1) a forced tier — every member whose issue score exceeds a
configured threshold; (2) a sampled-floor tier — additional members drawn
from the remaining (below-threshold) members so that the total number of
flagged members follows: `reviewCount(N) = N` for `N <= 5` total succeeded
members, and `reviewCount(N) = max(5, ceil(sqrt(5 * N)))` for `N > 5`. This
flagging SHALL be advisory only: it SHALL NOT change whether any member is
reviewable, approvable, or excluded from manual review.

#### Scenario: Small batch flags everything

- **WHEN** a batch has 5 or fewer succeeded members
- **THEN** every succeeded member is flagged as priority review

#### Scenario: Large batch flags a shrinking fraction

- **WHEN** a batch has 100 succeeded members
- **THEN** the number of members flagged as priority review is
  `max(5, ceil(sqrt(500)))` (i.e. 23), combining the forced tier and the
  sampled-floor tier
- **AND** that flagged count is less than 100% of the batch

#### Scenario: Sampled floor covers low-score documents

- **WHEN** the forced tier (members above the score threshold) is smaller
  than the target `reviewCount(N)`
- **THEN** the remaining flagged slots are filled by sampling from members
  with scores at or below the threshold, rather than leaving those slots
  unused

#### Scenario: Flagging never restricts review or approval

- **WHEN** a member is not flagged as priority review
- **THEN** it remains fully reviewable and approvable through the same
  controls as any other member
- **AND** no member is auto-approved or hidden as a result of this feature
