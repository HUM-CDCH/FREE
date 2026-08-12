## ADDED Requirements

### Requirement: Catalog executes one pinned synchronous model plan

The server SHALL load the pinned Source Representation and Schema Revision and resolve one Extraction Route for the whole Catalog attempt. It SHALL make zero or one whole-document values call when document-scoped content is requested, exactly one discovery call, at most one values call for each of the first 100 resolved records, and the calls needed to ground the final assembled result. The record limit SHALL be the constant `CATALOG_RECORD_LIMIT = 100`, not a user setting.

#### Scenario: Mixed-scope Catalog plan

- **WHEN** a schema contains document-, record-, and package-scoped fields and discovery resolves records
- **THEN** document content is extracted once
- **AND** each of the first 100 records is attempted once against its canonical slice
- **AND** package values cause no model call
- **AND** every call uses the one pinned route

#### Scenario: More than 100 records are discovered

- **WHEN** discovery resolves more than 100 records
- **THEN** only the first 100 are attempted
- **AND** every later record receives ordered `not_attempted_limit` diagnostics
- **AND** the attempt is incomplete

### Requirement: Catalog assembles ordered useful partial results

Catalog SHALL omit failed and unattempted records rather than fabricate placeholders. It SHALL assemble successful records in canonical source order, overlay document and package values, and ground the complete assembled payload once. A discovery failure SHALL be `FAILED`. Zero assembled records SHALL be `FAILED`. At least one assembled record SHALL be `SUCCEEDED`, with `complete: false` when a requested document call, attempted record, record limit, or grounding is incomplete. A fully grounded partial result SHALL remain reviewable.

#### Scenario: A middle record fails

- **WHEN** records before and after one failed record extract successfully
- **THEN** both successful records appear in source order
- **AND** no placeholder represents the failed record
- **AND** the attempt is `SUCCEEDED` and incomplete

#### Scenario: Document values fail but records succeed

- **WHEN** requested document-scoped extraction fails and at least one record succeeds
- **THEN** successful records are persisted without fabricated document values
- **AND** the attempt is `SUCCEEDED` and incomplete

#### Scenario: Discovery cannot resolve records

- **WHEN** discovery fails or its labels are rejected
- **THEN** the attempt is `FAILED` with structured discovery diagnostics
- **AND** no record values calls or result payload are produced

#### Scenario: Partial result is fully grounded

- **WHEN** a partial assembled result has Evidence for every populated content-derived scalar
- **THEN** it is reviewable even though `complete` is false

### Requirement: Catalog cancellation discards partial work

Researcher cancellation SHALL use the existing server-owned cancellation lifecycle and persist `CANCELLED` with no result, even when earlier Catalog stages or records succeeded. Catalog SHALL perform zero automatic retries.

#### Scenario: Cancellation follows successful records

- **WHEN** cancellation is observed after one or more record calls completed but before terminal persistence
- **THEN** the attempt is persisted as `CANCELLED`
- **AND** no partial result is persisted
- **AND** no call is retried automatically

### Requirement: Catalog targeted retries are explicit child attempts

A targeted Catalog retry SHALL create a new UUID-bound child attempt naming its immediate parent. The child SHALL inherit the parent's Source Representation Revision, Schema Revision, and `CATALOG` strategy, resolve the currently configured route, and persist retry selection and reuse provenance. A request SHALL select at most 100 failed or `not_attempted` records; larger selections SHALL be rejected. It MAY rerun a failed document-values stage, rediscover boundaries, and/or selected failed or limit-skipped records. Successful parent values and boundaries SHALL be reused with zero new calls. Rediscovery SHALL be required before dependent record reruns when the parent discovery did not succeed. The child SHALL perform a fresh grounding pass over its complete assembled result and SHALL NOT copy the parent's review state. Automatic/provider retries remain forbidden.

#### Scenario: Selected record retry reuses successful siblings

- **WHEN** a partial Catalog parent has one failed record and one successful record and the researcher selects only the failed record
- **THEN** a new child attempt reuses the successful sibling with `provenance: reused` and zero calls
- **AND** reruns only the selected failed record against the parent's pinned source and schema
- **AND** grounds the complete child result in a fresh pass

#### Scenario: A limit-skipped record may be selected explicitly

- **WHEN** a parent discovered more than 100 records and the researcher selects one `not_attempted_limit` record beyond the parent's first 100 (within the 100-record request selection limit)
- **THEN** the child may attempt it as one of its first 100 newly executed record calls
- **AND** reused successful parent records do not consume that child call limit
- **AND** any additional selected records beyond the child limit remain `not_attempted_limit`

#### Scenario: Rediscovery is required for a failed discovery parent

- **WHEN** a Catalog parent has failed discovery and a retry omits `rediscover: true`
- **THEN** the server rejects the retry before any model call
- **AND** a retry with `rediscover: true` reruns discovery and dependent records on the current configured route

#### Scenario: Retry review state is isolated

- **WHEN** a succeeded Catalog parent has saved Review Decisions and a child retry is created
- **THEN** the child has no copied review decisions or reviewed timestamp
- **AND** the parent remains independently reviewable and unchanged

### Requirement: Catalog diagnostics are durable and self-contained

Persisted diagnostics SHALL identify every stage and discovered record in source order. They SHALL retain outcome, finish reason, call count, token usage, latency, failure code, canonical record identity and boundary, grounding batches, and `not_attempted_limit` outcomes where applicable. Reopen SHALL return these diagnostics with the attempt's strategy and pins without provider re-execution.

#### Scenario: Partial Catalog attempt is reopened

- **WHEN** a persisted partial Catalog attempt is reopened
- **THEN** its result, completeness, strategy, pins, stage diagnostics, and ordered record diagnostics equal the terminal snapshot
