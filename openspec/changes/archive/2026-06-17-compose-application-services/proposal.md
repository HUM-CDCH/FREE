## Why

The backend currently creates the model provider in FastAPI lifespan but exposes it through hidden process-global state in `shared.model_stream`, while endpoint modules still assemble runtime dependencies, source-document preparation, source context, model calls, parsing, and HTTP mapping in one place. This makes lifecycle ownership unclear now and would make future chat conversation state harder to introduce cleanly.

## What Changes

- Add `application.py` as the backend composition container for settings, the shared HTTP client, provider, model gateway, source-document input preparer, source-context builder, and use-case pipelines.
- Attach a minimal `ApplicationServices` facade to `request.app.state.services` from FastAPI lifespan. The facade exposes only route-facing pipelines: `chat`, `extract`, `generate_template`, and `markdown`.
- Keep lower-level collaborators (`ModelGateway`, source-document preparation, and source-context building) hidden inside application composition and injected into pipelines rather than exposed as application-state services.
- Replace the hidden provider binding path with a use-case-facing `ModelGateway` over prepared `ModelRequest` values; the gateway owns model-call execution and exposes buffered and streaming execution without duplicating `ModelProvider`.
- Keep parser selection outside `ModelRequest`; parsers remain use-case-level inbound interpretation, while prompt and `chat_kwargs` remain outbound request semantics.
- Add a FastAPI-neutral `SourceDocumentInputPreparer` that accepts a raw `SourceDocumentInput` (`data`, `content_type`) and returns a `PreparedSourceDocument` containing source-document model parts plus page count.
- Add `SourceContextBuilder` to assemble source context from direct text, prepared source-document input, and future annotations. It does not own extraction schema semantics or task instructions.
- Refactor `/chat`, `/extract`, `/generate-template`, and `/markdown` around use-case pipelines that return plain result objects; route handlers map those results and typed internal exceptions to the existing HTTP behavior.
- Add ADR `0002-application-composition-and-use-case-pipelines.md` documenting the architectural decision.

## Capabilities

### New Capabilities
- `application-composition`: explicit backend application composition, use-case-facing model gateway, source-document/source-context boundaries, and use-case pipeline contracts.

### Modified Capabilities
<!-- None. Existing endpoint contracts should be preserved; chat-endpoint requirements are unchanged. -->

## Impact

- **Backend (`prototypes/mine/backend/`):** new `application.py`; new or revised shared modules for model gateway, source-document input preparation, and source-context building; use-case modules gain pipeline classes while keeping routers in the current package layout.
- **Runtime lifecycle:** FastAPI lifespan remains the owner of the shared `httpx.AsyncClient` and provider, but dependency access moves to `request.app.state.services`.
- **HTTP behavior:** no intended endpoint contract changes; existing status codes, response shapes, OpenAPI response media types, and developer-stage provider error detail should be preserved.
- **Testing:** endpoint tests should continue to validate HTTP behavior through the pipeline facade, while new focused tests instantiate `ModelGateway`, `SourceDocumentInputPreparer`, and `SourceContextBuilder` directly from their owning modules.
- **Dependencies:** none added or removed.
