# One canonical parsing result: design

Imported from kei-exp `93b9435c2b9a01a5424758d917c058fc79bbc159`. This document
retains the original internal design or measurements. The service README and
FREE root deployment runbooks govern the current runtime and verification commands.

Organization update: shared encoding and hashing now live in `kei_exp.canonical`, transcription contracts and
adapters in `kei_exp.transcription`, and API job ownership in `kei_exp.runs`. The evidence and execution
contracts below remain unchanged; see the [current code organization](../../../README.md#code-organization).

Evidence amendment, 2026-09-22: a born-digital page no longer publishes one coarse segment. Docling already
carries every item's page and provenance box, so the native transcriber returns one block per item — of the
body *and* the furniture layer, so a running header, a running footer and a page number are published as
blocks exactly as a scan's Surya blocks publish them — and the page file holds one `extent: "block"` segment
for each, labelled in Surya's vocabulary. The page's `text` and `markdown` stay Docling's body-only exports:
the blocks are the evidence set, which is deliberately wider than the reading text. Those boxes are
already in the PDF page's own top-left points — the engine read the PDF, not a raster — so `bbox_px` equals
`bbox_pt` numerically for them; §3.1 and §2's "Coarse evidence" row below are corrected accordingly. A native
page keeps its whole-input segment only where Docling yields no item at all. §1 records the problem as it
stood and is left as written. `RESULT_VERSION` stays 4: the page-file shape is unchanged.

Execution amendment, 2026-09-21: OCR runs inside the KIE pipeline, as requested after the original brief.
The Markdown CLI and API share that execution. This document describes the resulting architecture;
the upstream migration report (`docs/canonical-evidence-migration.md` at the import commit) records its evidence, measurements and limits.

Date: 2026-09-21. Status: the contract implemented by the `feat/canonical-evidence` branch, from PR #7's head
`e5ad72f`. Source: the implementation brief of 2026-09-21 (steps 1 to 4; step 5, durable incremental service
execution, is a separate change). Vocabulary: `CONTEXT.md`. Supersedes the stage 1 design
(`2026-09-17-kie-stage1-ocr-import-design.md`) as the KIE consumer's contract; amends the results contract of
`docs/CODE_REVIEW.md` §8 and the stage 0 design's runner section (§5) where they describe a stage chain.

## 1. Problem

The tree at `e5ad72f` persists the same OCR evidence twice and describes it three times:

- The converter publishes an accepted result: `result/pages/<n>.json` per PDF page and `result/result.json`
  (`kei_exp.pagefile`, written by `kei_exp.result`). Stage 1 of KIE (`kie/stages/ocr.py`) reads those files and
  writes `ocr/ocr.json`: every segment's text copied, its box re-projected, an envelope, a fingerprint, a digest,
  a report and a cache rule of its own (290 lines of stage, 130 lines of model, 60 of runner and loader).
  Nothing downstream needs the copy: the page files are immutable, published by rename, and already carry the
  text, the HTML, the box and the crop transform.
- The runner (`kie/runner.py`) is a generic stage framework for two stages: a fixed chain, a prefix-validated
  `stages` list in the config, a `Step` callable per stage, generic recovery, skip and publication parametrised
  by loader and version. One of the two stages is the copy above.
- Geometry is spelled in three places: `pages.CropTransform` (crop pixels to unit points), `ocr.to_page_pixels`
  and `ocr.place_block` (crop pixels to book-page pixels), `BookPage.to_page_points` (book-page points to PDF page
  points through the placement), and `boxes.page_geometry` (the viewer's projection). Box types and their
  validators exist in `pagefile.py`, `pages.py` and `kie/model.py`.
- The page file's `fingerprint` is the recipe hash. Stage 1 uses it to tie a page file to its manifest, which
  equates "produced under this recipe" with "this content": two runs of one recipe over one PDF produce two
  different OCR outputs with one fingerprint, and a reader cannot tell a page file of one from the other. The
  manifest lists page numbers, not the bytes it accepted, so a page file edited or half-replaced after
  publication is undetectable.
- A native or VLM segment has `bbox_px: None` and a `bbox_pt` that is the whole input's extent. That is the
  right evidence for a transcriber that returns no boxes, but nothing in the model says it is coarse: a reader
  measuring localisation would treat it as a block box.

Baseline, measured on 2026-09-21 at `e5ad72f` (`scratch/check_*.py`, `node scratch/check_web.cjs`): 12 of 14
checks pass. `check_pages.py:136` fails because its expectation assumes the fixture's placement is a pure
translation, and `Beier1988_GAC_02_Catalogue7.pdf` carries a −0.11° rotation in its image matrix (b = −2.33,
c = 1.64): the bounding box of a 678 pt tall rotated crop is 1.3 pt wider than the crop, so a block 10 px into the
crop is not 7.2 pt into the crop's bounding box. `check_result.py:99` fails because pdfium's crop render differs
from a slice of the whole-page render by one grey level in 74 of 1722 pixels (anti-aliasing rounding); the crop
offset the check derives (one canvas pixel) is right. Both are expectation defects of the checks, not defects of
the code, and both predate this branch. They are ported with corrected expectations and reported as such.

## 2. Decisions

| Question | Decision | Reason |
|---|---|---|
| The canonical evidence | Accepted page files and their manifest, evolved to `RESULT_VERSION` 4 (§3): under `result/` in API runs and `ocr/` in KIE runs. No separate KIE artifact copies OCR text. | Already the one file every consumer can read without a model server; the brief asks to evolve it, not to add a document format. |
| Content identity | A **generation**: an opaque id minted when a result is first written, recorded in the manifest and in every page file, plus the sha256 of every page file in the manifest and a digest over those hashes. The recipe fingerprint stays what it is: the hash of what was asked. | "Do not equate a parsing-recipe fingerprint with the identity of its produced content." An evidence reference names the generation; a reader verifies the bytes against the manifest. |
| OCR execution | `kie/stages/ocr.py` owns cutting, transcription, acceptance and result publication. `kie/evidence.py` verifies those files and projects `Segment`s in memory. | The user's later direction places execution in KIE; the original brief's ban on a persisted OCR copy still holds. |
| The runner | Ordinary functions run ingest and OCR, then assemble evidence and report. Ingest retains recovery, verified caching and publication; OCR runs each invocation. No `Step`, stage registry or configurable chain. | Preserve necessary responsibilities without a workflow framework. |
| Geometry | One leaf module, `kei_exp/geometry.py`: box types and validators, the crop transform, the projections between crop pixels, unit points, unit pixels and PDF page points. `pages.py`, `pagefile.py`, `kie/model.py`, `kie/evidence.py` and `boxes.py` use it. The rendering algorithms (pdfium's canvas rounding, the book page's native-grid cut, the ingest's raster extraction and gutter search) stay where they are. | Shared metadata, distinct algorithms. |
| Coarse evidence | `PageSegment.extent: "block" | "input"`, invariant `extent == "input"` iff `bbox_px is None`. | A VLM segment, and a native page Docling yields no item for, keeps its whole-input box and says so; nothing fabricates a precise box, and nothing coarsens a precise one — a native page with items publishes Docling's own per-block boxes (amended 2026-09-22). |
| Units and pages | `Unit.kind: "pdf_page" | "book_page"`, invariant `kind == "pdf_page"` iff `index == 0`; every box field says its space in its name (§3.1). | "Define physical PDF pages separately from optional book-page units, with explicit coordinate names and units." |
| Reuse | Ingest reuse verifies its full recipe, schema, source, assets and digest. The result reader verifies page files, generation, completeness, optional source/ingest/transcriber binding and optional expected coverage. OCR results are not reused as a cache. | Full OCR recipe comparison and checkpoint reuse belong to step 5; the reader alone is not a cache decision. |
| The debug report | Unchanged: `--debug-dir` keeps writing `report.json` and the input PNGs. | A diagnostics artifact the README and the model-verification notes rely on; 50 lines. The evidence it also happens to carry is not read by anything. |
| Tests | pytest, under `tests/`, with shared fixtures and parametrised cases; recorded transcriber responses and golden outputs of the old writer under `tests/recorded/` and `tests/golden/`. Migrated scratch checks are deleted once their pytest coverage passes. `scratch/check_api.py` and `scratch/check_web.cjs` stay. | "Consolidate tests through shared fixtures and parametrization; remove tests only when ... equivalent coverage replaces them." |
| Frontend and API | Unchanged routes, shapes and event types. `boxes.page_geometry` reads version 3 and version 4 page files. | "Keep the frontend and public behaviour stable during this PR." |

Non-goals: the job backend, page priority, `page_ready` events, cancellation and the service API (step 5);
`RunParams`/`Execution` (the deferred candidate 3); `api.py`'s job state machine; `dev.py`; the web app.

## 3. The canonical evidence model (`RESULT_VERSION` 4)

### 3.1 Coordinate spaces

Every box field names its space. Boxes are `(left, top, right, bottom)`.

| Suffix | Space | Origin, unit | Type |
|---|---|---|---|
| `_pt` | The PDF page the file is for | top-left, y down, PDF points (72 per inch) | floats, `PointBox` |
| `bbox_px` (segment) | The space the engine read: the crop image it received, or — for a native page, whose engine read the PDF itself — the PDF page (amended 2026-09-22) | top-left, as the engine reported them: image pixels for a rendered crop or page, PDF points for a native page, where `bbox_px` therefore equals `bbox_pt` | floats |
| `source_px` (crop) | The unit's native raster (a book page's PNG) | top-left, native pixels, half-open `[left, right) × [top, bottom)` | ints, `PixelBox`; `None` for a crop of a PDF page unit, which has no native raster |
| `image_px` (crop) | The crop image | its size, pixels | ints |
| `origin_pt`, `pt_per_px` (crop) | The unit's own points (page points for the PDF page unit, book-page points for a book page) | pixel (0, 0) of the crop in unit points; points per pixel on each axis | floats |

A book page's points are its native pixels over its dpi (`72 / dpi`); its placement on the PDF page (the
ingest artifact's `Placement`, `source_rect` and dpi) maps them to `_pt`. The page file records the derived
`bbox_pt` of every crop and segment and the exact transform beside it, so a reader can use the derived box or
re-derive it.

### 3.2 The manifest, `result/result.json` (`Result`)

```
result_version: 4
generation: str                      # "<UTC timestamp to the microsecond>-<8 hex>", minted before the first page file
digest: sha256                       # over canonical_json({"pages": {n: sha256}}): the content identity of the generation
fingerprint: sha256                  # over canonical_json(recipe): the identity of what was asked
recipe: dict                         # unchanged from version 3 (result_version, source_sha256, ingest_digest, transcriber, ...)
source_name, page_count, effective   # unchanged
started: ISO 8601 UTC                # when the transcriber was called
seconds: float                       # the transcriber's wall time
status: success | incomplete
incomplete: str | None
pages: dict[int, PageEntry]          # every page file written, ascending; PageEntry = {sha256, complete}
tokens: {input, output}
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
output_tokens, seconds, stop, capped, incomplete}`: version 3's `transform` four-tuple becomes the two named
pairs; `seconds`, `stop` and `capped` are the record's diagnostics, so a reader of the result alone can see what
the debug report showed.

`PageSegment = {text, html, markdown, label, confidence, status, unit, crop, bbox_px, bbox_pt, extent}`, frozen.
`extent` is `block` when `bbox_px` is the engine's box of one block, `input` when the segment is a whole input
whose transcriber returned no boxes and `bbox_pt` is the input's extent. Text is never rewritten (`CONTEXT.md`
invariant 1); the two never carry different text.

### 3.4 Evidence references

`EvidenceRef = {generation, page, index}` (`kie/model.py`): the result generation, the PDF page whose file holds
the segment, and its position in that file's `segments` list. Resolution is `pages/<page>.json` of a directory
whose manifest names `generation`, then `segments[index]`. A reference is valid for as long as that generation
exists; a rerun is another generation, and a reference into it is another reference.

### 3.5 What does not change

`recipe` and its fingerprint, `PageRecord`, `Transcription`, the `Transcriber` protocol and the three adapters,
`Inventory` (the input ordinal to source identity map, built by the converter alone), the events, the debug
report, `params.json`, `status.json`, `output.md`, and the ingest artifact and its cache proof.

## 4. Geometry (`kei_exp/geometry.py`)

A leaf module (no docling, no pdfium): `PointBox`, `PixelBox`, `CropTransform(origin_x, origin_y, pt_per_px_x,
pt_per_px_y, source_px)` with `to_unit_points(bbox_px)`; `unit_pixels(bbox_px, source_px, image_px) -> PixelBox`
(the crop-image box on the unit's native raster, floor left and top, ceil right and bottom, as the stage 0 design
§3.1 rounds every transformed box); `clamp(box, within) -> PixelBox | None` (the reference placement policy of
the stage 1 design §4: clamp into the crop after rounding, `None` when empty); `unit_to_page_points(placement,
source_rect, spread_size_px, dpi, bbox) -> PointBox` (book-page points onto the PDF page: the four corners through
the placement matrix and the visible page's origin, their bounding box); and the validators the models share
(`ordered_box`, half-open pixel boxes). `pages.PdfPage.crop_transform` and `pages.BookPage.crop_transform` keep
their rounding rules and return the shared type; `BookPage.to_page_points` calls `unit_to_page_points`.

## 5. The writer and the reader (`kei_exp/result.py`, `kei_exp/pagefile.py`)

The writer (`write_result`) mints the generation, writes every selected page's file by rename, hashes the bytes
it wrote, and writes the manifest last with the hashes, the digest, `started` and `seconds`. Identities come from
the inventory as before; a page the cut found nothing on gets a file with no segments and a warning.

The reader lives in the leaf module beside the models, so that KIE and a viewer can use it without the converter:

- `read_manifest(directory) -> Result`: the file parses and validates, `result_version == RESULT_VERSION`.
- `read_page(directory, number, manifest) -> PageResult`: the file parses, `page == number`, `generation ==
  manifest.generation`, its bytes hash to the manifest's entry, `complete == entry.complete`.
- `load_result(directory, *, source_sha256=None, ingest_digest=None, transcriber=None, page_source=None,
  pages=None) -> LoadedResult(manifest, pages: dict[int, PageResult])`: the manifest, every page it lists,
  and the checks above plus: the files present under `pages/` are exactly the listed pages; `pages`, when given,
  is exactly that set; each expected recipe field equals the expectation; the recomputed digest equals the
  manifest's; the completeness rules of §3.2 hold. Every refusal is a `ResultError` naming the file and the
  field. `require_complete=True` (the KIE loader's setting) refuses `status: incomplete`.

## 6. The KIE consumer

`kie/evidence.py`:

```
load_evidence(result_dir: Path, ingest: IngestArtifact) -> Evidence
Evidence = {segments: list[Segment], report: EvidenceReport}
```

It calls `load_result(result_dir, source_sha256=ingest.source.sha256, ingest_digest=ingest.envelope.digest,
transcriber="surya", page_source="ingest", require_complete=True)`, then checks what only the ingest can
know (the stage 1 design §2, preconditions 4 to 8, unchanged): the listed pages are a subset of the spreads; a
file's unit indices are exactly the ingest's book pages of that spread and unit 0 is refused; every segment's
crop is a crop of its unit with a `source_px`; a whole-input segment is refused; an empty label is refused. The
projection is the stage 1 design §3 and §4, unchanged: ids `p{unit}_s{n}` positional per unit over every entry,
`bbox` through `geometry.unit_pixels` and `geometry.clamp`, a box that clamps to nothing rejected with its
locator and reason (`CONTEXT.md` invariant 5), overlapping crop pairs per unit reported. `Segment` gains `crop`
and carries `source: EvidenceRef` in place of `SegmentSource`. `Rejected` names the PDF page as `page`.

The runner assembles `Document(source, pages, segments)` after loading, so the assembled-level rules (every
segment on a page the document has, every box inside its page image) run on every load; the Document stays
in memory. The run report records what was read: `EvidenceReport = {generation, digest, pages_read,
spreads_without_pages, segments, rejected: list[Rejected], clamped, by_label, by_status, empty_text, overlaps,
seconds}`.

## 7. The runner and the command line

`kie/runner.py` runs ingest, then `kie/stages/ocr.run`, then the verified evidence reader. The OCR stage
receives the accepted book pages directly, so there is no second ingest invocation or artifact reload.
`PipelineConfig` contains `ingest` and optional `ocr` settings (`ocr: null` means ingest only). `RunReport`
contains `ingest: IngestStep` and `ocr: EvidenceReport | None`; OCR timing includes execution and validation.

`kie run --config C --pdf P [--run-id ID] [--runs-root ROOT]` writes canonical page files under
`<root>/<id>/<pdf stem>/ocr/`. OCR settings are Surya's URL, cut, layout model, crop DPI, image size and selected
spread range. Ingest reuse retains its existing verification and interrupted-publication recovery. OCR runs
again and publishes a new generation; it has no cache or checkpoint reuse. A narrower selection removes old
page files before the new manifest is published.

The Markdown CLI and API call `runner.convert`, which prepares ingest book pages when requested and invokes
the same `ocr.run`. `convert.py` contains only the Markdown CLI. Transcriber adapters remain unchanged.
The result directory is still selectable for the Markdown CLI; KIE no longer imports an external result.

## 8. Equivalence and tests

`tests/recorded/` holds recorded transcriber responses: the debug reports and parameters of three API runs on
disk (Surya over the ingest of the fixture spread, Surya over its PDF page, native over `main.pdf`), reduced to
what a replay needs (per input: the region, the image size, the payload, Markdown, text, tokens, reasons). A
replay builds the inventory from the recorded regions (the crops rendered from the fixture at the recorded
bboxes, or blank images of the recorded size) and the records from the recorded outputs, and calls
`write_result`. `tests/golden/` holds what the version 3 writer at `e5ad72f` produced from those replays.
`tests/test_equivalence.py` runs the replays through the new writer and compares every page file and manifest
with its golden after the documented version 4 mapping (`fingerprint` → `generation`; `transform` → `origin_pt`,
`pt_per_px`; `extent` from `bbox_px`; unit `kind` from `index`; the manifest's page list → entries), with text,
HTML, boxes and Markdown compared verbatim: non-ASCII text, tables (Surya's table HTML, text with tabs),
rotated placement and incomplete outputs are among the cases. CropBox offsets are covered separately by
geometry and page-source tests. The KIE loader is
compared with the stage 1 import on the same fixtures: the same ids, boxes, rejections and overlaps.

Coverage migrates check by check to `tests/`, with shared PDF, replay and transcriber fixtures.
The API and web checks remain `scratch/check_api.py` and `scratch/check_web.cjs`; `make check` runs both
alongside pytest. The upstream migration report (`docs/canonical-evidence-migration.md` at the import commit) maps every former check.

## 9. Deleted and superseded

The persisted `OcrArtifact`, its fingerprint/cache/publication path, `SegmentSource`, generic `Step` and
`STAGE_CHAIN`, configurable `stages` prefix, and repeated geometry are removed. The new `OcrConfig`
describes execution settings; the new `ocr.run` executes the transcriber. Seven remaining scratch scripts
were removed after their pytest ports passed; the four KIE checks and result check had already migrated.

## 10. Visible behaviour changes

1. `RESULT_VERSION` 4 adds generation and integrity metadata (§3); the viewer still reads version 3 runs.
2. KIE runs OCR itself, writing `ocr/result.json` and `ocr/pages/<n>.json`. The old external `--result-dir`
   input and `stages` list are gone; `ocr: null` explicitly selects ingest only. The report has `ingest` and
   `ocr` fields. These KIE interface changes follow the user's later direction.
3. Markdown CLI flags, API routes, SSE events, debug output and frontend behaviour are retained.
4. The manifest's `pages` is a mapping; `tokens`, `status`, `incomplete`, `source_name`, `page_count` and the
   `/api/runs/{id}/result` route are as before.
5. `make check` runs pytest, the API check and the web check.

## 11. Deferred to step 5 (service readiness)

Bounded preparation and inference; publishing pages as they finish and `page_ready` after the file is
retrievable (the writer's atomic per-page publication and the reader's per-page verification are the hooks);
visible-page priority; Procrastinate with supervised exclusive worker ownership and startup reconciliation
(`docs/job-backend.md`); cancellation, checkpoint-aware retries (a retry reuses the pages of the generation it
resumes, verified by `read_page`), admission limits, replayable progress; the versioned service API; the FREE
export boundary.
