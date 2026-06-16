## Why

`prototypes/mine/backend/main.py` currently owns both HTTP route behavior and model-provider mechanics, including URL normalization, headers, payload shaping, Ollama prompt adaptation, and streamed response parsing. Splitting provider behavior behind an OpenAI-compatible base adapter with concrete Ollama and vLLM implementations will make provider differences testable in isolation while keeping the existing JSONL API behavior stable.

## What Changes

- Move provider-specific request construction and streaming behavior out of `main.py` into dedicated backend modules.
- Introduce an abstract provider interface used by the route/event helpers.
- Add concrete Ollama and vLLM provider implementations on top of a shared OpenAI-compatible base provider.
- Keep request routes, JSONL event shapes, OpenAPI response metadata, validation order, and `400` messages unchanged.
- Keep `openai` as a backwards-compatible provider alias for vLLM-style OpenAI-compatible endpoints.
- Keep provider-specific tests for URL normalization, auth headers, shared NuExtract prompt injection, Ollama reasoning flags, and vLLM content preservation.

## Capabilities

### New Capabilities

- `model-provider-adapters`: Backend model providers can be selected through a shared OpenAI-compatible provider abstraction with Ollama and vLLM implementations that preserve the current request and stream contracts.

### Modified Capabilities

- None.

## Impact

- Affected backend code: `prototypes/mine/backend/main.py` plus new provider/settings modules under `prototypes/mine/backend`.
- Affected tests: existing backend tests around model configuration, extraction streams, chat streams, and endpoint contracts should be updated to import the new module boundaries.
- No API route, request field, response media type, JSONL event, dependency, or frontend contract change is intended.
