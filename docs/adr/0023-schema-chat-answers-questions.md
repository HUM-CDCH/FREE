# 0023: The schema chat answers questions

Date: 2026-10-27. Status: accepted; amends [0012](0012-one-durable-execution-layer.md) and
[0022](0022-schema-edits-run-through-schema-suggestion.md).

## Context

Researchers ask the schema panel's chat questions about the source ("How many burials are listed?", "Which fields
hold dates?") as well as giving instructions. Before the first schema every message was kept as a generation
instruction without a model call; after it, every message became a Schema Suggestion request for an edit proposal.
A question either steered generation as if it were an instruction, or came back as a proposal.

## Decision

The chat tells a question from an instruction in the request it already makes, without a separate router model.

- **After the first schema**, the edit proposal's Schema Suggestion request also carries the message and may return
  `{"answer": …}` instead of a template. `proposeSchemaEdit`'s outcome is then `{ status: 'answered', answer }`, which
  the chat shows; nothing is proposed or saved. NuExtract only generates templates, so on a NuExtract Schema
  Suggestion Route the Interaction Route (the *Assistant model*, by default the deployment's instruction model) first
  answers or declines (`{"answer": null}`), and a declined message runs on NuExtract as before.
- **Before the first schema**, each message is a new `answerSchemaChat` workflow (`chat:<operationId>`, `POST
  /api/schema_chat`) on the general route that answers (the Schema Suggestion Route, or the Interaction Route beside
  NuExtract). It answers a question, or replies `instruction`, and the page keeps that message for Generate schema as
  before. An answered question is not a generation instruction.
- **A long source** (past the 48,000-character Schema Suggestion limit, which the deployment's 32k-token models set)
  is excerpted for the first request, as Schema Suggestion already is. When that request answers, the question is
  answered again from every window of the source (`answerWindow:<n>`), and the window answers are combined in one
  more request (`combineAnswers`), so the answer reads the whole source. A request for the schema keeps today's path.
- **Every request reads the whole conversation before its message**, oldest first: the messages before the first
  schema (each with its answer, or that it was kept as an instruction), then the edit chat's messages and replies. The
  page sends it as `history`, and the workflow input records it beside the message, so a follow-up can refer to an
  earlier question or answer. The conversation itself is still kept only in the page.
- The edit workflow's new behaviour is behind DBOS patch `schema-chat-answers`; a run before it never answers.

## Consequences

- The Interaction Route runs model work again: it answers questions when Schema Suggestion is NuExtract. With
  NuExtract and no Interaction Route, the chat only gives instructions, as before.
- Every message before the first schema waits for one model request, and a long source's question for one per window
  plus one.
- On NuExtract, an edit chat message that is not a question costs one Interaction Route request before NuExtract's.
- The conversation is not budgeted: it is sent whole beside the (possibly excerpted) source, so a very long chat over
  a long source can exceed a 32k-token model's context.
- `chat:` workflows are not model operations: a reload neither lists nor reopens them, as the instructions they sit
  beside live only in the page. Garbage collection keeps their history for the interactive retention.
- An answered edit is a finished `edit:` operation that a reload does not reopen.
