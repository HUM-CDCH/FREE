# 07 — Move conversational chat to typed AI SDK streaming

Status: ready-for-agent
Type: task
Blocked by: 01, 06

## What to build

Move normal conversational replies end to end through the typed AI SDK path:
independent chat model configuration (`AI_CHAT_PROVIDER=ollama`,
`AI_CHAT_MODEL=gemma4:26b-a4b-it-qat`,
`AI_CHAT_BASE_URL=http://spark.cdch-dgxspark.lan.ku.dk:11434`, no API key)
resolved by a `resolveChatModel()` beside the extraction resolver — no
general provider registry. The route runs a `ToolLoopAgent` streamed via
`createAgentUIStreamResponse` with the request's abort signal; the browser
uses `useChat` + `DefaultChatTransport`, sending markdown, annotations,
schema, revision, and documentEpoch in the body. Export a type-safe
`SchemaAgentUIMessage` via `InferAgentUIMessage` through a type-only-safe
shared boundary. Extraction stays on its existing NuExtract path. Record the
agent composition in ADR-0001. Construct the agent/model lazily or inject it
so automated tests use mock models.

This slice covers conversational replies only — proposal tool calls land in
issues 08–09.

## Acceptance criteria

- [ ] Chat replies stream through `useChat` → `/api/chat` → `createAgentUIStreamResponse`
- [ ] `resolveChatModel()` reads `AI_CHAT_*`; extraction/NuExtract settings untouched
- [ ] Route validates request body and UI messages, including prior tool parts
- [ ] Aborted or stale session results are ignored
- [ ] ADR-0001 updated; README documents `AI_CHAT_*` variables
- [ ] Automated tests use mock models; test, lint, and build green

## Blocked by

- 01-prove-gemma-schema-tool-support
- 06-parsed-source-context-in-chat
