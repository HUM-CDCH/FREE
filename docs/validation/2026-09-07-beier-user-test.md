# Beier catalogue rehearsal — 7 September 2026

Status: in progress. Ingestion, schema generation, revision persistence and the
deterministic checks below have been exercised. The full extraction and review
using the final code remain to be verified; this document does not yet certify them.

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

## Remaining live verification

- Complete extraction and evidence grounding using the final schema and code.
- Inspect representative multi-part entries, follow evidence to the original
  PDF, save review decisions, export, and reopen the reviewed result.
- Verify a fresh `pnpm dev` start with the final changes and retained state.

OCR still contains some damaged words and line joins. A successful run establishes
coverage and operational readiness, not scholarly accuracy. Extracted values and
their source evidence need researcher review, especially long descriptions and
abbreviations. The complete scan is expensive to parse and the full catalogue
requires hundreds of model calls; retain the prepared Source Representation for
the rehearsal rather than estimating its runtime from a small sample.
