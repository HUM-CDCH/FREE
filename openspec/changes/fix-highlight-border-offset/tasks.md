## 1. Fix coordinate offset

- [x] 1.1 In `EvidenceHighlightLayer.tsx`, add `pageEl.clientTop` to `pageTop` and `pageEl.clientLeft` to `pageLeft` when computing each page's canvas draw origin

## 2. Fix viewport scale (CSS_UNITS)

- [x] 2.1 In `EvidenceHighlightLayer.tsx`, multiply `pdfViewer.currentScale` by `96.0 / 72.0` when calling `pdfPage.getViewport()` to match PDF.js's internal rendering scale

## 3. Replace evidence mechanism with direct value search

- [x] 3.1 Rewrite `EvidenceHighlightLayer.tsx`: accept `result: unknown` instead of `evidence`; add `collectLeaves`, `buildHighlights`, `searchValueInPage`, `findValueRects`, `buildTopLevelColorMap`
- [x] 3.2 Remove evidence types (`EvidenceItem`, `Evidence`) and `includeEvidence` param from `api.ts`; `requestExtraction` returns `unknown`
- [x] 3.3 Remove `evidence` field from `ExtractionState` ready case in `extraction.ts`
- [x] 3.4 Remove evidence plumbing from `useExtraction.ts`
- [x] 3.5 Update `App.tsx` to pass `result` instead of `evidence` to `EvidenceHighlightLayer`

## 4. Remove backend evidence code

- [x] 4.1 Remove evidence wrapping and `EvidenceStructuredParser` usage from `use_cases/extract.py`
- [x] 4.2 Remove few-shot and evidence params from `shared/nuextract_request.py`
- [x] 4.3 Remove `EvidenceStructuredParser` and its dead import from `shared/result_parsers.py`
- [x] 4.4 Delete `shared/evidence_template.py` and `shared/few_shot_examples.py`
