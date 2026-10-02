## ADDED Requirements

### Requirement: The researcher chooses sample pages from the viewer

Studio SHALL track the page shown in the PDF viewer and SHALL let the researcher
set the sample to that page, to it with one or two neighbours on each side, or to
pages toggled on a thumbnail strip, and SHALL show how many pages the sample has
before it runs.

#### Scenario: Current page with neighbours

- **WHEN** the viewer shows page 13 and the researcher chooses "± 1 page"
- **THEN** the sample is pages 12–14

#### Scenario: Toggle a page on the strip

- **WHEN** the researcher toggles page 17 on the thumbnail strip
- **THEN** page 17 is added to or removed from the sample

### Requirement: Each field shows its sample values in the Schema tab

After a sample has run, each field card in the Schema tab SHALL list that field's
value for every sampled record, with its record label, its Evidence and the
reviewed status. Every card SHALL show which Schema Revision and pages produced
its values, and SHALL say so when the Current Schema Revision is newer. A field
that did not exist in that revision SHALL say it has no sample values yet. A
record SHALL carry the same label on every card: its recipe entry label, else its
Article identity field values, else its first Evidence page and first non-empty
scalar value, else its first Evidence page and position. Labels SHALL be display
only and never used to match records.

#### Scenario: Values under a field

- **WHEN** a sample on pages 12–14 extracted three catalogue entries
- **THEN** the `date` card lists three values labelled Nr. 41, Nr. 42 and Nr. 43

#### Scenario: Schema edited after the sample

- **WHEN** the researcher edits the `date` description after the sample ran on
  revision 4
- **THEN** the card says its values are from revision 4

### Requirement: Provenance works in both directions

Activating a sample value SHALL show its Evidence on the page, scrolling the
viewer to it. Activating an Evidence passage on the page SHALL focus the value it
supports in its field card. Passages supporting sample values SHALL be marked on
the page with the names of their fields.

#### Scenario: From value to page

- **WHEN** the researcher activates the value `1897` of `date` for Nr. 41
- **THEN** the viewer shows page 12 with the passage "Erworben 1897" highlighted

#### Scenario: From page to value

- **WHEN** the researcher activates the passage "H. 38,2 cm" on page 12
- **THEN** the `height_cm` value for Nr. 41 is focused in its card

### Requirement: Sample values are reviewed in place

The researcher SHALL mark each sample value right, or correct it, in its field
card. A correction SHALL carry Evidence: the passage containing the corrected
value, found automatically when it is unique on the record's pages, confirmed by
the researcher when there are several, or picked on the page when there is none.
Every decision SHALL be undoable until the review is finalized.

#### Scenario: Correction found on the page

- **WHEN** the researcher corrects `date` for Nr. 41 from `1897` to `um 1650`
- **THEN** the passage "um 1650" on page 12 becomes the correction's Evidence

#### Scenario: Corrected value not printed verbatim

- **WHEN** the corrected value does not occur on the record's pages
- **THEN** the correction cannot be saved until the researcher picks a passage

### Requirement: Running the sample again uses the current schema

Running a sample SHALL first save pending schema edits as the Current Schema
Revision, as Run extraction does. If saving succeeds and admission fails, the
revision SHALL stay saved and the researcher SHALL be able to retry admission.

#### Scenario: Edit then re-run

- **WHEN** the researcher edits a description and runs the sample again
- **THEN** a new Schema Revision is saved and the sample runs on it

### Requirement: Re-run values are compared with the review

A value in a later sample SHALL be shown as fixed, as reviewed, changed, type
changed, new field or unmatched record, according to the review-transfer rules.
A changed value SHALL offer accepting the new value or keeping the reviewed one;
keeping it SHALL visibly record a correction and keep the model's new value
visible.

#### Scenario: Description fix

- **WHEN** Nr. 41's `date` was corrected to `um 1650` with reviewed Evidence
  `a_p12_s8`, and the re-run extracts `um 1650` from `a_p12_s8`
- **THEN** the value is shown as fixed

#### Scenario: Regression

- **WHEN** Nr. 43's `height_cm` was approved as `29` and the re-run extracts
  nothing
- **THEN** the value is shown as changed, with "Accept new" and "Keep 29"

### Requirement: Structural schema edits keep reviewed values honest

Renaming a field SHALL keep its reviewed values. Retyping SHALL keep a reviewed
value only when it converts to the new type without loss, otherwise mark it type
changed. An added field's values SHALL be new and unreviewed. A removed field's
decisions SHALL be kept with the revision that had it and no longer shown.

#### Scenario: Rename

- **WHEN** `object_type` is renamed `object` and the sample re-runs
- **THEN** its reviewed values show as reviewed under `object`

#### Scenario: Lossless retype

- **WHEN** `number` is retyped from `string` to `integer` and the reviewed value
  was `"41"`
- **THEN** the value shows as reviewed and converted

#### Scenario: Added field

- **WHEN** `diameter_cm` is added and the sample re-runs
- **THEN** its values are marked as a new field and must be reviewed
