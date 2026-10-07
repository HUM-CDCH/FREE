# Ingest plan: layout-aware cuts and resolution control

Imported from kei-exp `93b9435c2b9a01a5424758d917c058fc79bbc159`. This document
retains the original internal design or measurements. The service README and
FREE root deployment runbooks govern the current runtime and verification commands.

Measured 2026-09-13 on `Bauer1988_GAC_02_Catalogue7.pdf` (one spread) with the
installed Docling 2.126.0 and pypdfium2 5.13. Implemented the same day in
`src/kei_exp/cut.py` (`--cut auto`, the default, and `--crop-dpi`); the
deviations from the sketch are listed at the end.

## Measurements that drive the design

| Fact | Value |
|---|---|
| Source scan | 1-bit gray, 600 dpi, 9928 x 7016 px (70 MP) on a 1191 x 842 pt A3 page |
| Docling layout model (Heron) on the whole spread, no OCR | 48 blocks, 1.2 s warm; x-gaps found at 0-86, 320-329, 563-653, 887-896, 1130-1191 pt: margins, two column gaps, gutter |
| Same model on each half as a PNG | 25 and 23 blocks, 0.5 s each; column gaps found again |
| Model input | RT-DETR, everything is resized to 640 x 640; input resolution beyond that is wasted |
| Text size, column 1 | line pitch 44 px at 300 dpi (about 8 pt type). x-height: 15 px at 300 dpi, 10 px at 200, 7 px at 150 |
| Render cost from the 600 dpi source | 0.5 s at 300 dpi, 0.2 s at 200 dpi (pdfium, anti-aliased) |
| Content area | x 86-1130, y 57-752 pt: 73 % of the page; 27 % of pixels are margins, gutter and scanner border |

Tokens per image, from `scratch/*/report.json`:

| Model | Prompt tokens | Rule |
|---|---|---|
| Nanonets-OCR2-3B | 5258 for 2382 x 1684 | pixels / 784 + about 70 |
| Infinity-Parser2-Flash | 4210 for 2382 x 1684 | pixels / 1024 + about 300 |
| Granite-Vision 4.1, Granite-Docling | 1156 / 877 at every size | fixed grid; more pixels add nothing, cropping is the only resolution lever |

## Cut detection: recursive X-Y cut on layout boxes

Docling's layout model is the layout-aware pass. It runs on the page image, so it
works on scans without OCR, and it is already installed and cached.

1. **Render once, small.** Render the source page at 100 dpi, 8-bit gray, with
   pypdfium2. Trim scanner borders first: rows or columns with more than 50 % ink
   at the page edge. Never pass the PDF itself to the layout step: that path
   decodes the 70 MP image at 1.5x scale (1.2 s instead of 0.5 s).
2. **Blocks.** `PdfPipelineOptions(do_ocr=False, do_table_structure=False)` with
   `layout_options.keep_empty_clusters=True` (without it, text blocks with no
   OCR cells are deleted). Read `res.pages[0].predictions.layout.clusters`:
   label, confidence, bbox in page points. Ignore `page_header` and
   `page_footer` for cutting; they sit in margins and page numbers would
   otherwise close the outer gaps.
3. **X cut.** Sort blocks by `l`, merge x-intervals, list gaps wider than a
   threshold (6 pt; the column gaps here are 9 pt). Cut at the widest gap first;
   a gap wider than 40 pt near the centre is a gutter, so its two sides are
   pages. Recurse into each side with the blocks it contains until no gap
   remains. Depth 2 gives pages then columns.
4. **Y cut.** Same on `t`/`b` inside each x-region, for figure-plus-caption or
   header-plus-body regions. Skip when the region is plain text (only `text`,
   `list_item`, `section_header` blocks).
5. **Snap.** Move each cut to the midpoint of the widest ink-free run of the
   100 dpi profile inside the gap. Boxes jitter by a few points; ink does not.
   Not `argmin` of a smoothed profile: on a 90 pt gutter the valley is a
   plateau and `argmin` returns its left edge, against the left page's text.
   No ink-free run inside the gap means box and profile disagree: fail the page.
6. **Order.** Regions left to right, then top to bottom, pages before columns.
   Emit per source page: `regions[] = {kind: page|column|figure, bbox_pt, order}`.
7. **Self-checks** (fail the page, do not guess): every block lies inside exactly
   one region; 1 or 2 pages per source page; column widths within 15 % of the
   document median; region count per page equal to the document mode or flagged.
   Golden test: this spread gives 4 regions with x-cuts near 324, 608 and 891 pt.

If a page yields one region and its ink profile shows no wide gap either, it is a
single page: pass it through. Skew shows up as vanishing profile gaps while the
blocks still separate cleanly, so the block cut is the primary signal and the
profile only refines it. Deskew is not planned until a document fails step 7.

VLM models need the column cut: smaller output per call ends the repetition
failures seen on the whole spread, and for the Granite family it is the only way
to give the fixed token grid more pixels per character.

Surya OCR 2 (surya-ocr 0.22.1) gets the same crops. Its client scales every
request image to fit an area of 3072 x 2048 px (`scale_to_fit`, by area, not
by edge): the 192 dpi spread (3176 x 2245) is shrunk 0.94x, a 250 dpi column
crop (860 x 2400, 2.1 MP) passes unscaled, and one column needs about a quarter
of the spread's 13k output tokens, well inside the full-page output cap (Surya's
default 12,288; the CLI raises it to 16,384). Overflow is silent: Surya ignores
`finish_reason`, so a truncated page comes back error-free at full confidence,
which is what the whole Bauer spread did at the default cap. Its own block mode
(`LayoutPredictor` result passed to `RecognitionPredictor`, one request per
block, 4 px padding) would also avoid the downscale, but its reading order
across a gutter is unverified and it is Surya-only; the shared cut serves every
model.

## Resolution: keep characters, drop pixels

Rules, in order of leverage:

1. **Crop before scaling.** 27 % of this page is margin, gutter and border.
   Crops come from the layout regions, with 4 pt padding.
2. **Choose dpi from x-height, not from bytes.** Floor 12 px, comfortable 15 px
   for the smallest body text in the crop. Measure at ingest: row ink profile of
   one text region gives line pitch and x-height in a few lines of numpy. For
   this 8 pt catalogue that means 250-300 dpi; an 11 pt book needs about 200.
   Store the measurement in the run report.
3. **Resample once, by area.** The source is bilevel; anti-aliased gray from
   averaging (pdfium render at the target scale, or `Image.reduce(k)` on the
   extracted bitmap) is better OCR input than the raw 1-bit pixels. Never
   nearest-neighbour, never re-binarize, never upscale.
4. **No second resampling downstream.** Save crops as 8-bit gray PNG with
   `dpi=(72, 72)` so Docling treats 1 px as 1 pt, run the VLM stage with
   `scale=1.0`, keep `--max-image-size` only as a safety cap. Docling's image
   backend otherwise LANCZOS-resizes again to `scale * dpi`.
5. **Budget with the token rule.** Column crop 235 x 675 pt:

   | dpi | Crop px | x-height | Nanonets tokens per crop / spread | Infinity per crop / spread |
   |---|---|---|---|---|
   | 300 | 979 x 2813 | 15 px | 3.5 k / 14 k | 2.7 k / 10.8 k |
   | 250 | 816 x 2344 | 12 px | 2.4 k / 9.8 k | 1.9 k / 7.5 k |
   | 200 | 653 x 1875 | 10 px | 1.6 k / 6.3 k | 1.2 k / 4.8 k |
   | today: whole spread at 145 dpi | 2382 x 1684 | 7 px | 5.3 k | 4.2 k |

   Output tokens per spread are unchanged; each call emits a quarter of them.
   Start at 250 dpi: same input cost as today, 1.7x the character height.
6. **Bytes on disk.** The 1-bit PDF is the smallest master there is (about
   1.5 MB per spread); keep it and re-render in 0.5 s instead of storing gray
   masters (5-8 MB per spread as PNG). Crops are run artifacts: gray PNG with
   `optimize=True`, or JPEG quality 90 when a run must be small. The API engine
   base64-encodes RGBA PNG whatever you feed it; irrelevant for local vLLM.

## Implementation sketch

- `src/kei_exp/cut.py`: `find_regions(pdf_path, page_no) -> list[Region]`
  (steps 1-7) and `render_crops(pdf_path, regions, dpi, out_dir) -> list[Path]`.
  About 80 lines, numpy plus Docling and pypdfium2 already installed.
- CLI: `--cut auto|pages|none` and `--crop-dpi 250`. With cuts on, convert the
  crop PNGs through `DocumentConverter.convert_all` with an `ImageFormatOption`
  carrying the same pipeline options, and join the Markdown in region order.
  The report writer (`src/kei_exp/report.py`) numbers pages across results.
- One check: `scripts/test_cut.py` asserts 4 regions and the three x-cuts on
  the Bauer page.

Skipped: deskew and dewarp (this scan needs neither); a second layout model;
PyMuPDF (AGPL, duplicates pypdfium2).

Implemented (2026-09-13), where it differs from the sketch:

- Cutting is a plain recursive X-Y cut: every x-gap at once (the gutter is just
  the widest of them), then, where a block covers at least 60 % of a region
  that has column gaps underneath it, y-cuts around that block and x again.
  Text is never y-cut at paragraph gaps. Kinds are `page` (no cut), `column`,
  `band` (from a y-cut) and `figure`. A box goes to the side of a cut its
  centre falls on, so none is dropped.
- Crop x-range runs toward the cuts but at most 8 pt past the blocks, so a
  text line the layout model missed at a column edge is still inside the crop
  while the gutter and the margins stay out. The y-range covers the leaf's blocks plus
  any running head or page number that fits between the cuts around it, so those
  are transcribed too.
  All sides get 4 pt of padding, clipped to the scanner-border trim.
- Snap profiles use only the rows spanned by the body blocks (the full-height
  profile finds no ink-free run: the scanner edge and running heads cross it).
- No column-width self-check: a single-column page beside a two-column page is
  a legitimate layout whose widths differ by half. A layout gap with no ink-free
  run remains the box-versus-profile check.
- No `pages` cut mode and no `scripts/`: the golden check is
  `scratch/check_cut.py` beside the other checks. Result on the Bauer spread:
  4 column regions, cuts at 323, 607 and 890 pt, crops of about 857 x 2400 px
  at 250 dpi; Surya through vLLM returns all entries 76-82 in 13,455 characters
  against 13,354 from the whole spread, with abbreviations such as
  `Einst.reihe` no longer broken at line ends.

Coverage and cut policy (2026-09-14): every region carries `ink`, its share of
the page's dark pixels inside the scanner border (shown in the region events,
the CLI region line and the debug report), and `_Page.policy(regions, coverage)`
has the final say on each page's cut, including pages where the layout model
found no body block. At or above 90 % page coverage, each column is also checked against
the ink in its vertical span between cuts. If its crop misses more than 3 %,
layout runs once on that column's full span; newly detected text can extend its
top or bottom while its x-cuts and neighbouring crops stay fixed. On Bauer
source page 6, page coverage was 94.2 % but column 2 covered only 85.3 % of its
ink, omitting the final paragraph. The column view recovers that paragraph.
Measured on the
45-page Bauer catalogue: median coverage 97 %, every page above 92 % except
source page 38, the two-column site index, at 39 %: a partial left column
(ink 24 %), a 192 x 18 pt two-line sliver (1 %) and a "figure" (15 %). The
sliver makes Surya OCR 2 loop until its token cap at greedy decoding (about
100 s) and the retry comes back without block markup, so its two lines are
dropped as well. Below 90 % coverage, the policy retries the same layout model
once on four overlapping views, each 60 % of the page's width and height.
These views give small text more of the model's fixed input resolution.
The additional boxes join the original detections, then the same X-Y cut and
ink-profile snapping run again. The index becomes two crops with the left
columns restored and no sliver. Keep the retry's crops only if coverage improves;
otherwise retain the original crops. The threshold triggers a retry, not a
failure: decorative rules and scan noise also count as ink. For example, the
first HA4-1 page covers all text at 86 % coverage; the excluded 14 % is a thick
rule above the heading. Finding no body blocks at either resolution still raises
`CutError`. Truly blank pages produce no crops and need no retry.

The cut pass defaults to **Heron-101** (`layout_heron_101`); the UI also offers
Heron and Egret XLarge. Each run uses its selected model for both the initial
layout and every column or tile retry, and records the choice in its parameters
and debug report. Only the most recently selected converter is cached.
The measurements above
describe the earlier default Heron model. Heron-101 detects the complete columns
on source pages 6 and 38 in its initial pass. The stricter column coverage check
also recovers short omissions on pages 28 and 41; five missing lines can still
leave a column above 90 % coverage. No model switch occurs during a run.
The CPU comparison (four threads, excluding model loading and PDF rendering)
measured about 1.8 s per Heron-101 pass versus 0.45 s for Heron. Egret XLarge was
faster at about 0.8 s but missed substantial content on page 37 of this catalogue.

## Alternatives considered (2026-09-13)

- **OpenCV darkness or projection profile first, layout boxes as fallback.**
  Rejected: two detectors and a confidence threshold between them, to save
  0.5 s per scan on a stage that costs 10-30 s per crop in the VLM. The profile
  also finds only gutters; the column cuts need the boxes anyway. The profile
  stays as the snap step and the disagreement check.
- **Surya text-line detector to infer the gutter.** Same information as the
  Docling boxes at line granularity. Surya's block mode already removes the
  need for a pre-cut on the Surya path, and the Docling layout model covers the
  other VLM paths without a server, so a second detector buys nothing.
- **DocLayout-YOLO.** A second layout model (AGPL-3.0, Ultralytics stack) for a
  job Heron already does on this material. Keep as the fallback if Heron fails
  a document class in the self-checks.
- **Custom YOLO or MobileNet gutter regressor.** Needs a few hundred annotated
  spreads; none exist. Revisit only after the box cut fails on a real corpus.
- **unpaper, ScanTailor.** Heuristic page splitters with deskew and border
  cleanup. unpaper fits the container if deskew becomes necessary; ScanTailor
  Spectre targets Apple Silicon and is out.

## Unsafe proposed gaps (2026-09-26)

One scanned map sheet exposed a layout gap crossing actual text on physical page 3. A gap with no ink-free
run is now rejected as a boundary: its adjacent boxes stay in one region, while other verified gaps still
split. Both axes recurse only when the accepted cuts make more than one group. This preserves the content
without inventing a cut or aborting the entire document. The earlier fail-page policy above records the
original implementation.

One report's last page contains only a footer (the page number). When layout finds no body after its
retry, but detected headers/footers account for at least 90% of the ink, the complete page is transcribed.
This retains the furniture and any remaining ink. Unexplained missing body content still fails explicitly.
