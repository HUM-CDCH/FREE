## ADDED Requirements

### Requirement: A reviewed field shows its matched gold value and a similarity-derived default action

FREE SHALL show a field's matched `GoldRecord` value alongside its
extracted value on the field's existing Approve/Reject/Edit review
control (in both the batch review grid and the single-document result
tab), whenever the document belongs to an `EvaluationCorpusVersion` and
the field has such a match, and SHALL pre-select a default action derived
from a fuzzy similarity comparison between the two values: similarity at
or above the high threshold pre-selects Approve, similarity below the low
threshold pre-selects Reject, and the band between pre-selects neither.
This comparison is independent of `record-alignment-scoring`'s exact/
tolerance comparator, which remains what `EvaluationRun` metrics are
computed from.

#### Scenario: A close match pre-selects Approve

- **WHEN** a field's extracted value and its matched gold value have a
  similarity score at or above the high threshold
- **THEN** FREE pre-selects Approve on that field's review control

#### Scenario: A clear mismatch pre-selects Reject

- **WHEN** a field's extracted value and its matched gold value have a
  similarity score below the low threshold
- **THEN** FREE pre-selects Reject on that field's review control

#### Scenario: An ambiguous partial match pre-selects nothing

- **WHEN** a field's similarity score falls between the two thresholds
- **THEN** FREE pre-selects no default action, matching today's behavior
  for a field with no gold comparison available

#### Scenario: No matched gold value leaves the control unaffected

- **WHEN** a document does not belong to any `EvaluationCorpusVersion`, or
  a field has no matched `GoldRecord` value
- **THEN** the field's review control behaves exactly as it does today, no
  gold value or pre-selection shown

### Requirement: A pre-selected default never commits a decision on its own

FREE SHALL NOT persist a `ReviewDecision` from a pre-selected default
alone — only the researcher's own action on the control commits
`APPROVED`, `REJECTED`, or `EDITED`, exactly as for a field with no gold
comparison.

#### Scenario: An untouched pre-selected field commits nothing

- **WHEN** a field's control shows a pre-selected default action and the
  researcher takes no action on it
- **THEN** FREE persists no `ReviewDecision` for that field

#### Scenario: The researcher's choice overrides the pre-selection

- **WHEN** a field's control shows one pre-selected default action and the
  researcher instead clicks a different action
- **THEN** FREE commits the researcher's chosen action, not the
  pre-selected one

### Requirement: The suggestion shown at decision time is persisted alongside the decision

FREE SHALL persist, on the `ReviewDecision` committed for a field that had
a gold comparison available, the similarity score and the default action
that were shown to the researcher at that moment — independent of whether
a later `EvaluationCorpusVersion` corrects that gold value.

#### Scenario: A later gold correction does not change what a past decision recorded

- **WHEN** a `GoldRecord` value is corrected in a new
  `EvaluationCorpusVersion` after a `ReviewDecision` was already committed
  against the prior version's value
- **THEN** the already-committed `ReviewDecision`'s persisted suggestion
  and similarity score remain those shown at the time, unchanged by the
  correction
