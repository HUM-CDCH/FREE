# Selective image OCR

Date: 2026-10-01. Status: implemented and verified locally; not deployed to
Baratheon. Changes apply to future ingestions and reprocessing.

Native text is retained when every selected nonblank page has a text layer.
Substantial textless embedded images/forms are OCR crops. Existing scan routing
remains for mixed documents, page-sized scans with text overlays and rotated
artwork. Overlapping crop unions that contain native text also retain that route.
The existing 5% artwork threshold remains. Native blocks, OCR crop transforms,
reading order and incomplete outcomes use the existing canonical page contract.
No DBOS workflow step was added, removed or reordered.

## Fowler PDF

The supplied 51-page PDF has SHA-256
`67cfe545768e2b3260da90e53236a26fe849443f94b8e6864e3f8cd8ccc48dc9`.
The prior Baratheon conversion completed in 14.84 minutes and OCR'd 107 layout
regions. The new route selects five embedded regions on pages 1, 15, 24, 28 and
36. Pages 15, 24 and 36 contain image tables; page 28 contains a diagram.

A complete conversion with local CPU Docling and Baratheon's existing Surya
server took 110.85 seconds wall time. It published 51 successful page files,
705 native blocks and 28 OCR blocks. This uses different hardware for native
processing from the original run and is not a controlled performance comparison.
The completed real-model pytest run took 121.57 seconds, including test setup.
OCR transcription quality remains that of the selected backend; this validation
checks routing, publication and evidence, rather than establishing a gold text
transcription of the embedded images.

Temporary real-model output and debug records are in
`/tmp/free-fowler-selective-ocr`. A replay of their native and OCR backend records
through the final code took 0.54 seconds, published all 51 pages with five crops,
and asserted that every native segment's text matched the real-model run. Crop
orders restart at zero per page and ink shares are measured on PDF previews.
Debug artifacts are validation inputs only, never extraction inputs.

## Verification

Historical: these are the counts from the first implementation, before either
review. "Review fixes" and "Second review fixes" below supersede them; the
current counts are at the end of the latter.

- Parser fast suite: 1,107 passed, 72 skipped, 76 deselected before the final
  missing-native-evidence guard.
- Final hybrid regression suite: 10 passed, 1 live-model test deselected.
- The new guard's test first failed because OCR hid missing native blocks, then
  passed after the conversion was marked incomplete.
- Studio translation: 9 tests passed, including mixed native/OCR evidence,
  Markdown spans, bounded geometry and the text-layer flag.
- Studio TypeScript build check, targeted ESLint, targeted Ruff and
  `git diff --check` passed.
- Real-model conversion and final captured-output replay passed as described
  above. No database, live application state or deployment was changed.

Run deterministic regression tests from `prototypes/parsing_service`:

```bash
.venv/bin/python -m pytest tests/test_hybrid.py -q -m 'not live_model'
```

Run the opt-in real conversion with a supplied illustrated native PDF and a
serving Surya endpoint:

```bash
KEI_HYBRID_PDF='/path/to/document.pdf' \
KEI_HYBRID_OCR_URL='http://127.0.0.1:8000/v1/chat/completions' \
.venv/bin/python -m pytest \
  tests/test_hybrid.py::test_real_native_and_selected_ocr_backends_preserve_the_illustrated_pdf -q
```

## Review fixes

A follow-up review found coordinate, reading-order, versioning, Markdown and
provenance defects. Each fix has a deterministic test on generated PDFs or
synthetic records. The live validation above was not rerun.

- **Page-box origin.** PDFium measures objects in canvas space, but crops are
  rendered in displayed-page space. Region boxes now subtract the origin of
  `PdfPage.get_bbox()`, and the union text check adds it back. CropBox and
  MediaBox fixtures at origin 50,50 return `(72, 292, 372, 442)` and render an
  all-black crop. Before the fix the crop was shifted to `(122, 242, 422, 392)`.
- **Nested forms.** An object inside a Form XObject is now mapped through every
  enclosing form matrix. A translated form gives one fully dark region, where
  before it gave a white bogus crop and the real one. The forms are still walked
  recursively, not capped with `max_depth=1`, because that walk is how a
  page-sized scan or a textless image inside a form that also holds text is
  detected.
- **Reading order with several crops on a page.** Each crop now has one anchor,
  computed once by the OCR stage from the native block boxes. The page Markdown
  and the page-file segments both use that anchor through `regions.splice`. A
  crop's `order` is its reading rank on the page, so crops still follow their cut
  order. `passages.order_issues` now holds whole-page passages (`crop: null`) to
  unit order only, and still flags crops that run backwards. The page-file
  comment and the canonical-evidence spec state this rule. A two-column fixture
  checks the Markdown, page file, events, report and evidence load, and finds no
  order issue. On that fixture the crop numbering (1, 2) differs from the reading
  order (B before A).
- **Marginal artwork.** Artwork with no aligned native block used to be placed
  first, ahead of the running header. It now follows the last block wholly above
  it.
- **Text-rules coupling.** A hybrid recipe now records `text_rules` as
  `{"hybrid": 1, "native": 2}`, plus the OCR kind's rules if it has any. Bumping
  `native` changes both native and hybrid fingerprints. Scan routes, which have
  no text rules, keep the fingerprints they had.
- **Markdown dialect.** On a supplemented page, the Markdown now leaves out
  `PageHeader`/`PageFooter` blocks and writes `Title`/`SectionHeader` as
  `#`/`##`, which is what Docling's native page export does. The furniture blocks
  stay in the page-file segments as evidence.
- **Provenance.** The manifest's `effective` image cap and scale now come from
  the OCR header on hybrid runs. Studio reports the parser version as
  `docling <version> + <model>`.
- **Ownership.** `HybridText` is no longer a registered transcriber with a
  backend registry injected into it. The OCR stage's `supplement` function runs
  the native adapter and the model's adapter unchanged. It renders crops with
  `cut.artwork_crops`, announces them through the same `announce` helper as cut
  crops, and maps page events through the ordinary crop inventory. The crop
  passthrough in `page_events` is removed. `transcription/hybrid.py` now only
  merges. The test-only `has_native_text` wrapper and the `hybrid` knob-table row
  are gone. Knobs are checked against the model's adapter, as before.
- **Guard.** `_covered` now tolerates a page that Docling did not build, like
  `blocks_of` does.

Artwork ink is the cut's measure (`gray < 128`). It is taken as a share of a
72 dpi whole-page preview with no scanner border, so it is diagnostic and not
comparable to scan-cut ink.

Checks after the first fixes (historical; superseded by "Second review fixes";
all with `-p no:cacheprovider`, from `prototypes/parsing_service` unless noted):

- Focused suites (`test_hybrid`, `test_extract_evidence`, `test_native`,
  `test_convert`, `test_pages`, `test_result`, `-m 'not postgres and not
  live_model'`): 121 passed, 22 skipped, 5 deselected.
- Full fast suite (`-m 'not postgres and not live_model'`): 1,115 passed,
  72 skipped, 76 deselected. The pre-fix baseline was 1,108 passed; the
  difference is the 7 new tests.
- Ruff on the changed Python files: only the four existing E741 hits in
  untouched `cut.py` lines, which the pre-fix snapshot also has.
- Studio (`prototypes/studio`): `vitest run api/_kei_exp.test.ts` 9 passed;
  targeted ESLint and `tsc -b` passed. `git diff --check` passed.

Limits:

- No live model, server, database or deployment was used.
- The Fowler PDF was not reopened, and the captured-output replay was not rerun.
- Results published before this fix keep their old fingerprints and page files.
  A new hybrid run gets a new fingerprint (the `text_rules` shape) and, on crop
  pages, Markdown without furniture.
- Rotated artwork still takes the scan path.

## Second review fixes

An independent review of the fixes confirmed every earlier finding fixed and
found one remaining reading-order defect, plus documentation and provenance
nits. The live validation above was not rerun.

- **Running heads and feet no longer place artwork.** A full-width
  `PageFooter` was the only block below artwork at the foot of a left column.
  The artwork was then anchored before the footer and read after the whole
  right column. Likewise, artwork heading a textless right column was anchored
  after the full-width `PageHeader` and read before the left column.
  `regions.anchor` now takes the indices of the page's `PageHeader` and
  `PageFooter` blocks (`hybrid.FURNITURE`). Those blocks keep their indices and
  their place in the page file and evidence, but they never place artwork. The
  OCR stage still computes each anchor once, so Markdown and segments share it.
  Body blocks in the artwork's span still bound it. Between the last one above
  and the first one below, the artwork now also follows any block not wholly to
  its right, which is an earlier column. As a result, a full-width body section
  below a column no longer captures that column's artwork either. Marginal
  artwork still follows the last body block above it. If there is no such
  block, artwork beside body text heads its own column and follows the body
  wholly to its left, which is how Docling reads column heads.
- **README.** It now says that a crop's `order` is its reading rank, and that
  the `crop` ordinal is discovery order.
- **Studio provenance.** A hybrid run with a Surya record (no Docling VLM spec
  in `recipe.record`) reports `docling <v> + surya-ocr <v>`. A VLM run reports
  `docling <v> + <model>`, because Docling's version already covers its
  pipeline, and the Surya package version the service records for every run is
  not that model's. When `surya-ocr` or the record is missing, it falls back to
  `docling <v> + <model>`.
- **Permanent safeguard tests.** The review's probes are now tests. Overlapping
  artwork whose union encloses native text keeps the scan path. When the OCR
  backend raises `ConnectionError`, the run closes every rendered crop, the
  error is retryable, and no result is written.
- **Retained cosmetic nit.** On a supplemented page, native list items are
  separate paragraphs in the page Markdown, where Docling's own export makes a
  tight list. Their source markers stay in the text (`orig`). A tight list is
  only valid Markdown when a marker happens to be a Markdown list marker:
  glyphs such as `•`, `a)` or `(i)` would render as one merged paragraph, which
  is worse. Fixing it properly means recognising or stripping markers, so it
  was left alone. Evidence, segments and Studio's rendering are not affected.

New tests: two `anchor` unit tests (furniture, and body sections spanning both
columns), a three-page OCR-stage regression, and the two safeguard tests. The
OCR-stage regression covers left-column artwork above a full-width footer,
right-column artwork below a full-width header, and marginal artwork under the
header. It checks Markdown order, segment order, crop `order`, and the
passages that `passages.load` returns, with no order issues. With the
baseline `regions.py`/`ocr.py`, the stage test and both unit tests fail. With
the new `regions.py` but no furniture passed from `ocr.py`, the stage test
fails on the marginal page.

Checks (all with `-p no:cacheprovider`, from `prototypes/parsing_service` unless
noted):

- Focused suites (`test_hybrid`, `test_extract_evidence`, `test_native`,
  `test_convert`, `test_pages`, `test_result`, `-m 'not postgres and not
  live_model'`): 126 passed, 22 skipped, 5 deselected (was 121 passed; plus
  the 5 new tests).
- Full fast suite (`-m 'not postgres and not live_model'`): 1,120 passed,
  72 skipped, 76 deselected (was 1,115 passed).
- Ruff on the scoped Python files: only the four existing E741 hits in
  untouched `cut.py` lines.
- Studio (`prototypes/studio`): `vitest run api/_kei_exp.test.ts` 10 passed
  (the 9 before plus the provenance regression). Targeted ESLint and `tsc -b`
  passed. `git diff --check` passed.

Limits: the anchor rule was checked on synthetic native blocks with a real
PDF, real region discovery and real publication. No Docling-labelled publisher
page was run end to end. A textless column with body text above it in another
column is still read as a marginal figure (after the last body block above
it); geometry alone cannot tell the two apart. No live model, server,
database or deployment was used.

## Bounded final review (historical)

This record predates both reviews. The `review_followup_required: false` below
was the first implementation's own conclusion, and the reviews that followed
overrode it.

```yaml
simplify_and_harden:
  simplify:
    cosmetic_applied: [removed_unused_crop_image_bindings]
  harden:
    applied: [reject_missing_native_evidence_even_when_ocr_succeeds]
    flagged_critical: []
    flagged_advisory: []
  document:
    comments_added: 1
  verification:
    result: pass
    evidence: final_hybrid_tests_and_full_pdf_backend_replay
  summary:
    review_followup_required: false
```
