<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Batch extraction is a sequential browser loop

Studio SHALL run batch extraction in the browser by iterating completed parsing task IDs sequentially and calling the same single-document extraction endpoint for each task. The server SHALL NOT expose a batch-specific extraction endpoint or module.

#### Scenario: Multiple completed tasks are submitted

- **WHEN** a humanities researcher starts extraction for multiple completed parsing tasks
- **THEN** the browser waits for each single-document request to settle before starting the next
- **AND** every request uses the same endpoint and request contract as an individual extraction

#### Scenario: Batch contains one task

- **WHEN** the batch contains one completed task ID
- **THEN** its result is equivalent to running that task through the individual extraction action

### Requirement: Batch preserves independent outcomes

The browser SHALL retain each document's successful Extraction Result or error independently. A failed request SHALL NOT erase prior successes or prevent later task IDs from being attempted.

#### Scenario: A later request fails

- **WHEN** an earlier task succeeds and a later task fails
- **THEN** the earlier task's Extraction Result remains available
- **AND** the failed task records its own error

#### Scenario: A middle request fails

- **WHEN** one request fails before unprocessed task IDs remain
- **THEN** the browser records that failure and continues with the next task ID
- **AND** each later success is retained independently

### Requirement: Batch does not introduce server-side persistence or concurrency

Sequential batch SHALL reuse the single-document response directly and SHALL NOT add result persistence, server-side queueing, concurrent model calls, or batch-only merge behavior.

#### Scenario: Batch completes

- **WHEN** all task IDs have settled
- **THEN** the browser holds the ordered per-document outcomes for display
- **AND** no combined server-side Extraction Result or durable batch record is created
