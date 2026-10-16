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
  is marked as such. A reply names no position, so a value printed several
  times in its part is shown at each place with its count, never as one
  occurrence, and is matched only as a whole word or number (10 is not the 210
  of a cited study); equal items those places do not tell apart are kept. For a scalar it answers a reading, NONE (no reading is
  the document's own, including when the opening states a value no reading
  matches) or UNSURE. For a list it answers every item with the work or entity
  its source gives the item to, copied as printed, the shortest excerpt that
  names it (`of`, empty when none is), then its label: OWN, OTHER (another
  work's or entity's item), UNSURE (the item's own abstention; since version 14
  a list has none of its own) or REPEAT, offered only for an item equal to
  another in its list or, since version 15, for a string that is a form of
  exactly one earlier value in its list part (`_form_of`: the same words case,
  accents and punctuation aside, or that value shortened, its last word kept,
  its first kept or cut to its initial, at least one word cut: a running
  header's "A. LOVELACE" after the byline's "Ada B. Lovelace"), marked as such;
  the earlier value is never offered REPEAT for it, so the byline keeps its
  place. REPEAT is the same thing printed again (a running header, a repeated
  byline), which leaves only beside an equal item, or the earlier value a form
  is of, labelled OWN (that copy stays) or OTHER (a repeat of another work's
  item is that work's too). **An item labelled OTHER leaves only when its
  `of` is printed in the part it was read from** (whole words, case and spacing
  aside; since version 15 an `of` that reached its 100-character limit only up
  to its last word, after a trailing comma, period, colon or semicolon, which
  may be a printed word's first letters when it and they are letters only);
  otherwise it stays, and it and every UNSURE item are
  named for review (`uncertain_items`, at their kept indices, with the label
  and `of` given). A bare label decided too much: on the PR #275 corpus the
  first own item's call was a near-tie (P(OTHER) 0.55 to 0.73, thinking off),
  and once it was another's every later item followed (0.88 to 1.0), so one
  paper lost its whole own list in both model configurations; partial and
  method-only readings of own samples were called another's too. Every
  genuinely cited item removed had its citation printed beside it. Each item
  is shown with 160 characters of source on each side, so such a citation is
  in view. An answer leaving an item unlabelled changes nothing.
  Equal values that describe different things (two finds of one material) stay
  separate items, and two readings of one own item that differ (one part read a
  sample's temperature, another its imino content) are both kept: neither is a
  repeat. Each item is shown whole, without its empty fields, where its least
  printed value is. A scalar read alike by several parts is not
  asked; one read by a single part is, so a cited work's value cannot pass
  alone.
- **What the model settles is a model value**, marked not checked like any
  other; its alternatives and dropped items stay in the run's issues
  (`resolved_value`, `dropped_items` with each item's `of`). **UNSURE, a failed or
  raising call, or an answer outside its labels changes nothing**: the place stays a Value Disagreement
  and the list keeps every item, as under 0018.
- List resolution filters the assembled occurrences after overlap joins. Kept items
  retain their original reply coordinates, including nested positions; overlap
  diagnostics follow their retained indices. A failed resolution stays visible in
  attempt-local failure history, is recoverable, and never changes Pause or Stop
  intent sent by the researcher.
- A long list is resolved in parts of at most 60 items, fewer when its whole
  items do not fit one request, so it is never left unresolved for its
  length alone (version 13); a repeat across those parts is
  kept and stays named (`possible_repeated_items`, at its kept indices), since
  its copies were never shown together. A form and its earlier value in
  different list parts are never compared: the form stays, unnamed.

## Consequences

- `ARTICLE_VERSION` 12, 13 for token-sized list parts and repeats of
  OTHER items, 14 for attributed list answers, and 15 for cut attributions and forms (version 10 adds the context
  fallback). Replays of earlier artifacts (`fixed_upstream`) skip resolution, which they did not make. A version 12,
  13 or 14 artifact is refused and must be run again: version 13 sizes, counts and decides its list parts
  differently, and versions 14 and 15 each ask and decide list items differently. Saved snapshots and captured calls
  are never rewritten: an unchanged request reuses its capture, a changed resolution request is captured anew, and a
  planning result already checkpointed keeps the behaviour it was recorded with.
- Version 15 came from an Article QA run read in three parts: the byline's authors were kept, and so were the
  first author's running-header initials (REPEAT was offered only to equal items) and a cited reference's three
  authors, labelled OTHER with an `of` that reached the 100-character limit and ended in a mark the source does not
  print there.
- What the runtime guarantees: an item leaves only labelled OTHER with an `of` printed in its part (one at its
  length limit: up to its last word), or as a REPEAT beside an equal item, or the one earlier value it is a form
  of, labelled OWN or OTHER (never beside UNSURE alone); every item that leaves is in
  `dropped_items` with its `of`, and every OTHER item kept and every UNSURE item is in `uncertain_items`. What
  rests on the model's judgment: whose a printed work is. The guard checks only that the work is printed in the
  item's part, not that it is this item's, so an own item given a neighbouring item's citation, the document's
  own title printed in a running header, or a borrowed method's citation leaves when labelled OTHER. A printed
  citation is never evidence that an item is another's; another work's item whose part does not print its work
  stays, marked for review. At its length limit an `of` whose last word is the start of a printed one counts as
  printed, so "Smith" there names "Smithson". Whether a form is its earlier value printed again or another
  person with the same initial is the model's call; an earlier value labelled OTHER anchors its form even when its
  own attribution failed and it stays, marked. Each list item's answer
  reserves room for its `of`, so list parts hold fewer items.
- A run read in one call is unchanged: one part, nothing to resolve.
- Review shows `uncertain_items`, `dropped_items` and `resolved_value` from the run's completion snapshot
  (`coverage.diagnostics`), each at its field and, for an item kept, its kept index; they belong to that
  snapshot only, so the results of a later attempt that names none show none.
  An invalid list reply also names its field in `resolution_not_applied`; review states
  “assembled values retained; resolution not applied.” Failed calls and over-budget resolution
  requests show the same fallback with their reason. Reply validation and retained values are unchanged.
- The model can drop a list item that belonged to the document or pick a wrong
  reading. Unlike a Value Disagreement, a picked value reaches review and
  export as the answer; the issues keep what it replaced.
- Rejected: a list answer naming the items to keep (an item the model omits is
  lost, and a second reading of an own item reads as a repeat), and one naming
  only the items to leave out (the model sometimes named the items that
  belong, which then all left),
  auto-picking without UNSURE (forces a choice the source does not
  settle), flagging foreign items without dropping them (the contamination
  still reaches review and export), and resolving by first, majority or
  grounding (grounding attests presence, not membership in the document).
