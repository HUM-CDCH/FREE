## ADDED Requirements

### Requirement: Single JSONL streaming transport

The frontend SHALL consume every backend JSONL-streaming endpoint through one shared transport function, `streamJsonl<T>`, which owns request dispatch, line framing, event-envelope handling, and abort wiring. Feature code SHALL NOT re-implement JSONL framing or the event-dispatch loop; it SHALL depend on the transport and never the reverse.

#### Scenario: Endpoint consumed through the shared transport

- **WHEN** the frontend calls a streaming endpoint (`/chat`, `/extract`, `/generate-template`, or `/markdown`)
- **THEN** the request is issued through `streamJsonl<T>` with `accept: application/jsonl`
- **AND** no per-endpoint code parses raw response lines or buffers the byte stream itself

#### Scenario: Transport has no endpoint-specific knowledge

- **WHEN** a new streaming endpoint wrapper is added
- **THEN** it is expressible as a thin call to `streamJsonl<T>` supplying only the endpoint path, a `FormData` body, the delta/page handlers, and a `done` decoder
- **AND** the transport module requires no edit to support it

### Requirement: Event-envelope dispatch contract

`streamJsonl<T>` SHALL interpret each parsed JSONL event by its `event` field as follows: a `delta` event invokes the caller's `onDelta` handler with the incremental output (and page index when present); a `page_done` event invokes the caller's optional `onPageDone` handler; an `error` event aborts the stream by throwing an `Error` carrying the event's `detail`; and a terminal `done` event is passed to the caller's decoder and its decoded value becomes the resolved result.

#### Scenario: Delta events drive incremental output

- **WHEN** the stream yields one or more `delta` events
- **THEN** `onDelta` is invoked for each with the event's `output` text
- **AND** when a `delta` carries a `page` index it is forwarded to `onDelta`

#### Scenario: Error event rejects the call

- **WHEN** the stream yields an `error` event
- **THEN** `streamJsonl` throws an `Error` whose message is the event's `detail`
- **AND** no decoded result is returned

#### Scenario: Malformed page_done fails loud

- **WHEN** a `page_done` event is missing its required `page` or `markdown` field
- **THEN** `streamJsonl` throws a named `Error` identifying the endpoint and the contract drift
- **AND** no fabricated default values are passed to `onPageDone`

#### Scenario: Done event resolves the decoded result

- **WHEN** the stream yields a terminal `done` event
- **THEN** the event's `data` is passed to the caller-supplied decoder
- **AND** the decoder's return value resolves the `streamJsonl<T>` promise

#### Scenario: Stream ends without a terminal result

- **WHEN** the stream closes without yielding a `done` event
- **THEN** `streamJsonl` throws an `Error` indicating the stream ended without a result

#### Scenario: Caller aborts mid-stream

- **WHEN** the caller's `AbortSignal` fires before the `done` event
- **THEN** the underlying request is aborted and no further handlers fire

### Requirement: Typed boundary decoder drift guard

Each streaming endpoint SHALL define exactly one boundary decoder for its `done` payload that asserts the fields the frontend depends on and returns a typed value. When a required field is absent, the decoder SHALL throw a named error identifying the endpoint and the missing field, so backend contract drift fails loudly at the single boundary rather than propagating as an `undefined` into feature code.

#### Scenario: Well-formed payload decodes to a typed value

- **WHEN** a `done` payload contains all fields the endpoint's decoder requires
- **THEN** the decoder returns the typed payload (e.g. `ExtractDone`, `TemplateDone`)
- **AND** feature code receives that typed value with no further runtime guards

#### Scenario: Missing field fails loud and localized

- **WHEN** a `done` payload is missing a field the endpoint's decoder requires
- **THEN** the decoder throws an `Error` naming the endpoint and the missing field
- **AND** the error surfaces at the decode boundary, not deep inside feature code

### Requirement: Behavior-preserving migration of existing wrappers

The existing `requestTemplate` and `requestExtraction` functions SHALL retain their current call signatures and observable behavior after being re-implemented on `streamJsonl<T>`. Existing callers (`App.tsx`, `useExtraction.ts`) SHALL require no changes.

#### Scenario: Template request unchanged for callers

- **WHEN** `App.tsx` calls `requestTemplate` with the same arguments as before
- **THEN** it streams `delta` output through the same callback and resolves with the parsed template
- **AND** the function signature is unchanged

#### Scenario: Extraction request unchanged for callers

- **WHEN** `useExtraction.ts` calls `requestExtraction` with the same arguments as before
- **THEN** it streams `delta` output through the same callback and resolves with the extraction result object
- **AND** the function signature is unchanged
