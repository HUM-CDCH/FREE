# 0024: The rail chat guides the researcher to an extraction

Date: 2026-10-27. Status: accepted; builds on [0023](0023-schema-chat-answers-questions.md).

## Context

A researcher reached a first extraction through four separate places: the schema panel's chat and Generate schema,
the proposal's Apply / Discard bar, the Article/Catalog select in the schema header, and Run extraction in the tab
strip. The chat lived inside the Schema tab, so it disappeared on Results, and nothing said what came next. A
prototype (branch `prototype/chat-guided-flow`) compared three layouts; the researcher chose a chat docked in the
right rail whose next step is always in view as a card with numbered options, in the manner of an approval prompt.

## Decision

- **The schema chat is the rail's.** Its state (`useSchemaChat`) is lifted out of the schema panel into the workspace
  rail, which shows it under every tab (`RailChat`). The Schema tab keeps the editor and the per-change acceptance of a
  proposal; the batch editors, which have no rail, keep the chat inside the panel as before.
- **Studio, not the model, chooses the next step.** `nextStep` (`chatGuide.ts`) works it out from the workspace's
  state alone: Generate schema, a proposal to apply, the Record Scope, Run extraction, a running Extraction's
  progress, then opening Results. A step stays in view while the conversation is collapsed; "Not yet" dismisses it
  until its key changes.
- **Actions happen only through a step's options.** A message is still answered, kept as an instruction or turned into
  a proposal (ADR 0023). No router model reads "run it", and a step calls the same handlers as the controls it stands
  in for (`runExtraction`, `setRecordScope`, the proposal review), so admission and its refusals are unchanged.

## Consequences

- No server, contract or workflow changes; the chat's requests and their durable recovery are those of 0022 and 0023.
- The step never duplicates Pause, Resume, Retry or Stop: a running Extraction's step shows its progress and points to
  the tab strip.
- Schema Suggestion reports no per-window progress, so its step shows a spinner and Stop generating only.
