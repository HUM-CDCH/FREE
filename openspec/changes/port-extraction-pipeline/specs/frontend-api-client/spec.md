<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Extraction client uses the parsing task identity

The frontend extraction client SHALL retain the parsing task ID associated with the current completed canonical document and SHALL submit `{ taskId, schema, strategy }` to the Studio server extraction endpoint. It SHALL NOT send Source Document bytes or the complete canonical document.

#### Scenario: Current document completes parsing

- **WHEN** ingestion and canonical parsing produce a completed task
- **THEN** the frontend retains that task's ID for subsequent extraction

#### Scenario: Extraction is requested

- **WHEN** the frontend starts Catalog or Article extraction for the current document
- **THEN** it sends the retained `taskId`, the Extraction Schema, and the explicit strategy
- **AND** it does not upload the Source Document again

### Requirement: Extraction response has one boundary decoder

The extraction client SHALL decode the non-streaming endpoint response at one boundary and return a typed schema-shaped Extraction Result plus its minimal warnings. Missing required response fields SHALL fail at that decoder rather than propagating `undefined` into feature code.

#### Scenario: Well-formed extraction response is received

- **WHEN** the endpoint returns a result and warnings with the expected shapes
- **THEN** the decoder returns the typed extraction response to feature code

#### Scenario: Required extraction field is absent

- **WHEN** the endpoint response omits its result or warnings field
- **THEN** the decoder throws an error naming the extraction endpoint and missing field

## MODIFIED Requirements

### Requirement: Single JSONL streaming transport

The frontend SHALL consume every remaining backend JSONL-streaming endpoint through one shared transport function, `streamJsonl<T>`, which owns request dispatch, line framing, event-envelope handling, and abort wiring. Feature code SHALL NOT re-implement JSONL framing or the event-dispatch loop; it SHALL depend on the transport and never the reverse. The canonical-document extraction endpoint SHALL use its dedicated non-streaming client contract instead.

#### Scenario: Streaming endpoint consumed through the shared transport

- **WHEN** the frontend calls a remaining streaming endpoint such as `/chat`, `/api/generate_schema`, or `/markdown`
- **THEN** the request is issued through `streamJsonl<T>` with `accept: application/jsonl`
- **AND** no per-endpoint code parses raw response lines or buffers the byte stream itself

#### Scenario: Canonical-document extraction is requested

- **WHEN** the frontend requests extraction by parsing task ID
- **THEN** it uses the dedicated extraction request and response decoder
- **AND** it does not require the extraction endpoint to emit JSONL events

#### Scenario: Transport has no endpoint-specific knowledge

- **WHEN** a new streaming endpoint wrapper is added
- **THEN** it is expressible as a thin call to `streamJsonl<T>` supplying only the endpoint path, a `FormData` body, the delta/page handlers, and a `done` decoder
- **AND** the transport module requires no edit to support it

### Requirement: Typed boundary decoder drift guard

Each streaming endpoint SHALL define exactly one boundary decoder for its `done` payload that asserts the fields the frontend depends on and returns a typed value. When a required field is absent, the decoder SHALL throw a named error identifying the endpoint and the missing field, so backend contract drift fails loudly at the single boundary rather than propagating as an `undefined` into feature code.

#### Scenario: Well-formed streaming payload decodes to a typed value

- **WHEN** a `done` payload contains all fields its streaming endpoint decoder requires
- **THEN** the decoder returns the typed payload, such as `TemplateDone`
- **AND** feature code receives that typed value with no further runtime guards

#### Scenario: Missing field fails loud and localized

- **WHEN** a `done` payload is missing a field the streaming endpoint decoder requires
- **THEN** the decoder throws an `Error` naming the endpoint and the missing field
- **AND** the error surfaces at the decode boundary, not deep inside feature code

## REMOVED Requirements

### Requirement: Behavior-preserving migration of existing wrappers

**Reason**: Canonical-document extraction intentionally replaces the current extraction request and streamed result contract with a task-ID-based server API. Preserving the existing `requestExtraction` signature would retain the browser/model boundary this port removes.

**Migration**: Update extraction callers to retain the parsing task ID, select an explicit Catalog or Article strategy, submit `{ taskId, schema, strategy }`, and consume the decoded result-plus-warnings response. `requestSchema` and unrelated streaming wrappers remain on their existing contracts.
