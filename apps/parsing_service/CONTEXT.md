# Internal ingest and evidence vocabulary

The vocabulary of the ingest and evidence model under `src/kei_exp/kie/`, and the evidence and ownership
invariants it exists to protect. Read this before reading or writing anything under `src/kei_exp/kie/`. It names
terms only. How a stage computes anything lives in
[the KIE data model and stage 0 design](docs/design/2026-09-14-kie-model-and-ingest-design.md) and the code; the
processing boundary and HTTP contract live in [README.md](README.md), product concepts in FREE's root
`CONTEXT.md`. `crop` and `region` belong to the OCR stage's layout cut; the canonical passage view
(`kie/passages.py`), shared by the recipe stages and extraction, calls a canonical segment a `Passage`; the
extraction module (`kie/extract`) uses `record` for an extracted occurrence under an Extraction Schema.

## The document and its images

Spread, Page, Gutter and Binding shadow belong to the ingest stage, which runs only for `page_source=ingest`.

**Spread** — one source PDF page: a scan of two facing book pages, made on a copier with the book open.
Spreads are numbered from 1 in PDF order.

**Page** — one book page, and the image the ingest stage produces from a spread. Pages are numbered from 1 in
reading order: the left page of a spread, then its right page. Downstream a Page is the `unit` its segments were
read in, which is why page numbering is an identity to be preserved, not a convenience. Page files, segment boxes
and evidence references index the PDF page, which both Pages of a spread share.

**Gutter** — the x coordinate, in spread pixels, where a spread is split into two pages. The left page is
`[0, gutter)` and the right page `[gutter, width)`.

**Binding shadow** — the dark vertical band a copier records at the book's spine. It is the gutter's
signature: on the catalogue the ingest was measured on it is present on every scan, whereas a clean blank band
between the two pages is not.

**Printed page label** — the number printed on the book page, such as `96`. It is not the Page number and it
is not ingest's business: a stage that reads it records it in its own namespace. The two can disagree; the
printed label is then evidence about the book, and the identities stay the Page number and the PDF page.

## Evidence

**Segment** — one immutable piece of evidence: text, plus its box on the PDF page and the unit it was read in.
A segment is never rewritten by a later stage.

**Page file** — the OCR stage's accepted result of one PDF page (`PageResult` in `src/kei_exp/pagefile.py`),
`pages/<n>.json` under the result directory: `<run>/result/pages/<n>.json` for a worker run,
`<--result-dir>/pages/<n>.json` for the CLI. It holds the units rendered, their crops with the recorded render
transforms, and the page segments in reading order. The one persisted parsing result: `kie/passages.py`
projects passages from it in memory.

**Result generation** — one immutable set of page files and their manifest, written by one OCR execution under
one recipe and named by an opaque id minted when it is first written; every page file names it, and the
manifest records every page file's hash and a digest over them. A rerun is another generation. The recipe
fingerprint identifies what was asked; the generation and its digest identify what was produced.

**Evidence reference** — where a segment came from: the generation, the PDF page whose file holds it, and its
position in that file's segment list, named `p{page}_s{index}`. It resolves for as long as the generation exists.

**Source OCR block** — one block of the transcriber's output, before it becomes a page segment. Its HTML and
italics stay resolvable from the page file through the segment's evidence reference, while the generation exists.

**Span** — a half-open character range `[start, end)` inside one segment's text, counted in code points.
Values, ownership and evidence are all spans. A value that crosses segments is a list of spans, never a
concatenated string.

**Page segment** — a segment as the OCR stage publishes it, placed on the PDF page (`PageSegment` in
`src/kei_exp/pagefile.py`): text and HTML as the engine gave them, the engine's own box, and that box on the
page through the recorded render transforms; its extent says whether the box is one engine block or the whole
input, which a transcriber without boxes leaves deliberately coarse. Extraction reads it as a `Passage` in
memory; the two never carry different text.

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

**Heading event** — a heading of one of the recipe's kinds, at that kind's level (1 the outermost), anchored to
the spans that are its evidence, such as the `bezirk` (level 1) and `kreis` (level 2) headings of
`numbered-catalogue-de`. Its position is its first span; there is no separate index. A heading clears every deeper level (see the invariants
below).

**Continuation** — a block that crosses a column boundary or a page boundary. Nothing else is a
continuation: an entry that merely runs over several paragraphs inside one column is not one.

## The pipeline

**Stage** — one step of the pipeline, owning its own namespace. Ingest and OCR are modules with a `run(...)`
that writes only that namespace: ingest the book-page images, OCR the canonical page files. The recipe stages
(`kie/stages/{layout,route,segment}.py`) are pure functions over canonical evidence; `kie/segmentation_run.py`
reuses their validated segmentation or computes and publishes it.

**Artifact** — a stage's JSON output file, holding that stage's namespace alone. **Envelope** — the
artifact's header, recording what the stage was and what it was run on. **Fingerprint** — a hash of a
stage's inputs, which decides whether the stage can be skipped. **Digest** — a hash of a stage's produced
namespace, which is what a downstream consumer binds to; the OCR recipe binds to the ingest digest.

**Source** — the identity of the PDF an ingest artifact was built from.

**Run** — as a type, in ingest: a maximal stretch of consecutive spread columns that are all blank or all
dark; the gutter is chosen from runs. `Run` in code is always this one. In prose, "a run" is one parse
execution, named by a **run id** and writing into a **run directory** — and the two never collide, because
the execution has no type of its own.

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

6. **A heading clears every deeper level.** Heading levels are a hierarchy, so a deeper heading is only
   meaningful under the heading it appeared beneath. In `numbered-catalogue-de` a new Bezirk clears the current
   Kreis: carrying the previous Bezirk's Kreis across the boundary would attach every entry of the new Bezirk
   to a district it is not in. A heading replaces its own level and keeps the shallower ones; a section
   heading clears every level.

7. **`31` and `31a` are distinct entry identities**, and each inherits its own heading state. Uniqueness,
   completeness checks and any deduplication work on the pair, never on the leading integer.

8. **A continuation is a boundary crossing**, and it is the reason a single block's spans can sit on two
   pages or in two columns. It is also why a block's first or last field may be completed by evidence the
   block does not own.
