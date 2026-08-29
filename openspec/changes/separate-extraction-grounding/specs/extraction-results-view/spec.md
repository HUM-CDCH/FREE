## ADDED Requirements

### Requirement: Results distinguish extraction from grounding progress

While a composed Extraction run is active, the Results experience SHALL identify whether values are being extracted or Evidence is being grounded. The completed Results JSON SHALL display the clean value result without citation wrappers. A grounding failure after successful extraction SHALL keep the values visible and SHALL offer a grounding-only retry.

#### Scenario: Value extraction is running

- **WHEN** the first model operation is pending
- **THEN** the Results experience reports that values are being extracted

#### Scenario: Evidence grounding is running

- **WHEN** value extraction succeeded and the grounding operation is pending
- **THEN** the Results experience reports that Evidence is being grounded

#### Scenario: Grounding fails after extraction

- **WHEN** the grounding operation fails after values were extracted
- **THEN** the extracted values remain visible without PDF highlights or Review Decisions
- **AND** the researcher can retry grounding without rerunning value extraction
