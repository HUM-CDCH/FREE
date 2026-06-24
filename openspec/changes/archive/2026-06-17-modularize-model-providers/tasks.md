## 1. Baseline and Test Coverage

- [x] 1.1 Run the current backend test suite with `.venv\Scripts\python.exe -m unittest discover tests` and record any pre-existing failures.
- [x] 1.2 Move or add provider-focused tests that cover Ollama URL normalization, vLLM URL preservation, empty API-key header omission, real API-key bearer headers, Ollama reasoning payloads, and vLLM content preservation.
- [x] 1.3 Add stream-adapter tests for parseable chunks, malformed chunks, empty chunks, and `[DONE]` termination without live model calls.

## 2. Provider Module Structure

- [x] 2.1 Create backend provider modules for the shared adapter protocol, OpenAI-compatible base adapter (used directly for vLLM/OpenAI), concrete Ollama adapter, and provider factory.
- [x] 2.2 Move URL normalization, authorization-header construction, payload construction, Ollama content adaptation, and Ollama task prompts out of `main.py` into provider modules.
- [x] 2.3 Keep `Settings` as the central configuration source and pass settings into provider construction without changing `NUEXTRACT3_*` environment behavior.

## 3. Runtime Integration

- [x] 3.1 Preserve the shared `httpx.AsyncClient` lifespan and inject the client into the selected provider.
- [x] 3.2 Update model-stream calls so event helpers consume the selected provider's `(reasoning_delta, content_delta)` stream.
- [x] 3.3 Preserve route-level content construction for `/chat`, `/extract`, `/markdown`, and `/generate-template`, including instruction/template embedding and temperature resolution.
- [x] 3.4 Preserve `STREAM_RESPONSES`, `JSONLResponse`, `jsonl_response()`, JSONL media type, and buffered JSON fallback behavior.

## 4. Main Module Cleanup

- [x] 4.1 Remove provider-specific branches and helper functions from `main.py` after tests cover the new module boundaries.
- [x] 4.2 Keep route validation order and exact existing `400` details unchanged.
- [x] 4.3 Avoid broad unrelated moves for PDF rendering, JSON repair, result parsing, or frontend-facing response events.

## 5. Verification

- [x] 5.1 Run `.venv\Scripts\python.exe -m unittest discover tests` from `prototypes\mine\backend`.
- [x] 5.2 Run a mocked extraction or chat stream probe that verifies `delta`, `done`, and provider-error behavior without a live model endpoint.
- [x] 5.3 Verify OpenAPI for streaming routes still advertises JSONL/JSON response metadata.
- [x] 5.4 Run `openspec status --change "modularize-model-providers"` and confirm the change is apply-ready.

## 6. Shared NuExtract Prompt Semantics

- [x] 6.1 Move mode-specific NuExtract task prompt preparation out of `OllamaProvider` into a shared helper used before concrete provider request shaping.
- [x] 6.2 Update `OllamaProvider` so it only handles Ollama mechanics such as `/v1` URL normalization and the reasoning payload flag.
- [x] 6.3 Ensure vLLM payload construction (via `OpenAICompatibleProvider`) sends the same shared mode-specific task prompt as Ollama.
- [x] 6.4 Add tests proving Ollama and vLLM structured, content, markdown, and template-generation payloads share the same task prompt text without duplicating it.
- [x] 6.5 Run `.venv\Scripts\python.exe -m unittest discover tests` and refresh OpenSpec apply progress.
