<!-- markdownlint-disable MD013 MD041 -->

## 1. Establish the pinned parity harness

- [ ] 1.1 Copy `Burial_Finds.json` into Studio test fixtures with attribution to `FREE-technical` commit `67ea4dc535a2ab674ed8c4b558068e13e7c2980d`
- [ ] 1.2 Add a minimal two-record canonical Markdown fixture and deterministic fake boundary and record model responses
- [ ] 1.3 Add API/server TypeScript configuration and reference it from the Studio build so `api/*.ts` is type-checked
- [ ] 1.4 Encode the pinned Python conformance, primary-array, boundary, retry, merge, and deduplication outcomes as failing TypeScript characterization tests
- [ ] 1.5 Run a fresh parity review and scope review of the fixture expectations against the pinned reference and this change's do-not-build list

## 2. Port pure conformance and Catalog behavior

- [ ] 2.1 Implement faithful recursive conformance in `api/_model_output.ts`, including unknown-key removal, missing-value restoration, scalar nulling, singleton-array recovery, and free-form empty containers
- [ ] 2.2 Implement primary repeated-array and matching `_schema_metadata` selection for Catalog schemas, including `record.entries` for Burial Finds
- [ ] 2.3 Add `api/_catalog.ts` with pure boundary-marker resolution, source-ordered slicing, and one-section whole-document fallback with exactly one `boundary_fallback` warning
- [ ] 2.4 Implement section extraction orchestration with an injected model callback, recursive conformance, pinned suspicious-record detection, and at most one retry per section
- [ ] 2.5 Implement source-ordered merge and pinned scalar-fingerprint deduplication while preserving nested `fundliste` values and leaving out-of-array document fields empty
- [ ] 2.6 Make the pure-function test matrix pass for normal boundaries, partial and total marker failure, one retry, retry exhaustion, source order, nested values, and deduplication
- [ ] 2.7 Run a fresh parity review and scope review of the pure Catalog slice, apply accepted in-scope fixes, and rerun its tests

## 3. Deliver Burial Finds through the canonical-document endpoint

- [ ] 3.1 Expose one callable structured-generation function from `api/_model.ts` while preserving the hand-built NuExtract prompt, direct Ollama `/api/generate` request, and `raw: true`
- [ ] 3.2 Add narrow runtime validation and selection for the `parsed_document.v1` Markdown, pages, spans, Evidence Anchors, and tables consumed by extraction
- [ ] 3.3 Implement `api/extract.ts` request validation for `{ taskId, schema, strategy }`, server-side canonical-document fetch, Catalog routing, response shaping, and client-visible error mapping
- [ ] 3.4 Reject incomplete parsing tasks, unsupported strategies, and invalid canonical-document contracts before model invocation
- [ ] 3.5 Replace the frontend extraction wrapper with the task-ID-based non-streaming request and one result-plus-warnings boundary decoder
- [ ] 3.6 Retain the completed parsing task ID in frontend state and pass it with the Extraction Schema and explicit Catalog strategy
- [ ] 3.7 Update extraction state and the Results tab to show the read-only schema-shaped result plus non-empty warnings without live raw model output
- [ ] 3.8 Add API tests with fake parsing-service and model responses for successful Burial Finds extraction, contract drift, incomplete tasks, strategy rejection, error mapping, and absence of Source Document uploads
- [ ] 3.9 Run a fresh parity review and scope review of the end-to-end Catalog slice, apply accepted in-scope fixes, and rerun Studio tests and build
- [ ] 3.10 Add and execute an opt-in local NuExtract smoke test that extracts the Burial fixture in source order without making it part of normal CI

## 4. Complete embedded Evidence and Article parity

- [ ] 4.1 Extend `api/_evidence_template.ts` to traverse and retain schema-local `_evidence` slots, including Evidence nested in `fundliste`, without creating a separate public Evidence envelope
- [ ] 4.2 Normalize text Evidence through canonical pages, spans, and Evidence Anchors while preserving the pinned ellipsis-snippet behavior
- [ ] 4.3 Normalize table Evidence against deterministic canonical `ParsedTable` and cell order while preserving the public `table_index` field
- [ ] 4.4 Add deterministic tests for nested Evidence, unresolved and resolved text grounding, ellipsis snippets, table-cell grounding, and nested `table_index`
- [ ] 4.5 Copy `collagen_extraction.json` with pinned-reference attribution and deterministic Article model output fixtures
- [ ] 4.6 Add `api/_article.ts` with one whole-document model call followed by the shared conformance and Evidence path
- [ ] 4.7 Route `strategy: "article"` explicitly and prove collagen uses Article behavior despite also containing `record.entries`
- [ ] 4.8 Run a fresh parity review and scope review of the Evidence and Article slice, apply accepted in-scope fixes, and rerun Studio tests and build

## 5. Add sequential browser batch

- [ ] 5.1 Add a frontend batch function that processes completed task IDs sequentially through the same single-document extraction wrapper
- [ ] 5.2 Retain ordered per-document successes and errors independently so one failure neither erases earlier results nor blocks later task IDs
- [ ] 5.3 Display each batch outcome without adding a batch endpoint, server module, concurrent model calls, persistence, or batch-only merge
- [ ] 5.4 Add tests proving batch results match individual requests and a middle failure preserves prior successes and allows later attempts
- [ ] 5.5 Run a fresh parity review and scope review of the batch slice, apply accepted in-scope fixes, and rerun Studio tests and build

## 6. Verify the completed port

- [ ] 6.1 Add or confirm focused guards proving extraction never reads Source Document bytes or invokes PDF, Docling, OCR, or Camelot processing
- [ ] 6.2 Confirm production code adds no modules beyond `_catalog.ts` and `_article.ts` unless an approved cohesion split is documented
- [ ] 6.3 Run `pnpm --filter studio test` and `pnpm --filter studio build`
- [ ] 6.4 Run strict OpenSpec validation and verify every capability scenario has deterministic automated coverage or an explicitly opt-in live-model check
