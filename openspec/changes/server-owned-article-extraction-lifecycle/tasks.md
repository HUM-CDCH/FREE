## 1. Shared contracts and persistence

- [x] 1.1 Replace the Extraction and ReviewDecision database contract with append-only terminal-attempt fields, pin-safe retry identity, review timestamp, and PostgreSQL outcome/JSON constraints
- [x] 1.2 Generate the direct destructive prototype migration without applying it to the research database
- [x] 1.3 Add strict shared Article attempt, review, diagnostics, attribution, and reopen DTO decoders
- [x] 1.4 Move anchored-document and grounding logic to the shared Extraction package and keep canonical-anchor validation exact
- [x] 1.5 Keep SchemaNode values document-derived without changing the visible one-record schema shape

## 2. ProjectStore lifecycle

- [x] 2.1 Add pinned Article input loading and terminal attempt lookup with Project Context ownership validation
- [x] 2.2 Add transactional terminal attempt persistence with UUID identity conflict handling and no partial writes
- [x] 2.3 Replace combined reviewed-extraction persistence with write-once review finalization against stored Evidence and occurrence ownership
- [x] 2.4 Return deterministic independent `latestAttempt` and `latestReviewed` reopen DTOs with each attempt's own pins
- [x] 2.5 Add focused ProjectStore and disposable-PostgreSQL tests for constraints, rollback, idempotency, concurrent reviews, and different-pin reopen

## 3. Server-owned Article operation

- [x] 3.1 Add the Article POST and cancellation routes with strict request parsing and stable error responses
- [x] 3.2 Implement process-local in-flight identity sharing, mismatch rejection, terminal replay, and cancellation phase boundaries
- [x] 3.3 Load the pinned schema and canonical package, run one whole-source values call, and ground populated paths
- [x] 3.4 Persist safe attribution, diagnostics, completeness, failure, and cancellation before every terminal response
- [x] 3.5 Add concurrent identical/mismatched, cancellation, persistence-before-response, foreign-anchor, and reviewability route tests

## 4. Provider and browser integration

- [x] 4.1 Carry finish reason, usage, and duration through model execution; set raw NuExtract `num_ctx: 32768` and `num_predict: 8192` for Ollama
- [x] 4.2 Handle Ollama `done_reason: length` and usable tolerant-parser output as an incomplete succeeded attempt, with focused adapter tests
- [x] 4.3 Replace browser-side PDF/model/grounding/persistence orchestration with UUID Article POST, cancellation, review-by-ID, and server DTO state
- [x] 4.4 Replace the obsolete extraction-review route and update Vite parameterized dispatch and API clients without a compatibility path
- [x] 4.5 Update browser and contract tests for rerun UUIDs, reviewability, terminal replay, and latest-attempt/latest-reviewed reopen state

## 5. End-to-end verification

- [x] 5.1 Run focused contract, grounding, ProjectStore, PostgreSQL constraint/transaction, idempotency, NuExtract option, truncation, and reopen tests
- [x] 5.2 Run real Vite plus disposable PostgreSQL plus fresh-browser Article lifecycle coverage
- [x] 5.3 Run Studio lint and build
- [x] 5.4 Run one focused live Article smoke for each configured available provider and record any unavailable-provider limitation
- [x] 5.5 Rerun the retained 32-call and 48-call Article/Catalog matrices for 80 cumulative calls and record redacted evidence
  - All 80 calls returned; 77/80 component contracts were valid and zero retries ran. The selected Codex paths passed, while Ollama Article truncation and one missed Catalog start keep the provider matrix release gate blocked. See `matrix-rerun-evidence.md` and the redacted per-call JSON.
- [ ] 5.6 Run final Sonnet and Opus read-only advisor reviews, reconcile every finding against the canonical resolution, and ensure completed task boxes match evidence
  - No committed Sonnet or Opus advisor output is available; this task remains open.

## 6. Acceptance repair

- [x] 6.1 Remove out-of-slice Catalog execution, parser changes, diagnostics, and UI controls
- [x] 6.2 Hide the runtime `records` envelope for single- and multi-record Article output while preserving Evidence paths
- [x] 6.3 Keep succeeded partially grounded attempts reviewable and validate review coverage as Evidence-or-ungrounded
