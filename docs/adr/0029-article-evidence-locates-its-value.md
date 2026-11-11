# 0029: Article Evidence locates its value

Date: 2026-11-03. Status: proposed; amends [0024](0024-printed-lines-narrow-scanned-evidence.md) (a link's spans
include an Article link's `location`; Studio no longer narrows through pdf.js's text layer).

## Context

Studio boxed a segment link's mark to its quoted text when pdf.js's text layer showed it (`narrowBox` in
`useEvidenceOverlays.ts`), reading the quote only from `grounding.textSpans`. Only the recipe's (version 2) and the
unified Catalog's (version 3) links carry spans. An Article's links are version 1 (`Link` in `kie/extract/stages.py`):
the segment, its box, the cell when the box is the cell's, and no spans. So no Article mark narrowed: two values of one
paragraph are one paragraph-sized mark, and the researcher looks for each value inside it. Locating the value in
canonical text does not establish that its PDF mark is safe. The text-layer narrowing methods produced failures in
pre-registered automated checks: they can mark the wrong text. Those experimental verdicts remain provisional until
human adjudication; this change carries the location and keeps every mark at block level.

## Decision

A value's **printing** is one place where its text, or for a number one spelling of it, occurs in the source text.

- **Located when linked, in the Parsing Service.** When Article grounding links a value to its chosen candidate (a
  table cell, a `SourceSpan` or the whole passage), a helper opted into by Article alone locates the value in the
  passage's full text with `locate`'s `within` set to the candidate's range. The link gains
  `location = {spans: [{segment, start, end}], raw}`: one contiguous half-open code-point range of the link's own
  segment, and the text it covers. Before writing it the producer checks that its offsets lie inside the passage
  text and form one range of the link's segment, and that `raw` is exactly the text they cover; a location failing
  a check is not written. `link_json` writes no `location` key when there is none, so the generic Catalog's
  version 1 results are unchanged byte for byte.
- **Only a unique printing.** The value is located only when it prints exactly once in the candidate's range; no
  printing or several leave the link coarse, as does a value that does not occur in the text (often a yes/no, a label
  or a derived value). For a typed number, every numeric token in the range one of whose readings equals it is a
  printing, in these spellings: a decimal point or comma (`18`, `18.0`, `18,0` and `18.00` all print 18) and thousands
  separators (`1,000` reads 1 and 1000); a separator text extraction spaced (`0 . 02`, `0. 02`, but not the list `18,
  20`); a slash between digits (`1/2` prints 1 and 2); a digit, then one space, no-break or narrow space, thin space,
  `'` or `’`, then exactly three digits (`1 234` and `1'234` print 1, 234 and 1234; a tab, a line break or two spaces
  part two numbers); a `+` sign (`+42` prints 42); and an exponent (`1.8e1`, `1.8E+1`, `18e0`, `1.8×10^1`, `1.8 x
  10^1` and `1.8 × 10¹` print 18; `1.8 × 101` and `1.8 × 10-1`, perhaps a superscript text extraction lowered, read
  both ways: 18, 1.8 and 101, and 0.18, 1.8, 10 and 1; so a product such as `50 × 100` is never located on either). So
  18 printed once as `18` and once as `18.0` or `1.8e1` is not located, and 10 is never found in `210` or `10.5`. A
  token that is one of several numbers or may be (spaced, slashed or grouped), that a `+` sign precedes, that is an
  exponent form, or that a combining mark continues (`2005` and U+0338) counts as printed there but is never located
  on. A string of digits is found only as a whole number too, by the same rules in the shared numeric `locate` (no
  part of `± 0 . 02`, `1/2`, `1 234`, `+42` or `1.8×10^1`), though only its own spelling counts as a printing. That
  shared `locate` is also the Catalog's: `forms()` is unchanged, but the Catalog's and the unified Catalog's
  acceptance no longer find a number that is part of one of those tokens (`20` in `value 0 . 20`, `0,6` in `Wdg.
  0,6/0,7`, `7` in `SD 7 122`), nor text right after a combining mark that NFKC leaves uncomposed (it belongs to the
  word before). Where the quote prints the value only so, the Catalog reports `value_not_in_quote` instead of
  accepting it, and the unified Catalog, after trying the other cells of a quoted cell's row, reports
  `value_not_in_quote` or takes the quote as supporting for a derived field or one with allowed values. Where the
  quote also prints the value whole, that printing is taken, and a keyed field whose value follows its key only in
  such a form reports `key_context_missing`.
- **Local to the candidate.** `location` says where the value prints inside the passage or cell grounding chose. It
  does not change which candidate was chosen or `verbatim`. The repetition diagnostic retained here was later
  retired by [ADR 0033](0033-repetition-does-not-make-evidence-uncertain.md). A
  link to a whole table, not to one of its cells, is never located: the table's text holds its caption, which its
  box leaves out.
- **Beside grounding, not in it.** `plainEvidenceLink` projects it to `EvidenceLink.location` (`textSpans`, `raw`),
  never into `grounding`: grounding records how a value was accepted, which a version 1 link does not, and `location`
  would only refine how its anchor's box is drawn. Evidence is still located by its anchor's identity, as
  [0005](0005-parsed-document-v2-canonical-content-stream.md) requires, and a value's Evidence status is unchanged.
  The link readers on both sides accept it as optional and validate its shape; the evidence union's order is
  unchanged. Producer and readers share `apps/parsing_service/tests/fixtures/contracts/article-location-link.json`.
- **Carried, not drawn, by Studio.** Studio accepts and validates `location` but narrows no mark with it, nor with
  `grounding.textSpans`: every mark is its Evidence Anchor's block box, for every link version. Narrowing a mark to
  its quote in pdf.js's text layer (`narrowBox`) failed a pre-registered safety gate, since it can mark the wrong
  text, and is removed; how a mark narrows is decided separately. The Markdown view still marks whole anchors.
- **Never shown to a model.** The correction context (`modelEvidence` in `durable-feedback.ts`) strips `location`,
  so a drawing refinement never changes a prompt.
- **Written once.** A link is written with its saved value and never rewritten (`retained.py`). Locating it then
  keeps the location in the link's lifecycle, computed from the passage text it was linked to; a read-time locator
  (a Python sidecar, or a TypeScript port of `locate`) would locate against whatever text and code read it. The field
  is optional and additive, so no Article method version or DBOS patch guards it: this version's readers accept links
  with and without it. An attempt whose first links a worker from before it published, recovered by this version,
  reads its saved replies again and publishes the located links as new snapshots beside the old ones: a snapshot's
  identity follows its digest, so they never conflict (`test_durable_extraction.py`, on the in-memory coordination
  contract).

## Consequences

- An Article link carries a `location` only where its value prints once in the chosen passage or cell. No mark
  narrows yet: every mark, of any link version, is its anchor's block box, as before `narrowBox`.
- Extractions linked earlier carry no `location`. Nothing backfills: a value gains one only when a later run links it
  afresh; one a later snapshot carries unchanged keeps its saved links.
- Not decided here:
  - Narrowing a mark to its value, from `location`, `grounding.textSpans` or the PDF itself, and the gate it must
    pass.
  - Article `quoted` or `spans` grounding as the default, where values that are not verbatim or print several times
    could be located.
  - Printed Lines on scanned pages ([0024](0024-printed-lines-narrow-scanned-evidence.md), proposed): a `location`
    counts there as the link's spans once 0024 is built.
  - A table's caption: the parser inlines it into the table's text yet keeps the table's box without it, so a whole
    table's link is not located and a value printed in the caption has a mark that misses it until that box includes
    the caption.
  - Narrowing inside a table cell.
