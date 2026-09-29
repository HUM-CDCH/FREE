## ADDED Requirements

### Requirement: Reviewed sample decisions are pinned at admission

When a single Extraction of a Source Document is admitted after samples of the
same document, Source Representation Revision and Extraction Schema, Studio SHALL
pin to it an immutable snapshot of the decisions of all those samples: explicit
decisions plus carried ones not overridden. Where two samples decided the same
aligned record and schema node, the newer decision SHALL win; decisions on
records no later sample aligned SHALL be kept unchanged. A later change to a
sample's review SHALL NOT change the snapshot. Nothing SHALL be pinned across a
different Source Representation Revision or Extraction Schema. Batch Extraction
members SHALL NOT pin a snapshot in this change.

#### Scenario: Full run after a partly reviewed sample

- **WHEN** the researcher reviewed 15 of 18 sample values and runs the full
  Extraction
- **THEN** the full Extraction pins those 15 decisions

#### Scenario: Samples on two page sets

- **WHEN** the researcher reviewed a sample on pages 12–14, then one on pages
  40–42, then runs the full Extraction
- **THEN** the full Extraction pins the decisions of both samples

#### Scenario: Reprocessed source

- **WHEN** the document was reprocessed after the sample
- **THEN** the next Extraction pins no decisions

### Requirement: Records are aligned before values are compared

A transfer SHALL align records first. For recipe Catalog runs with the same
segmentation fingerprint, records SHALL align by segmentation block. Otherwise
two records SHALL align only when they share Evidence Anchors and the pairing is
one-to-one and mutual. A record that does not align SHALL be reported as
unmatched, and its values SHALL NOT be reported as changed.

#### Scenario: Article records merge in the full run

- **WHEN** two sample records share anchors with one full-run record
- **THEN** none of them align and their values stay to review as unmatched

### Requirement: The researcher can pair unmatched records by hand

Studio SHALL let the researcher pair an unmatched destination record with an
unmatched record of the snapshot, one-to-one, and undo the pairing until the
review is finalized. A paired record SHALL be compared field by field under the
same rules as an aligned one; pairing SHALL NOT let a value carry whose anchors
differ.

#### Scenario: Pair a split record

- **WHEN** a sample record is unmatched because the full run split it in two and
  the researcher pairs it with one of the two
- **THEN** that pair's fields show as reviewed, changed or to review
- **AND** the other record stays to review

#### Scenario: Pairing does not relax Evidence

- **WHEN** a paired field has the reviewed value on a different anchor
- **THEN** it is shown as changed and stays to review

### Requirement: A decision carries only when field, value and Evidence agree

Within aligned records, fields SHALL match by schema node id and array items by
their Evidence Anchors, never by index. After lossless conversion to the
destination field type:

- an approval SHALL carry when the destination value and anchors equal the
  approved ones;
- a correction SHALL carry as an approval when the destination value equals the
  corrected value and its anchors equal the correction's reviewed Evidence, and
  as the same correction when the destination repeats the corrected model value
  on the same anchors;
- a rejection SHALL carry when the destination repeats the rejected value on the
  same anchors.

Every other value SHALL stay to review.

#### Scenario: Approved value carries into the full run

- **WHEN** Nr. 41's `material` was approved as "Silber, vergoldet" on anchor
  `a_p12_s4` and the full run extracts the same value on the same anchor
- **THEN** the full run's review starts with that value approved and marked as
  reviewed in the sample

#### Scenario: The same mistake again

- **WHEN** Nr. 41's `date` was corrected from `1897` to `um 1650` and the full run
  again extracts `1897` from "Erworben 1897"
- **THEN** the full run's review starts with the same correction

#### Scenario: Same value, different passage

- **WHEN** the destination value equals the approved value but cites another
  anchor
- **THEN** the value stays to review

### Requirement: Carried decisions seed a draft

Carried decisions SHALL seed the destination review as draft decisions under the
destination's own result paths, each recording the source Extraction and source
path. The researcher SHALL be able to override any of them, and the review SHALL
become authoritative only when the researcher finalizes it. Studio SHALL show how
many values were reviewed in the sample, how many changed since, and how many are
left.

#### Scenario: Override a carried decision

- **WHEN** the researcher rejects a value carried as approved
- **THEN** the draft holds the rejection and the finalized decision is the
  rejection
