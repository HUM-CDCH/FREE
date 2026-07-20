## 1. Fix color assignment

- [x] 1.1 In `evidenceHighlights.ts`, remove `colorMap` parameter from `buildHighlights` and assign `PALETTE[i % PALETTE.length]` directly by result key iteration index
- [x] 1.2 In `EvidenceHighlightLayer.tsx`, delete `buildTopLevelColorMap` and remove `schema` from `Props`, destructor, and `useEffect` dependency array
- [x] 1.3 In `App.tsx`, remove `schema` prop from `<EvidenceHighlightLayer>`

## 2. Verify

- [ ] 2.1 Run extraction with a multi-field result and confirm adjacent top-level keys get different highlight colors on the PDF
