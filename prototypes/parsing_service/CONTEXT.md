# Internal ingest and evidence vocabulary

Imported from kei-exp `93b9435`. This vocabulary describes the ingest/evidence
model under `src/kei_exp/kie/`; FREE's root `CONTEXT.md` defines product concepts.
The current processing boundary and HTTP contract are in [README.md](README.md).

The domain vocabulary of this project, and the evidence and ownership invariants the vocabulary exists to
protect. Read this before reading or writing anything under `src/kei_exp/kie/`.

This file is vocabulary, not design. How a stage computes anything lives in
[the KIE data model and stage 0 design](docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md)
and in the current service implementation. The terms below name the ingest
model and its artifacts.

In the ingest model, `crop` and `region` belong to the OCR stage's layout cut.
The extraction module (`kie/extract`) uses `Passage` for canonical parser
segments and `record` for an extracted occurrence under an Extraction Schema.

## The document and its images

**Spread** — one source PDF page: a scan of two facing book pages, made on a copier with the book open.
Spreads are numbered from 1 in PDF order.

**Page** — one book page, and the image stage 0 produces from a spread. Pages are numbered from 1 in reading
order: the left page of a spread, then its right page. Every segment bbox is expressed on a page. Everything
downstream indexes pages, which is why page numbering is an identity to be preserved, not a convenience.

**Gutter** — the x coordinate, in spread pixels, where a spread is split into two pages. The left page is
`[0, gutter)` and the right page `[gutter, width)`.

**Binding shadow** — the dark vertical band a copier records at the book's spine. It is the gutter's
signature: it is present on every scan of this document, whereas a clean blank band between the two pages is
not.

**Printed page label** — the number printed on the book page, such as `96`. It is not the Page number and it
is not ingest's business: a later stage reads it and records it in that stage's own namespace. The two can
disagree, and when they do, the printed label is evidence about the book while the Page number stays the
identity the pipeline uses.

## Evidence

**Segment** — one immutable piece of OCR evidence: text, plus a bbox on its page. Initially one source OCR
block. A segment is never rewritten by a later stage.

**Page file** — the OCR stage's accepted result of one PDF page, `ocr/pages/<n>.json` in KIE (`PageResult` in
`src/kei_exp/pagefile.py`): the units rendered, their crops with the recorded render transforms, and the page
segments in reading order. The one persisted parsing result: the evidence reader projects segments from it in memory.

**Result generation** — one immutable set of page files and their manifest, written by one OCR execution under
one recipe and named by an opaque id minted when it is first written; every page file names it, and the
manifest records every page file's hash and a digest over them. A rerun is another generation. The recipe
fingerprint identifies what was asked; the generation and its digest identify what was produced.

**Evidence reference** — where a segment came from: the generation, the PDF page whose file holds it, and its
position in that file's segment list (`EvidenceRef`). It resolves for as long as the generation exists.

**Source OCR block** — a page segment of a page file, before it becomes a segment. Its HTML and italics stay
resolvable from the page file through the segment's evidence reference, while the generation exists.

**Span** — a half-open character range `[start, end)` inside one segment's text, counted in code points.
Values, ownership and evidence are all spans. A value that crosses segments is a list of spans, never a
concatenated string.

**Page segment** — the same evidence as the OCR stage publishes it, placed on the PDF page (`PageSegment` in
`src/kei_exp/pagefile.py`): text and HTML as the engine gave them, the engine's box in image pixels, and that
box on the page through the recorded render transforms; its extent says whether the box is one engine block
or the whole input, which a transcriber without boxes leaves deliberately coarse. The evidence loader projects
`Segment` from it in memory; the two never carry different text.

**Input ordinal** — a transcriber input's 1-based position in what it was given: a crop number, or a position
in the selected page range. Adapters number their records and events by it. **Source identity** — the PDF page,
unit (the page itself, or a book page of the ingest) and crop an ordinal names; the OCR stage maps one
to the other (`ocr.inventory`).

## The catalogue

**Entry** — a numbered catalogue record in the book. `entry_label` is the number as printed: `31`, `31a`.

**Entry identity** — the pair of the leading number and the suffix: `31` is `(31, "")` and `31a` is
`(31, "a")`. They are two different entries, not one entry recorded twice, so uniqueness is checked on the
pair. Comparing entries by the leading number alone would collide them and silently lose one.

**Block** — an entry block: the unit of extraction, one per entry. A block owns primary spans and sees
context spans.

**Primary span** — text the block owns. **Context span** — text the block only sees, as overlap, so that a
value split across a boundary can still be read.

**Heading event** — a `Bezirk` or `Kreis` heading, anchored to the spans that are its evidence. Its position
is its first span; there is no separate index. A new Bezirk clears the current Kreis (see the invariants
below).

**Continuation** — a block that crosses a column boundary or a page boundary. Nothing else is a
continuation: an entry that merely runs over several paragraphs inside one column is not one.

## The pipeline

**Stage** — one module with a `run(...)` that writes only its own namespace. Ingest writes the book-page images;
OCR runs the transcriber and writes the canonical page files.

**Artifact** — a stage's JSON output file, holding that stage's namespace alone. **Envelope** — the
artifact's header, recording what the stage was and what it was run on. **Fingerprint** — a hash of a
stage's inputs, which decides whether the stage can be skipped. **Digest** — a hash of a stage's produced
namespace, which is what a downstream consumer binds to; the OCR recipe binds to the ingest digest.

**Document** — the whole document as the pipeline sees it, assembled from the ingest artifact and the
evidence read over it, and never persisted as one file. **Source** — the identity of the PDF a Document was
built from.

**Run** — as a type, in ingest: a maximal stretch of consecutive spread columns that are all blank or all
dark; the gutter is chosen from runs. `Run` in code is always this one. In prose, "a run" is one execution
of the pipeline — what `kie run` does, named by a **run id**, writing into a **run directory** and producing
a **run report** — and the two never collide, because the execution has no type of its own.

## The invariants these names protect

1. **Segment text is immutable.** Every span in the document indexes it, so a normalised, dehyphenated or
   otherwise cleaned reading is a separate view with a mapping back to the original offsets. Rewriting the
   text would move every span that points into it.

2. **Ownership belongs to primary spans.** The primary spans of two different blocks never overlap, while
   context spans may overlap anything, including another block's primary spans. So "who owns this text" has
   exactly one answer and "what could this block see" has a wider one, and the two questions never have to
   be confused.

3. **Not every character is owned.** Headings, the glossary and running heads legitimately belong to no
   block. Unowned text is therefore a diagnostic worth looking at, not a validation failure.

4. **Evidence is a span, not a quotation.** A value carries the segment and the offsets it came from; its
   string is derived from those and can always be re-derived. A value that cannot be pointed at is not
   grounded.

5. **Evidence that cannot be placed is recorded, not dropped.** A rejected entry-start candidate, or a
   source OCR block that cannot belong to one page, goes to an explicit list with its locator and a reason.

6. **A new Bezirk clears the current Kreis.** Bezirk and Kreis are a two-level hierarchy, so a Kreis is only
   meaningful under the Bezirk it appeared beneath. Carrying the previous Bezirk's Kreis across the boundary
   would attach every entry of the new Bezirk to a district it is not in. A new Kreis replaces only the
   Kreis.

7. **`31` and `31a` are distinct entry identities**, and each inherits its own heading state. Uniqueness,
   completeness checks and any deduplication work on the pair, never on the leading integer.

8. **A continuation is a boundary crossing**, and it is the reason a single block's spans can sit on two
   pages or in two columns. It is also why a block's first or last field may be completed by evidence the
   block does not own.
