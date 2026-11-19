# 0034: The chat reads what a message asks for first

Date: 2026-11-18. Status: accepted; amends [0023](0023-schema-chat-answers-questions.md) and
[0027](0027-the-chat-hears-a-request-to-extract.md).

## Context

The schema chat read a message's intent inside the request that already did something else (0023): before the first
schema, the Assistant model's answer-or-instruction request; after it, the Schema Suggestion request that revises the
schema, beside a 48,000-character source. Each state offered its own replies, added clause by clause (0027 added
`extract`, after the first schema only). A researcher can ask anything in any state, so whatever a state left out was
misread: "give me a template of this doc" before the first schema was answered with a template written as text, or
kept as an instruction, and never generated one; "yes" beside a step, "approve it" or "start over" became schema
changes. The model never saw the step it was answering, and the steps already answered were left out of the
conversation it read.

## Decision

- **One classification, the same in every state.** Each chat message is first classified by the chat's general route
  (the Schema Suggestion Route, or the Interaction Route beside NuExtract) into one of six intents (`_chat_intent.ts`):
  `question`, `generate` (make the template, or make it again), `edit` (change it, or say what it should hold),
  `extract`, `confirm` (agree to what the chat offers) and `none`. The request reads the message, the conversation
  and what the chat offers beside it (its step's title and question, sent as `offer`); no document, no schema. For
  `generate` it also reads what the template should hold (`focus`). A reply that names no intent is `edit`, as every
  message was before. With NuExtract and nothing beside it, every message is still a change or an instruction.
- **Then one request does what it asks.** A question is answered by its own request from the source (long sources by
  window, as before); a change runs the Schema Suggestion request, which now only ever returns a schema. The
  classification runs inside each workflow's existing first step (`answerIfQuestion`, `proposeSchemaEdit`), so neither
  step sequence changes.
- **Studio decides what each intent does where it is.** The replies are `{ kind: 'requested', action, focus }` before
  the first schema and `{ status: 'requested', action, focus }` after it (`extract` as in 0027, now with `generate` and
  `confirm`); `none` stays `none` and `declined`.

  | Intent | Before the first template | After it |
  | --- | --- | --- |
  | question | answered | answered |
  | generate | Generate template comes back; `focus` kept as an instruction | the Regenerate dialog opens; `focus` kept as an instruction |
  | edit | kept as an instruction | proposed as a change |
  | extract | "no template yet", and Generate template comes back | the Extract step (0027) |
  | confirm | the step's lead option | the step's lead option |
  | none | pointed to the chat box | pointed to the chat box |

- **A "yes" goes ahead.** `confirm` runs the lead (positive, enabled) option of the step the message was sent beside,
  as that step stands when the reply arrives, through the same handler as its card, with the documents ticked when
  the message was sent. A step that has moved on, or has nothing to go ahead with, is said to have nothing instead.
  Generating, from either `generate` path, still waits for the researcher's click.
- **The model reads the steps already answered.** Each step answered in the conversation is a `note` in the history
  ("The researcher chose “…” at the step “…”").
- **An evaluation set measures it.** `api/_chat_intent.live.test.ts` holds labelled messages in English and Chinese,
  with and without an offer, and classifies them on a live model under `test:live-model`. It prints every misread
  message and fails below `FREE_CHAT_INTENT_MIN_ACCURACY`. A misread found in use is added there before the prompt
  changes.

## Consequences

- Every chat message on a general route costs one more, small request; a question or a change still costs the one it
  did, without the other's instructions beside it. Beside NuExtract the count is unchanged.
- 0023 chose to read a question in the request it already made, without a router; this reverses that choice.
- A misread `confirm` runs the step's lead option, a run or an approval among them, which 0027 ruled out for a
  misread request to extract. The classification is told that a message asking for anything besides agreement is not
  `confirm`, and the evaluation set checks it.
- Outputs saved before this, with `requested` and no `focus`, still read.
