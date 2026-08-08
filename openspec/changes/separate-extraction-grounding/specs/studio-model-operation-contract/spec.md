## ADDED Requirements

### Requirement: Composed Extraction stages preserve buffered operation contracts

Studio SHALL compose value extraction and grounding from buffered model operations without introducing a model stream or provider-specific transport. Each operation SHALL retain the stable success and failure envelopes of the selected Studio model route, while the browser orchestration SHALL distinguish which stage failed.

#### Scenario: Both model stages succeed

- **WHEN** value extraction and grounding both complete
- **THEN** each model operation uses one buffered JSON response
- **AND** the completed run retains model attribution for both stages

#### Scenario: Grounding provider call fails

- **WHEN** the grounding operation fails after value extraction succeeded
- **THEN** the failure is reported as a grounding-stage failure
- **AND** the successful value result is not converted into a provider failure or discarded
