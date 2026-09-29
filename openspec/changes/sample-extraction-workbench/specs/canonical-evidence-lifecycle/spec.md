## MODIFIED Requirements

### Requirement: Review is an explicit action bound to what produced the result

The researcher SHALL accept a successful Extraction Result through an explicit
browser action that posts the result, the Schema Revision the extraction used,
and one Review Decision per canonical Evidence Anchor the result cites. The
write MAY also carry Review Decisions on values the result does not ground, each
with researcher-chosen canonical Evidence. The action SHALL NOT be offered once
the Extraction Schema in the browser is no longer that Schema Revision, and an
anchor the Parsing Service did not publish for the pinned Source Representation
SHALL NOT become a Review Decision or its reviewed Evidence.

#### Scenario: Researcher accepts a result

- **WHEN** the researcher accepts an Extraction Result citing canonical anchors
- **THEN** the write carries the pinned Schema Revision and one Review Decision
  per cited anchor, with that anchor's published occurrences reviewed

#### Scenario: Researcher supplies a value the model missed

- **WHEN** the result has no value for `height_cm` of Nr. 43 and the researcher
  enters `29` citing the published passage "H. mit Henkel 29 cm"
- **THEN** the write carries a Review Decision for that path with no model
  anchor and the chosen passage as its reviewed Evidence

#### Scenario: Chosen passage is not canonical

- **WHEN** a Review Decision's reviewed Evidence names an anchor the pinned
  Source Representation does not publish
- **THEN** nothing is written

## ADDED Requirements

### Requirement: A correction keeps the model's Evidence and its own

A Review Decision that edits a grounded value SHALL keep the model's Evidence
Anchor and MAY add reviewed Evidence naming the canonical passage that holds the
corrected value.

#### Scenario: Correction printed elsewhere on the page

- **WHEN** the researcher corrects `date` from `1897` (anchor `a_p12_s12`) to
  `um 1650`, printed in `a_p12_s8`
- **THEN** the decision keeps `a_p12_s12` as the model's anchor and records
  `a_p12_s8` as reviewed Evidence

### Requirement: Carried decisions do not make a review authoritative

Review Decisions carried from an earlier Extraction SHALL enter the destination
review as draft decisions. The destination review SHALL become authoritative only
through the researcher's explicit finalization, under the same completeness rules
as any review.

#### Scenario: Every grounded value was carried

- **WHEN** every grounded value of a full Extraction carries from the sample
- **THEN** the review stays a draft until the researcher finalizes it
