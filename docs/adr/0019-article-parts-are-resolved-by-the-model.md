# 0019: An Article's separately read parts are resolved by the model

Date: 2026-10-11. Status: proposed; amends
[0018](0018-value-disagreements-stay-saved.md) (FREE picks no winner).

## Context

A bounded Article asks every value context for the whole document root. A part
without the document's own value answers from what it alone shows: a cited
work's title and year from the bibliography, a section heading as the title,
a running header's author names and page numbers. Measured on nine journal
articles read in 12,288-token parts, with a corrected record description:
1 of 9 titles survived, 37 author items were running-header duplicates and 21
were foreign, every one linked to evidence by grounding. With a stale
reference-entry description, foreign author items reached 386. The same
articles read in one call were correct. A document longer than one call, any
book among them, could not be read in one call at all: the full default failed
with `article_root_unanswered`.

0018 kept every disagreement for the researcher and rejected model
arbitration. On long sources that leaves most places empty and every list
contaminated, and the researcher who owns the product chose to let the model
settle what it can.

## Decision

- **A document too long for one root call is read in bounded parts** of the
  served context instead of failing; the run records `context_fallback`.
- **Whenever the source was read in parts and any part answered, one
  reasoning call per batch of places resolves them** (`resolution.resolve`),
  even when a single part answered: that part may be the bibliography. It is
  shown the document's opening (so it knows which document is its own), each
  place's readings with the pages and source text each was read from, and the
  record and field descriptions; an item equal to an earlier one in its list
  is marked as such. For a scalar it answers a reading, NONE (no reading is
  the document's own, including when the opening states a value no reading
  matches) or UNSURE. For a list it returns the items that belong to the
  document's own list, leaving out another work's or entity's item and the
  same thing printed again (a running header, a repeated byline); equal values
  that describe different things (two finds of one material) stay separate
  items. A scalar read alike by several parts is not
  asked; one read by a single part is, so a cited work's value cannot pass
  alone.
- **What the model settles is a model value**, marked not checked like any
  other; its alternatives and dropped items stay in the run's issues
  (`resolved_value`, `dropped_items`). **UNSURE, a failed call, or an answer
  outside its labels changes nothing**: the place stays a Value Disagreement
  and the list keeps every item, as under 0018.
- List resolution filters the assembled occurrences after overlap joins. Kept items
  retain their original reply coordinates, including nested positions; overlap
  diagnostics follow their retained indices. A failed resolution stays visible in
  attempt-local failure history, is recoverable, and never changes Pause or Stop
  intent sent by the researcher.
- A long list is resolved in parts of 60 items; a repeat across those parts is
  kept.

## Consequences

- `ARTICLE_VERSION` 12 (version 10 adds the context fallback). Replays of earlier artifacts (`fixed_upstream`) skip
  resolution, which they did not make.
- A run read in one call is unchanged: one part, nothing to resolve.
- The model can drop a list item that belonged to the document or pick a wrong
  reading. Unlike a Value Disagreement, a picked value reaches review and
  export as the answer; the issues keep what it replaced.
- Rejected: auto-picking without UNSURE (forces a choice the source does not
  settle), flagging foreign items without dropping them (the contamination
  still reaches review and export), and resolving by first, majority or
  grounding (grounding attests presence, not membership in the document).
