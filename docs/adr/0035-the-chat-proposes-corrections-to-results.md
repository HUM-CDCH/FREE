# 0035: The chat proposes corrections to results

Date: 2026-11-19. Status: accepted; amends [0034](0034-the-chat-reads-what-a-message-asks-first.md); amended by
[0036](0036-a-missing-value-can-be-filled-in.md), which lets a missing value be filled in, and by
[0037](0037-a-correction-the-template-cannot-hold-becomes-a-template-change.md), which turns a request the template
cannot hold into a template change and a run, and by
[0042](0042-what-the-values-cannot-take-is-run-again.md), which offers a new run for what the template holds but no
value can take.

## Context

The chat leads the whole workflow (0026), but a researcher who saw a wrong value in Results ("the year of record 3
should be 1854") could only fix it there, value by value. Said in the chat, the message was read as a change to the
template, so it came back as a template proposal, or as "that leaves the template as it is". A wrong value is not a
wrong template: the template may read every other record right, and only the researcher knows this value.

Results already has the operation such a message needs. A Review Decision is a revisioned correction of one saved
value: typed, checked against its producing field, refused when a newer correction overtook it, and saved in a
numbered Decision Version. Only the researcher's decision approves or changes a value (product contract, *Evidence
and review*), so the model may propose a correction but never save one.

## Decision

- **One more intent, the same in every state.** The classification (0034) reads a seventh intent, `correct`: the
  message says particular extracted values are wrong, or asks to change, fill in or remove them. A message that says
  how a field should be read from now on, or for every value, stays `edit`. The intent is not offered or withheld by
  state: Studio decides what it does where it is, so a request to correct is never misread as a template change
  because the state left `correct` out.

  | State | `correct` |
  | --- | --- |
  | Before the first template | "There are no results yet", and nothing else |
  | A template, no result shown (or Results shows one read-only) | "This document has no results to change yet" |
  | Results shows a result | the changes proposed, as a step |

- **A second request proposes the changes.** On `requested`/`correct` the page sends the message, with the
  conversation before it, to `POST /api/result_chat` for the Extraction Results shows, at the snapshot it shows (else
  the latest). The handler checks ownership and pins the snapshot and Decision Version; the `proposeResultCorrections`
  workflow (`correct:<operation_id>`) reads that snapshot's saved values and the pinned source's Markdown outside any
  step, and asks the chat's general route (the Schema Suggestion Route, or the Interaction Route beside NuExtract) in
  one step. The model reads each saved value as Results shows it (the researcher's decision applied), under an alias
  (`v1`, `v2`…), with its record, field, type and quote, up to a 40,000-character table, and the source as the
  Schema Suggestion request reads it. It replies with edits and rejections of named aliases, and a sentence for the
  researcher.
- **Studio checks every change before showing it.** An alias not listed, an edit that does not fit its field
  (`correctionValueFits`, as the save checks it), a second change to one value, or a change that leaves the value as
  it is is left out; what was left out is said. No value is saved by the workflow.
- **The researcher saves them.** The changes show on their values in Results, as a proposed template change shows in
  the Template view: the value as it is struck through in red, what it would be in green (a missing value filled in
  shows only the green; a rejection strikes the value and says *rejected*). A proposal opens Results unless it is
  already shown, and there shows every value, opens each changed value's record and brings the first change into
  view. The chat's *Change results* step only counts them ("Save N changes?"), with *Save*, *Discard*, and the
  composer; saving or discarding clears the marks. Saving goes through Results' own correction save,
  one value at a time, with the revision the proposal read, no Evidence and `included: true`; a change a newer
  correction overtook is refused and said, the others stay saved, and the result is read again. A "yes" beside the
  step saves them as the option does. Setting the step aside unsaid discards them; saying something else instead
  only sets it aside.

## Consequences

- A correction from the chat is an ordinary correction: Results, History, review counts, finalization and exports
  read it as any other. It carries no Evidence. An
  edit guides later Extractions in the project as an edit made in Results does (a rejection guides none): only the
  value the researcher saved and its source context, never the chat's text or the model's reasons.
- A wrong value costs two model requests (the classification, then the proposal); a misread `correct` costs a step
  the researcher discards, never a saved value.
- Values past the table's budget cannot be changed from the chat; Results still can. Rows are listed in result order,
  so on a long Catalog the later records may be the ones left out.
- With NuExtract and no Assistant model beside it there is no classification, so no `correct`: Results remains the way
  to change a value.
- A message that asks for a value to be read again from the source, rather than set, is answered from the excerpted
  source in the same request; re-running Extraction for a field whose reading is wrong everywhere stays a template
  change and a run.
