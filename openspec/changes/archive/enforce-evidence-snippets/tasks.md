## 1. Implement the evidence-field instruction

- [x] 1.1 Add `EVIDENCE_FIELD_INSTRUCTION` constant to `api/_model.ts` with the directive text
- [x] 1.2 In `extractWithModel`, compose the combined instruction from `EVIDENCE_FIELD_INSTRUCTION` and the caller-supplied `instruction` (filter nullish, join with newline) before passing to `generateWithNuExtractRawPrompt`

## 2. Verify

- [ ] 2.1 Run an extraction and confirm the model response contains non-null `snippet` and positive `page` values in the raw JSON
- [ ] 2.2 Confirm `splitEvidenceResult` returns a non-null `evidence` record and `EvidenceHighlightLayer` draws highlights
