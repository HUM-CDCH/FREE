# studio-model-operation-contract Specification

## Purpose
TBD - created by archiving change runtime-model-configuration. Update Purpose after archive.
## Requirements
### Requirement: Studio buffered model operations preserve their success contracts

Studio's TypeScript `POST /api/extract`, `POST /api/generate_schema`, and `POST /api/edit_schema` handlers SHALL return their existing single JSON success payloads with `200 application/json`. They MUST NOT emit a model stream, a JSON Lines response, or a buffered array of stream events.

#### Scenario: Extraction succeeds

- **WHEN** the Studio extraction handler completes a model operation
- **THEN** `POST /api/extract` returns its existing extraction result as one JSON object
- **AND** it does not expose a streaming transport

#### Scenario: Schema suggestion succeeds

- **WHEN** the Studio schema-suggestion handler completes a model operation
- **THEN** `POST /api/generate_schema` returns its existing schema result as one JSON object
- **AND** it does not expose a streaming transport

#### Scenario: Conversational schema editing succeeds

- **WHEN** the Studio schema-edit handler completes a model operation
- **THEN** `POST /api/edit_schema` returns its existing `{ "ops": ... }` payload as one JSON object
- **AND** it does not expose a streaming transport

### Requirement: Studio model-operation HTTP failures use one stable envelope

Studio's TypeScript model-operation handlers SHALL parse client-supplied inputs strictly and SHALL reserve repair for generated model output. The three buffered handlers and failures detected by `POST /api/chat` before its stream response begins SHALL return `{ "error": { "code": string, "message": string, "details"?: unknown } }`. For an immediate provider failure, the envelope MAY include the numeric upstream status and raw verbatim provider response body bounded as defined by the design; this detail is immediate-only. The envelope and its details MUST NOT add FREE-managed credentials, request headers, full request bodies, stack traces, unbounded upstream response bodies, or arbitrary thrown objects.

#### Scenario: A buffered request is invalid

- **WHEN** `/api/extract`, `/api/generate_schema`, or `/api/edit_schema` receives malformed or schema-invalid client input
- **THEN** the handler returns HTTP 400 with `error.code` `invalid_request`
- **AND** it does not repair the client input or invoke a model

#### Scenario: A buffered model operation fails

- **WHEN** a buffered Studio model operation reaches its selected provider and the provider or generated output fails
- **THEN** the handler returns HTTP 502 with a stable error envelope
- **AND** any included upstream status and raw provider body are bounded, immediate-only, and do not add FREE-managed credentials or request data
- **AND** the response is not a `200` success object

#### Scenario: Chat fails before stream creation

- **WHEN** `/api/chat` request parsing, Capability Route resolution, option validation, or required credential lookup fails before stream creation
- **THEN** the handler returns the mapped non-200 status with the stable error envelope
- **AND** it does not start the UI-message stream

### Requirement: Studio chat failures preserve the committed stream protocol

Once the TypeScript `POST /api/chat` handler has committed its stream response, it SHALL preserve the committed HTTP status and represent a later failure with the AI SDK UI-message stream's standard `{ "type": "error", "errorText": string }` part. It MUST NOT encode the HTTP error envelope in the stream or attempt to replace the committed response.

#### Scenario: Chat fails after stream commitment

- **WHEN** provider or generation failure occurs after `/api/chat` stream headers are committed
- **THEN** the stream emits the standard AI SDK error part with sanitized `errorText` of at most 512 Unicode code points
- **AND** the committed HTTP status remains unchanged
- **AND** the error part excludes internal causes, credentials, request data, upstream bodies, and stack traces

#### Scenario: Studio receives an in-stream error

- **WHEN** the Studio frontend receives the AI SDK UI-message error part
- **THEN** it terminates stream consumption on that error, including through `readUIMessageStream` with `terminateOnError: true` or equivalent behavior
- **AND** it reports a failed operation rather than a completed assistant message

### Requirement: Runtime configuration does not change deferred model-output tolerance

This change SHALL limit model-operation behavior changes to saved-route
resolution, strict client-request parsing, and error transport. It SHALL retain
the existing tolerant handling outside those boundaries: parseable Extraction
output that does not match its declared schema remains on the current tolerant
path, individual invalid conversational Extraction Schema operations remain
filtered, and a non-array schema-edit result remains the existing no-op. This change MUST NOT
add partial Extraction validation issues, reject all schema-edit operations,
or turn a wrong top-level edit shape into a provider error.

#### Scenario: Deferred output-tolerance behavior remains stable

- **WHEN** a selected provider returns parseable but schema-mismatched Extraction output, invalid individual schema-edit operations, or a non-array schema-edit result
- **THEN** runtime-model configuration does not convert that existing tolerant behavior into a new HTTP 502 or validation contract
- **AND** strict parsing still applies to client-supplied request JSON, while repair remains limited to generated model output

