# 07 — Move conversational chat to typed AI SDK streaming

Status: resolved
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

- [x] Chat replies stream through `useChat` → `/api/chat` → `createAgentUIStreamResponse`
- [x] `resolveChatModel()` reads `AI_CHAT_*`; extraction/NuExtract settings untouched
- [x] Route validates request body and UI messages, including prior tool parts
- [x] Aborted or stale session results are ignored
- [x] ADR-0001 updated; README documents `AI_CHAT_*` variables
- [x] Automated tests use mock models; test, lint, and build green

## Blocked by

- 01-prove-gemma-schema-tool-support
- 06-parsed-source-context-in-chat

## Answer

Implemented typed conversational streaming with a lazily composed Ollama
`ToolLoopAgent`, independent `AI_CHAT_*` configuration, validated call data and
UI messages, and request abort propagation. Studio now uses typed `useChat` and
`DefaultChatTransport`, carries Source Context plus schema freshness in every
call, and replaces the chat session on document-epoch changes. Extraction stays
on its existing NuExtract path. ADR-0001 and the Studio README record the
composition and configuration. Request-validation failures now return HTTP 400
while provider failures remain HTTP 502. Regression coverage streams through the
real agent UI composition (including Source Context insertion) and verifies that
a document-epoch change aborts and replaces the stale browser session. Focused
route/provider/agent tests use mocked boundaries and an injected mock model; the
complete Studio test, lint, and build lanes pass.
