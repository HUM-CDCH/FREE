# 08 — Create an Extraction Schema through chat

Status: resolved
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

- [x] Chat proposes a root Extraction Schema when none exists
- [x] Server owns suggestion ID, documentEpoch, and baseRevision — never model-supplied
- [x] No proposal changes the schema before Apply
- [x] Invalid tool output renders an error, never a suggestion
- [x] Ordinary replies create no suggestion; loop terminates on tool call or step cap
- [x] Route tests cover proposal, text reply, invalid output, provider error, streamed tool parts (mock models)
- [x] Test, lint, and build green

## Blocked by

- 05-generate-schema-review
- 07-typed-ai-sdk-chat-streaming

## Answer

Implemented the side-effect-free `proposeSchemaChanges` agent tool for root
Extraction Schemas. The model supplies only summary and schema content; shared
schema validation runs during server execution, which injects the UUID and
validated document epoch and base revision. The finite agent loop now stops on
the proposal call or the configured step cap.

Chat renders streamed input, validated output, and tool errors through the same
`SchemaSuggestionCard` used by Generate Schema. Apply and Reject route to the
App-owned freshness-aware handlers, so proposals cannot mutate the approved
schema before Apply. Rejected streamed suggestions are replaced by a terminal
review state and cannot be acted on again.

The schema selector now exposes a reachable “No approved schema” state, and the
shared transition can validate and apply a root replacement from that state.
The route strictly validates persisted proposal tool-part states, including the
complete root Extraction Schema output, before invoking the agent. Mock-model,
route, review-state, and transition tests cover valid and malformed proposals,
ordinary text, provider failure, streamed parts, root creation, and rejection.
Full Studio test, lint, and build lanes pass.
