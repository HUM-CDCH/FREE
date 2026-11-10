# 0031: A value mark is placed from the source PDF

Date: 2026-11-10. Status: proposed; amends [0029](0029-article-evidence-locates-its-value.md) (Studio draws a
value mark; decides its open items "narrowing a mark to its value ... and the gate it must pass" and "narrowing
inside a table cell") and the Parsing Service's rule that Extraction reads canonical results only (it also reads the
run's own `input.pdf`, to place a box and for nothing else).

## Context

Every Evidence mark is its Evidence Anchor's block box ([0029](0029-article-evidence-locates-its-value.md)). The
block is usually a paragraph, and Humanities Researchers search it by eye for the value. 0029 saves where an Article
value prints in canonical text (`location`), and Catalog links carry `spans`; neither is drawn, because the removed
narrowing (`narrowBox`) found the quote by searching pdf.js's text layer and could mark the wrong text.

A span counts code points of the Parsing Service's text. That text is not the PDF's: line joins, hyphens, ligatures
and quotation marks differ. So a span cannot be applied to another reader's text without finding the value again,
and a check that the text under a mark equals the value does not help: `narrowBox` passed it every time and still
marked the wrong place.

Two sources of geometry were probed on the first 6 pages of 5 real PDFs (30 pages; the documents are not
redistributable, and the methodology and results are summarised in the pull request that adds this ADR):

- **Docling's own line and word cells at parse time.** Every segment's text aligned to its line cells (567 of 567).
  On one document a footer stamped on every page had its word cells one or two words to the right of the ink (seen
  on a rendered page); a second parser was needed to refuse them. Publishing the cells would also change canonical
  page files, whose readers forbid unknown fields, and reach only Source Documents parsed again.
- **pdfium's characters under the block's box, read when the link is made.** Every word of every aligned segment
  stood in for a value (15,748). The rule below placed 15,741. Where the result and Docling's word cell named
  different places, the rendered page showed pdfium on the ink.

The same rule was then run, read-only, over the deployed parse results (553 source PDFs, 6,781 pages, every token a
stand-in value). It placed 99.3% of 2,160,337 values in blocks read from the PDF's own text, 99.4% of 13,249 table
cells, and 80.1% of 97,778 values in OCR-read blocks on pages with a text layer; 164,418 values sit on OCR-read
pages with none. Placed boxes were also tested against the rendered page. On 88 scanned pages, 87 had 80 to 100% of
their boxes on ink and one, whose text layer is shifted against the image, under 10%; the same boxes moved one line
down or half a line up never reached 30% on any page. The module as written, image check included, then ran over a
second sample of the same results: it placed 99.2% of 1,148,150 values in blocks read from the PDF's own text, 99.3%
of 11,780 table cells, and 36,125 of the 38,941 OCR-read values its text rule could place; another 160,676 OCR-read
values print under no text layer that agrees with them.

For those, a second reader of the page image was then measured (amended 2026-11-10): Tesseract's word boxes on the
block's crop, aligned with canonical text. On 14 block crops of real scans from four works (8 on pages with no text
layer), 98 whole-word stand-in values had their ink marked on the pixels by readers who saw no prediction. The rule
below placed 52 (26 of the 56 on pages with no text layer): 50 covered at least 99% of their reference ink and no
ink outside it, and the two others were looked at on the pixels by an independent reviewer, who found the mark on
the value and the reference not. On 54 more crops (6 further blocks of those scans, 24 blocks of twelve native PDFs
rendered as images, and the same 24 degraded), it placed 101 of 162, each on the ink its reference names. Two
earlier rules placed a value on its other printing in constructed cases and were dropped: one took the one match
left in the second reading where the reader missed the first; one asked only that whole words spell the value
once, which two columns read in different orders, with words broken apart differently, defeat. The rule below
refuses both and every other constructed case (233 controls). The crops are not redistributable; the protocols,
fixed before each run, the independent review and the results are summarised in the pull request that adds this
amendment.

## Decision

A **value mark** is where a value prints on the PDF page: one box per printed line, or per printed word where it is
placed from the page image, inside its Evidence Anchor's box. The anchor's own mark is unchanged.

- **Placed when linked, in the Parsing Service, from the run's own PDF.** Where a link names the value's printing as
  code-point spans of its own segment, the linker reads the page of the run's `input.pdf` with pdfium and adds
  `value_boxes_pt`: boxes in PDF points from the top-left of the displayed page, as `bbox_pt` is. The PDF is the
  run's immutable source, verified by digest when the run was prepared. Nothing read from it changes a value, a
  link's anchor, a span or a status: it only places a printing that canonical text already located. This is the one
  exception to "Extraction reads canonical results only".
- **Which links.** A version 1 link's `location`; a version 2 link's `spans`; a version 3 link's `spans` when its
  support is `literal`. Every span must lie in the link's own segment. A cell link is placed inside its cell's box
  from the cell's own text. Not placed: a `supporting` passage (it does not print the value), an `input`-precision
  link (it has no box to draw in), a whole table, and anything on a rotated page. A table the OCR model read is
  always a whole table: only the PDF's own text yields cells (`transcription/native.py`).
- **Only where the printing and its surroundings print once.** The characters whose middle lies in the anchor's box,
  within 1 pt (every box of a block printed in several places), are compared with the segment's text after both are folded: no
  white space, hyphens or NULs, since two readers break lines differently; ligatures unfolded; one quotation mark.
  The value is placed only if its folded text with 8 folded characters on each side occurs exactly once among them.
  If that occurs more than once, the surroundings are doubled until it is unique or they are the whole text. Where
  the text ends before 8 characters, nothing else may print before, or after, under the box. No match, two matches
  or an unanchored edge leaves the link without boxes. The match is never a search for the value alone.
- **One box per printed line** where the PDF's characters place the value, from the boxes of the value's own
  characters (from the page image, below, one per printed word), and each must lie inside the anchor's
  box within 2 pt, or none is written. A link with several spans gets boxes only if every span is placed.
- **Scanned pages first through a text layer the page image confirms.** A block the OCR model read is placed the same
  way when the PDF carries a text layer that prints the value and its surroundings as the model read them. The
  position is then the text layer's, and some scans carry one shifted against the image. So the page is rendered and
  two things are required. The page must be in register: of the tokens its text layer places in OCR-read blocks, at
  least 20 can be judged and at least 80% lie on ink, with most of the nearby ink inside the box and a word gap beside
  each side edge. And each of the value's own boxes must lie on ink. A block counts as read from the PDF's own text
  only under the `native` or `hybrid` transcriber and with no crop; every other block is checked. A scan without a
  text layer, or a page with too few tokens to judge, is left to the page image.
- **Scanned pages from the page image, where no text layer places the value** (amended 2026-11-10). A block the OCR
  model read, of one box and not a table cell, that the rule above did not place is read once more, only for where
  its words print: its crop of the rendered page (the block's box and 2 pt around it, bordered in its own paper
  tone) goes to Tesseract, which returns words with their boxes. Canonical text stays the only text; the second
  reading changes no value, span or anchor. Both readings are folded as above and aligned whole, and the value is
  placed only if all of this holds:
  - every alignment of the two readings within one edit of the best maps the value and 8 folded characters on each
    side, unchanged, to the same characters of the second reading. A misreading away from the value is tolerated;
    one at it, beside it, or that could be shifted onto it is not; a text edge must be an edge of the reading;
  - the value is whole printed words in both readings, spelled alike character for character. A word's box says
    nothing of where a comma, a quotation mark, a hyphen at a line end or a syllable inside it ends, so a value
    that leaves any of them out keeps its block mark;
  - the value's folded letters occur once in the text and once in the reading, inside a longer word and across
    words included. Aligned text cannot tell two printings of the same letters apart when the two readers took
    the block in different orders, and a reader that breaks words apart differently can make a whole word of
    either, so a value whose letters repeat is never chosen by position;
  - the reading is in the order of its places: every word box lies in the crop, the words of a line overlap
    vertically, and the middles of the words rise along each line and of the lines down the crop. Each of the
    value's word boxes, grown by one pixel (a third of a point: Tesseract's boxes shave the outermost ink), lies
    inside the crop and clear of every other word's box. A touch between two boxes refuses the values beside it,
    not their block. Nothing here shows the block to be one column, which is why the letters must occur once.

  The mark is those words' own measured boxes, one per printed word, never split, joined or interpolated, at most
  64, their areas together under nine tenths of the crop's, and inside the anchor's box within 2 pt. Anything else
  leaves the block's mark: so do a block of more than 4,000 folded characters, a reading that fails or takes more
  than 30 seconds (it is not tried again), and a block not yet read when less than 30 of a placement call's 120
  seconds are left. The reason counted is then the page image's, under `scan:`, in place of the text layer's.
  Without Tesseract and its four language models installed nothing is read and nothing else changes.
- **Checked again and drawn by Studio.** `EvidenceLink.valueBoxes` carries the boxes. Studio draws them for every
  placed value, the selected or hovered one stronger, inside the anchor's mark, and only if every box lies inside one
  occurrence of the anchor; otherwise it draws none. A block that holds a value mark recedes to a faint fill, so a
  page reads by its values without a selection. The anchor's mark stays the button and the accessible name; a value
  mark is a pointer shortcut that selects its own value, not announced. A block whose every value has a value mark
  takes no pointer, so each value has one pointer target; the keyboard still reaches the block. Studio still locates
  nothing by text
  ([0005](0005-parsed-document-v2-canonical-content-stream.md)).
- **Never shown to a model, written once.** The correction context strips the boxes as it strips `location`. The
  field is optional and additive: links with and without it are read alike, and no method version or DBOS patch
  guards it, as for `location` in 0029.
- **The gate.** Fast tests place values on PDFs generated in the test, whose positions the generator knows: a value
  broken by a hyphen at a line end, a paragraph in two columns, a repeated phrase, a value printed twice with the
  same surroundings, a ligature, a rotated page, a table cell, a page with no text, and scans whose text layer is
  in register, one line off and half a line off. A wrong box fails; a missing one fails only where the case expects
  one. For the page image, readings are laid out in the test, so every word's place is known: misreadings away
  from, beside and at the value, repeated values, two columns the readers took in different orders and broke into
  different words, touching and nested boxes, words and lines out of order, punctuation, quotation marks and a
  hyphen at a line end; the alignment is held to
  every alignment enumerated; and a scan with no text layer is placed with a stand-in reader and, where Tesseract
  is installed (the worker image, CI), with Tesseract itself. On real documents the check uses a reader the rule
  does not:
  every box is compared with docling-parse's word cells, and each disagreement is looked at on a rendered page. Its
  pass rule is no box on a place the page does not print the value. That check needs documents that cannot be
  committed, so its results go in the pull request.
- **Counted.** Each extraction logs how many links had spans, how many were placed and why the others were not.

## Consequences

- Canonical page files, manifests, parsed_document.v2 and their hashes are unchanged, and no Source Document is
  parsed again. A value gets a mark when a new Extraction links it; saved links are not rewritten.
- The mark covers the value's own characters, not its line or its whole token. From the page image it covers the
  value's whole printed words, and only a value that is whole words is placed.
- A value whose surroundings the two readers spell differently, beyond the fold, gets no mark. So does a value in a
  block whose box also covers a neighbour's characters at a text edge.
- Extraction opens the PDF for the pages its links cite, under the process-wide pdfium lock only while pdfium
  runs: once for the final result, and once more for each partial publication (an Article retain round, a finished
  unified Catalog entry). A page is rendered only where an OCR-read block is placed on.
- A rollback of Studio past this change refuses links that carry the boxes, as a rollback past 0029 refuses
  `location`.
- Printed Lines (0024) stay the way to narrow what the page image does not place. How their line boxes would reach
  a link written before they exist is not decided here.
- From the page image, coverage is partial by design. Not placed: a value beside punctuation its span leaves out,
  a part of a word, a word broken at a line end whose hyphen canonical text dropped, a value whose letters print
  again in its block (a short number inside a longer one), a value the two readers spell differently at or beside
  it, a block of several boxes, a table, a rotated page, and a block whose reading is out of order (2 of the 14
  measured crops). On those crops that left 26 of 56 whole-word values placed on pages with no text layer. What
  remains possible is what any reading of text allows: a reader that misses the value where it prints and reads
  the same letters, in the same surroundings, elsewhere. Not measured: values as researchers cite them (the saved
  Extractions audited hold no citation with spans on a page with no text layer), how often a cited value is whole
  words, a value of several words on real pixels (it is placed as the same per-word boxes), scripts and languages
  beyond the four models, and a block set in several columns under one box (constructed cases only).
- The worker image carries Tesseract 5 (Debian's, with its English, Danish, German and French models; the packages
  are not pinned), run as a process on one thread: 0.3 to 1.4 s a block on the measured crops, on the production
  host. Its output there was byte for byte that of the build the measurements used. A reading is kept in the
  worker's memory, by the crop's pixels, for the later placements of the same block (512 readings, the least
  recently used dropped first). Other languages are read with those four models and mostly refused.
- A mark from the page image is not deterministic as one from the PDF's characters is: a reading that fails, or a
  call that runs out of time after the worker dropped the reading, leaves a later placement of the same link without
  the mark an earlier one had. The snapshot that carries it is then another snapshot, never a conflicting one.
- What that leaves unmarked, counted on the deployed parse results on 2026-11-10 (576 results of 557 distinct PDFs;
  every token of an OCR-read block a stand-in value; pages counted per result): 125 PDFs carry no text layer on any
  page (612 pages, 171,908 values, none placed). Another 405 pages in 106 PDFs have too few tokens to judge: their
  OCR-read blocks are all crops, 383 pages with no text under them, and the text rule places 210 of their 14,820
  values, so a lower threshold would not help. 13 pages in 2 PDFs are refused as not registered. The 532 registered
  pages, in 18 PDFs, place 148,386 of 170,513 values. No table the OCR model read has cells (31 tables), so no
  OCR-read cell is ever placed.
- *Value mark* enters CONTEXT.md when this is accepted.
- Rejected: Docling's cells written to the page file at parse time (a canonical change, a new parse of every Source
  Document, and the one geometry the probe saw on the wrong words); the same cells from a second Docling pass after
  extraction (a layout model run per cited page that must reproduce the saved text); a mark on the whole line
  (coarser than the value, with no gain in safety once the value's characters are placed); narrowing in pdf.js's
  text layer (0029).
