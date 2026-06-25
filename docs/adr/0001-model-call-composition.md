# ADR 0001 — Model-call composition: TypeScript serverless functions, buffered by default, streaming for chat

**Status**: Accepted

The model-call spine for LLM features is implemented in TypeScript under `prototypes/studio/api/`.

## Decided Design

- **Endpoint Buffering & Streaming**: The endpoints for extraction (`/api/extract`), schema generation (`/api/generate_schema`), and markdown (`/api/markdown`) return single, buffered JSON objects. The chat endpoint (`/api/chat`) is the only streaming endpoint, implemented using the Vercel AI SDK's `streamText`.
- **Markdown & Output Structure**: The markdown endpoint returns `{ markdown, pages }` (pages is `number | null`). Extractions do not support build-up streaming, displaying a loading state in the frontend.
- **Model Calling**: Vercel AI SDK functions (`generateText`, `streamText`) are used directly inside separate modular functions (`extractWithModel`, `generateSchemaWithModel`, `streamChatWithModel`) located in [_model.ts](file:///c:/Users/arkan/.codex/worktrees/9bfd/FREE/prototypes/studio/api/_model.ts).
- **Testing**: Workflows are verified via Vitest ([_model.test.ts](file:///c:/Users/arkan/.codex/worktrees/9bfd/FREE/prototypes/studio/api/_model.test.ts)), mocking Ollama fetch responses.


