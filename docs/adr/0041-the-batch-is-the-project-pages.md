# 0041: The batch is the project page's

Date: 2026-11-26. Status: accepted; supersedes parts of [0026](0026-the-chat-leads-the-whole-workflow.md).

## Context

The chat led the whole workflow (0026): the pilot, the approval, the batch, its review document by document, and the
export. A pilot and a batch answer different questions. A pilot asks whether the template is right, on a few
documents read closely against their source. A batch makes the dataset, often on many documents, where comparing a
field across documents and approving in bulk matters more than reading each one. Reviewing a batch one document at a
time from the chat did not scale, and the grid that does ([0030](0030-a-batch-review-grid-over-completed-members.md))
sat folded away under Runs & exports. The approval itself was asked in two cards: whether to try more documents (once,
before the first approval only), then whether to approve.

## Decision

- **The approval asks one question.** Both the approval and a re-approval ask "Is this template good for batch
  extraction?": *Yes* approves it; *No, try it on more documents* opens the documents not tried on this revision yet to
  tick, with their upload where the host can add documents, and a way back to the approval. A trial started from there
  is reviewed in the chat as any pilot is, and the approval asks again after it.
- **After the approval the batch is the project page's.** Its status says what is next and offers it: *Extract N
  documents* (the batch's preparation on the approved revision, ticking the documents it has no result for yet),
  *Review in grid* (the newest Batch Extraction with results left to review), *Export results…* (every reviewed
  document's newest reviewed result on the Current Template Revision, in one file), *Upload more documents*, and the
  way back to the chat to change the template. A changed template is approved again in the chat before the batch goes
  on.
- **The chat points there.** From the approval on, the chat's project step is one card that opens the project page:
  for the documents left to extract, the results left to review, a running batch, and a finished project (where the
  open document's own results and its run again stay beside it, since the chat is the only place to re-run one). A chat
  message asking to extract the project's documents is answered the same way; a run of the open document alone stays
  the chat's.
- **The grid fills in missing values.** A value the model found nothing for can be filled in from its cell, edited, or
  emptied again, as the document's review does (the same correction, bound to the value's revision).
- A batch document can still be opened from the grid, where its source is needed (choosing between different readings,
  checking a value against its highlight); the chat does not lead that review.

## Consequences

- Pilot rounds stay the chat's, document by document; the chat's review step never leads a batch.
- The chat's export step, and its export dialog in the document workspace, are gone: the project page exports.
- "Try more documents" is no longer remembered as answered: it is the approval's other answer, asked at every
  approval.
