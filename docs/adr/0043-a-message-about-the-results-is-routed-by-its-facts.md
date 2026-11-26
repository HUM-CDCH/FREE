# 0043: A message about the results is routed by its facts

Date: 2026-11-26. Status: accepted; amends [0034](0034-the-chat-reads-what-a-message-asks-first.md),
[0035](0035-the-chat-proposes-corrections-to-results.md) and
[0037](0037-a-correction-the-template-cannot-hold-becomes-a-template-change.md); supersedes the leaning of
[0040](0040-a-chat-message-is-read-where-it-is-said.md) and the routing of
[0042](0042-what-the-values-cannot-take-is-run-again.md).

## Context

A message about the results can need three things: a change to values, a new run (the template holds it but no value
can take it, 0042), or a template change (0037). Two model readings chose between them, and both chose by the
message's words. The classification (0034) told `edit` from `correct` without seeing the template or the values, with
a leaning by the view the message was said in (0040). The proposal then chose its route from a list of example cases
in its prompt. A message that fit no example ("the dates are all day-month-year", "作者漏了") was misread, and a
general mistake in a field became dozens of value edits, or none.

## Decision

- **The classification tells structure from results.** `edit` is a change to the template's structure that says
  nothing about what was extracted: fields added, removed or renamed, a type or the allowed values changed, what the
  template covers. `correct` is anything said about what was extracted: a value wrong, missing or extra, a record
  missed, a field read wrongly in one value or in all, how values should be read. A message that could be either is
  `correct`, because what follows `correct` can still change the template and what follows `edit` cannot. The view the
  message is said in is context only; with no result shown, `correct` is answered as `edit`.
- **The proposal reports facts, one item per thing asked.** Which listed value (`value`, by alias) and which template
  field (`field`) it is about; whether it is about particular values or how the field is read in general (`scope`);
  whether the value should go (`remove`); the value it should hold (`desired`), and where that comes from (`from`:
  the message, or the source with an exact `quote`); and, for a field the template lacks or a field read wrongly in
  general, the instruction for the template (`template`). The view the message was said in is a hint for `scope`.
- **Studio routes each item, in this order.** No template field for it, `scope` `field`, or a wanted value its field
  cannot hold (`correctionValueFits`): a template change. A listed value whose wanted value is known, given by the
  message or read from the source with its quote found there (case, spacing and Markdown marks aside), and fits: a
  change to that value, or its rejection. Otherwise the template holds it and no listed value can take it (a record
  the results do not have, a value whose right value was not found): a new run. A template change goes first, so no
  run is offered beside it; no items is a question back, in the reply. The proposal Studio returns keeps its shape
  (`corrections`, `templateChange`, `rerun`), so everything after it is unchanged.
- **Both readings are evaluated on labelled messages.** `_chat_intent.live.test.ts` and
  `_result_correction.live.test.ts` run on a live model (`test:live-model`) and print every misread; a misread found in
  use is added as a case before the prompt changes.

## Consequences

- A message's route no longer depends on its wording matching an example: it follows from which value and field it is
  about and whether the right value is known, which Studio checks where it can.
- A value read from the source is taken only with a quote found in it; one the model cannot quote is offered as a new
  run, not saved as read.
- A message that only changes the template from the Results view, once read as `correct`, costs one more model
  request (the facts) before the template change.
