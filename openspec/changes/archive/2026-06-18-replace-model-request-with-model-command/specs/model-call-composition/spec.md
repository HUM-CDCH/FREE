## REMOVED Requirements

### Requirement: Temperature is resolved by an injectable policy
**Reason**: Temperature resolution is part of outbound provider request compilation, not model execution.

**Migration**: Move the model-card temperature rule into `RequestCompiler` or a collaborator used only by the compiler; `ModelExecutor` receives already compiled payloads and MUST NOT resolve temperature.

### Requirement: Each use case composes a uniform, stateless model call
**Reason**: `ModelCall` is removed and merged with `ModelGateway` into `ModelExecutor`.

**Migration**: Use cases depend on the shared `ModelExecutor` and pass a `ModelCommand` plus optional parser.

## MODIFIED Requirements

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

## ADDED Requirements

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
