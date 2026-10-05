## ADDED Requirements

### Requirement: Admission commits durable work directly

A valid single, Batch or suggested-Batch request SHALL admit durable work
without a release flag or environment switch. Admission SHALL create the public
Extraction, durable head, dispatch and workflow enqueue in one transaction.
There SHALL be no non-durable fallback. An identical single admission SHALL
replay its saved identity without creating another workflow. An enqueue failure
SHALL roll back all admission writes. The HTTP contract SHALL return 201 for a
new Extraction and expose its current durable execution status and saved values.

#### Scenario: Successful admission

- **WHEN** the researcher submits valid current pins
- **THEN** the Extraction, durable head, dispatch and workflow commit together
- **AND** a new HTTP admission returns 201

#### Scenario: Failed enqueue

- **WHEN** enqueue fails inside the admission transaction
- **THEN** no public Extraction, durable head, dispatch or workflow is committed

#### Scenario: Single admission is replayed

- **WHEN** the researcher repeats an identical admitted single Extraction ID
- **THEN** the saved identity is returned without another workflow

#### Scenario: Durable work completes

- **WHEN** an admitted Extraction completes processing
- **THEN** its API reports executionStatus COMPLETED
- **AND** its saved values are available from the durable values endpoint
