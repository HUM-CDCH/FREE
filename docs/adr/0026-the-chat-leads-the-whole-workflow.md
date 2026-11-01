# 0026: The chat leads the whole workflow

Date: 2026-11-01. Status: accepted; supersedes parts of [0024](0024-rail-chat-guides-to-extraction.md).

## Context

After 0024 three guides still told a researcher what came next: the project page's six-step workflow bar with its
Next, the rail chat's step on the open document, and the pilot strip under the document tabs. The work itself sat in
the rail's Schema and Results tabs and the project page's Schemas and Extractions tabs. Researchers could not tell
which guide to follow or where the work happened, and the chat, docked under one document's tabs, read as that
document's rather than the project's.

## Decision

- **The chat is the only guide.** Its next step (`chatGuide.ts`) runs, in order: the schema's own steps on the open
  document, that document's running Extraction with Pause, Resume, Retry and Stop, the project's workflow
  (`guidedWorkflow`, the server's phase: pilot the schema on documents ticked in the step, review a round document by
  document, approve, extract the documents left, review), then a run of the open document alone. Studio still
  chooses the step from state alone, and each option calls the handlers the controls it replaces called.
- **The chat has a column of its own.** AppFrame gives it a full-height column beside the document area and its
  tabs, titled with the project. Schema, Results and History open from the chat as views that lead back to it; under
  a view the next step and the composer stay in view. No tab strip remains in the rail.
- **Runs start only in the chat.** The tab strip keeps its status lines; Run, Re-run and every control of a run, the
  pilot strip, and "Save schema and pilot it" are gone. A pilot or batch start saves the schema, re-reads the saved
  method and opens the Batch Extraction as a run does (ADR 0015).
- **The project page is the project's record.** It says where the workflow stands, offers Continue in chat, and lists
  the documents; the schema's tools (history, codebook and spreadsheet imports) and Runs & exports fold away below.
  The route still names the open section.

## Consequences

- No server, contract or workflow changes.
- A collapsed chat hides every control of a run: expanding it is the way back to them.
- The custom Batch Extraction in Runs & exports stays as an advanced start outside the guided workflow.
