# Layout-aware cuts and crop resolution

How `src/kei_exp/cut.py` cuts a scanned page into crops for OCR, and at what
resolution. The figures below were measured on one A3 catalogue spread, a 1-bit
600 dpi scan, with Docling 2.126 and pypdfium2 5.13. The spread is not
committed: the tests read it as `scan.pdf` from `PARSING_FIXTURE_DIR` and skip
without it.

## Measurements that drive the design

| Fact | Value |
|---|---|
| Source scan | 1-bit gray, 600 dpi, 9928 x 7016 px (70 MP) on a 1191 x 842 pt A3 page |
| Layout boxes on the whole spread (Heron, no OCR) | 48 blocks; x-gaps at 0-86, 320-329, 563-653, 887-896 and 1130-1191 pt: margins, two 9 pt column gaps, a 90 pt gutter |
| Layout model input | RT-DETR; everything is resized to 640 x 640, so input resolution beyond that is wasted |
| Text size, column 1 | line pitch 44 px at 300 dpi (about 8 pt type); x-height 15 px at 300 dpi, 10 px at 200, 7 px at 150 |
| Render cost from the 600 dpi source | 0.5 s at 300 dpi, 0.2 s at 200 dpi (pdfium, anti-aliased) |
| Content area | x 86-1130, y 57-752 pt: 73 % of the page; 27 % of the pixels are margins, gutter and scanner border |

Input tokens per image of the VLM OCR models:

| Model | Rule |
|---|---|
| Nanonets-OCR2-3B | pixels / 784 + about 70 |
| Infinity-Parser2-Flash | pixels / 1024 + about 300 |
| Granite-Vision 4.1, Granite-Docling | fixed grid; more pixels add nothing, so cropping is the only resolution lever |

VLMs need the column cut: a smaller output per call ends the repetition
failures seen on the whole spread, and for the Granite family it is the only
way to give the fixed token grid more pixels per character.

## Cut detection: recursive X-Y cut on layout boxes

Docling's layout model finds the blocks. It reads the page image, so it works
on scans without OCR.

1. **Render once, small.** Render the page at 100 dpi in 8-bit gray and trim
   the scanner border: edge rows and columns that are more than half ink. The
   layout model gets this image, never the PDF, which it would decode at 1.5x
   the 70 MP source (1.2 s instead of 0.5 s).
2. **Blocks.** Docling runs layout alone (`do_ocr=False`,
   `do_table_structure=False`) on the CPU, with `keep_empty_clusters=True`:
   without it, text blocks with no OCR cells are deleted. `page_header` and
   `page_footer` blocks take no part in cutting; they sit in the margins, where
   page numbers would otherwise close the outer gaps.
3. **X cut.** Merge the blocks' x-extents and cut at every gap wider than 6 pt
   at once; the gutter is just the widest. Each block goes to the side its
   centre falls on, so none is dropped, and each group is cut again as a
   column.
4. **Y cut.** Only where a block at least 60 % as wide as the region's blocks
   together bridges columns underneath: cut above and below such blocks, then
   cut each band again. Text is never y-cut at paragraph gaps.
5. **Snap.** Each cut moves to the midpoint of the widest ink-free run (at most
   0.5 % ink) of the 100 dpi profile inside its gap, measured over only the
   rows or columns the blocks being split span; the full-height profile has no
   ink-free run, since the scanner edge and running heads cross it. Boxes jitter
   by a few points; ink does not. Not `argmin` of a smoothed profile: on a 90 pt
   gutter the valley is a plateau and `argmin` returns its left edge, against
   the left page's text. A gap with no ink-free run crosses printed content: it
   is not cut and its blocks stay in one region, while the other gaps still
   split. An axis recurses only when its cuts make more than one group.
6. **Regions.** Each leaf is a region of kind `page` (no cut), `column`, `band`
   (from a y-cut) or `figure` (a leaf with any block other than text, list
   item or section header), numbered in reading order: groups left to right,
   bands top to bottom, depth first.
7. **Crop box.** A crop runs toward the cuts but at most 8 pt past its blocks,
   so a line the layout model missed at a column edge is inside while the gutter
   and margins stay out. Vertically it covers the leaf's blocks plus any running
   head or page number between the cuts around it, so those are transcribed
   too. Every side gets 4 pt of padding, clipped to the scanner-border trim.

Every region records `ink`, its share of the page's dark pixels inside the
scanner border, and `_Page.policy` has the final say on each page's cut:

- At 90 % page coverage or more, each column is checked against the ink in its
  vertical span between cuts. If its crop misses more than 3 %, layout runs on
  two overlapping views of the column, each 60 % of its height, and newly
  detected text can extend the crop's top or bottom; its x-cuts and the
  neighbouring crops stay fixed.
- Below 90 %, layout runs once more on four overlapping views of the page, each
  60 % of its width and height, which give small text more of the model's fixed
  input resolution. The new boxes join the original detections, the same cut
  and snapping run again, and the retry's crops are kept only if they cover
  more ink. The threshold triggers a retry, not a failure: decorative rules and
  scan noise count as ink too.
- A blank page yields no crops. A page with no body blocks after the retry is
  transcribed whole, furniture included, when its detected headers and footers
  account for at least 90 % of its ink.

`CutError` is raised when no body blocks remain and the furniture does not
explain the ink, when nothing lies inside the scanner border, for an unknown
layout model, and for a page index or crop box the renderer refuses.

The cut runs Heron-101 (`layout_heron_101`) by default; Studio's **Page
regions** choice also offers Heron and Egret XLarge. A run uses its model for
the first pass and every column or tile retry, with no switch during the run,
and its recipe records the choice. On the measured catalogue, per CPU pass:

- **Heron-101**, the default, found complete columns where Heron missed them;
  about 1.8 s.
- **Heron** is the fastest, about 0.45 s, but missed column content.
- **Egret XLarge** takes about 0.8 s but missed substantial content.

Surya OCR 2 gets the same crops. Its client scales every request image to fit
an area of 3072 x 2048 px (`scale_to_fit`, by area, not by edge): the whole
spread at 192 dpi (3176 x 2245) shrinks 0.94x, while a 250 dpi column crop
passes unscaled. One column needs about a quarter of the spread's 13k output
tokens, well inside the full-page output cap. Surya ignores `finish_reason`, so
the adapter counts each request's output against its cap and marks a capped
input incomplete. Surya's own block mode would also avoid the downscale, but its
reading order across a gutter is unverified and it serves Surya alone; the
shared cut serves every model.

## Resolution: keep characters, drop pixels

Rules, in order of leverage:

1. **Crop before scaling.** 27 % of the measured page is margin, gutter and
   border. Crops come from the layout regions, with 4 pt padding.
2. **Size by x-height, not by bytes.** OCR wants an x-height of at least 12 px,
   comfortably 15 px, for the smallest body text in the crop. The worker
   renders crops at a fixed 250 dpi, which gives the 8 pt catalogue 12 px; an
   11 pt book would need about 200 dpi. The CLI's `--crop-dpi` changes it.
3. **Resample once, by area.** The source is bilevel; anti-aliased gray from
   averaging (pdfium rendering at the target scale, or area resampling of an
   ingest page) is better OCR input than the raw 1-bit pixels. Never
   nearest-neighbour, never re-binarize.
4. **No second resampling downstream.** Crops go to Docling as 8-bit gray PNG
   tagged `dpi=(72, 72)`, so Docling treats 1 px as 1 pt, and the VLM stage
   runs at `scale=1.0`, with `--max-image-size` only as a safety cap. Docling's
   image backend otherwise LANCZOS-resizes again to `scale * dpi`.
5. **Budget with the token rule.** At 250 dpi a 235 x 675 pt column is about
   816 x 2344 px: about 2.4 k Nanonets or 1.9 k Infinity tokens per crop, and
   each call emits a quarter of the spread's output tokens.
6. **Masters stay bilevel.** A run keeps its source PDF (for this 1-bit scan,
   about 1.5 MB per spread) or the ingest's 1-bit book-page PNGs, and renders
   gray crops as it converts; only a debug report saves them.

## Golden measurements

`tests/test_cut.py` cuts the measured spread for real and asserts four `column`
regions in reading order, with cuts at 323, 607 and 890 pt: columns 0 and 1
share the first cut and columns 2 and 3 the last (each within 3 pt), and the
crops of columns 1 and 2 stop either side of the gutter at 607 pt. The four
crops cover at least 90 % of the page's ink, and the first column renders at
250 dpi as an 840-870 x 2420-2460 px gray crop, under Surya's 3072 x 2048 cap,
so it is sent unscaled.

## Alternatives rejected

- **Ink profile first, layout boxes as fallback.** Two detectors and a
  threshold between them, to save 0.5 s per scan on a stage that costs 10-30 s
  per crop in a VLM; the profile finds only gutters, and the column cuts need
  the boxes anyway.
- **Surya's text-line detector to find the gutter.** The same information as
  the layout boxes at line granularity, from a second detector.
- **DocLayout-YOLO.** A second layout model (AGPL-3.0, Ultralytics stack) for a
  job the Docling layout models already do on this material.
- **A custom gutter regressor (YOLO or MobileNet).** Needs a few hundred
  annotated spreads; none exist.
- **PyMuPDF.** AGPL, and duplicates pypdfium2.
