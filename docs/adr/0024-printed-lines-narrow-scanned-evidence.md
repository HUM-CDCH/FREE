# 0024: Printed Lines narrow cited Evidence on scanned pages

Date: 2026-10-29. Status: proposed; amends [0017](0017-durable-extraction-control-and-call-checkpoints.md) (the
workflows the worker registers) and the durable execution spec's
[Deletion and garbage collection](../design/unified-durable-execution.md#deletion-and-garbage-collection)
(attempts only read runs).

## Context

Since PR #315, Studio boxes a segment link's mark to its quoted text when pdf.js's text layer shows it (`narrowBox`
in `useEvidenceOverlays.ts`). Where a scanned page has no text layer, or one that does not show the quote, its mark
stays the whole Source OCR block, usually a paragraph. That costs precision, not correctness: the paragraph is
locatable Evidence under the product contract (item 4), and an Evidence Anchor needs no visual geometry.

Nothing finer exists. Surya (surya-ocr 0.22.1), the default OCR model, returns one box per block; on 3 pages probed
its full-page output held no nested line boxes. A segment Surya read keeps that one box (`PageSegment` in
`pagefile.py`), and parsed_document.v2 gives each text observation one bbox (`parsed-document.ts`). The recipe
path's lines are source lines, "because Surya's blocks are paragraphs and no line geometry exists"
(`kie/stages/layout.py`).

Over the saved Studio extractions (17 with Evidence, 5,548 links, 6 documents, 2 of them real scans), 1,069
citations sit on OCR'd blocks whose text layer does not show the quote; their blocks print a median of 3 lines (p90
9, max 24). A stop rule set beforehand (90% of citations in a block of at most 3 lines, or quoting all but at most 2
of its lines) held for 59%. The need is in long-paragraph scans: half of a 41-page scanned book's 219 citations
quote at most 2 lines of a block of 8 or more. The sample is two documents, a quote's lines were estimated
proportionally, and only about 1,860 of the 5,548 links carry spans for their passage.

Reading the lines was tried on 11 scanned pages (10 of a scanned book volume and a 1790 newspaper page; 376 lines).
Surya's text-line detector (`DetectionPredictor`) finds the lines, one Surya block request rereads each, and the
readings are aligned to the block's saved text, so each line owns a code-point range. In the book's body none of
298 cuts failed both edge-word checks and the lines covered at least 99.6% of each block; the noisier footnotes
showed no wrong cut. On a checked newspaper block 118 of 119 words fell on the right line (96 when placed
proportionally). Another newspaper block read garbled yet passed a 90% cover check: cover alone cannot certify a
split. These probes ran outside the repository; their methodology and results are summarised in the pull request
that adds this ADR, and their data is not redistributable.

## Decision

Narrow only what Evidence cites, after extraction and off its critical path. A **Printed Line** is a line as the
page prints it: its box on the PDF page and the code-point range of its segment's text that it holds, unlike the
recipe path's source line.

- **Started where links are made.** Links and spans are the Parsing Service's output (`publish_final` saves the
  result's `evidence`; Studio only projects `spans` onto `grounding.textSpans`). So once `publishExtractionResultV1`
  has published a result whose processing completed (`processing_complete`; not a historical-only one),
  `extractDurableV1` enqueues `extractLinesV1` as `kei-lines:<attempt>` without waiting, with identities only: the
  run, its Result generation and the cited segments' Evidence references. `extractLinesV1` joins 0017's list of
  registered workflows; the new step is behind DBOS patch `extract-lines`, and a failed enqueue is logged and never
  stops the acknowledgement.
- **On its own lane**, `kei-lines`, one workflow at a time. Its line reads go to the OCR server conversions use.
- **What it reads.** Each segment that a link with spans cites and that Surya read as one block (extent `block`, not
  a native page's Docling block): the detector runs over its box and one Surya block request reads each line. Line
  crops follow the cut path's crop planning, render limits, cancellation and white margin; boxes reach PDF points
  through the crop's transform, whose origin the margin moves out (`CropTransform.to_unit_points`, then
  `unit_to_page_points` on a book page). A line gets no range if its read loops, hits its token limit or comes back
  empty (#321's guard covers full-page reads only), or if it aligns to the segment's text as well elsewhere; a block
  gets no lines unless they cover 90% of its text and lie inside its box. No check depends on a quote, so a block's
  lines serve every link that cites it.
- **The detector** is the worker's first text-line detector and first local Surya model (Docling's layout detectors
  already run in-process; Surya is otherwise an OCR-server client). Once it passes the gate below, it runs
  process-local (`DetectionPredictor.local()`, not Surya's autostarted server) on the CPU, where the worker runs all
  its models. Its checkpoint (Surya 0.22.1 names `text_detection/2025_05_07`, fetched on first use from Datalab's
  model host into Surya's cache) is pinned by digest.
- **Gated on a CPU benchmark.** The only CPU figure is a laptop's: about 161 s per full page at 192 dpi, against
  1.35 s on its GPU (a GTX 1650 Ti); full pages, not block crops, not the production host. Before implementation,
  detection on cited-block crops is benchmarked on the production worker's CPU: initialisation, batching, the total
  for one extraction's cited blocks, and contention with a running conversion. Budget: initialisation at most 60 s
  per workflow, at most 5 s per cited block at p90, no conversion more than 10% slower. Past it, blocks keep the
  paragraph mark, and a GPU detector needs a deployment amendment: a detector model server, or GPU access and a GPU
  torch build for the worker.
- **Stored as a derived artifact of the parse**, as a recipe segmentation is (`kie/segmentation.py`): one file per
  cited segment under the run, named by Result generation, Evidence reference and algorithm version, published by
  rename, and recording the digest of the text it was aligned to, the detector checkpoint, the OCR model and
  `KEI_OCR_REVISION`. A published file is kept, so a later attempt redoes no block. Canonical manifests and page
  files, parsed_document.v2 and the Evidence links are unchanged; Extraction never reads the artifact.
- **Read through Studio.** kei's API gains a read-only route beside `/result` and `/pages/{n}` for a generation's
  Printed Lines. Studio serves them as `lines` beside a Source Representation's `pdf`, `markdown` and `source`
  (`source_representations.ts`): after the same ownership check it branches before the canonical-package read, finds
  the run from the revision's preprocess ID (`keiRunOf`) and reads kei with bounded reads; the other resources'
  decoding is unchanged. A missing, unreadable or digest-mismatched file gives no lines.
- **Drawn by Studio.** Where the text layer does not narrow a segment-precision link (a scan has none, or its
  overlay lacks the quote) and its block has lines, `narrowBox` unions the boxes of the lines whose ranges overlap
  the link's spans; a quote with any code point outside a ranged line keeps the paragraph mark. The overlay draws
  that box inside the paragraph outline, which stays visible (a text-layer box replaces the block's today).
  Evidence is still located by its anchor's identity, as [0005](0005-parsed-document-v2-canonical-content-stream.md)
  requires; `narrowBox`'s text match and Printed Lines only refine how the located box is drawn.
- **Failure leaves paragraph marks**, and the Extraction's outcome never depends on enrichment.
- **It follows the representation's lifecycle.** The files live in the run, which Studio's `collectGarbage` hands
  to `deleteRuns` once no Source Representation revision or durable head names it. `kei-lines:<attempt>` joins its
  attempt's durable graph: Studio's reconciler, scope cancellation (`cancelScopeWork`), the kei stand-in used in
  tests and `delete_quiescent_history` count it with the `kei-call` children, so a tombstoned head keeps the run
  pinned until it can no longer write. The spec's "attempts only read runs" (also in `gc.py`) becomes: attempts
  write into a run only derived artifacts, a recipe segmentation (as already) and Printed Lines.

## Consequences

- Only links with spans narrow. Links without them keep the paragraph mark until their document is extracted again
  by a method whose links carry spans.
- Only a published result whose processing completed starts the workflow. An incomplete (`incomplete_processing`),
  paused, stopped or failed attempt enqueues none; its links narrow only where lines exist for the same block.
- Pages read by the VLM transcriber (extent `input`, no block box) get no Printed Lines.
- An Extraction published before the patch schedules no enrichment; its links narrow only where a later Extraction
  on the same Source Representation cited the same block. Nothing backfills: the measured cost for today's Evidence
  (638 line reads for 164 cited blocks, about 3 minutes on the production GPU host) covers existing Evidence only.
- Line reads queue with conversions on the OCR server, so an enrichment can delay a scan's ingestion.
- The laptop figure does not establish that CPU detection fits the worker; Printed Lines stay disabled until the
  gate passes.
- Left to the implementation issue: the checkpoint's licence (Surya's README puts its weights under a modified
  OpenRAIL-M licence; the checkpoint's own terms are unconfirmed) and its provisioning for offline machines, which
  no ADR or runbook covers for any model.
- *Printed Line* enters CONTEXT.md when this is accepted.
- Rejected: reading lines at parse time, 10.2 to 13.1 s per page against 18.0 s of full-page OCR (4 parallel
  requests, shared GPU): 57 to 73% more OCR time on every scanned page, mostly for uncited blocks.
- Rejected: proportional placement over detector lines (7.8% of the book's and 19.3% of the newspaper's words on
  the wrong line), and its widening to the neighbouring line, over detector lines or Studio ink-projection rows (up
  to 3 lines for a one-line quote, failing criteria set beforehand; the newspaper's 15 lines projected as one band).
- Rejected as a replacement, open as a complement: narrowing in the markdown pane, which marks the transcription,
  not the print.
- Rejected: a synthetic text layer from word-level OCR (Surya has no word geometry: another OCR model and pass), a
  box per value from the extraction model (it reads text, not the image, so its box is unchecked), and OCR in the
  browser (outside the durable pipeline and its recorded recipe).
