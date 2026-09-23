## Implementation (plan M0–M5)

- [x] Contract, recipe and fixtures for the acceptance matrix (M0).
- [x] Extraction view with canonical references, units, crops and precision;
  source layout selection wired from Studio upload (M1).
- [x] Reading order, line roles, heading events, glossary and duplicate
  observations (M2).
- [x] Structural segmenter, numbering resolution, coverage ledger and
  immutable segmentation artifact (M3).
- [x] Bounded per-entry extraction, code verification, inheritance, rejected
  candidates, competitors and token budget (M4).
- [x] Versioned result in API, TypeScript decoding, persistence and review UI
  (M5).

## Decisions before cutover

- [x] D1 recipe selection: per Extraction (settled 2026-09-23); default unchanged.
- [ ] D2 binding editing.
- [ ] D3 archaeological schema confirmation.
- [ ] D4 scoped entry identity for restarts and prefixed series.
- [x] D5 exact tokenizer (implemented; consensus C8).

## Acceptance evidence (plan M6)

- [ ] Full catalogue segmented through the real scan/spread path, with the
  coverage ledger inspected.
- [ ] Boundary labels on 20 stratified pages and block-F1 under a frozen
  matching definition. (Machinery ready: `kei_exp.kie.boundaries`, design §9;
  labels missing.)
- [ ] OCR comparison on labelled lines.
