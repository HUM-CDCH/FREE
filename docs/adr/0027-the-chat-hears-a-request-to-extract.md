# 0027: The chat hears a request to extract

Date: 2026-11-01. Status: accepted; amends [0023](0023-schema-chat-answers-questions.md) and
[0024](0024-rail-chat-guides-to-extraction.md).

## Context

Once a template (Extraction Schema) exists, every chat message is an edit request that the model answers as a
question or turns into a revised schema (0023). A researcher who wrote "generate the results" on another document got
an unchanged schema back, said as "0 changes proposed", while the only way to run the extraction was a step's option
(0024: no router model reads "run it"). With the chat leading the whole workflow (0026), that dead end stopped the
work it is meant to carry.

## Decision

- The edit request's Schema Suggestion prompt, and the Assistant model's answer-or-decline prompt beside NuExtract,
  may reply `{"action":"extract"}` when the message asks to run the extraction with the schema as it is. The edit's
  response is then `{ status: 'requested', action: 'extract' }`: nothing is proposed, saved or run. Messages before
  the first schema are never offered this reply.
- **The model hears the request; Studio still decides what may run.** The chat answers it with an Extract step that
  asks which documents: this document alone (the workspace's Run), or the project's documents ticked in the step
  (a pilot of at most `PILOT_BATCH_SELECTION_LIMIT` before the template's approval, a Batch Extraction after it).
  Each option is offered or disabled exactly as the guide's own steps are, with the reason when nothing can run, and
  calls the same handlers. The step lasts until the researcher chooses or says "Not now".
- An edit that changes nothing now says so and how to extract, instead of "0 changes proposed".

## Consequences

- The edit workflow's step sequence is unchanged; the new reply is one more value of its existing step's output, which
  a reload does not reopen (only `proposed` outputs are).
- Whether a message is a request to extract is the model's reading, as a question is (0023); a misread one costs a
  dismissed step or a proposal, never a run, since every run still waits for the researcher's choice.
