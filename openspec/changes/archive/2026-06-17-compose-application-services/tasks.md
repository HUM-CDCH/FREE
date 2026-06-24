## 1. Application Composition

- [x] 1.1 Add `application.py` with route-facing `ApplicationServices` (`chat`, `extract`, `generate_template`, `markdown`) and a build function that composes the shared HTTP client, provider, model gateway, source-document input preparer, source-context builder, and use-case pipelines.
- [x] 1.2 Update `main.lifespan` to attach the composed services to `app.state.services` and keep the shared HTTP client lifecycle explicit.
- [x] 1.3 Remove the process-global provider binding path from request execution, leaving no route dependent on `shared.model_stream._provider`.
- [x] 1.4 Keep lower-level collaborators off `ApplicationServices`; routes must access pipelines only, while lower-level tests instantiate modules from their owning shared files.

## 2. Model Gateway

- [x] 2.1 Add `shared/model_gateway.py` with `ModelRequest` containing `content`, `chat_kwargs`, `reasoning`, and optional `temperature`.
- [x] 2.2 Implement `ModelGateway.collect(...)` and `ModelGateway.stream(...)` over the existing model-call spine so pipelines do not call `ModelProvider.stream_chat` directly.
- [x] 2.3 Keep parser selection outside `ModelRequest`; accept parser arguments on gateway execution methods.
- [x] 2.4 Add typed model-gateway errors that preserve raw provider detail and original causes for developer inspection.

## 3. Source Document and Source Context

- [x] 3.1 Add `shared/source_document.py` with raw `SourceDocumentInput`, `PreparedSourceDocument`, `SourceDocumentInputPreparer`, and typed source-document errors.
- [x] 3.2 Ensure source-document preparation accepts bytes/content type, returns `PreparedSourceDocument` with model parts plus page count, and imports no FastAPI request/response types.
- [x] 3.3 Move PDF/image DPI configuration into constructor-provided settings instead of reading global `settings` inside the preparer.
- [x] 3.4 Add `shared/source_context.py` with `SourceContextRequest`, `SourceContext`, and `SourceContextBuilder`.
- [x] 3.5 Keep extraction schema and extraction-specific instruction text out of `SourceContextBuilder`; add them in `ExtractPipeline`.
- [x] 3.6 Keep `SourceContext` free of task-text helper methods; task instructions and prompt controls belong in pipelines.

## 4. Use-Case Pipelines

- [x] 4.1 Refactor `/chat` around a chat pipeline that streams through `ModelGateway` while preserving current JSONL and buffered JSON behavior.
- [x] 4.2 Refactor `/extract` around `ExtractPipeline`, preserving structured/free-text parser selection, raw reconstruction, page count, and 400/502 behavior.
- [x] 4.3 Refactor `/generate-template` around a schema-suggestion pipeline, preserving annotation parsing, guidance, result shape, and validation messages.
- [x] 4.4 Refactor `/markdown` around a markdown pipeline, preserving the current single JSON response shape and page count.
- [x] 4.5 Define transport-free request/result types for every pipeline (`ChatRequest`, `ExtractRequest`, `GenerateTemplateRequest`, `MarkdownRequest`, and matching results/events).
- [x] 4.6 Keep route handlers as HTTP adapters that translate form/file inputs, call pipelines through `request.app.state.services`, and map typed exceptions to existing responses.

## 5. Public Surface and Imports

- [x] 5.1 Update `shared/__init__.py` and `main.py` public re-exports only where needed by tests or current runtime imports.
- [x] 5.2 Preserve the existing route paths, OpenAPI media types, status codes, and response payload shapes.
- [x] 5.3 Verify package direction stays acyclic: no `import main` from shared/use-case modules and no broad architecture package introduced.

## 6. Tests

- [x] 6.1 Add unit tests for `ApplicationServices` composition or lifespan-created service availability, asserting the facade exposes only route-facing pipelines.
- [x] 6.2 Add unit tests for `ModelGateway` collect/stream execution over a fake provider and parser argument handling.
- [x] 6.3 Add unit tests for `SourceDocumentInputPreparer`, including FastAPI-neutral errors and configured DPI usage.
- [x] 6.4 Add unit tests for `SourceContextBuilder`, including direct text, prepared source-document input, page-count preservation, and exclusion of extraction schema/task text.
- [x] 6.5 Update endpoint tests for `/chat`, `/extract`, `/generate-template`, and `/markdown` to use the new pipeline/gateway seams while asserting unchanged HTTP contracts.
- [x] 6.6 Add regression coverage showing model/provider error detail remains inspectable through typed exceptions and current API error detail.
- [x] 6.7 Run `.venv\Scripts\python.exe -m unittest discover -s tests` from `prototypes/mine/backend`.

## 7. Verification

- [x] 7.1 Run `openspec validate compose-application-services --strict` from the repo root.
- [x] 7.2 Confirm `git diff --check` reports no whitespace errors.
- [x] 7.3 Review the final diff to ensure only the planned architecture refactor and documentation artifacts changed.
