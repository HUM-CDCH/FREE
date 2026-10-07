# One canonical parsing result: design

Status: implemented. Vocabulary: `CONTEXT.md`. This is the contract of the accepted parsing result: the page
files and manifest every consumer reads, their content identity and coordinate spaces, and the writer and reader
that guarantee them. The [model/ingest design](2026-09-14-kie-model-and-ingest-design.md) §5 covers the ingest
cache and canonical JSON.

## 1. Problem

The accepted page files are immutable, published by rename, and already carry the text, the HTML, the box and
the crop transform, so no consumer needs a second persisted copy of the same OCR evidence. A recipe
fingerprint is not a content identity: two runs of one recipe over one PDF produce two different OCR outputs
under one fingerprint, and a manifest that lists page numbers instead of the bytes it accepted cannot detect a
page file edited or half-replaced after publication. A whole-input box must say that it is coarse, or a reader
measuring localisation treats it as a block box.

## 2. Decisions

| Question | Decision | Reason |
|---|---|---|
| The canonical evidence | Accepted page files and their manifest (§3), under `result/` of a worker run (`KEI_RUNS/<run>/result/`) or wherever the CLI's `--result-dir` points. No separate artifact copies OCR text. | The one file every consumer can read without a model server. |
| Content identity | A **generation**: an opaque id minted when a result is first written, recorded in the manifest and in every page file, plus the sha256 of every page file in the manifest and a digest over those hashes. The recipe fingerprint stays what it is: the hash of what was asked. | A parsing-recipe fingerprint is not the identity of its produced content. An evidence reference names the generation; a reader verifies the bytes against the manifest. |
| OCR execution | `kie/stages/ocr.py` owns cutting, transcription, acceptance and result publication. `kie/passages.py` verifies those files and projects passages in memory (§6). | A persisted copy of OCR text would be a second source of evidence. |
| The runner | Ordinary functions run ingest and OCR (§7). Ingest keeps recovery, verified caching and publication; OCR runs each invocation unless the worker adopts a verified result of the same recipe. No `Step`, stage registry or configurable chain. | Necessary responsibilities without a workflow framework. |
| Geometry | One leaf module, `kei_exp/geometry.py`: box types and validators, the crop transform, the projections between crop pixels, unit points, unit pixels and PDF page points. The page sources (`pages.py`), the cut, the page-file models, the writer and the KIE primitives use it. The rendering algorithms (pdfium's canvas rounding, the book page's native-grid cut, the ingest's raster extraction and gutter search) stay where they are. | Shared metadata, distinct algorithms. |
| Coarse evidence | `PageSegment.extent: "block" | "input"`, invariant `extent == "input"` iff `bbox_px is None`. | A VLM segment, and a native page Docling yields no item for, keeps its whole-input box and says so; nothing fabricates a precise box, and nothing coarsens a precise one: a native page with items publishes Docling's own per-block boxes. |
| Units and pages | `Unit.kind: "pdf_page" | "book_page"`, invariant `kind == "pdf_page"` iff `index == 0`; every box field says its space in its name (§3.1). | Physical PDF pages are defined separately from optional book-page units, with explicit coordinate names and units. |
| Reuse | Ingest reuse verifies its full recipe, schema, source, assets and digest. The result reader verifies page files, generation, completeness, optional source/ingest/transcriber binding and optional expected coverage. The worker adopts another run's complete result whose recipe hashes to the same fingerprint, rewritten as a new generation that names it in `reused_from` (`reuse.py`); nothing partial is reused, and the CLI and debug runs reuse nothing. | The reader alone is not a cache decision; the recipe fingerprint is. |
| The debug report | `--debug-dir` writes `report.json` and the input PNGs. | Diagnostics only: nothing reads the evidence it also carries. |

## 3. The canonical evidence model (`RESULT_VERSION` 5)

### 3.1 Coordinate spaces

Every box field names its space. Boxes are `(left, top, right, bottom)`.

| Suffix | Space | Origin, unit | Type |
|---|---|---|---|
| `_pt` | The PDF page the file is for | top-left, y down, PDF points (72 per inch) | floats, `PointBox` |
| `bbox_px` (segment) | The space the engine read: the crop image it received, or — for a native page, whose engine read the PDF itself — the PDF page | top-left, as the engine reported them: image pixels for a rendered crop or page, PDF points for a native page, where `bbox_px` therefore equals `bbox_pt` | floats |
| `source_px` (crop) | The unit's native raster (a book page's PNG) | top-left, native pixels, half-open `[left, right) × [top, bottom)` | ints, `PixelBox`; `None` for a crop of a PDF page unit, which has no native raster |
| `image_px` (crop) | The crop image | its size, pixels | ints |
| `origin_pt`, `pt_per_px` (crop) | The unit's own points (page points for the PDF page unit, book-page points for a book page) | pixel (0, 0) of the crop in unit points; points per pixel on each axis | floats |

A book page's points are its native pixels over its dpi (`72 / dpi`); its placement on the PDF page (the
ingest artifact's `Placement`, `source_rect` and dpi) maps them to `_pt`. The page file records the derived
`bbox_pt` of every crop and segment and the exact transform beside it, so a reader can use the derived box or
re-derive it.

### 3.2 The manifest, `result/result.json` (`Result`)

```
result_version: 5
generation: str                      # "<UTC timestamp to the microsecond>-<8 hex>", minted before the first page file
digest: sha256                       # over canonical_json({"pages": {n: sha256}}): the content identity of the generation
fingerprint: sha256                  # over canonical_json(recipe): the identity of what was asked
recipe: dict                         # result_version, source_sha256, ingest_digest, transcriber, ...
source_name, page_count, effective
started: ISO 8601 UTC | None         # when the transcriber was called
seconds: float | None                # the transcriber's wall time
status: success | incomplete
incomplete: str | None
pages: dict[int, PageEntry]          # every page file written, ascending; PageEntry = {sha256, complete}
tokens: {input, output}
reused_from: {run_id, generation}    # only on an adopted result: the run and generation it was copied from
```

Completeness rules, checked by the reader and written by the writer:

1. `status == "success"` iff `incomplete is None` and every `PageEntry.complete` is true.
2. `pages` lists exactly the selected PDF pages (`recipe.pages_requested`, or `1..page_count`), each with a
   file whose bytes hash to `sha256` and whose `complete` equals the entry's.
3. `digest` is the hash of the `pages` mapping's hashes, recomputed on every load.

### 3.3 The page file, `result/pages/<n>.json` (`PageResult`)

```
generation: str                      # the manifest's; a page file of another generation is another result
page: int                            # the PDF page, 1-based
size_pt: (width, height)
units: list[Unit]
segments: list[PageSegment]          # reading order: units, then crops by their order, then blocks; a
                                     # native page's blocks (no crop) read among its artwork crops
markdown: str
complete: bool
warnings: list[str]
```

`Unit = {index, kind, bbox_pt, crops}`: `index` 0 and `kind: pdf_page` for the page itself, else the ingest's
book page index and `kind: book_page`; `bbox_pt` is where the unit sits on the PDF page.

`CropResult = {crop, kind, order, bbox_pt, ink, origin_pt, pt_per_px, source_px, image_px, input_tokens,
output_tokens, seconds, stop, capped, incomplete}`: `origin_pt` and `pt_per_px` are the crop transform;
`seconds`, `stop` and `capped` are the record's diagnostics, so a reader of the result alone can see what the
debug report showed.

`PageSegment = {text, html, markdown, label, confidence, status, unit, crop, bbox_px, bbox_pt, extent, table,
boxes_pt?}`, frozen. `extent` is `block` when `bbox_px` is the engine's box of one block, `input` when the
segment is a whole input whose transcriber returned no boxes and `bbox_pt` is the input's extent. Text is never
rewritten (`CONTEXT.md` invariant 1); the two never carry different text.

A native page publishes one `block` segment per Docling item, of the body and the furniture layer (running
headers, footers, page numbers), labelled in Surya's vocabulary; the page's `markdown` stays Docling's body-only
export, so the blocks are deliberately wider than the reading text. A native page keeps one whole-input segment
only where Docling yields no item. A native table block carries `table = PageTable{rows, columns, cells,
producer}`, each `TableCell{cell_id r{row}_c{col}, row, column, rowspan, colspan, role, text, start, end,
bbox_pt}` a range of the parent segment's text: cells refine the segment and never replace it. `boxes_pt`, present
only for a block printed in several places on its page, lists every box in reading order, `bbox_pt` the first.

### 3.4 Evidence references

A segment is named `p{page}_s{index}` (`pagefile.segment_id`): the physical, one-based PDF page whose file holds
it and its zero-based position in that file's `segments` list. The name is valid within the generation it was
read from (`Evidence.generation`, §6): resolution is `pages/<page>.json` of a directory whose manifest names that
generation, then `segments[index]`. A rerun is another generation, and a reference into it is another reference.
FREE's anchors are `a_p{page}_s{index}`.

## 4. Geometry (`kei_exp/geometry.py`)

A leaf module (no docling, no pdfium): `PointBox`, `PixelBox`, `CropTransform(origin_x, origin_y, pt_per_px_x,
pt_per_px_y, source_px)` with `to_unit_points(bbox_px)`; `unit_pixels(bbox_px, source_px, image_px) -> PixelBox`
(the crop-image box on the unit's native raster, floor left and top, ceil right and bottom, as the stage 0 design
§3.1 rounds every transformed box); `clamp(box, within) -> PixelBox | None` (a rounded box clamped into the crop
it was read from, `None` when nothing is left); `unit_to_page_points(placement,
source_rect, spread_size_px, dpi, bbox) -> PointBox` (book-page points onto the PDF page: the four corners through
the placement matrix and the visible page's origin, their bounding box); and the validators the models share
(`ordered_box`, half-open pixel boxes). `pages.PdfPage.crop_transform` and `pages.BookPage.crop_transform` keep
their rounding rules and return the shared type; `BookPage.to_page_points` calls `unit_to_page_points`.

## 5. The writer and the reader (`kei_exp/result.py`, `kei_exp/pagefile.py`)

The writer (`write_result`) mints the generation, writes every selected page's file by rename, hashes the bytes
it wrote, and writes the manifest last with the hashes, the digest, `started` and `seconds`. Identities come from
the inventory; a page the cut found nothing on gets a file with no segments and a warning.

The reader lives in the leaf module beside the models, so that KIE and a viewer can use it without the converter:

- `read_manifest(directory) -> Result`: the file parses and validates, `result_version == RESULT_VERSION`.
- `read_page(directory, number, manifest) -> PageResult`: the file parses, `page == number`, `generation ==
  manifest.generation`, its bytes hash to the manifest's entry, `complete == entry.complete`.
- `load_result(directory, *, source_sha256=None, ingest_digest=None, transcriber=None, page_source=None,
  pages=None) -> LoadedResult(manifest, pages: dict[int, PageResult])`: the manifest, every page it lists,
  and the checks above plus: the files present under `pages/` are exactly the listed pages; `pages`, when given,
  is exactly that set; each expected recipe field equals the expectation; the recomputed digest equals the
  manifest's; the completeness rules of §3.2 hold. Every refusal is a `ResultError` naming the file and the
  field. `require_complete=True` (the extraction loader's setting) refuses `status: incomplete`.

## 6. The extraction consumer

`kie/passages.py`'s `load(run_dir) -> Evidence` reads `run_dir/result` through `load_result(...,
require_complete=True)`, so extraction reads only a complete result. It projects every segment into a `Passage`
named `p{page}_s{index}` (§3.4) with its unit, crop, crop order and crop box. A segment the engine did not read
`ok` is kept as `withheld` and never extracted from; a blank `ok` segment is skipped. A page whose segments name a
unit or crop the page does not have, or that repeats a unit or crop ordinal, is refused: the hashes prove the
bytes, not the placement. Where the page file's order disagrees with the cut's own order, `order_issues` reports
it; nothing is reordered. `Evidence` carries the run id, generation, digest, source name and page count beside
the passages.

## 7. The runner and the command line

`kie/runner.py`'s `convert` runs ingest when `page_source` is `ingest`, then `kie/stages/ocr.run`, which receives
the accepted book pages directly, so there is no second ingest invocation or artifact reload. The Markdown CLI
(`kei-exp`) and the worker's `convert` workflow call it. Ingest reuse keeps its verification and
interrupted-publication recovery. OCR runs again and publishes a new generation, except in the worker, which
first offers it another run's complete result of the same recipe fingerprint to adopt (`reuse.py`). A narrower
selection removes old page files before the new manifest is published. The result directory is the CLI's
`--result-dir`, or the worker run's `result/`.

## 8. Equivalence and tests

`tests/recorded/` holds one recorded transcriber run (native, over the committed synthetic eight-page PDF
`tests/fixtures/synthetic-main.pdf`), reduced to what a replay needs; `tests/helpers/synthetic.py` adds four
hand-built cases over the same PDF (`hand-built`, `capped`, `blank-cut`, `whole-pages`). A replay builds the
inventory and the records and calls `write_result`. `tests/golden/` holds what the version 3 writer produced from
those replays. `tests/test_equivalence.py` writes each replay with the current writer and compares every page file
and manifest with its golden after the documented version 4 mapping (`fingerprint` → `generation`; `transform` →
`origin_pt`, `pt_per_px`; `extent` from `bbox_px`; unit `kind` from `index`; the manifest's page list → entries),
with text, HTML, boxes and Markdown compared verbatim: non-ASCII text, a table block, whole pages under an engine
transform, a page with no boxes, an errored block, a capped page and an all-blank cut are among the cases. CropBox
offsets are covered by the geometry and page-source tests.
