## Context

The backend already has a useful model-call spine (`ModelCall`) and provider adapters, but runtime dependency ownership is split awkwardly. FastAPI lifespan creates the shared HTTP client and model provider, then `shared.model_stream` stores the provider in a process-global variable. Endpoint modules call that hidden global while also owning source-document preparation, context assembly, parser choice, model execution, result shaping, and HTTP error mapping.

This change keeps the current package layout and endpoint contracts, but makes application composition explicit. It also leaves room for future chat conversation state by ensuring model access remains stateless and conversation state can later be introduced as a separate composed dependency.

## Goals / Non-Goals

**Goals:**

- Make FastAPI lifespan the clear owner of runtime dependencies and composed use-case pipelines.
- Replace hidden process-global model binding with a use-case-facing `ModelGateway`.
- Keep `ModelRequest` outbound-only: content, `chat_kwargs`, reasoning, and temperature.
- Keep parser selection outside `ModelRequest` as inbound result interpretation.
- Keep source-document input preparation FastAPI-neutral and source-document-only.
- Introduce `SourceContextBuilder` as the source-context assembly boundary.
- Keep route handlers thin HTTP adapters that call pipelines and map result/exception objects to the existing HTTP behavior.
- Preserve all existing endpoint contracts, including developer-visible model failure detail.

**Non-Goals:**

- No runtime behavior changes to `/chat`, `/extract`, `/generate-template`, or `/markdown`.
- No chat conversation state, persistence, project context store, or annotation store in this slice.
- No broad `domain/`, `core/`, or `services/` package.
- No provider request-shape changes beyond routing calls through the new gateway.
- No sanitization of current developer-stage provider error detail.

## Decisions

### Use `application.py` as the composition container and expose only pipelines

`application.py` will define the application composition types and build function. FastAPI lifespan will create the shared `httpx.AsyncClient`, provider, model gateway, source-document input preparer, source-context builder, and use-case pipelines, then attach a minimal route-facing facade to `app.state.services`.

```python
@dataclass(frozen=True, slots=True)
class ApplicationServices:
    chat: ChatPipeline
    extract: ExtractPipeline
    generate_template: GenerateTemplatePipeline
    markdown: MarkdownPipeline


def build_application_services(
    settings: Settings,
    client: httpx.AsyncClient,
) -> ApplicationServices: ...
```

`ApplicationServices` intentionally exposes only pipelines. `ModelGateway`, `SourceDocumentInputPreparer`, and `SourceContextBuilder` are lower-level collaborators built in `application.py` and injected into pipelines; they are not available through `request.app.state.services`. Tests that need those modules instantiate them directly from `shared.model_gateway`, `shared.source_document`, or `shared.source_context`.

Alternative considered: `services.py`. Rejected because that name tends to become a junk drawer. `application.py` is specific to composition and lifecycle wiring.

Alternative considered: module-level pipeline globals. Rejected for dependencies that are created at runtime, especially the HTTP client/provider and future conversation state.

Alternative considered: exposing `model_gateway`, `source_documents`, and `source_context` on `ApplicationServices`. Rejected because it turns `request.app.state.services` into a service bag and lets route handlers/tests bypass the use-case pipeline interface.

### Keep the first implementation inside the current package layout

New shared boundaries belong in `shared/`, provider transport remains in `model_providers/`, and use-case pipelines initially live beside their route handlers in `use_cases/*.py`. If a use-case module grows too large, split locally, for example `use_cases/extract_pipeline.py`, before adding a broad architecture package.

### Make `ModelGateway` deeper than `ModelProvider`

`ModelProvider` remains the transport adapter with `stream_chat`. `ModelGateway` is the use-case-facing seam over prepared `ModelRequest` values:

```python
@dataclass(frozen=True, slots=True)
class ModelRequest:
    content: ChatContent
    chat_kwargs: dict[str, Any]
    reasoning: bool = False
    temperature: float | None = None
```

The gateway owns model-call execution through the existing model-call spine and exposes buffered and streaming execution. Parser selection stays outside `ModelRequest`:

```python
class ModelGateway:
    def __init__(
        self,
        provider: ModelProvider,
        *,
        temperature: TemperaturePolicy,
    ) -> None: ...

    async def collect(
        self,
        request: ModelRequest,
        *,
        parser: ResultParser | None = None,
    ) -> Result: ...

    def stream(
        self,
        request: ModelRequest,
        *,
        parser: ResultParser | None = None,
    ) -> ModelStreamer: ...
```

This prevents `ModelGateway` from duplicating `ModelProvider` while keeping outbound request semantics separate from inbound result interpretation. If a parser expectation requires a model behavior, that behavior belongs in prompt text or `chat_kwargs`, not in the parser.

### Separate source-document input from source context

`SourceDocumentInputPreparer` is a technical, FastAPI-neutral boundary:

- input: bytes and content type
- output: prepared source-document model parts plus page count
- no `UploadFile`
- no `HTTPException`
- no direct global `settings` access

It focuses only on the source document. It does not append instructions, extraction schema text, annotation guidance, or chat context.

```python
@dataclass(frozen=True, slots=True)
class SourceDocumentInput:
    data: bytes
    content_type: str | None


@dataclass(frozen=True, slots=True)
class PreparedSourceDocument:
    content: ChatContent
    page_count: int


class SourceDocumentInputPreparer:
    def __init__(self, *, pdf_dpi: int) -> None: ...
    def prepare(self, source: SourceDocumentInput) -> PreparedSourceDocument: ...
```

`SourceContextBuilder` sits above it and uses the repo glossary term `Source Context`. It builds source-context model content from a typed request containing prepared source-document input, direct text, and future annotations. It returns a `SourceContext` value object with model content and page count. Extraction schema text remains in `ExtractPipeline` because the glossary treats `Extraction Schema` as its own concept, not part of `Source Context`.

```python
@dataclass(frozen=True, slots=True)
class SourceContextRequest:
    text: str | None = None
    document: PreparedSourceDocument | None = None
    annotations: Sequence[SourceAnnotation] = ()


@dataclass(frozen=True, slots=True)
class SourceContext:
    content: ChatContent
    page_count: int


class SourceContextBuilder:
    def build(self, request: SourceContextRequest) -> SourceContext: ...
```

`SourceContext` intentionally has no helper such as `with_task_text()`: task text, extraction schemas, annotation guidance, and mode-specific prompt controls stay in the relevant pipeline.

### Use typed request/result objects for pipelines

Pipelines are the public use-case interface behind `ApplicationServices`:

```python
class ChatPipeline:
    def stream(self, request: ChatRequest) -> AsyncIterator[ChatEvent]: ...


class ExtractPipeline:
    async def run(self, request: ExtractRequest) -> ExtractResult: ...


class GenerateTemplatePipeline:
    async def run(
        self,
        request: GenerateTemplateRequest,
    ) -> GenerateTemplateResult: ...


class MarkdownPipeline:
    async def run(self, request: MarkdownRequest) -> MarkdownResult: ...
```

The pipeline request/result types are transport-free. They may contain `SourceDocumentInput` values produced from HTTP uploads by the route adapter, but they do not contain `UploadFile`, `Request`, `Response`, or `HTTPException`.

### Keep route handlers as HTTP adapters

Pipelines return plain result objects and raise typed internal exceptions. FastAPI route handlers read `request.app.state.services`, translate form/file inputs into pipeline requests, and map pipeline results/exceptions to the existing HTTP responses.

This keeps the use-case layer reusable and testable without FastAPI transport objects, while preserving current API behavior.

### Preserve raw diagnostic detail

Typed exceptions should carry stable classification plus raw detail and cause information. Route-level behavior keeps the current developer-stage model failure detail so a developer can inspect true vLLM/Ollama/Docker Model Runner failures from the API response or exception chain.

## Risks / Trade-offs

- **Over-abstracting a small backend** -> Keep classes local and narrow. Do not introduce broad packages or registries.
- **`ApplicationServices` becoming a service bag** -> Expose only route-facing pipelines; instantiate lower-level modules directly in their own tests.
- **`ModelGateway` becoming a pass-through wrapper** -> Require it to execute `ModelRequest` through `ModelCall`, not just forward to `provider.stream_chat`.
- **`SourceContextBuilder` becoming a prompt junk drawer** -> Keep extraction schema in `ExtractPipeline`; reserve the builder for source material and future annotations.
- **Accidentally hiding provider diagnostics** -> Preserve raw detail/cause on typed exceptions and keep current developer-stage model error response detail.
- **Contract drift during refactor** -> Endpoint tests must assert current status codes, response shapes, media types, and representative provider-error behavior.

## Migration Plan

1. Add ADR `0002-application-composition-and-use-case-pipelines.md`.
2. Add `application.py` with route-facing `ApplicationServices` and a build function for lifespan.
3. Add `shared/model_gateway.py` with `ModelRequest` and `ModelGateway`.
4. Add `shared/source_document.py` with `SourceDocumentInput`, `PreparedSourceDocument`, `SourceDocumentInputPreparer`, and typed source-document errors.
5. Add `shared/source_context.py` with `SourceContextRequest`, `SourceContext`, and `SourceContextBuilder`.
6. Refactor `/chat`, `/extract`, `/generate-template`, and `/markdown` into pipelines that return plain result objects.
7. Update `main.lifespan` to attach `app.state.services` and remove hidden provider binding.
8. Update tests around composition, gateway behavior, source document preparation, source context assembly, and endpoint contract preservation.

Rollback is a single revert of the implementation change; there is no data migration.

## Open Questions

- None blocking. Chat conversation state is explicitly future scope and should be introduced later as a separate composed dependency.
