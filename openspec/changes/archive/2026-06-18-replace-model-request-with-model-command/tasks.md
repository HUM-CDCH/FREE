## 1. Characterization Tests

- [x] 1.1 Add compiler-oriented golden payload tests for chat with reasoning disabled and enabled across `ollama`, `vllm`, and `openai`.
- [x] 1.2 Add golden payload tests for markdown across `ollama`, `vllm`, and `openai`.
- [x] 1.3 Add golden payload tests for direct extraction with and without researcher instructions across `ollama`, `vllm`, and `openai`.
- [x] 1.4 Add golden payload tests for schema-guided extraction with extraction schema, researcher instructions, combined structured instructions, and reasoning controls across `ollama`, `vllm`, and `openai`.
- [x] 1.5 Add golden payload tests for schema suggestion with no annotations, `hints` guidance, and `fields` guidance, including the accepted removal of duplicated base task prompt text from use-case guidance.
- [x] 1.6 Add compiler tests for URL normalization, authorization headers, stream flag, model, max tokens, system prompt, explicit temperature, default non-reasoning temperature, default reasoning temperature, and Ollama reasoning payload fields.

## 2. Model Command and Compiler

- [x] 2.1 Add `shared/model_command.py` with immutable `ModelCommand` and task variant dataclasses.
- [x] 2.2 Add `PreparedProviderRequest` and `RequestCompiler` with provider-profile dispatch for `ollama`, `vllm`, and `openai`.
- [x] 2.3 Move NuExtract task-prompt loading and task encoding into compiler-owned code.
- [x] 2.4 Move provider URL normalization and authorization-header creation into compiler-owned code.
- [x] 2.5 Move temperature resolution into the compiler and remove executor-side temperature resolution.

## 3. Transport and Execution

- [x] 3.1 Replace provider payload-building subclasses with a generic provider transport protocol exposing `stream(prepared)` and posting `PreparedProviderRequest` unchanged.
- [x] 3.2 Preserve OpenAI-compatible SSE decoding into `(reasoning_delta, content_delta)` tuples and malformed-line handling in transport tests.
- [x] 3.3 Centralize `httpx.HTTPError` translation into one model-provider error type at the transport boundary.
- [x] 3.4 Add `ModelExecutor` that compiles commands, streams transport deltas through per-request splitter state, and accepts an optional parser.
- [x] 3.5 Implement `ModelExecutor.collect()` by draining `ModelExecutor.stream()` and returning the stream's final `Result`.
- [x] 3.6 Preserve current `ThinkSplitter` hybrid behavior and existing reasoning-splitting tests without adding provider-specific reasoning-format mapping.

## 4. Use-Case Integration

- [x] 4.1 Update `ChatPipeline` to construct `ModelCommand(ChatTask(...))` instead of hand-building `ModelRequest`.
- [x] 4.2 Update `ExtractPipeline` to construct `StructuredExtractionTask` or `ContentExtractionTask` commands from source context.
- [x] 4.3 Update `GenerateTemplatePipeline` to construct `TemplateGenerationTask` commands and simplify `template_guidance()` to annotation-mode guidance only.
- [x] 4.4 Update `MarkdownPipeline` to construct `MarkdownTask` commands from source context.
- [x] 4.5 Update route error handling to catch the new model-provider error type while preserving existing HTTP 502 responses.

## 5. Composition and Removal

- [x] 5.1 Update `application.py` to compose `RequestCompiler`, generic provider transport, and `ModelExecutor`, and inject only route-facing pipelines through `ApplicationServices`.
- [x] 5.2 Remove `ModelRequest`, `ModelGateway`, `ModelCall`, `NuExtractRequestBuilder`, `NuExtractTaskControlChannel`, `nuextract_control_channel_for_provider`, and `create_model_provider`.
- [x] 5.3 Remove provider `build_payload()` subclasses and old `ModelProvider` protocol attributes while retaining shared `ChatContent`, `ChatDelta`, and `ProviderSettings` base types.
- [x] 5.4 Remove obsolete `_without_repeated_task_prompt`, builder alias methods, duplicate error catches, and callback-based model stream plumbing.
- [x] 5.5 Update imports, package exports, and tests so no production code references `template_kwargs` outside compiler-owned payload assembly.

## 6. Verification

- [x] 6.1 Run `uv run python -m unittest discover -s tests` from `prototypes/mine/backend`.
- [x] 6.2 Confirm `/chat`, `/extract`, `/generate-template`, and `/markdown` endpoint tests preserve existing external request and response shapes.
- [x] 6.3 Confirm OpenSpec status marks the change apply-ready.

## Deferred Follow-Up

TODO: Create a follow-up OpenSpec change for explicit provider reasoning-format selection after runtime evidence exists.

The provider probe now has a reasoning-format streaming check. That follow-up should run it against supported Ollama, vLLM, and OpenAI-compatible NuExtract runtimes, record whether each emits `reasoning_content`, inline `<think>` tags, both, or no reasoning channel, and only then move `ThinkSplitter` from the current hybrid behavior to explicit provider-configured formats.
