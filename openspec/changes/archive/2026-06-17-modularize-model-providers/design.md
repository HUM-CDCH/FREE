## Context

The backend is a single-file FastAPI prototype where `main.py` handles routing, document/image preparation, JSONL response handling, result parsing, and model-provider behavior. Provider behavior is currently concentrated in `model_api_base_url()`, `chat_completions_url()`, `model_headers()`, `build_payload()`, `ollama_content()`, `ollama_task_prompt()`, and `call_model_stream()`.

The existing runtime contract must remain stable:

- `NUEXTRACT3_PROVIDER` accepts `ollama`, `vllm`, and the backwards-compatible `openai` alias.
- Ollama base URLs are normalized to `/v1`; vLLM/OpenAI-compatible base URLs are preserved.
- Empty or `EMPTY` API keys omit the `Authorization` header.
- Routes keep returning the same JSONL events, with the current buffered JSON fallback for `Accept: application/json`.
- Existing validation order and exact `400` messages remain unchanged.

## Goals / Non-Goals

**Goals:**

- Move provider-specific URL, header, payload, prompt-adaptation, and streaming code out of `main.py`.
- Define a narrow provider abstraction that route/event helpers can call without branching on provider-specific details.
- Implement a concrete Ollama provider on top of an OpenAI-compatible base provider that serves vLLM/OpenAI directly, while preserving current request payload semantics.
- Keep provider construction explicit enough for tests to inject fake streams without live model calls.
- Keep the `main.py` refactor mechanical and behavior-preserving.

**Non-Goals:**

- No route, request-form, response-event, or frontend contract changes.
- No new model provider beyond Ollama and vLLM-compatible chat completions.
- No dependency changes.
- No broad package restructuring beyond the modules needed to split provider behavior from route code.
- No change to document rendering, result parsing, JSON repair, or Tailwind/frontend behavior.

## Decisions

### Use an OpenAI-compatible base provider plus concrete classes

Create a provider module with a small interface such as:

- `stream_chat(content, chat_kwargs, temperature) -> AsyncIterator[tuple[str, str]]`
- helper methods or constructor-owned behavior for payloads, headers, and endpoint URLs

`main.py` should depend on the provider interface rather than calling `build_payload()` and `client.stream()` directly. Shared OpenAI-compatible streaming, headers, payload construction, and SSE parsing should live in `OpenAICompatibleProvider`. The `vllm` and `openai` settings use `OpenAICompatibleProvider` directly (no dedicated subclass), while `OllamaProvider` should override only URL normalization and provider-specific payload additions such as the reasoning flag.

Rationale: the event helpers already operate on a stream of `(reasoning_delta, content_delta)` tuples. Keeping that as the provider boundary minimizes churn and preserves `ThinkSplitter`, `extract_events()`, `chat_events()`, and `markdown_events()` semantics.

Alternative considered: split only helper functions into modules and keep provider branching in `main.py`. That would reduce file size but would not create a meaningful abstraction or make provider implementations independently testable.

### Keep shared HTTP client lifecycle in FastAPI lifespan

The app should continue to create one `httpx.AsyncClient` during lifespan and close it on shutdown. The provider instance should receive this client, or receive a callable/context that uses it, instead of creating per-request clients.

Rationale: previous backend simplification settled on explicit shared client lifecycle. The provider split should preserve that lifecycle rather than introducing hidden globals.

Alternative considered: providers own their own `AsyncClient`. That hides lifecycle behind provider construction and complicates cleanup/testing.

### Keep settings parsing centralized

Keep `Settings` as the single source for provider, base URL, model, API key, token, timeout, PDF, and prompt configuration. Provider factory code should select `OllamaProvider` for `ollama` and `OpenAICompatibleProvider` for `vllm` from those settings, with `openai` accepted as a compatibility alias that also maps to `OpenAICompatibleProvider`.

Rationale: environment-variable compatibility is part of the current operator workflow. Moving settings piecemeal into provider modules risks drift in `NUEXTRACT3_*` behavior.

Alternative considered: each provider owns its own settings model. That is more scalable long term, but unnecessary for two providers and likely to break current tests/imports.

### Make NuExtract task prompts provider-independent

The backend currently embeds NuExtract controls in the user message text before provider construction. Mode-specific NuExtract task prompts, such as structured extraction, content extraction, Markdown conversion, and template generation, describe what the model should do. Those instructions are model/task semantics, not Ollama transport semantics, so they should be applied consistently before concrete provider-specific request shaping.

- route-level extraction logic still builds `content` with text, instructions, and templates as today
- a shared NuExtract prompt preparation helper prepends the same mode-specific task prompt for both Ollama and vLLM
- the `vllm`/`openai` settings send the shared prepared content through `OpenAICompatibleProvider` directly
- `OllamaProvider` sends the same shared prepared content, then applies only provider mechanics such as `/v1` URL normalization and the Ollama reasoning payload flag

Rationale: tests already distinguish route-level content embedding from provider-level prompt preparation. Keeping prompt preparation shared prevents Ollama and vLLM from drifting when they serve the same NuExtract task modes.

Alternative considered: make only Ollama responsible for mode-specific prompt text and let vLLM rely on `chat_template_kwargs`. That keeps vLLM payloads smaller, but it assumes the vLLM serving template injects equivalent instructions. Without explicit evidence and tests for that server-side template, the safer default is shared prompt instructions.

## Risks / Trade-offs

- Provider abstraction can become too broad -> Keep the first interface limited to the existing streamed-chat tuple boundary.
- Test monkeypatches may break when functions move -> Update tests to patch the provider/factory boundary or add compatibility shims only where they help preserve readability.
- OpenAPI/JSONL metadata can regress during file movement -> Keep `STREAM_RESPONSES`, `JSONLResponse`, and `jsonl_response()` behavior under endpoint tests.
- Ollama/vLLM prompt behavior can drift -> Put NuExtract task prompt preparation in one shared helper and test both providers against the same prepared instructions.
- Import cycles can appear if providers import route helpers from `main.py` -> Put provider-independent types/helpers in leaf modules and keep FastAPI app construction at the edge.

## Migration Plan

1. Add provider modules and tests while keeping current `main.py` functions available or migrated with direct test updates.
2. Move URL/header/payload/task-prompt logic into provider implementations.
3. Change `call_model_stream()` or the event helpers to use the selected provider instance.
4. Move only low-risk supporting code out of `main.py` after the provider boundary is covered by tests.
5. Run backend unit tests with the repo-local `.venv`.

Rollback is straightforward: provider modules are internal only, and no persisted data or external API contract changes are involved.

## Open Questions

- Should short-term compatibility aliases remain in `main.py` for tests and ad hoc imports, or should tests move directly to the new modules during implementation?
- Should the provider factory be module-level and refreshed from `settings`, or should it live exclusively on `app.state` after lifespan startup?
