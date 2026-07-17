# 08 — Create an Extraction Schema through chat

Status: ready-for-agent
Type: task
Blocked by: 05, 07

## What to build

Let a validated `proposeSchemaChanges` tool call propose a root Extraction
Schema when none exists. The model supplies proposal content only; server
execution validates it through the shared schema module and injects the
suggestion ID, document epoch, and base revision from validated call options
— no application side effects. Finite loop:

```ts
stopWhen: [
  hasToolCall('proposeSchemaChanges'),
  isStepCount(MAX_SCHEMA_AGENT_STEPS),
]
```

`SchemaSuggestionCard` renders validated tool states (input available, output
available, error) and routes Apply and Reject through the same App-owned
handler as Generate Schema. Normal replies without a tool call remain
conversational guidance and create no suggestion; invalid tool output renders
an error state and never creates a suggestion.

## Acceptance criteria

- [ ] Chat proposes a root Extraction Schema when none exists
- [ ] Server owns suggestion ID, documentEpoch, and baseRevision — never model-supplied
- [ ] No proposal changes the schema before Apply
- [ ] Invalid tool output renders an error, never a suggestion
- [ ] Ordinary replies create no suggestion; loop terminates on tool call or step cap
- [ ] Route tests cover proposal, text reply, invalid output, provider error, streamed tool parts (mock models)
- [ ] Test, lint, and build green

## Blocked by

- 05-generate-schema-review
- 07-typed-ai-sdk-chat-streaming
