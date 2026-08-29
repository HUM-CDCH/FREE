# model-call-composition Specification

## Purpose
TBD - created by archiving change compose-model-features. Update Purpose after archive.
## Requirements
### Requirement: Pure parsing is separated from domain logic

The `shared/parsing.py` module SHALL contain only domain-agnostic text/JSON helpers. Model-invocation domain logic — the temperature policy and the NuExtract-specific JSON repair / structured-result handling — MUST NOT live in `parsing.py`; it SHALL live in dedicated, injectable collaborators, each defined exactly once.

#### Scenario: Parsing module holds only pure helpers

- **WHEN** `shared/parsing.py` is inspected
- **THEN** it defines only domain-agnostic helpers (`strip_code_fence`, `pretty_json_or_text`, `extract_answer_block`, `normalize_template`, `parse_result`)
- **AND** it does not define `resolve_temperature` or any JSON-repair / structured-result function

#### Scenario: Domain logic lives in its own collaborators

- **WHEN** the temperature policy or the JSON repair / structured-result handling is needed
- **THEN** it is provided by a dedicated module other than `parsing.py`
- **AND** no use case redefines a local copy of that logic

### Requirement: Result parsing and repair are an injectable strategy

The transform from raw model output to a use case's result value SHALL be an injectable result-parser collaborator. Structured extraction SHALL use a repairing parser that preserves the current repair behavior; each other use case SHALL inject the parser appropriate to its output.

#### Scenario: Structured parser repairs known model output quirks

- **WHEN** the model returns a comma-separated object sequence with bare hyphenated ids (e.g. `8-1`), with or without a missing opening array bracket
- **THEN** the structured parser returns the repaired object, quoting hyphenated ids as strings and wrapping a bare object sequence under an `items` array

#### Scenario: Structured parser rejects irrecoverable output

- **WHEN** the model returns output that cannot be parsed or repaired into a JSON object
- **THEN** the structured parser raises a clear error carrying the message "Model returned invalid JSON for the extraction result"

#### Scenario: Each use case injects its own parser

- **WHEN** a use case composes its model call
- **THEN** `/extract` in structured mode injects the repairing object parser, `/extract` in free-text mode and `/api/generate_schema` inject the JSON-or-text parser, and `/chat` and `/markdown` inject no result parser (their result is raw text)

### Requirement: Reasoning splitting is decoupled from streaming

The `ThinkSplitter` SHALL be usable to split reasoning from output over a fully buffered model response and over a streamed model response. The streaming transport module MUST NOT import or own the `ThinkSplitter`, and this change SHALL preserve the current hybrid reasoning-splitting behavior without introducing provider-specific reasoning-format selection.

#### Scenario: Reasoning is split over a buffered response

- **WHEN** a buffered model command runs with reasoning enabled
- **THEN** the completed output is split into reasoning and answer text without emitting any streaming delta event

#### Scenario: Splitter and transport do not import each other

- **WHEN** `shared/streaming.py`, provider transport code, and model-execution code are inspected
- **THEN** streaming response helpers and provider transport do not import `ThinkSplitter`
- **AND** model execution does not import any JSONL/streaming response helper type
- **AND** driving the splitter is the responsibility of `ModelExecutor`

#### Scenario: Separate reasoning deltas remain supported
- **WHEN** a model stream emits reasoning text on the reasoning-delta channel
- **THEN** `ThinkSplitter` routes that text to reasoning
- **AND** content deltas from the same stream are emitted as output

#### Scenario: Inline reasoning tags remain supported
- **WHEN** a model stream emits inline `<think>...</think>` tags in content while reasoning is enabled
- **THEN** `ThinkSplitter` routes tagged text to reasoning
- **AND** emits content after the closing tag as output

#### Scenario: Provider reasoning format selection is deferred
- **WHEN** this change is implemented
- **THEN** the code does not add a hard-coded provider-to-reasoning-format mapping
- **AND** explicit provider reasoning-format selection waits for future runtime evidence

### Requirement: Both response versions are testable from one composed core

The buffered and streaming versions of a model command SHALL be exercisable from the same `ModelExecutor` core without the HTTP layer, and SHALL be consistent: given the same compiled transport output, the buffered result equals the accumulation of the streamed deltas.

#### Scenario: Either mode is drivable in a test

- **WHEN** a test holds a composed executor and a stubbed provider transport stream
- **THEN** it can drive the buffered mode and assert the returned value
- **AND** it can drive the streaming mode and assert the emitted deltas
- **AND** neither requires an HTTP request

#### Scenario: Buffered and streamed results agree

- **WHEN** the buffered mode and the streaming mode run against the same stubbed model output
- **THEN** the buffered result value, reasoning, and raw output equal the result obtained by accumulating the streamed deltas

### Requirement: Buffered endpoints return a single JSON object

`POST /extract`, `POST /api/generate_schema`, and `POST /markdown` SHALL return a single plain JSON result object with `200 application/json`. They MUST NOT emit JSON Lines, a streaming response, or a buffered array of events. Their OpenAPI `200` response SHALL advertise only `application/json`. `POST /markdown` SHALL produce its result from a single multi-page model call. This is a BREAKING change to the prior streaming contract.

#### Scenario: Extract returns a plain result object

- **WHEN** a client posts a document (or text) and template to `/extract`
- **THEN** the response is a single JSON object containing `result`, `reasoning`, `raw`, and `pages`
- **AND** the body is neither a JSON Lines stream nor an array of events

#### Scenario: Generate-template returns a plain template object

- **WHEN** a client posts a document to `/api/generate_schema`
- **THEN** the response is a single JSON object containing `template`, `raw`, and `pages`

#### Scenario: Markdown returns one document from a single multi-page call

- **WHEN** a client posts a multi-page document to `/markdown`
- **THEN** all page images are sent in one model call in page order
- **AND** the response is a single JSON object containing `markdown` (one rendering for the whole document) and `pages` (the page count)

#### Scenario: Model-side failure is reported as HTTP 502

- **WHEN** a buffered endpoint's model call fails — the model endpoint is unreachable, or `/extract` structured output cannot be parsed or repaired
- **THEN** the endpoint responds with HTTP 502 whose body carries a `detail` distinguishing the two cases (and the `raw` model output for the unparseable case)
- **AND** the response is not a `200` result object

#### Scenario: OpenAPI advertises only JSON for these endpoints

- **WHEN** the OpenAPI document is inspected
- **THEN** the `200` response of `/extract`, `/api/generate_schema`, and `/markdown` advertises `application/json` and does not advertise `application/jsonl`

### Requirement: Chat is the only streaming endpoint

`POST /chat` SHALL retain the JSON Lines streaming contract (incremental `delta` events and a terminal `done` event) and the buffered `application/json` fallback. No other endpoint SHALL stream.

#### Scenario: Chat streams delta and done

- **WHEN** a client submits non-empty chat text to `/chat`
- **THEN** the system streams `delta` events with incremental `think` / `output` and a terminal `done` event with `message`, optional `reasoning`, and `raw`
- **AND** a client accepting only `application/json` receives the buffered array of the same events

#### Scenario: Only chat advertises JSONL

- **WHEN** the OpenAPI document is inspected
- **THEN** the `200` response of `/chat` advertises both `application/json` and `application/jsonl`
- **AND** `/extract`, `/api/generate_schema`, and `/markdown` advertise `application/json` only

### Requirement: Model-call behavior is otherwise preserved

Apart from the response transport of the buffered endpoints and the `/markdown` output shape, this change SHALL NOT alter extracted values, reasoning extraction, page counts, request parameters, validation (HTTP 400) behavior, or `NUEXTRACT3_*` configuration.

#### Scenario: Results and validation are unchanged

- **WHEN** `/extract`, `/api/generate_schema`, or `/chat` is called with the same inputs as before the change
- **THEN** the extracted / template / chat result values, the reasoning text, and the page counts are identical to the prior behavior
- **AND** the same invalid inputs are rejected with HTTP 400 and the same messages

#### Scenario: Markdown output shape is the intended exception

- **WHEN** `/markdown` is called
- **THEN** its response shape changes from a per-page `pages: string[]` array to `{ markdown, pages }`
- **AND** this is the only intended behavioral change beyond transport

### Requirement: ModelExecutor is the use-case-facing model boundary
The backend SHALL expose model access to use cases through a `ModelExecutor` that executes provider-neutral `ModelCommand` values and accepts an optional result parser at execution time.

#### Scenario: Executor streams a command
- **WHEN** a pipeline asks the executor to stream a `ModelCommand`
- **THEN** the executor compiles the command once
- **AND** it streams the prepared provider request through transport
- **AND** it yields normalized reasoning and output deltas

#### Scenario: Executor collects through streaming
- **WHEN** a pipeline asks the executor to collect a `ModelCommand`
- **THEN** `collect()` drains the same streaming execution path used by `stream()`
- **AND** it returns the final `Result` produced by that stream

#### Scenario: Executor is stateless across requests
- **WHEN** a single executor serves two concurrent model commands
- **THEN** neither request observes the other's reasoning, output, parser result, or prepared provider request
- **AND** per-request state lives only inside per-request execution objects

### Requirement: Executor does not own provider payload fields
`ModelExecutor` SHALL execute commands through the compiler and transport without adding provider payload fields itself.

#### Scenario: Executor does not resolve temperature
- **WHEN** model-execution code is inspected
- **THEN** it does not call the temperature policy or model-card temperature rule
- **AND** it uses the compiled provider request produced by `RequestCompiler`

#### Scenario: Executor does not mutate template kwargs
- **WHEN** model-execution code is inspected
- **THEN** it does not create or mutate `chat_template_kwargs`
- **AND** task-control placement is absent from executor logic

