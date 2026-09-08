# Beier catalogue rehearsal — 7–8 September 2026

Status: live rehearsal finished. The workflow was exercised locally through
ingestion, schema generation, extraction, evidence navigation, review drafts,
CSV/Excel export, and reopen. The final Extraction contains all 420 expected
entries but is marked incomplete because one populated field is ungrounded.
Model values still require researcher review, as detailed below.

## Source and prepared project

- Source: `Beier1988_GAC_02_Catalogue.pdf`, 68,086,716 bytes, 45 physical pages.
- SHA-256: `31b024007313aa5323e5d428ea49ec47dfd236ed95a31a56ba14cacc3211dc2f`.
- The source is an image-only scan of landscape spreads: two printed pages,
  each with two text columns, on most physical PDF pages.
- Project: **Beier catalogue — user test**, owned by the local development
  Researcher Account.
- [Open the prepared Source Document](https://localhost:8443/free/projects/3513480b-8122-415a-b7ee-6739e6ea53c8/documents/b22e2499-1745-4400-90c1-829cf97ff04b).
- Source Representation: `12ed88db-d3fa-4b1d-8b7b-92b88ca3c856`.
- Both model routes use `qwen3.8:27b` through the supplied Ollama endpoint,
  `http://spark.cdch-dgxspark.lan.ku.dk:11434`, with general execution.

The rehearsal uses one record per complete catalogue entry. Its selected scope
is physical pages 2–32: main entries 1–378 plus the inserted entries 649 and 650,
u1–u8, a1–a29, and the three entries under **Katalognachtrag**: **420 records**.
Lettered subentries remain within their parent. Later summary lists, the
findspot index, bibliography and figure captions are excluded. This scope is
written in the editable Record description.

## Findings and corrections

| Observed problem | Correction and evidence |
| --- | --- |
| The original PDF exceeded the checkout's 50 MiB limit and received HTTP 413. | The merged development branch provides the 100 MiB file limit, 101 MiB application envelope and 110 MiB proxy limit. The unchanged original passed the browser upload; additional HTTP regressions retain and verify a 65 MiB PDF. |
| Docling joined adjacent columns and reordered entries. Increasing OCR resolution or changing its layout model did not resolve this. | Detect clear gutters in image-only landscape spreads, parse lossless column crops, and restore physical PDF page coordinates. Preserve original list markers and publish separate, exact UTF-8 evidence spans. Geometry/publication regressions use a synthetic scanned spread. |
| A numbered entry was classified as page furniture and omitted. | Retain numbered entry text mislabeled as a header/footer after cropping. All 420 expected opening labels are present in the final canonical source. |
| The actual parse exceeded the previous ten-minute ingestion deadline. | Allow a bounded thirty-minute ingestion wait. The final full parse completed in 796,971 ms (13 min 17 sec). |
| A full-source schema prompt was too large; generated array and field shapes were unreliable. | Use bounded excerpts from every physical page for schema design and clarify the supported template format. Extraction still uses the full canonical source. |
| Catalog discovery could select only heading blocks, omitted entries at excerpt boundaries, and included later index rows. | Label all canonical text/list blocks. Keep normal physical pages together, split oversized pages at whole blocks, include nearby unselectable context, and carry the previous record/section boundary across excerpts. Validate copied IDs against the current excerpt. The full real-model discovery probe found all 420 expected entries, with no extras, in 45 calls. |
| A per-entry array template let the model split entry 40 into two root records. | Request one record object per canonical entry and retain the public result array. The real-model check keeps both parts and both museum references in one entry; regressions reject an invalid per-entry shape without losing successful siblings. |
| The 100-record cap prevented this catalogue from completing. | Raise the bounded per-run cap to 500 and the Catalog execution deadline to three hours. Unit coverage includes a 420-entry run and explicit diagnostics beyond the cap. |
| Evidence search included the entire catalogue for every record. | Restrict record-scoped evidence candidates to each record's canonical slice. Regression coverage rejects links to another entry. Existing whole-anchor and lexical checks remain in use. |
| The strategy selector displayed Article and the PDF hint said to run extraction while a Catalog extraction was already running. | Display the active extraction's strategy and a running status hint; preserve the existing next-run default. Browser/component coverage verifies the active strategy. |
| The developer evidence inspector mounted all 3,252 anchor buttons, including while hidden. | A native physical-page selector renders one page's anchors at a time. A regression verifies page selection and navigation to an anchor on the second page. |
| The PDF viewer drew evidence rectangles on blank scanned pages. The worker reported that the JBIG2 decoder could not initialize without `wasmUrl`. | Copy the installed PDF.js decoder assets into Vite's public assets for development and production, and configure both browser and Node PDF rendering to use them. The original physical page 2 rendered with default canvas settings; selecting entry 3 Havelberg then highlighted its printed text. The Node image fallback also rendered the same page successfully. |
| Evidence navigation moved vertically but left passages in the right-hand columns off-screen. | Center the focused passage on both axes in the existing shared navigation function. Regressions cover horizontal-only movement and a distant page; a live check highlights the restored entry 226 heading on the right-hand printed page. |
| The Ollama adapter did not pass the cancellation signal to its HTTP request. | Use the existing AI SDK middleware and combine request signals in a call-scoped fetch. The adapter regression fails without the fix and passes with it. Raw NuExtract retains its existing protocol and temperature. |

## Reproduced ingestion and schema checks

The final full ingestion used Docling 2.120.3 and produced 45 physical pages,
3,093 content blocks, three tables with 162 cells, 3,252 evidence anchors and
535,365 bytes of canonical Markdown. Its 78 diagnostics describe column
separation and reading-order corrections. The retained source was downloaded
through the authenticated resource route after a Studio restart; its byte count
and SHA-256 exactly match the original.

Schema generation was exercised through Studio with the real Ollama model.
The saved schema has six fields: catalogue label, locality/findspot, FA code,
find description, a repeated list of museum/inventory passages, and a repeated
list of references. Revision 6 clarifies identifier-only labels, short source
quotations, abbreviated collection references (Mus., LM, HK, Inv.-Nr.) and
exclusion of Mbl. map-sheet references. Saving revisions while an extraction
ran preserved the extraction's pin to revision 2.

The complete discovery-only probe used the production executor and real Ollama
model, with only the source-filename field to isolate discovery. It returned
exactly 420 parent boundaries, including the formerly omitted short and
page-boundary entries, and excluded later index rows. It took 1,011,769 ms
(16 min 52 sec) while sharing Ollama with another run. The confirmation with
revision 6's final Record description also returned all 420 expected starts,
with no extras or duplicates, in 45 calls and 1,401,357 ms (23 min 21 sec) while
sharing the model with the ongoing full extraction.

The final full Studio run, `5c2e6fbc-6c32-4603-b97c-48f1a5975fb5`, started at
21:54:23 UTC on 7 September using Schema Revision 6
(`32860369-2d89-4031-93bd-af016cda089d`). Discovery took 546,528 ms (9 min 7 sec)
and returned the exact 420 expected starts, without extras or duplicates.
All 420 stored start/end boundaries match the final-schema discovery probe,
including entry 233's continuation onto the following page and the final
supplement's exclusion of subsequent captions and indexes. Values extraction
took 3,462,294 ms (57 min 42 sec); all 420 per-entry requests succeeded, all
six-field shapes are valid, and every identifier matches its expected parent.

The run finished at 23:40 UTC on 7 September. Total execution time was
6,346,918 ms (**1 hr 45 min 47 sec**), including 2,333,195 ms (38 min 53 sec)
for 420 grounding calls. All 45 discovery, 420 values and 420 grounding calls
completed successfully. The persisted outcome is `SUCCEEDED`, with
`reviewable: true` and `complete: false`: **3,513 of 3,514 populated values**
have Evidence links. The single ungrounded path is entry 356's `fa_code`.
All retained links reference valid anchors inside their own parent entry;
there are no links into adjacent entries or the later indexes.

The result has 363 non-verbatim flags: 96 FA values, 93 literature references,
71 descriptions, 58 museum references, 43 locality/findspot values and two
catalogue labels. A further 1,287 links have the separate repeated-passage
warning, producing Studio's total **1,650 To check**. Repeated short labels
and classification codes can occur in many passages; this count is not a count
of missing records or failed model requests. Neither warning is an approval.

Real-model value checks covered main entries 1, 3, 29, 40, 62, 226, 649 and 650,
plus u1, a1 and the first supplement entry across schema refinements. The final
schema sample retains the collection references from all parts of 29 and 40;
entry 649 has an empty museum list. Grounding those three final-schema records
produced 34 links within the corresponding entry boundaries, with no invalid
IDs or ungrounded paths. Six values had non-verbatim flags: these include quotes
spanning two OCR blocks, expanded abbreviated citations, and the existing
conservative treatment of single-letter classifications. These links establish
navigation and traceability, not approval of the values.

## Deterministic verification

Run these from the repository root. PostgreSQL integration tests require fresh,
migrated disposable databases under the README's safety restrictions.
The checks include development-branch changes through `ef878809`, including
atomic lease/draft guards and the completion/review UI.

| Command | Observed result |
| --- | --- |
| `pnpm test` | Passed: Studio 1,014, database 54, extraction 48, export 33, configuration 4, launcher 37 plus one Windows skip; Python 19 plus one opt-in live-model skip. |
| `pnpm typecheck` | Passed after resolving the development-branch merge. |
| `pnpm lint` | No errors; three existing React hook warnings. |
| `pnpm build` | Passed with the PDF decoder assets present in the production output; existing bundle-size warnings remain. |
| `pnpm test:safety` | 14 passed. |
| `pnpm test:postgres` | Three project-store and 21 extraction integration checks passed, using newly created `free_test_beier_store_final_20260907` and `free_test_beier_extraction_final_20260907`. |
| `pnpm test:e2e` | 50 passed, one developer-inspector skip, after the development-branch merge and all PDF/evidence changes. |

No reset or deletion of the development database was used. The PostgreSQL and
browser integration tests used their disposable databases/stacks.

## Live review, export and persistence verification

Studio displayed the completion dialog with 3,513 grounded values and one
ungrounded value. **Review now** opened the complete record collection and
its visible incomplete-result warning. The used and Current Schema Revisions
both remained revision 6.

The browser checks inspected entries 3, 18, 29, 40, 226, 649, u1, a1 and the last
supplement entry. Entry 29 retains all four museum references, and entry 40
retains both, within one parent record each. Selecting their later subentries'
Evidence navigated to the corresponding original passages. Entry 226's label
was present and highlighted on the right-hand printed page. Scanned pages
rendered after navigation; no browser warning or error was reported.

For entry 18, an approval of the printed label and an edit from the original
632-character description to a verified 316-character source quotation saved
as draft version 2. Both decisions, including the shortened visible value,
survived a full browser reload. A rejection of the last supplement entry's
incorrect FA value then saved as draft version 3. The underlying Extraction
values remained unchanged throughout.

Both actual **Export** buttons were exercised after reopening draft version 2,
using **Rows represent: Root result**. The CSV (163,872 bytes) and Excel
(66,430 bytes) each contain **420 data rows and six columns**. Every cell was
compared with the stored values plus the saved edit: zero mismatches in either
file, including repeated museum and literature text joined within their cells.
The Excel workbook has one `Results` sheet, a frozen header, filters covering
`A1:F421`, and no formulas. These are rehearsal exports of a partial review,
not finalized research data.

The three rehearsal decisions were restored to pending through the existing
version-checked review reset API, after confirming that no other decisions had
been added. A fresh API read returned draft version 4 with zero decisions;
reopening Studio showed all 3,513 eligible values pending and the original
632-character description. The prepared result is left for the researcher's
own review. Finalization of an entire review is covered by the deterministic
tests; no bulk approval of this catalogue was performed.

The unedited complete review request measures 1,031,036 UTF-8 bytes, within the
existing 1 MiB API body limit. The live partial draft writes also passed.

A fresh `pnpm dev` start with the final merged code completed at 21:50 UTC on
7 September. The image build and health checks passed, migrations reported
already up to date, and the prepared Project Context, Source Representation,
Schema Revision 6, previous Extraction, and unchanged source PDF were retained.
The final full Extraction above was started through the newly loaded Studio.

## Researcher review priorities

The final values contain 21 descriptions longer than the Record description's
400-character guidance: main entries 18, 26, 53, 57, 61, 72, 102, 115, 157,
171, 173, 179, 182, 189, 191, 211, 213, 269 and 373, plus u1 and u7. These are
model-output review items; the recorded source quotations were not silently
truncated to make the check pass.

Entries 356 and 364 illustrate semantic review items. Entry 356's `fa_code`
contains the find description as well as `vG`; the grounding model returned
`NONE` for that field even though the text is in the canonical passage. Entry
364's model output put
`EvG. Verz. KA.` into `fa_code` and left `find_description` empty. The source
line is `FA: EvG. Verz. KA.`; the classification and find description require
separation during review. The empty FA fields for a10 and a27 correspond to
entries with no printed `FA:` marker.

The third supplement entry has no printed `FA:` marker. Its model output
nevertheless places `KAK` in `fa_code`, using a word from the passage in the
wrong field. This was the verified rejection example above and is restored
to pending with the other rehearsal decisions. A locatable passage alone does
not establish that a value fits the field's meaning.

## Steps for the test

1. Leave the prepared development stack running, or start it from this branch
   with `pnpm dev`. Open the prepared Source Document linked above and sign in
   through the local development sign-in if requested.
2. In **Schema**, inspect the saved **Beier catalogue entries** schema and its
   Record description. Confirm that complete parent entries are the research
   unit and that the six fields answer the research question.
3. In **Results**, inspect the prepared full Extraction. Start with entries
   3, 18, 29, 40 and 226; also inspect an inserted, u-prefixed, a-prefixed and
   supplement entry. Select Evidence to check the original scan. Check linked
   passages even when a value has an Evidence link.
4. Approve, reject or edit individual values. Partial decisions save as a
   draft; FREE finalizes only after all eligible values have explicit decisions.
   Do not use **Approve remaining** merely to dismiss review work.
5. Use **Export** and keep **Rows represent: Root result** to retain one catalogue
   entry per spreadsheet row. CSV and Excel contain the visible values,
   including saved draft edits; an export does not imply that review is complete.
6. To test a new full Extraction, choose **Catalog** in the Extraction strategy
   selector and run with the Current Schema Revision. Keep the prepared result
   available for the review portion of the session: this full run took about
   1 hr 46 min after ingestion, and ingestion itself took 13 minutes.

OCR still contains some damaged words and line joins. A successful run establishes
coverage and operational readiness, not scholarly accuracy. Extracted values and
their source evidence need researcher review, especially long descriptions and
abbreviations. The complete scan is expensive to parse and the full catalogue
requires hundreds of model calls; retain the prepared Source Representation for
the rehearsal rather than estimating its runtime from a small sample.
