# Application Composition and Use-Case Pipelines

The backend will use `application.py` as the explicit composition container for runtime dependencies and use-case pipelines. FastAPI lifespan owns settings, the shared HTTP client, provider creation, a use-case-facing model gateway, source-document input preparation, source-context building, and pipeline construction; route handlers access only route-facing pipelines through `request.app.state.services` and remain HTTP adapters.

This replaces hidden process-global model binding with explicit application composition while keeping model providers transport-focused. The `ModelGateway` is deliberately deeper than `ModelProvider`: it executes prepared `ModelRequest` values through the existing model-call spine, while parsers remain use-case-level inbound interpretation. Source-document preparation stays FastAPI-neutral and source-document-only; `SourceContextBuilder` owns source-context assembly, with extraction schemas kept in extraction pipelines as task-specific controls.

`ApplicationServices` is deliberately a minimal facade:

```python
@dataclass(frozen=True, slots=True)
class ApplicationServices:
    chat: ChatPipeline
    extract: ExtractPipeline
    generate_template: GenerateTemplatePipeline
    markdown: MarkdownPipeline
```

Lower-level collaborators such as `ModelGateway`, `SourceDocumentInputPreparer`, and `SourceContextBuilder` are composed inside `application.py` and injected into pipelines, but they are not exposed through `request.app.state.services`. Tests that need those lower-level modules instantiate them directly from their owning modules instead of reaching through application state.

## Consequences

- Use-case pipelines return plain result objects, and FastAPI handlers map them to the existing HTTP responses.
- `ApplicationServices` exposes only use-case pipelines, keeping the composition container deep instead of a service bag.
- Typed internal exceptions preserve raw provider/source-document detail for developer inspection while keeping route-level status mapping explicit.
- Future chat conversation state can be added as a separate composed dependency without putting conversation history into the model gateway.
