# Conversational Extraction Schema Plan

## Goal

Let a Humanities Researcher create and modify one browser-session Extraction
Schema through chat. Every AI-produced Schema Suggestion must be previewed and
explicitly applied or rejected.

An Extraction Schema belongs to one Source Document. Opening another Source
Document starts a new active document context; it does not mutate the previous
Source Document.

## Guardrails

- The model proposes changes; it never mutates browser state.
- Generative UI means one deterministic React card backed by validated data.
- Existing Generate Schema and chat use the same review/apply path.
- Parsed Source Document Markdown replaces repeated PDF attachments in chat.
- Manual and AI-authored changes cross the same schema mutation seam.
- Persistence, broad provider parity, and terminology cleanup are out of scope.

## Schema domain contract

Add a DOM-free shared schema module that can be imported by both `src/` and
`api/`. The API must not duplicate schema validation or mutation logic.

### Concepts

- `SchemaSuggestion`: server-owned `id`, `documentEpoch`, `baseRevision`,
  `summary`, and `changes`.
- `SchemaChange`: one of `set(path, value)`, `remove(path)`, or
  `rename(path, name)`.
- `SchemaPath`: a record-relative chain of field names.
- `ApplyResult`: a discriminated result with `applied`, `stale`, or `invalid`
  status and structured issues for expected failures.
- `applySchemaSuggestion(schema, freshness, suggestion)`: checks freshness,
  applies the complete change set immutably, and validates the result.

`SchemaChange.value` is a JSON value, never `unknown`.

### Path and operation semantics

- `[]` targets the complete `ExtractionSchemaEnvelope`.
- A non-root path starts beneath `schema.record`.
- Array nodes traverse the repeated-item schema at index `0`; arbitrary array
  indexes are not part of the patch language.
- Root `set` creates or replaces an Extraction Schema.
- Root `remove` and root `rename` are invalid.
- Nested `set` may create a missing leaf only when its complete parent path
  already exists.
- Missing intermediate nodes, invalid removes, and invalid renames return typed
  issues rather than silently doing nothing.
- Changes apply sequentially to one immutable working copy. Any failure rejects
  the entire change set.
- A generated root replacement is stale if the approved schema changed while
  generation was running. The ordinary freshness check enforces this; no
  special merge or warning flow is added.

Do not reuse `transformField` unchanged: its current silent no-op and array
behavior do not satisfy this contract.

### Schema grammar and names

The validator accepts the existing recursive Extraction Schema grammar,
including scalar placeholders, `null`, nested records, repeated-item arrays,
`_evidence`, `_meta`, and `_schema_metadata`. Validation must not be reduced to
`FIELD_TYPES`.

Researcher-authored changes cannot directly create or target the system-managed
`_evidence`, `_meta`, or `_schema_metadata` names. They also reject
`__proto__`, `constructor`, and `prototype` at every path segment.

Normalize names only when a field is newly created or renamed. Preserve names
already present in a loaded or generated Extraction Schema.

### System-managed metadata and evidence

The schema engine owns `_schema_metadata`, `_evidence`, and `_meta` during
nested edits:

- `rename` migrates dependent metadata and evidence paths.
- `remove` prunes dependent metadata and evidence paths.
- `set` synchronizes the required local evidence shape for a new field.
- Root `set` validates the complete supplied system structures.
- Invalid or orphaned system references reject the complete change set.

These rules must preserve the extraction behavior driven by
`_schema_metadata` and the requirement that every extracted value can carry
Evidence.

## Browser-owned state and transitions

`App.tsx` owns:

- the approved Extraction Schema;
- a monotonic schema revision;
- a monotonic document epoch;
- the current Schema Suggestion;
- schema-generation lifecycle state.

`SchemaPanel` emits typed `SchemaChange[]`; it never emits an already-mutated
record and its callback never accepts `unknown`. Manual edits, generated
suggestions, pinned-schema transitions, and chat Apply all use the same schema
engine and App-owned transition.

Apply is one atomic transition:

1. Compare `{ documentEpoch, revision }`.
2. Apply and validate all changes.
3. Commit the schema and increment revision together.
4. Invalidate Extraction Results.

A pinned Extraction Schema remains immutable. Applying a change to one creates
an editable browser-owned copy and leaves the pinned source unchanged.

Opening another Source Document:

- increments the document epoch;
- aborts schema generation and chat for the previous context;
- clears the approved schema, pending suggestion, conversation, and Extraction
  Results;
- resets schema revision for the new epoch;
- prevents late responses from committing.

The active Source Document itself is not described as changing. Revision is
never used without document epoch. Extraction identity and completion guards
include both values.

Keep the approved schema visible while generation is pending. Generation state
and pending suggestion state are separate from approved schema state.

## Chat transport and agent contract

The complete browser-to-agent bridge is:

```text
App
  → RightRail
  → ChatTab
  → useChat / DefaultChatTransport
  → /api/chat
  → createAgentUIStreamResponse
```

`useChat` sends each message with validated call data:

```ts
sendMessage(
  { text },
  {
    body: {
      markdown,
      annotations,
      schema,
      revision,
      documentEpoch,
    },
  },
)
```

The route validates both the request body and UI messages, including tool parts
from previous turns, then calls:

```ts
createAgentUIStreamResponse({
  agent,
  uiMessages: messages,
  options,
  abortSignal: request.signal,
})
```

Parsed Markdown is delimited and identified as untrusted Source Context. It is
never interpolated into system instructions. Annotation call identity includes
annotation text and page number, not only annotation IDs.

Export a type-safe `SchemaAgentUIMessage` using
`InferAgentUIMessage<typeof schemaAgent>` through a type-only-safe shared
boundary and use it with `useChat`.

The model supplies proposal content only. Server execution validates the
proposal and injects the suggestion ID, document epoch, and base revision from
validated call options. It has no application side effects.

Configure a finite loop with:

```ts
stopWhen: [
  hasToolCall('proposeSchemaChanges'),
  isStepCount(MAX_SCHEMA_AGENT_STEPS),
]
```

A normal reply without a proposal tool call remains visible as conversational
guidance and creates no Schema Suggestion. Invalid tool output renders an error
state and never creates a suggestion. Ignore aborted or stale session results.

`SchemaSuggestionCard` renders validated tool states for input availability,
output availability, and errors. Apply and Reject call the same App-owned
handler used by Generate Schema.

## Provider prerequisite

Before chat UI implementation, run a credentialed provider spike using the
actual `ToolLoopAgent` and `createAgentUIStreamResponse` path.

- Add `@ai-sdk/react@4.0.16`, compatible with the installed `ai@7.0.15`.
- Update `pnpm-lock.yaml`.
- Test `gemma4:12b-it-qat`, `gemma4:e4b-it-qat`, and
  `gemma4:26b-a4b-it-qat` through `ai-sdk-ollama` at the VPN-only Ollama
  endpoint `http://spark.cdch-dgxspark.lan.ku.dk:11434`.
- Verify tool input, validated output, streamed UI tool parts, and final
  completion.
- Map unsupported provider or model behavior to a clear route error.
- Use `gemma4:26b-a4b-it-qat` as the selected default. The other two models
  remain verified alternatives.

`ai-sdk-ollama` has no capability-discovery interface, so configured provider
and model names alone do not prove native tool support.

The production chat configuration will use:

```env
AI_CHAT_PROVIDER=ollama
AI_CHAT_MODEL=gemma4:26b-a4b-it-qat
AI_CHAT_BASE_URL=http://spark.cdch-dgxspark.lan.ku.dk:11434
```

The endpoint is reachable only while connected to the institutional VPN. It
does not require a cloud Ollama API key.

## Tracer-bullet implementation sequence

### 01 — Prove Gemma schema-tool support

Verify one candidate Gemma model through the intended agent and streamed tool
path. Record the selected model, unsupported-model behavior, and repeatable
manual smoke procedure.

**Depends on:** Nothing.

### 02 — Safely add and retype schema fields

Expand the schema engine beside the existing helpers. Route manual field
addition and type changes through immutable `set` operations. Reject malformed,
duplicate, reserved, or overwriting changes and derive the accepted grammar
from fixture-based tests of existing pinned Extraction Schemas.

**Depends on:** Nothing.

### 03 — Safely rename and remove schema fields

Migrate the remaining manual operations to explicit validated changes. Rename
or prune dependent metadata and Evidence atomically, create editable copies of
pinned schemas, and delete the old mutation seam.

**Depends on:** 02.

### 04 — Keep Extraction Results aligned with schema revision

Invalidate obsolete Extraction Results after each approved schema transition.
Include schema revision in extraction identity and prevent delayed completions
from restoring results for an older revision.

**Depends on:** 03.

### 05 — Review Generate Schema before applying it

Turn buffered generation into a root-replacement Schema Suggestion. Preview it
without replacing the approved schema, then route Apply and Reject through the
shared freshness-aware transition.

**Depends on:** 03 and 04.

### 06 — Send parsed Source Context through existing chat

Replace repeated PDF attachment with validated parsed Markdown and annotations
while preserving the current conversational experience. Delimit Source Context
as untrusted data.

**Depends on:** Nothing.

### 07 — Move conversational chat to typed AI SDK streaming

Move normal conversational replies end to end through independent chat model
configuration, `ToolLoopAgent`, typed UI messages, and `useChat`. Keep extraction
on its existing NuExtract path and record the agent composition in ADR-0001.

**Depends on:** 01 and 06.

### 08 — Create an Extraction Schema through chat

Let a validated tool call propose a root Extraction Schema when none exists.
The server supplies identity and freshness fields, while the shared card handles
Apply, Reject, invalid output, and ordinary replies.

**Depends on:** 05 and 07.

### 09 — Modify an approved Extraction Schema through chat

Let chat propose nested set, rename, and remove operations. Apply fresh changes
through the same engine as manual edits while rejecting stale or invalid
proposals without mutating the approved schema.

**Depends on:** 08.

### 10 — Isolate active Source Document contexts

Opening another Source Document clears browser-owned state, aborts old work,
increments document epoch, and prevents generation, chat, or extraction
responses from crossing into the new active context. Run final integrated
acceptance verification.

**Depends on:** 09.

Tickets 01, 02, and 06 form the initial frontier and may run independently.
Every ticket includes focused tests and leaves tests, lint, and build green.
Each ticket runs in a fresh context, blockers-first.

## Acceptance

- Chat can propose a new Extraction Schema when none exists.
- Chat can propose changes to the approved Extraction Schema.
- Normal conversational replies do not create suggestions.
- No proposal changes the schema before Apply.
- Reject, stale Apply, and invalid Apply never change the schema.
- Applying a change to a pinned schema creates an editable copy.
- Manual and AI-authored changes use the same schema engine.
- Generate Schema uses the same card and review handler as chat.
- Opening another Source Document clears the old browser-owned context and late
  responses cannot commit into the new context.
- Chat sends parsed Markdown, not a PDF attachment.
- Extraction continues using its existing model and NuExtract prompt path.
- The selected Gemma model emits and completes the proposal tool call
  through AI SDK 7.
- System-managed metadata and Evidence remain valid after set, rename, and
  remove operations.

## Explicit deferrals

- Persistence and audit history across browser sessions.
- Multiple simultaneous suggestions, undo, and cross-document schema reuse.
- Claude Code and Codex CLI MCP adapters. Add these later behind the same
  side-effect-free proposal contract.
- A generalized provider-capability framework. The bounded version is the
  model-gateway follow-up below.
- RSC, model-generated components, or automatic application.
- Retrieval, summarization, and long-document token budgeting.
- The repository-wide `template` to Extraction Schema terminology rename.

## Follow-up refactors after acceptance

From the 2026-07-17 architecture review; ordered. These follow the accepted
slice because doing them first would churn the same seams rewritten above.

1. **Model gateway.** Deepen `prototypes/studio/api/_provider.ts` into the one
   model seam: it resolves and invokes, with the AI SDK call and NuExtract raw
   transport as adapters. Move the embedded raw `fetch` and duplicate `AI_*`
   reads out of `_model.ts`, absorb the Codex temperature quirk, and map Codex
   auth/version failures to real statuses instead of blanket 502s. Prompt
   construction stays in `_model.ts` per ADR-0003. Do this once
   `resolveChatModel()` exists so three real call paths shape the interface.
2. **Evidence anchoring module.** Extract the text-to-rectangle matcher from
   `EvidenceHighlightLayer.tsx` behind a page-text-in, rectangles-out interface;
   keep the layer as a thin canvas adapter and add headless grounding tests.
3. **Parsing service.** Delete dead compatibility functions and duplicate
   `public_url_ref`; centralize coordinate conversion in one geometry module;
   share one task-metadata contract between route, worker, and response schema.
