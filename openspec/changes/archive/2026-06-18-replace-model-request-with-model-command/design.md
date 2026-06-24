## Context

The backend currently assembles a provider request across several collaborators: source-context assembly produces content, `NuExtractRequestBuilder` mutates content and `template_kwargs`, `ModelCall` resolves temperature, provider subclasses add messages, URL, headers, stream settings, token limits, and Ollama reasoning fields, and `ModelGateway` wraps transport errors. The same logical command therefore has several owners before it reaches the HTTP client.

The decisive constraint for this change is no compatibility shim and no retained legacy path. `ModelRequest.template_kwargs` is the legacy contract because it lets use cases encode provider controls directly. A clean `ModelCommand` cannot coexist with that path without preserving the invalid states this change removes, so command creation, request compilation, provider transport, and execution must land together.

The current route contracts remain the external boundary. This is an internal architecture change for the backend prototype under `prototypes/mine/backend`.

## Goals / Non-Goals

**Goals:**
- Represent model work as provider-neutral semantic commands.
- Make one compiler the complete owner of URL, headers, JSON payload, task encoding, provider reasoning controls, model settings, max tokens, stream flag, and temperature resolution.
- Remove `ModelRequest`, `template_kwargs` construction in use cases, `NuExtractRequestBuilder`, provider `build_payload()` subclasses, `ModelGateway`, and `ModelCall`.
- Preserve existing endpoint request and response shapes.
- Preserve current provider payload behavior with golden tests, except for the accepted schema-suggestion cleanup where duplicate base task prompt text is removed from use-case guidance.
- Preserve current reasoning-splitting behavior while keeping the single command reasoning flag as the only source of thinking controls.

**Non-Goals:**
- Do not reorganize backend packages into new `model/`, `source/`, or `result_parsing/` packages.
- Do not add a `SourceContextFactory` in this change.
- Do not redesign route response contracts.
- Do not introduce a strict official OpenAI compiler. The current `openai` provider setting continues to mean an OpenAI-compatible NuExtract endpoint that accepts the same extensions as the current branch.
- Do not add provider plugin or strategy registries before the provider set grows.
- Do not introduce explicit per-provider `reasoning_format` selection until the provider-control probe is run and records actual reasoning output formats for the supported runtimes.

## Decisions

### ModelCommand is an envelope with typed task variants

Add `shared/model_command.py` with immutable dataclasses:

```python
@dataclass(frozen=True, slots=True)
class StructuredExtractionTask:
    template_json: str
    instruction: str = ""

@dataclass(frozen=True, slots=True)
class ChatTask:
    pass

@dataclass(frozen=True, slots=True)
class MarkdownTask:
    pass

@dataclass(frozen=True, slots=True)
class ContentExtractionTask:
    instruction: str = ""

@dataclass(frozen=True, slots=True)
class TemplateGenerationTask:
    guidance: str = ""

Task = (
    ChatTask
    | MarkdownTask
    | ContentExtractionTask
    | StructuredExtractionTask
    | TemplateGenerationTask
)

@dataclass(frozen=True, slots=True)
class ModelCommand:
    task: Task
    content: ChatContent
    reasoning: bool = False
    temperature: float | None = None
```

This design uses structural invariants rather than runtime assertions: structured extraction has a required `template_json`; chat and markdown have no instruction field; template generation has guidance but no extraction schema. The envelope carries cross-cutting data once: model content, one reasoning flag, and optional temperature.

Alternatives considered:
- A flat command dataclass with optional fields was rejected because it still permits invalid combinations such as chat with an extraction schema.
- One command dataclass per task was rejected because content, reasoning, and temperature would be duplicated across every command.
- A pydantic discriminated union was rejected because these are internal immutable values, not boundary payloads.

### RequestCompiler is the single payload owner

Add a compiler that accepts provider settings and the temperature policy, then returns a fully compiled request:

```python
@dataclass(frozen=True, slots=True)
class PreparedProviderRequest:
    url: str
    headers: Mapping[str, str]
    payload: Mapping[str, Any]
```

`RequestCompiler.compile(command)` is the only operation that:
- resolves temperature,
- inserts system and user messages,
- encodes task prompts or `chat_template_kwargs`,
- derives `enable_thinking` and provider-specific reasoning fields from `command.reasoning`,
- adds model, `max_tokens`, and `stream`,
- normalizes provider URL,
- creates authorization headers.

The compiler uses one explicit provider match for `ollama`, `vllm`, and `openai`. That match is simpler and more inspectable than a strategy hierarchy for three known provider profiles. If provider behavior grows, this can become a small profile table or strategies later.

### NuExtract control placement remains provider-specific, but command creation is not

Use cases create the same command shape regardless of provider. The compiler chooses the NuExtract control channel:

| Task | Ollama payload encoding | vLLM/openai-compatible payload encoding |
| --- | --- | --- |
| Chat | user content plus `enable_thinking` | same |
| Markdown | prepend markdown prompt, send `enable_thinking` | `mode: markdown`, send `enable_thinking` |
| Direct extraction | prepend content prompt and append researcher instruction text | `mode: content`, optional `instructions`, send `enable_thinking` |
| Schema-guided extraction | prepend structured prompt and append researcher instruction plus extraction schema text | `mode: structured`, `template`, combined task and researcher `instructions`, send `enable_thinking` |
| Schema suggestion | prepend template-generation prompt and append guidance | append guidance to content, `mode: template-generation`, send `enable_thinking` |

`enable_thinking` is derived from the single command reasoning flag for every task. Existing schema-suggestion callers currently pass `reasoning=False`, so this preserves behavior while allowing future callers to request reasoning without adding a second control source.

### Template-generation guidance stops carrying the base task prompt

`use_cases/generate_template.py` should simplify `template_guidance()` to return only the annotation-mode guidance sentence, or an empty string when there are no annotations. The compiler owns the base template-generation task prompt for every provider branch. This removes `_without_repeated_task_prompt` and prevents duplicate prompt text from being normalized in a legacy builder.

This is the one accepted payload difference: vLLM/openai-compatible schema-suggestion content no longer receives the base task prompt from use-case guidance; the task mode remains in `chat_template_kwargs`.

### Transport posts compiled requests unchanged

Replace provider payload-building classes with a generic transport seam:

```python
async def stream(prepared: PreparedProviderRequest) -> AsyncIterator[ChatDelta]:
    ...
```

The transport posts `prepared.url`, `prepared.headers`, and `prepared.payload` without adding provider fields. It still decodes OpenAI-compatible streaming chunks into `(reasoning_delta, content_delta)` pairs and ignores malformed or empty stream lines. It is the only boundary that translates `httpx.HTTPError` into the backend model-provider error type.

The old provider adapter protocol exposed `settings` and `client` attributes. The replacement transport interface should expose only the stream operation needed by `ModelExecutor`. Shared base aliases such as `ChatContent`, `ChatDelta`, and the `ProviderSettings` protocol remain available because the command, compiler, and transport still use them.

### ModelExecutor replaces ModelGateway and ModelCall

`ModelExecutor` receives the compiler, transport, splitter factory, and optional result parser at execution time. `stream(command, parser=None)` compiles once, opens transport once, drives a per-request splitter, emits `(think, output)` deltas, and exposes the final `Result` after iteration. `collect(command, parser=None)` consumes `stream()` and returns that same final result.

Temperature is not resolved in the executor. The compiler owns it, and tests should fail if a later edit reintroduces executor-side temperature resolution.

### Reasoning output format is deferred pending evidence

Do not change provider reasoning-format selection in this apply pass. Current code supports a hybrid behavior: it accepts `reasoning_content` deltas and also scans content for inline `<think>...</think>` when reasoning is enabled. The existing tests should continue to cover that behavior.

The correct long-term fix is still explicit provider reasoning format, but it needs separate evidence. The provider-control probe now includes a reasoning-enabled streaming check that captures whether supported Ollama, vLLM, and OpenAI-compatible NuExtract runtimes emit separate reasoning deltas, inline tags, both, or no reasoning channel. Run that probe and record observations before changing `ThinkSplitter` semantics.

## Risks / Trade-offs

- [Risk] Removing the shim makes the change larger than the assessment's phased plan. -> Mitigation: start with characterization/golden payload tests for current task-by-provider behavior, then replace internals against those tests.
- [Risk] Compiler responsibilities could grow too broad. -> Mitigation: keep it pure and test it directly; it owns outbound provider requests only, while transport owns HTTP streaming and executor owns result processing.
- [Risk] Provider-specific branches become hard to scan. -> Mitigation: keep all provider branching in one module and use small helpers for URL, headers, task encoding, and payload assembly.
- [Risk] Schema-suggestion cleanup changes vLLM/openai-compatible content bytes. -> Mitigation: record this as the only accepted payload change and cover it with compiler tests.
- [Risk] Current reasoning-splitting behavior can still misclassify provider output in edge cases. -> Mitigation: defer explicit reasoning-format changes until runtime evidence exists, and do not mix that uncertain change with the payload-ownership replacement.

## Migration Plan

1. Add golden compiler-oriented tests that express current payloads for chat, markdown, direct extraction, schema-guided extraction, and schema suggestion across provider profiles.
2. Add `ModelCommand` task dataclasses and update use cases to create commands.
3. Add `RequestCompiler` and `PreparedProviderRequest`; port prompt loading and provider URL/header/payload logic into the compiler.
4. Add generic transport and move streaming chunk decoding plus HTTP error translation there.
5. Replace `ModelGateway` and `ModelCall` with `ModelExecutor`; implement `collect()` by draining `stream()`.
6. Remove obsolete builder, request, provider factory, gateway, call, and provider subclass code and update application composition.
7. Preserve existing `ThinkSplitter` behavior and tests; defer explicit provider reasoning-format selection to a future evidence-backed change.
8. Run backend tests with `uv run python -m unittest discover -s tests`.

Rollback is a git revert of the change branch. There is no runtime data migration.
