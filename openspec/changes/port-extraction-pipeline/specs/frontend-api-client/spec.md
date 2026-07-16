<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Extraction client uses the parsing task identity and full schema envelope

The frontend extraction client SHALL retain the parsing task ID associated with the current completed canonical document and SHALL submit an `application/json` body `{ taskId, schema, strategy }` to the Studio server extraction endpoint. When a researcher selects a pinned Extraction Schema, the client SHALL retain and submit that full envelope unchanged, including `_schema_metadata` and schema-local `_evidence`. It SHALL NOT send Source Document bytes or the complete canonical document.

#### Scenario: Current document completes parsing

- **WHEN** ingestion and canonical parsing produce a completed task
- **THEN** the frontend retains that task's ID for subsequent extraction

#### Scenario: Extraction is requested with Burial Finds

- **WHEN** a researcher selects the pinned `FieldReports / Burial_Finds` Extraction Schema and starts extraction
- **THEN** the frontend sends the retained `taskId`, the explicit `catalog` strategy, and the verbatim full schema envelope
- **AND** the submitted `record.entries` retains its local `_evidence`
- **AND** the submitted `_schema_metadata` retains the `record.entries` instance description
- **AND** it does not upload the Source Document again

#### Scenario: Extraction is requested from a Studio-generated template

- **WHEN** the frontend starts extraction from the existing generated-template path
- **THEN** it explicitly adapts the generated record template to a full envelope with `_schema_metadata: {}`
- **AND** it does not represent that generated envelope as the pinned Burial Finds parity schema

### Requirement: Extraction response has one boundary decoder

The extraction client SHALL decode the non-streaming `{ result, warnings }` endpoint response at one boundary and return a typed record-shaped Extraction Result plus its ordered string warnings. Missing or malformed required response fields SHALL fail at that decoder rather than propagating invalid values into feature code.

#### Scenario: Well-formed extraction response is received

- **WHEN** the endpoint returns an object result and string-array warnings
- **THEN** the decoder returns the typed extraction response to feature code

#### Scenario: Required extraction field is absent or malformed

- **WHEN** the endpoint response omits `result` or `warnings`, returns a non-object result, or returns non-string warnings
- **THEN** the decoder throws an error naming the extraction endpoint and invalid field

## MODIFIED Requirements

### Requirement: Typed boundary decoder drift guard

Each JSON request wrapper SHALL define exactly one boundary decoder that asserts the response fields the frontend depends on and returns a typed value. When a required field is absent or malformed, the decoder SHALL throw a named error identifying the endpoint and field, so backend contract drift fails at the single boundary rather than propagating into feature code.

#### Scenario: Well-formed JSON payload decodes to a typed value

- **WHEN** a JSON response contains all fields its endpoint decoder requires
- **THEN** the decoder returns the typed payload
- **AND** feature code receives that typed value with no further runtime guards

#### Scenario: Missing field fails loud and localized

- **WHEN** a JSON response is missing a field its endpoint decoder requires
- **THEN** the decoder throws an `Error` naming the endpoint and missing field
- **AND** the error surfaces at the decode boundary, not deep inside feature code

## REMOVED Requirements

### Requirement: Single JSONL streaming transport

**Reason**: The repository's schema and extraction endpoints use ordinary JSON responses, chat uses its AI SDK stream protocol, and no shared JSONL event transport exists. Requiring `/api/generate_schema`, `/markdown`, and extraction to adopt JSONL would expand this parity port beyond its approved scope.

**Migration**: Keep each existing endpoint on its actual transport and use one typed boundary decoder per JSON response. Canonical-document extraction uses its dedicated JSON request and response contract.

### Requirement: Event-envelope dispatch contract

**Reason**: No current Studio extraction or schema endpoint emits the historical `delta`, `page_done`, `error`, and `done` JSONL envelope described by this requirement.

**Migration**: Continue using the AI SDK chat stream for chat and ordinary decoded JSON for schema generation and canonical-document extraction.

### Requirement: Behavior-preserving migration of existing wrappers

**Reason**: Canonical-document extraction intentionally replaces the current multipart `requestExtraction` signature and separate Evidence result contract with task-ID-based server extraction.

**Migration**: Update extraction callers to retain the parsing task ID, choose an explicit Catalog or Article strategy, preserve selected pinned Extraction Schema envelopes, submit `{ taskId, schema, strategy }`, and consume `{ result, warnings }`. Adapt the existing generated-template response to an envelope at its own boundary rather than rebuilding every schema inside `requestExtraction`.
