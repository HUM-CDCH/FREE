## ADDED Requirements

### Requirement: Batch finished dialog shows success count and collapsed per-document detail

`BatchExtractionFinishedDialog` SHALL display the total number of
successfully-extracted documents in the batch, and SHALL show a detailed
per-document row (using the three-way classification from
`extraction-result-classification`) only for documents whose
`ungroundedWithValue` or `missing` count is greater than zero. Documents
with zero `ungroundedWithValue` and zero `missing` SHALL be summarized in a
single collapsed line rather than one row per document.

#### Scenario: Batch with a mix of clean and problem documents

- **WHEN** a batch finishes with 40 succeeded documents, 5 of which have at
  least one ungrounded-with-value or missing field
- **THEN** the dialog shows "40 succeeded"
- **AND** shows one detailed row per each of the 5 documents with issues
- **AND** shows a single summary line covering the remaining 35 clean
  documents instead of 35 individual rows

#### Scenario: Batch with no problem documents

- **WHEN** every succeeded document in the batch has zero
  ungrounded-with-value and zero missing fields
- **THEN** the dialog shows the success count and the collapsed summary line
- **AND** shows no per-document detail rows
