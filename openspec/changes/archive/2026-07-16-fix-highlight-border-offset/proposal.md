## Why

Evidence highlights were not working: the component was designed to receive model-provided `{snippet, page}` evidence and draw rectangles on a canvas overlay. Two problems emerged during investigation:

1. **Coordinate offset**: highlights appeared at the correct page but displaced ~9px up and left. Root cause: `getBoundingClientRect()` returns the border box of the `.page` element, while the PDF content area starts inside the 9px transparent border.

2. **Model compliance**: NuExtract3 does not reliably follow complex evidence-augmented template formats. When the schema was modified to include `{value, snippet, page}` objects, the model's output became unstable — it would produce plain values without evidence structure, resulting in zero highlights built.

## What Changed

**Coordinate fix (kept):** `EvidenceHighlightLayer` now compensates for the `.page` border via `pageEl.clientTop` / `pageEl.clientLeft`.

**Architectural pivot:** The evidence mechanism was removed entirely. Instead of asking the model to provide source locations, the frontend takes the clean extraction result and searches the PDF text layer directly for each extracted string value. The model does what it's good at (structured extraction); the frontend does what it's good at (text location).

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `evidence-highlight-layer`: Component rewritten to use direct value search. Accepts the clean extraction result instead of model-provided evidence. Searches `pdfPage.getTextContent()` for each extracted string leaf. Colors highlights by top-level schema key. Page-to-canvas coordinate mapping compensates for `.page` border width.

## Impact

- `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx` — complete rewrite
- `prototypes/mine/pdf-render/src/api.ts` — evidence types and `includeEvidence` param removed
- `prototypes/mine/pdf-render/src/extraction.ts` — evidence field removed from ready state
- `prototypes/mine/pdf-render/src/useExtraction.ts` — evidence plumbing removed
- `prototypes/mine/pdf-render/src/App.tsx` — passes `result` instead of `evidence` to layer
- `prototypes/mine/backend/use_cases/extract.py` — evidence wrapping and parsing removed
- `prototypes/mine/backend/shared/nuextract_request.py` — few-shot and evidence params removed
- `prototypes/mine/backend/shared/evidence_template.py` — deleted (dead code)
- `prototypes/mine/backend/shared/few_shot_examples.py` — deleted (dead code)
- `prototypes/mine/backend/shared/result_parsers.py` — `EvidenceStructuredParser` removed
