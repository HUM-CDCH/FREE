# 0037: A correction the template cannot hold becomes a template change

Date: 2026-11-25. Status: accepted; amends [0035](0035-the-chat-proposes-corrections-to-results.md).

## Context

A request to change results (0035) can only change values the result already has, as their fields' types allow.
"Add the parish", "the year is ca. 1850" in an integer field, or "record 7 is missing" asked for something no listed
value can hold: the model's change was left out as not fitting, or it asked the researcher again, and the request
went nowhere. What it needs is a change to the template, and then a run that reads the document with it; the
researcher's words are what the template should say.

## Decision

- **The proposal names the template change.** The correction prompt asks the model, beside the changes to listed
  values, for `templateChange`: when the field named is not in the template, the value cannot be held by its type or
  allowed values, or records or entries the results do not have are asked for, one instruction for the template that
  names the fields to add or change and says, for each, how it is read. When every change the model proposed was
  left out as not fitting its field and it named no template change, Studio asks for one itself, from the message.
- **The chat proposes it, as it is.** The page says "This needs a change to the template: …" as the assistant's,
  and sends the instruction, with the conversation through the request, to the edit request with `direct`: the
  edit workflow proposes it on the Schema Suggestion route without reading it first (no classification, so it can
  never be heard as `correct` again). Changes to listed values the same message asked for wait in their own step
  first. The instruction is kept where the edit puts it: in the changed fields and their descriptions, versioned with
  the template, visible and editable in the Template view.
- **One choice applies it and runs.** Its proposal step leads with *Apply and extract again*, which applies the
  change and starts this document's run, which saves the template first as Run does; *Apply only* stays beside it.
  While no run can start, the option is disabled with the reason and *Apply only* leads. A "yes" beside the step
  chooses the leading option. A refused Apply runs nothing.

## Consequences

- No run starts without the researcher's choice (0027): the model only proposes, the researcher applies and runs.
- A run reads the document again into a new result. Changes saved to the earlier result stay with it and are not
  carried over, unless the researcher included them as guidance.
- A request that becomes a template change costs a third model request (classification, correction proposal, edit).
- A reloaded page reopens the proposal as an ordinary one: *Apply changes*, then the run step.
