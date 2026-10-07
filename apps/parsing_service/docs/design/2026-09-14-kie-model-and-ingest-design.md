# KIE data model and stage 0 (ingest) design

Status: implemented. This is the contract of the KIE model types, stage 0 (ingest), its cache and the canonical
JSON every hash is taken over. Vocabulary: [CONTEXT.md](../../CONTEXT.md). OCR evidence is specified by the
[canonical evidence design](2026-09-21-canonical-evidence-design.md), and segmentation by the
[grounded catalogue design](2026-09-23-grounded-catalogue-design.md), which amends §3.6.

## 1. Decisions

| Question | Decision | Reason |
|---|---|---|
| Page unit | The book page: ingest cuts each scanned spread into book-page images, and OCR reads those when a run asks for `page_source: ingest`. | Entries, columns and headings are per book page, not per scanned spread. |
| Split method | Native raster extraction with pypdfium2; gutter from the binding shadow and the blank margin beside it. No layout model, no deskew. | The embedded scan is 1-bit 9928 x 7016 at 600 dpi and extracts in 0.2 s. Measured on all 45 spreads: a binding shadow is present on every spread and a wide clean blank band between the pages is not, so the shadow is the primary signature and the blank margin beside it the refinement (§4.2, §4.5). Deskew waits for a measured failure. |
| Model scope | Source, Page and the ingest artifact; Span, Block and HeadingEvent. No Record or Field type. | The evidence contracts (spans, ownership, geometry) are cheap now and expensive after annotations exist. |
| Artifacts | Ingest writes one JSON holding only its namespace in a typed envelope (§5). OCR evidence stays in the canonical page files and is never copied into another artifact. | 30k segments serialise to 8–11 MB; repeating them in every stage snapshot is the wrong shape. |
| Cache | Skip when the accepted ingest in the document directory proves its recipe (§5), so a rerun of the same PDF skips. The CLI only reuses its own `runs/kie/<stem>/<stem>/ingest/`. The worker also seeds a proven ingest of the same recipe from another run of the same PDF bytes (`reuse.py`). | A skip is proven, never assumed: the skip rule rechecks every hash. |

### 1.1 What transfers between documents

The input family ingest supports is scanned catalogues with one binary native image per PDF page and a
run-wide explicit `spread` or `single` mode. Page count, image size, dpi and text-column count are derived
from the input, never assumed. Ingest must not use entry numbers, German keywords, the file name or a
particular spread index to choose a split; source-specific knowledge belongs in recorded config only.

| Layer | Transferability requirement |
|---|---|
| Source, Page, Span, runner and artifacts | Reusable across documents; derive counts and dimensions from the input |
| Gutter detector | Configurable scan assumptions, distances independent of raster resolution, explicit evidence and fallbacks |
| Reference-catalogue method counts and selected page numbers | Reference-fixture measurements only; never runtime conditions |
| Block and HeadingEvent | Numbered-catalogue domain contracts; heading levels come from the recipe |

This ingest does not support arbitrary PDFs. Grayscale or colour rasters, composite pages (anything
beside the one scan: a path, a shading, a Form XObject, or text in a visible or clipping render mode; an
invisible OCR text layer is inside the family and is counted, §4.4), nonzero PDF page rotation, mixed
single/spread mode and deskew or dewarp each need an additional input contract.
Unsupported input is rejected clearly (§4.1) rather than hidden behind a rendering fallback that would
change the image or the coordinates derived from it. Add such a capability when another target document
establishes the need.

The blank and dark ink thresholds and the central search window stay empirical, configurable defaults, and
the reference rule's preference for a blank margin on the shadow's left is a calibrated policy, not a
universal property of books. The part that must not depend on raster resolution is the distances those
thresholds measure, which is why §4.3 states them as fractions of the spread width. Having config fields is
not by itself evidence of generality (§6).

## 2. Vocabulary

[CONTEXT.md](../../CONTEXT.md) defines the terms used here: spread, page, gutter, binding shadow, span, block,
entry, heading event, primary and context span, continuation, stage, artifact, envelope, fingerprint, digest.

## 3. Data model (`kie/primitives.py`, `kie/ingest_model.py`, `kie/blocks.py`; pydantic v2, `extra="forbid"` everywhere)

### 3.1 Coordinate spaces, intervals and rounding

Three spaces exist; every bbox field says which one it is in.

- **Page pixels**: the book-page image, origin top-left, y down. A book page's crop `source_px` in a page file.
- **Spread pixels**: the native raster, origin top-left, y down. `Page.source_rect`, `Page.gutter_x_px`.
  Page pixels to spread pixels is one offset: add `source_rect.left`, `source_rect.top`.
- **PDF points**: the source page, origin bottom-left, y up, as PDF defines it. Page files use points with
  origin top-left, y down: `y_pdf = page_height_pt - y_top`.

Spread pixels to PDF points: pixel `(px, py)` maps to the unit square `(u, v) = (px / W, 1 - py / H)`, then
to `(a u + c v + e, b u + d v + f)` with the placement matrix. The inverse solves the 2 x 2 system. A bbox is
transformed corner by corner; the result is the enclosing rectangle rounded outward (floor left and top,
ceil right and bottom). Measured: the reference catalogue's one-spread sample carries a 0.11° rotation in its
matrix; all 45 spreads of the full PDF are a pure scale with `e = f = 0`.

`Bbox` is `[left, top, right, bottom]`, integers, `left < right`, `top < bottom`.

Intervals and rounding, used by every part of this spec:

- Every pixel interval is half-open, `[start, end)`: a `Bbox`'s right and bottom, `Page.source_rect`, a
  `Run`, a raster slice and a `Span`. The left page is `[0, gutter)` and the right page `[gutter, W)`, so
  the two rects tile the spread and no column belongs to both.
- A fractional *bound* — `gutter_window` and `interior_rows`, which name a place in the image — becomes a
  pixel index with `floor(fraction * dimension)`. A fraction pair whose resulting interval is empty is a
  configuration error and is rejected, never silently widened. The fractional *distances* of §4.3
  (`min_blank_fraction`, `min_dark_fraction`, `support_radius_fraction`) are lengths, not places, and round
  to the nearest pixel by their own rule there; this bullet does not apply to them.
- Horizontal bands are `numpy.array_split(rows, bands)`: when the band count does not divide the row count,
  the earlier bands receive the extra rows.

### 3.2 Page (owned by ingest)

| Field | Type | Meaning |
|---|---|---|
| `index` | int, 1-based | Position in reading order: left then right page of each spread. |
| `spread` | int, 1-based | Source PDF page. |
| `side` | `left` \| `right` \| `single` | |
| `image` | str | `pages/NNN.png` relative to the artifact directory, mode `1`. |
| `width_px`, `height_px` | int | Size of the page image. Equal to `source_rect` size. |
| `sha256` | str | Of the PNG bytes, verified on cache hit. |
| `source_rect` | Bbox, spread pixels | `[0,0,g,H]`, `[g,0,W,H]` or `[0,0,W,H]`. |
| `spread_width_px`, `spread_height_px` | int | Native raster size `W`, `H`. |
| `placement` | Placement | `a, b, c, d, e, f`, `page_width_pt`, `page_height_pt`, and `origin_x_pt`, `origin_y_pt`: the visible page's lower-left corner in user space (CropBox within MediaBox), so a book page maps onto the rendered page whatever the CropBox origin. |
| `dpi_x`, `dpi_y` | float | `72 * W / hypot(a, b)` and `72 * H / hypot(c, d)`. |
| `gutter_x_px` | int \| None | The split. None for `single`. |
| `gutter_method` | `shadow` \| `blank` \| `midline` \| `override` \| `none` | §4.3. `none` for `single`. |
| `gutter_reason` | str \| None | For `midline`: `no_candidate`, `ambiguous_candidates`. For `override`: `config`. Otherwise None. |
| `gutter_evidence` | GutterEvidence \| None | §4.3, typed. None for `single`. |

Left and right pages of a spread carry the same `gutter_*` values.

With `split: single` ingest computes no gutter profile at all, so `gutter_x_px`, `gutter_reason` and
`gutter_evidence` are null and `gutter_method` is `none`. Making the evidence nullable is the point: there
is no support score to report for an operation that did not happen, and inventing one would make a
never-measured number look measured.

### 3.3 Segment

There is no separate segment type. OCR evidence is the canonical page file's `PageSegment` (canonical
evidence design §3.3); extraction and the recipe stages read it as `kie/passages.py`'s `Passage`, named
`p{page}_s{index}` by its physical PDF page and its position in that page file's `segments`. The page file's
order is the reading order.

### 3.4 Text from HTML

A block segment's text is `html_to_text` (`transcription/types.py`) of its HTML: data as given, entities decoded,
a newline where a block ends or at `<br>`, a tab where a table cell ends, trailing whitespace stripped. Text
is never rewritten (`CONTEXT.md`).

### 3.5 Span

`{segment_id, start, end}` with `0 <= start < end <= len(segment.text)`, half-open, code points.
Multi-segment values are `list[Span]`. Normalised or dehyphenated text is a separate view with a mapping back
to these offsets; it never rewrites the segment's text. Until line or character boxes exist, a span's visual
evidence is the enclosing segment's bbox.

### 3.6 Block and HeadingEvent (owned by segmentation)

Block: `id` (`b{n}`, unique), `entry_label` (str), `entry_no` (int, the leading digits), `entry_suffix` (str,
the rest, `""` normally, `a` for `31a`), `primary_spans` (at least one), `context_spans`, `continuation`
(bool), `heading_events` (list of ids in force). Rejected entry-start candidates are not blocks; they go to the
segmentation's `rejected_starts` with span, label, role and reason (grounded catalogue design §7).

HeadingEvent: `id` (`h{n}`, unique), `kind` (the recipe's name for its heading level; the German recipe keeps
`bezirk` and `kreis`), `level` (its depth, 1 the outermost), `text`, `spans` (evidence, at least one). Its
position is its first span; no separate index.

### 3.7 Source

`Source` is one type, used by the ingest artifact (§4.1):

| Field | Type | Meaning |
|---|---|---|
| `pdf_name` | str | The source file's name, not its path. A path is not reproducible across machines. |
| `sha256` | str | Of the PDF bytes. This is the identity every stage binds to. |
| `spreads` | int | Number of source PDF pages. |
| `page_size_pt` | dict[int, [float, float]] | Width and height in points, keyed by 1-based spread number. The keys become decimal strings in canonical JSON (§5). |

`page_size_pt` is keyed per spread rather than stored once because a uniform page size is an assumption this
project has not measured on a second document; per-spread sizes make the assumption unnecessary, and §3.8
requires them to agree with the Page placement metadata.

### 3.8 Validation, two levels

**Artifact level**, when one stage file is loaded alone: shape, `extra="forbid"`, and local rules:

1. Page indices are 1..N without gaps; one page per spread for `single`, two for `spread`; `side` and
   `source_rect` agree; the two rects of a spread are complementary and inside `[0,0,W,H]`. The distinct
   `Page.spread` values are exactly `1..source.spreads`, with no gaps and nothing outside the range, and
   `source.page_size_pt[spread]` equals the `page_width_pt` and `page_height_pt` of every Page of that
   spread.
2. Bbox and span offset rules that need no other artifact.
3. Spread reports and weak-support spreads are unique. The ingest envelope names stage `ingest` and no
   upstream, and the report's counts and per-spread choices agree with the pages.

**Against the canonical text**, when a segmentation artifact loads (grounded catalogue design §7): every span
lies inside its segment's current text, `(entry_no, entry_suffix)` is unique across blocks, primary spans of
different blocks do not overlap, and every non-blank line has exactly one disposition. Spans are half-open, so
`[0, 10)` and `[10, 20)` in the same segment are adjacent, not overlapping: two consecutive entries inside one
OCR segment are the normal case, not a violation.

## 4. Stage 0: ingest (`kei_exp/kie/stages/ingest.py`)

### 4.1 Signature and typed boundary

```
run(pdf: Path, cfg: IngestConfig, out: Path, *, on_spread: OnSpread | None = None) -> IngestArtifact
```

This is the stage's own entry point, called by `kie/ingest_cache.py` with the staging directory it prepared
(§5); a stage never imports the runner or the cache.

`IngestArtifact = {envelope, source: Source (§3.7), config: IngestConfig, pages: list[Page],
report: IngestReport}`. The persisted `config` is the effective-config projection of §5, not the mapping the
caller supplied. Internal types: `Raster` (array, placement, spread number), `Profile` (the spread width,
the whole-interior ink fraction per column, and the same per band), `Run` (`left, right, kind: blank|dark`),
`GutterChoice` (`x, method, reason, evidence`).

Rejections, raised as `IngestError` naming the spread: a page with zero or more than one image object; any
path, shading or Form XObject object (so a scan nested in a form is refused rather than placed by its local
matrix, which is not its placement on the page); a text object in any render mode other than 3, invisible
(mode 7 clips what is painted after it, and every other mode paints); an image carrying a clipping path
(`re W n` before `Do` is no page object: PDFium attaches it to the image, and it changes what the page shows
without changing the raster); an image the page paints differently from the raster it holds: a soft mask, a
stencil or colour-key mask, an alpha in the graphics state, whole or partial, or an image mask
(`/ImageMask true`, whose raw decode is the inverse of what it paints and which is transparent where it has
no ink); none is a page object and PDFium reports none, so the image is painted on its own, unrotated and
unscaled, and the render must be the decoded raster byte for byte, 0 or 255 on every colour channel and
opaque; a PDFium failure while loading the page, listing its objects or decoding its
image; an image whose placement has `hypot(a, b)` or `hypot(c, d)` under 1 pt; a page rotation other than 0; a raster
whose pixel values are not a subset of `{0, 255}`. A subset, not exactly that set: a uniformly white or a
uniformly black raster is valid input and must stay representable, which is what makes the blank-spread case
of §4.3 reachable instead of a rejection. Any intermediate grey means the image is not the expected 1-bit
scan, and is rejected before the threshold at 128 turns it into a boolean array.

### 4.2 What the scans look like (all 45 spreads of the reference catalogue, window 40–60 % of width)

Column ink over rows 10–90 % of height, from left to right: left text at 8–11 %; a blank inner margin
(ink under 0.5 %) 75–180 px wide, or wider when the left page's second column is empty; a thin binding
line; the binding shadow, a run of 90–190 px on 42 spreads and 25–59 px on three (§4.5), at 15–24 % ink;
a dithered grey tail at 3–10 % that fades into the right text. Text columns never exceed about 12 % over
the interior rows, and a shadow is visible on every spread. So the shadow is the primary signature and the
blank margin the refinement; a wide blank band between the pages never occurs. Visible is not the same as
qualifying: on three spreads the shadow's dark run is too narrow to pass the width minimum, and the blank
margin decides instead (§4.5).

### 4.3 Config and rule

`IngestConfig` (`extra="forbid"`, bounds checked):

| Field | Default | Reason |
|---|---|---|
| `split` | `spread` | `spread` or `single`. No automatic detection. With `single` the gutter settings are not part of the effective config. |
| `gutter_window` | `[0.40, 0.60]` | Fraction of width searched. Measured shadow at 0.49–0.52. |
| `interior_rows` | `[0.10, 0.90]` | Fraction of height profiled, to skip the scanner border without cropping the saved image. |
| `bands` | 5 | Horizontal bands for the support measure. |
| `blank_ink` | 0.005 | A column with at most this ink fraction is blank. Measured margins are 0.000–0.004. |
| `dark_ink` | 0.15 | A column with at least this ink fraction is dark. Measured text tops out near 0.12, shadow bottoms out at 0.15. |
| `min_blank_fraction` | 0.004 | Narrowest blank run that counts, as a fraction of spread width. Column gaps inside a page are wider, but lie outside the window. |
| `min_dark_fraction` | 0.006 | Narrowest dark run that counts, as a fraction of spread width. Most measured shadows are far wider; on three spreads none qualifies and the blank margin decides (§4.5). |
| `support_radius_fraction` | 0.001 | Half-width of the neighbourhood the support measure examines, as a fraction of spread width. |
| `min_band_support` | 0.6 | Bands below this fraction mark the spread as weak support in the report; it does not change the selection. |
| `overrides` | `{}` | `spread -> gutter_x_px`, in native spread pixels. |

The three distances are fractions of the full native spread width `W`, not pixel constants, so that the
rule transfers to a catalogue scanned at another resolution; a pixel default would silently mean a different
physical distance there. Each resolves to pixels once per spread with `max(1, floor(fraction * W + 0.5))`,
giving `min_blank_px`, `min_dark_px` and `support_radius_px`. At the reference catalogue's width `W = 9928`
they resolve to the 40, 60 and 10 px the baseline of §4.5 was measured with; at half that raster resolution
they approximately halve. Evidence coordinates and `overrides` stay in native pixels, because they name places
in one particular image, and the resolved distances are recorded per spread in the report.

Config is checked in two places, because two different things are knowable at two different times:

- Shape and value checks — types, ranges, ordered pairs, `bands >= 1`, fractions inside `(0, 1)` — happen at
  parse time, in the model.
- Source-dependent checks are two pure methods, because they are knowable at two different places. The
  resolved `gutter_window` columns and `interior_rows` rows must each be a nonempty interval (§3.1 rejects
  an empty one, and emptiness is only knowable once `W` and `H` are), the interior rows must yield at least
  `bands` rows, and every `overrides` key must be a spread number this document has:
  `IngestConfig.check_against_source(width, height, spreads)`, which ingest calls once per distinct raster
  size, at the first spread of that size and before profiling, because spreads of one source may differ in
  size and a later, shorter one can hold fewer interior rows than there are bands. An override *value* is
  not checked there: `0 < x < width` is only meaningful against the width of the spread the override names a
  column of, so checking every override against one document-wide width would refuse a legitimate config on
  a source of mixed raster sizes. That check is `IngestConfig.check_override(spread, width)`, which ingest
  calls at each spread with that spread's own width, before selection. Both raise `IngestError`. Neither can
  run at parse time, because they need the raster dimensions and the spread count. These two are the one
  place source-dependent config checks live. With `split: single` both return without checking anything:
  every setting they examine is inactive, excluded from the effective config and therefore from the
  fingerprint (§5), so aborting the run on one would reject a knob that provably changed nothing. The
  parse-time shape and value checks above still apply in full in single mode.

Pure steps:

1. `ink_profile(raster, cfg) -> Profile`: black fraction per column over the interior rows, and the same per
   band. The profile carries the spread width, so the steps below resolve the same distances from `cfg`.
2. `find_runs(profile, cfg) -> list[Run]`: maximal runs of blank columns at least `min_blank_px` wide and of
   dark columns at least `min_dark_px` wide, inside the window, on the whole-interior profile. Runs are
   half-open and are not joined across gaps.
3. `choose_gutter(runs, width, cfg, *, spread, profile) -> GutterChoice`, the reference policy. `spread`
   selects an override and `profile` lets the policy populate its evidence through `band_support`; both are
   keyword-only, so the selection stays a pure function of stated inputs rather than reaching for ambient
   state.
   - An override for this spread wins: `override`, reason `config`. Its evidence still records the run
     counts, `band_support` at the chosen `x` and the distance from the midline, so an override can be
     audited against what the projection saw; `dark_run` and `blank_run` are null, because no run was
     selected.
   - Exactly one dark run: if a blank run lies immediately to its left, meaning
     `0 <= dark.left - blank.right <= min_blank_px` with the resolved distance, split at that blank run's
     right end, method `shadow`; otherwise split at the dark run's left edge, method `shadow`. The shadow
     belongs to the right page, whose inner margin it darkens.
   - No dark run and exactly one blank run: split at the blank run's centre, `(left + right) // 2`, method
     `blank`.
   - More than one dark run, or no dark run and more than one blank run: midline, `ambiguous_candidates`.
   - No qualifying run of either kind: midline, `no_candidate`.
   - Run edges are integer columns, and the midline is `width // 2`.
4. `band_support(profile, x, cfg) -> float`: the fraction of bands in which the columns
   `[max(0, x - r), min(width, x + r + 1))` of that band's profile are all blank, or all dark, with `r` the
   resolved `support_radius_px`. A band that mixes the two does not qualify. Recorded in evidence. Below
   `min_band_support` the method stays but the report lists the spread under "weak support".
5. `split_raster(raster, x) -> (left, right)`: the half-open slices `[0, x)` and `[x, W)`; re-placing them at
   their `source_rect` reproduces the raster.

`GutterEvidence`: `dark_run: [l, r] | None`, `blank_run: [l, r] | None`, `dark_runs: int`, `blank_runs: int`,
`band_support: float`, `distance_from_midline_px: int`, the last being `abs(x - width // 2)`.

With `split: single` none of these steps runs at all (§3.2).

Failure modes and treatment:

| Case | Treatment |
|---|---|
| Dust or text bleeding into the gutter | The shadow, not a blank band, is the signature; a blank run is only a refinement. |
| Left page's inner column empty | The blank run is wide; the split still sits at its right end next to the shadow (measured on spread 37). |
| Figure plate across the spine | Both halves kept; band support drops and the spread is listed under weak support. Projection cannot decide the semantic split. |
| Single-page scan | `split: single`, whole raster as one page, `gutter_method: none`, gutter evidence null. |
| Blank or sparse spread | No branch of its own. A blank window is one qualifying blank run, so the rule selects `blank` at its centre; only a spread with no qualifying run of either kind falls back to midline with `no_candidate`. |
| Uniformly black raster | The symmetric case, and defined rather than undefined: the window is one qualifying dark run, so the reference rule selects `shadow` at the window's left edge. An alternative policy (§7) may instead treat a dark run that fills the window as ambiguity, since a shadow that wide is not a spine. |

### 4.4 Extraction and output

`extract_raster` takes the page's sole image object via pypdfium2 with `render=False`. The bitmap arrives as
mode `L` with values 0 and 255; it is thresholded at 128 into a boolean array and saved as mode `1` PNG.
The image is then painted once more with `render=True`, which applies masks and alpha, and compared with
that array byte for byte in blocks of rows (§4.1). That comparison is the cost of refusing a scan the page
shows otherwise than stored. `pages/NNN.png` numbered by `Page.index`.

The PDF is read whole into memory once: its sha256 and the pypdfium2 document both come from those bytes, so
the hash and the pixels are one snapshot, and a file replaced under its name between the two cannot bind one
PDF's pixels to another's hash. Working set: the PDF bytes plus one spread, plus one full BGRA render for the
byte comparison (about 280 MB at 9928 x 7016). A file mutated in place while it is open is outside this
contract. The cache's own hash of the path for the skip decision is a separate read, compared against
`source.sha256`, so a source changed between two runs reruns.

`IngestReport`: spreads read, pages produced, counts per `gutter_method`, per-spread `gutter_x_px`, method,
reason, evidence and resolved distances (`min_blank_px`, `min_dark_px`, `support_radius_px`), spreads with
weak support, `text_layers` (spread → invisible text objects, only for spreads that carry any), seconds for
extraction, seconds for PNG writing, total. The resolved distances are in the
report rather than only in config because they are what the rule actually applied, and they depend on the
raster the run met.

### 4.5 Measured baseline, and what acceptance may assert

The reference policy of §4.3, applied to all 45 native rasters of the reference catalogue at the distances
resolved for its width (selection only, no PNGs written):

| Result | Measured value |
|---|---|
| Native image dimensions | 9928 x 7016 on every spread |
| Selected methods | 42 `shadow`, 3 `blank`, 0 `midline` |
| Blank selections | spread 28 at x=4726; spread 29 at x=4734; spread 44 at x=4796 |
| Longest dark run on those three spreads | 25, 59 and 59 px, each below the resolved `min_dark_px` |
| Support below `min_band_support` | all 42 `shadow` selections |
| Support distribution | 33 spreads at 0.0; 9 at 0.2; the three `blank` selections at 1.0 |

The support rule tests a neighbourhood across a selected run edge, which can explain weak support even when
the shadow candidate is the right one. That explanation is an inference: visual split quality is unverified.
So this is a baseline, not a target. Acceptance inspects the non-`shadow` selections and the weak-support
evidence instead of asserting 45 `shadow` selections. Any change to selection or support needs a stated
reason, new measured numbers, and the matching config or `stage_version` change; thresholds are not tuned to
obtain a method count.

## 5. Runner and artifacts (`kei_exp/kie/runner.py`, `kei_exp/kie/ingest_cache.py`)

`runner.convert(execution, emit, *, seed, adopt, before_ocr)` is the one entry point; the Markdown CLI and the
worker call it. For `page_source: ingest` it runs `ingest_cache.ingest_step`, then `kie/stages/ocr.run` over the
accepted book pages. OCR writes the canonical page files of the
[canonical evidence design](2026-09-21-canonical-evidence-design.md) and keeps no artifact of its own. The rules
below apply to the ingest generation.

- Document directory: `<ingest_dir or runs/kie/<stem>>/<stem>/`, with the ingest in its `ingest/`. For the
  worker that is `KEI_RUNS/<run id>/input/ingest/`; the CLI uses `runs/kie/<stem>/<stem>/ingest/`. One writer
  per document directory.
- CLI: `uv run --no-sync kei-exp PDF --page-source ingest [--result-dir DIR]`. The CLI always uses the default
  `IngestConfig`; split and gutter overrides reach a run only through the worker `convert` request's `ingest`
  object.
- `ingest_step(pdf, cfg, doc_dir, on_spread)` returns `IngestStep{skipped, seconds, report}` with the artifact;
  the runner only logs it. `on_spread(spread, spreads)` is progress reporting only: the stage calls it before
  it reads each spread, never when the accepted artifact is reused, and an exception from it aborts the stage
  before publication; it is not part of the config, the fingerprint or the stage version.
- Artifact `ingest.json` = `{envelope, ...namespace}`. Envelope: `stage`, `stage_version`, `fingerprint`,
  `digest`, `upstream: {stage: digest}` (empty for ingest), `created`.
- `stage_version` is one integer constant per stage module. Bump policy: any change that can alter the
  stage's output for the same inputs, including namespace shape, algorithm, rounding, thresholds not in
  config, and a dependency whose behaviour the stage relies on. It is not a git revision, so unrelated
  commits do not invalidate caches.
- Canonical JSON (`kei_exp/canonical.py`) is the one serialization every hash is taken over, because a hash of
  an undefined encoding is not reproducible: pydantic models dumped in JSON mode, then `json.dumps` with
  `sort_keys=True`, `separators=(",", ":")`, `ensure_ascii=False` and `allow_nan=False`, encoded UTF-8. A
  dict with integer keys, such as `Source.page_size_pt`, serializes those keys as decimal strings after
  model serialization, because JSON has no integer keys; parsing converts them back. Hashing always uses
  this form, even when the file actually saved to disk is indented for reading.
- `fingerprint` = sha256 over canonical JSON of `{stage_version, effective_config, inputs}`, where `inputs` is
  the PDF bytes' sha256.
- Effective config is the projection of a stage's config that drops every setting inactive for the chosen
  mode. With `split: single` the serialized effective config is exactly `{"split": "single"}`. The supplied
  config is validated in full first, so a wrong gutter bound is still an error in single mode; the
  projection only decides what is persisted and hashed. Omitted inactive fields may come back as their
  defaults when the artifact is parsed, but they must stay excluded on serialization, or a setting that
  changed nothing would change the fingerprint and re-run the stage. The artifact's `config` field and the
  fingerprint use this one serialization, so the digest — taken over the namespace, which contains
  `config` — sees the same bytes.
- `digest` = sha256 over canonical JSON of the namespace without the envelope and without the report. So
  timing never changes a digest, but any change in produced pages does, and a consumer binds to what was
  actually produced.
- Skip rule: the artifact loads and validates at artifact level; the digest recomputed from the loaded
  namespace equals `envelope.digest`; the envelope names stage `ingest`, the current `stage_version`, the
  recomputed fingerprint and no upstream; the artifact's config and source hash equal the request's, because
  the fingerprint sits in the envelope, which the digest excludes; every page PNG exists with the recorded
  sha256 and begins as the header of a bilevel PNG of the recorded size (signature, 13-byte `IHDR`, width,
  height, bit depth 1, colour type 0), read through the same handle the hash was streamed through. Nothing is
  decoded. Otherwise the stage runs. A stored digest is never trusted on its own, because it is the value a
  consumer binds to: a namespace edited after publication would otherwise keep vouching for content it no
  longer holds.
- Threat model: run directories are trusted local output. The integrity checks defend against interruption,
  drift and operator error, not against an adversary who can rewrite the artifact; such an adversary can
  recompute the digest and every page hash, so decoding hash-verified bytes would prove nothing further.
- Publication: the stage writes JSON and assets into `ingest.staging/`; on success the previous `ingest/`
  directory (if any) is renamed to `ingest.old/`, staging is renamed to `ingest/`, and `.old` is removed.
  A failed run leaves the accepted generation untouched. Layout on disk is therefore
  `ingest/ingest.json` and `ingest/pages/NNN.png`. That swap is two renames, which is not one atomic
  replacement for a reader already traversing the directory. Before any cache decision, `_recover` undoes an
  interrupted swap: staging is discarded, an accepted generation that proves itself wins, and otherwise a
  provable `ingest.old/` is put back.

## 6. Tests and verification

Tests, only where a plausible bug would fail them:

- Gutter on synthetic spreads: shadow plus blank margin gives `shadow` at the margin's right end; shadow
  alone gives `shadow` at its left edge; blank margin alone gives `blank` at its centre; two shadows give
  `midline` with `ambiguous_candidates`; a spread with no qualifying run gives `midline` with
  `no_candidate`; a uniformly blank spread is accepted and selects `blank`; an override wins; halves
  reconstruct the raster exactly; an empty left column does not move the split into the text; the same
  synthetic spread at half the raster width selects the proportionally equivalent split, up to integer
  rounding, which is the whole reason the distances are fractions; `split: single` produces one page with
  `gutter_method: none` and null gutter evidence.
- Cache: a second run skips ingest; a changed active config, a changed `stage_version`, a PNG with a
  different hash, or a missing PNG re-runs it; under `split: single` a changed gutter threshold does not
  re-run it, because the threshold is not in the effective config; a namespace edited after publication is
  caught by recomputing the digest rather than trusting `envelope.digest`.
- Model: malformed spans, bboxes, placements and configs, and non-complementary source rects, are rejected at
  artifact level; a segmentation artifact that fails a check against the canonical text is refused when it
  loads.

The cases that need a real scanned catalogue spread skip unless `PARSING_FIXTURE_DIR` supplies one as
`scan.pdf`.

Validated on one reference catalogue only. The implemented reference policy reproduces the §4.5 baseline
(42 `shadow`, 3 `blank`, 0 `midline`). Visual split quality and transfer to a second, independently scanned
catalogue are not demonstrated; the reference catalogue's one-spread sample does not count as a second
catalogue, since it is the same scan.

## 7. Alternative gutter policies

`choose_gutter` implements the reference policy of §4.3, one valid answer among several. Open alternatives
include ranking several dark runs, letting a blank run override a shadow, and calling a window-filling dark run
ambiguous (§4.3). Any alternative keeps a valid cut inside the gutter, reports ambiguity through `midline` with
a reason, handles margins on either side, and follows the change rule of §4.5.
