<!-- markdownlint-disable MD013 -->

# Tasks: publish-parsed-document-v2

## 1. Resolve the fixture-gated table schema

- [ ] 1.1 Confirm `harden-canonical-parsing-service` parsing-fidelity tasks, especially the real multi-page Docling table fixture, are complete before starting v2 implementation
- [ ] 1.2 Inspect the fixture's table, cell, provenance, page, and geometry payloads through the actual Docling producer boundary
- [ ] 1.3 Add failing contract tests for one logical table spanning pages, page-scoped Evidence, partial geometry, and merged logical cells
- [ ] 1.4 Freeze the exact v2 table fragment and cell-location fields in the model, specification, design, and ADR 0004; remove the blocked open question
- [ ] 1.5 Run `openspec validate publish-parsed-document-v2 --strict` after the fixture-driven contract update and do not continue until it passes

## 2. Introduce the v2 canonical models

- [ ] 2.1 Add `parsed_document.v2` Pydantic models for semantic content blocks, page-local ordered and unplaced content, logical tables, page-scoped table Evidence, typed Evidence Anchors, and separate table content/structure/geometry parser attribution
- [ ] 2.2 Define deterministic block, table, and anchor IDs scoped to `content_sha256 + preprocess_id`; add duplicate-task and changed-policy tests
- [ ] 2.3 Add model invariants for physical-page coverage, reference integrity, unique IDs, optional verified geometry, logical table spans, and package-relative artifact refs
- [ ] 2.4 Remove the untyped `EvidenceIndex.anchors: list[dict[str, Any]]` placeholder in favor of the discriminated v2 anchor union
- [ ] 2.5 Reject non-PDF inputs and document-level unverified page mapping under the v2 contract with stable client-safe errors

## 3. Build the canonical semantic content stream

- [ ] 3.1 Extend DocTags conversion to emit parser-observed heading, paragraph, list, code, formula, caption, table-slot, and page-boundary intermediate blocks while preserving exact source text
- [ ] 3.2 Convert OCR fallback output into ordered generic text blocks unless semantic structure is explicitly proven; retain page and optional geometry provenance
- [ ] 3.3 Match DocTags table slots to final canonical logical tables using producer identity or exact normalized content/structure plus physical page, producer order, Evidence, and safe geometry without guessing ambiguous placement
- [ ] 3.4 Put valid fallback-only, mismatched, ambiguous, or otherwise unplaceable table refs in page-local `unplaced_content`; emit stable placement-disagreement diagnostics instead of silently substituting an inline table
- [ ] 3.5 Preserve captions as text blocks while leaving figure IDs, crops, and visual interpretation out of v2
- [ ] 3.6 Add focused fixtures for minified content, lists, code, formulas, captions, OCR generic text, inline tables, unplaced tables, blank pages, and rotated pages
- [ ] 3.7 Refactor table canonicalization behind one module: keep Docling semantics authoritative, accept Camelot only for exact-match monotonic geometry enrichment or explicit no-inventory fallback, and retain rejected candidates as internal diagnostics
- [ ] 3.8 Add conflict regressions for matrix, role, span, geometry, repeated-table, unmatched-candidate, and incomplete-Docling-inventory cases; verify no conflict creates a second canonical table

## 4. Derive synchronized Markdown, tables, pages, and anchors

- [ ] 4.1 Render each inline and unplaced table's Markdown from the final Docling-authoritative `ParsedTable` matrix rather than from an independent OTSL or Camelot representation; do not publish a second canonical Camelot appendix
- [ ] 4.2 Render canonical Markdown from the final block stream with one reserved explicit marker per physical page and deterministic UTF-8/LF bytes
- [ ] 4.3 Compute page and block `CharSpan` values against the exact final Markdown while excluding renderer page markers from source-text Evidence
- [ ] 4.4 Build one typed text anchor per anchorable textual block and one typed cell anchor per canonical logical cell, retaining verified geometry only where available
- [ ] 4.5 Add publication validation that re-renders table Markdown from typed cells, slices every text span, resolves every ref, verifies parser-role attribution, and rejects any inconsistency before canonical commit
- [ ] 4.6 Bump the schema/converter-policy preprocessing identity so every v1 or pre-stream cache entry rebuilds

## 5. Implement the deterministic canonical package

- [ ] 5.1 Freeze the package schema and fixed ZIP layout for `manifest.json`, `source.pdf`, `parsed_document.json`, and `artifacts/document.llm.md`
- [ ] 5.2 Implement package-relative canonical artifact references shared by route JSON and the packaged v2 document without leaking service-owned paths
- [ ] 5.3 Build a package manifest containing package/schema versions, source hash, preprocess ID, and path/media-type/size/SHA-256 for every non-manifest entry
- [ ] 5.4 Generate uncompressed `ZIP_STORED` entries with fixed order, DOS-epoch timestamps, permissions, UTF-8 names, and safe normalized paths; validate missing, extra, duplicate, traversal, size, and digest cases
- [ ] 5.5 Include the original Source Document and required canonical artifacts while proving raw Docling, DocTags, inspection, task metadata, and parser diagnostics are never exported
- [ ] 5.6 Reuse the hardened task-lock-through-response and archive quota behavior; remove temporary packages on every failure/cancellation path
- [ ] 5.7 Add byte-for-byte repeatability tests for the same generation and package validation tests independent of parsing-service storage paths

## 6. Switch public routes and cache behavior

- [ ] 6.1 Make both `GET /tasks/{id}/document` and `/parsed-document` return the same v2 contract with no v1 projection or version negotiation
- [ ] 6.2 Keep `GET /tasks/{id}/markdown` byte-for-byte aligned with the canonical Markdown packaged and referenced by v2
- [ ] 6.3 Replace the task-shaped archive response with the canonical package while preserving completed-task guards and structured 409 behavior
- [ ] 6.4 Treat v1 canonical entries as cache misses and rebuild from the content-addressed source; test that mixed v1/v2 generations are never served as equivalent
- [ ] 6.5 Verify task, source, and document cleanup remain retention-bound after package delivery and add no durable pin/repository semantics

## 7. Verification and documentation

- [ ] 7.1 Extend the semantic golden oracle with v2 block order, explicit page markers, synchronized table rendering, page-scoped multi-page Evidence, and stable anchor facts
- [ ] 7.2 Add adversarial invariants for repeated text, absent geometry, rotated pages, unplaced tables, DocTags/Docling/Camelot disagreement, misleading parser attribution, table/Markdown disagreement, invalid spans, unsafe refs, and incomplete page mapping
- [ ] 7.3 Run focused model/storage/archive tests, `uv run --no-sync python -m unittest discover -s tests`, `RUN_GOLDEN_E2E=1`, `RUN_DOCLING_INTEGRATION=1`, and Python diagnostics
- [ ] 7.4 Update `docs/parsing-service.md`, `docs/parsing-quality.md`, the parsing-service README, and architecture drawing with the v2 authority model, PDF-only scope, explicit page guarantee, EvidenceIndex, and package lifecycle
- [ ] 7.5 Record the canonical-content-stream decision in ADR 0005 and update ADR 0004 with the fixture-proven table shape
- [ ] 7.6 Validate OpenSpec artifacts, Markdown, links, package examples, and `git diff --check` before implementation completion and archival
