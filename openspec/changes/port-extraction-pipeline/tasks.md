<!-- markdownlint-disable MD013 MD041 -->

## 1. Establish the pinned parity harness

- [x] 1.1 Copy `Burial_Finds.json` verbatim into Studio's production `schemas/FieldReports/` path with attribution to `FREE-technical` commit `67ea4dc535a2ab674ed8c4b558068e13e7c2980d`; parity tests consume the same file
- [x] 1.2 Add a minimal two-record canonical Markdown fixture and deterministic fake boundary and record model responses
- [x] 1.3 Add API/server TypeScript configuration and reference it from the Studio build so `api/*.ts` is type-checked
- [x] 1.4 Encode the pinned Python conformance, primary-array, boundary, retry, merge, and deduplication outcomes as failing TypeScript characterization tests
- [x] 1.5 Run a fresh parity review and scope review of the fixture expectations against the pinned reference and this change's do-not-build list

## 2. Port pure conformance and Catalog behavior

- [x] 2.1 Implement faithful recursive conformance in `api/_model_output.ts`, including unknown-key removal, missing-value restoration, scalar nulling, singleton-array recovery, and free-form empty containers
- [x] 2.2 Implement primary repeated-array and matching `_schema_metadata` selection for Catalog schemas, including `record.entries` for Burial Finds
- [x] 2.3 Add `api/_catalog.ts` with pure boundary-marker resolution, source-ordered slicing, and one-section whole-document fallback with exactly one `boundary_fallback` warning
- [x] 2.4 Implement section extraction orchestration with an injected model callback, recursive conformance, pinned suspicious-record detection, and at most one retry per section
- [x] 2.5 Implement source-ordered merge and pinned scalar-fingerprint deduplication while preserving nested `fundliste` values and leaving out-of-array document fields empty
- [x] 2.6 Make the pure-function test matrix pass for normal boundaries, partial and total marker failure, one retry, retry exhaustion, source order, nested values, and deduplication
- [x] 2.7 Run a fresh parity review and scope review of the pure Catalog slice, apply accepted in-scope fixes, and rerun its tests

## 3. Deliver Burial Finds through the canonical-document endpoint

- [x] 3.1 Expose one callable structured-generation function from `api/_model.ts` while preserving the hand-built NuExtract prompt, direct Ollama `/api/generate` request, and `raw: true`
- [x] 3.2 Add narrow runtime validation and selection for the `parsed_document.v1` Markdown, pages, spans, tables, and optional Evidence Anchors consumed by extraction
- [x] 3.3 Implement `api/extract.ts` JSON validation for `{ taskId, schema, strategy }`, including the full envelope, `PARSING_SERVICE_URL` resolution, canonical-document fetch, Catalog routing, exact `{ result, warnings }` response shaping, and client-visible error mapping
- [x] 3.4 Reject incomplete parsing tasks, unsupported strategies, and invalid canonical-document contracts before model invocation
- [x] 3.5 Replace the frontend extraction wrapper with the task-ID-based JSON request, preserve caller-supplied full schema envelopes, adapt generated templates at their own boundary, and add one result-plus-warnings boundary decoder
- [x] 3.6 Retain the completed parsing task ID in frontend state and pass it with the Extraction Schema and explicit Catalog strategy
- [x] 3.7 Update extraction state and the Results tab to show the read-only schema-shaped result plus non-empty warnings without live raw model output
- [x] 3.8 Add API tests with fake parsing-service and model responses for successful Burial Finds extraction, contract drift, incomplete tasks, strategy rejection, error mapping, and absence of Source Document uploads
- [x] 3.9 Run a fresh parity review and scope review of the end-to-end Catalog slice, apply accepted in-scope fixes, and rerun Studio tests and build
- [x] 3.10 Add and execute an opt-in local NuExtract smoke test that extracts the Burial fixture in source order without making it part of normal CI

## 4. Complete embedded Evidence and Article parity

- [x] 4.1 Extend `api/_evidence_template.ts` to traverse and retain schema-local `_evidence` slots, including Evidence nested in `fundliste`, without creating a separate public Evidence envelope
- [x] 4.2 Normalize text Evidence through canonical pages and spans with optional Evidence Anchors, splitting pinned `...` and `…`-glued snippets into contiguous entries
- [x] 4.3 Normalize table Evidence against deterministic canonical `ParsedTable` and cell order while preserving the public `table_index` field
- [x] 4.4 Add deterministic tests for nested Evidence, unresolved and resolved text grounding, ellipsis snippets, table-cell grounding, and nested `table_index`
- [x] 4.5 Copy `collagen_extraction.json` verbatim into Studio's production `schemas/JournalArticles/` path with pinned-reference attribution and add deterministic Article model output fixtures
- [x] 4.6 Add `api/_article.ts` with one whole-document model call followed by the shared conformance and Evidence path
- [x] 4.7 Route `strategy: "article"` explicitly and prove collagen uses Article behavior despite also containing `record.entries`
- [x] 4.8 Run a fresh parity review and scope review of the Evidence and Article slice, apply accepted in-scope fixes, and rerun Studio tests and build
- [x] 4.9 Verify canonical Markdown page-slice grounding, canonical table matching, page-only Evidence behavior, Article table inventory, and restored scalar highlighting

## 5. Verify the completed port

- [x] 5.1 Add or confirm focused guards proving extraction never reads Source Document bytes or invokes PDF, Docling, OCR, or Camelot processing
- [x] 5.2 Confirm production code adds no modules beyond `_catalog.ts` and `_article.ts` unless an approved cohesion split is documented
- [x] 5.3 Run `pnpm --filter studio test` and `pnpm --filter studio build`
- [x] 5.4 Run strict OpenSpec validation and verify every capability scenario has deterministic automated coverage or an explicitly opt-in live-model check
- [x] 5.5 Correct the researcher-facing schema path: expose the two pinned production schemas in Studio, default Burial Finds to Catalog, and regression-test that `requestExtraction` sends metadata and local Evidence unchanged

## 6. Address extraction review findings

- [x] 6.1 Add failing normalization tests proving Catalog discards section-local table coordinates, resolves a unique canonical cell in document-global order, leaves ambiguous matches ungrounded, and Article verifies its document-global hints
- [x] 6.2 Extract the reference-derived canonical table matcher into `api/_table_evidence.ts`, make normalization strategy-aware, and update the endpoint so Catalog ignores model location hints while Article treats them only as verified hints
- [x] 6.3 Add failing highlight-projection tests proving field-level Evidence applies to every scalar-array element and a valid Evidence page remains the preferred page when snippets are empty
- [x] 6.4 Extract pure PDF text matching into `src/pdfTextMatching.ts`, port the `FREE-technical` normalization and token-sequence behavior, and require complete-token alignment instead of the reference substring fast path
- [x] 6.5 Replace Article prompt-prose assertions with endpoint behavior tests that prove one-call Article routing, canonical table grounding, conformance, and empty-snippet page preservation
- [x] 6.6 Replace Q2 documentation and the Modelfile base with the official NuExtract3 `Q4_K_M` profile, document local Catalog, Spark Ollama, and Codex CLI profiles, add strict optional `AI_NUM_CTX` parsing, and prove Ollama request serialization without model-name enforcement or silent routing
- [ ] 6.7 Split live verification into a NuExtract Q4-or-better Ollama Catalog smoke with conflicting metadata and an Article smoke through Codex CLI or Spark-hosted Ollama; require both lanes, record the passing Article provider, and keep both outside ordinary CI
- [ ] 6.8 Run focused tests, Studio lint/test/build, strict OpenSpec validation, and manual PDF-viewer QA proving scalar arrays retain Evidence page guidance and short numeric values do not highlight larger tokens
