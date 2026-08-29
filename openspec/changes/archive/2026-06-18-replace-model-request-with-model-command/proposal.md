## Why

The backend still has no single owner for the provider request: source-context assembly, NuExtract request construction, model-call execution, provider adapters, and settings all contribute pieces of the final HTTP payload. This makes provider behavior hard to trace and permits invalid internal states such as duplicated reasoning controls or overwritten researcher instructions.

## What Changes

- Add a provider-neutral `ModelCommand` envelope with typed task variants for chat, markdown, direct extraction, schema-guided extraction, and schema suggestion.
- Add a `RequestCompiler` that is the sole owner of provider URL, headers, payload shape, task encoding, reasoning wire controls, model settings, max tokens, stream flag, and temperature resolution.
- Replace `NuExtractRequestBuilder` and raw `template_kwargs` construction with typed command creation in use-case pipelines.
- Replace provider payload-building subclasses with a generic provider transport that streams compiled `PreparedProviderRequest` values and centralizes model-provider error handling.
- Merge `ModelGateway` and `ModelCall` into one `ModelExecutor`; `collect()` drains the same streaming execution path used by `stream()`.
- Simplify schema-suggestion guidance so use cases provide only researcher/task input while the compiler owns the NuExtract task prompt.
- Defer provider-specific reasoning-format changes until probe evidence exists; preserve the current reasoning-splitting behavior in this change.
- **BREAKING** internal change: remove `ModelRequest`, `template_kwargs`, `NuExtractRequestBuilder`, `create_model_provider`, provider `build_payload()` subclasses, `ModelGateway`, and `ModelCall` rather than adding compatibility shims.

## Capabilities

### New Capabilities
- `model-command-compilation`: Provider-neutral model commands compile into concrete provider requests through one authoritative compiler.

### Modified Capabilities
- `nuextract-request-construction`: Use-case pipelines create typed `ModelCommand` task variants instead of prepared `ModelRequest` values or raw NuExtract template kwargs.
- `model-call-composition`: Model execution moves to a single `ModelExecutor` whose streaming and buffered modes share one execution path while preserving current reasoning splitting.
- `model-provider-adapters`: Provider adapters no longer own payload construction; provider transport exposes a minimal `stream(prepared)` seam, sends compiled requests, and decodes streaming deltas behind one error boundary.
- `application-composition`: Application startup composes the compiler, generic transport, and executor instead of separately composing a request builder, provider adapter, and model gateway.

## Impact

- Affected backend files include `shared/nuextract_request.py`, `shared/model_gateway.py`, `shared/model_call.py`, `model_providers/providers.py`, `model_providers/base.py`, `application.py`, `use_cases/{extract,generate_template,markdown,chat}.py`, `shared/temperature.py`, `shared/think_splitter.py`, and related tests.
- External route request and response shapes are intended to remain unchanged.
- Provider payloads for existing calls should be characterized with golden tests before replacement, except for the accepted schema-suggestion cleanup where duplicate task prompt text is removed from use-case guidance.
- Explicit provider reasoning-format selection is deferred until the extended provider probe records actual reasoning output formats.
- No new runtime dependencies are expected.
