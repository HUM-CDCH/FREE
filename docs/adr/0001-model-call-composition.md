# ADR 0001 — Model-call composition: TypeScript serverless functions, buffered extraction and streamed chat

**Status**: Accepted

The model-call spine for LLM features is implemented in TypeScript under
`prototypes/studio/api/`.

## Decided Design

- **Endpoint buffering and streaming**: extraction (`/api/extract`) and schema
  generation (`/api/generate_schema`) return buffered JSON. Conversational chat
  (`/api/chat`) streams typed AI SDK UI messages.
- **Extraction composition**: extraction and schema generation keep their
  existing NuExtract path and `AI_*` configuration in `_model.ts` and
  `_provider.ts`.
- **Chat composition**: `_chat_agent.ts` lazily composes an independently
  configured Ollama model from `AI_CHAT_*` with a `ToolLoopAgent`. The route
  validates call data and UI messages, then delegates to
  `createAgentUIStreamResponse` with the request abort signal.
- **Browser composition**: `ChatTab` uses `useChat` with a typed
  `DefaultChatTransport`. `SchemaAgentUIMessage`, inferred from the server agent,
  crosses the browser/server boundary through a type-only shared module.
- **Source Context**: parsed Markdown and annotations are serialized as delimited,
  untrusted data immediately before the current researcher question. They are
  not interpolated into agent instructions.
- **Freshness**: each call carries the browser-owned document epoch and schema
  revision. Changing document epoch recreates and stops the browser chat session,
  so late stream results cannot enter the active conversation.
- **Testing**: agent construction accepts an injected model, allowing automated
  tests to avoid live providers. Route tests replace the agent response boundary;
  live provider checks remain explicit smoke tests.
