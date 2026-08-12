<!-- markdownlint-disable MD013 -->

# Tasks: publish-parsed-document-v2

## 1. Correct and freeze the table design gate

- [x] 1.1 Confirm through the real producer boundary that Docling exports page-local table items rather than one multi-page `TableItem`; record that hardening tasks 2.5/2.6 closed because their premise was disproven
- [x] 1.2 Inspect current deterministic DocTags continuation behavior and the continuation-looking `Beretning_Ellekilde_8_13` golden facts
- [x] 1.3 Freeze logical tables, ordered fragments, unique slot matching, continuation conditions, repeated-header behavior, fragment-cell mappings, merged-cell roots, page geometry, table-reference blocks, anchors, and ambiguity behavior in the spec/design/ADR
- [x] 1.4 Reproduce focused NuExtract probes using Studio's exact raw structured prompt shape and record bounded evidence for page markers, block IDs, and deterministic downstream range handling
- [x] 1.5 Add a focused regression for existing DocTags continuation targeting without claiming v2 inventory coverage
- [x] 1.6 Run `openspec validate publish-parsed-document-v2 --strict`

## 2. Introduce the v2 canonical models

- [ ] 2.1 Add `parsed_document.v2` Pydantic models for semantic blocks, page-local ordered/unplaced content, logical tables, ordered fragments, fragment-cell mappings, page geometry, typed diagnostics, and typed Evidence Anchors
- [ ] 2.2 Define deterministic generation-scoped block, table, fragment, and anchor IDs; test duplicate tasks and changed preprocessing policy
- [ ] 2.3 Implement the frozen block-anchor, table, fragment, fragment-cell, reference, and cell-anchor fields without adding redundant page/span data, fragment order, or anchor geometry
- [ ] 2.4 Enforce array-authoritative fragment order, reference integrity, unique IDs, optional page-valid v1-compatible geometry, root-only merged cells, and logical spans
- [ ] 2.5 Replace the untyped `EvidenceIndex` placeholder with block anchors that resolve page/span through blocks and root-cell anchors whose locations reference fragment-local root cells
- [ ] 2.6 Reject non-PDF input and unverified physical-page mapping with stable client-safe errors

## 3. Build deterministic page-local table canonicalization

- [ ] 3.1 Emit parser-observed semantic blocks, table slots, and page boundaries while preserving source text
- [ ] 3.2 Match every DocTags slot against page-local inventory by producer identity or exact normalized content/structure; route non-unique matches to that page's `unplaced_content`
- [ ] 3.3 Admit continuation only for consecutive pages, adjacent slots across furniture, unique bidirectional matching, compatible columns/structure/caption/header state, and no narrative interruption
- [ ] 3.4 Map observed repeated headers to existing logical header roots as additional physical occurrences; reject ambiguous mappings and give renderer-generated headers no source occurrence
- [ ] 3.5 Map merged cells to one logical root coordinate and prohibit anchors for covered positions
- [ ] 3.6 Emit `table_continuation_ambiguous` only for multiple plausible mappings; keep definitely incompatible fragments separate without that diagnostic and use placement diagnostics for slot ambiguity
- [ ] 3.7 Keep Docling fragment semantics authoritative; permit Camelot only for exact-match monotonic geometry enrichment or attributed no-inventory fallback
- [ ] 3.8 Add positive and negative fixtures for body-only continuation, observed repeated headers, captions, incompatible columns/spans, narrative interruption, non-consecutive pages, multiple candidates, unplaced slots, partial geometry, and rotations

## 4. Derive synchronized Markdown, pages, tables, and anchors

- [ ] 4.1 Render inline table-reference blocks at their ordered positions and unplaced references in a deterministic labelled appendix at the end of their physical page; derive both from the final logical table and fragment mapping
- [ ] 4.2 Emit exactly one `<!-- FREE:PAGE n -->` marker per page with deterministic UTF-8/LF output
- [ ] 4.3 Fail with stable `reserved_page_marker_collision` when source text matches the reserved marker grammar; never rewrite source text
- [ ] 4.4 Resolve the deferred character-offset versus UTF-8-byte-offset gate, then compute exact page/block spans under the chosen convention
- [ ] 4.5 Build deterministic block anchors that resolve page/span through their blocks and root-cell anchors that resolve physical locations through fragment-local root cells
- [ ] 4.6 Validate all block and table references, fragment mappings, root-only anchors, repeated-header occurrences, page geometry, inline and unplaced table rendering, and exact spans before commit
- [ ] 4.7 Bump schema/converter-policy preprocessing identity so v1 and pre-stream cache entries cannot be served as v2

## 5. Switch public document routes and migration behavior

- [ ] 5.1 Resolve the deferred completed task-local v1 migration gate
- [ ] 5.2 Make both document routes return the same v2 contract with no projection or version negotiation
- [ ] 5.3 Keep the Markdown route byte-identical to the v2 canonical artifact
- [ ] 5.4 Verify cleanup remains retention-bound and introduces no durable repository semantics

Package format, quota, metadata, archive-route behavior, and package tests belong to a separate future OpenSpec change.

## 6. Verification and documentation

- [ ] 6.1 Extend semantic goldens with block order, explicit page markers, fragment rendering, logical table identity, page-scoped occurrences, and stable anchors
- [ ] 6.2 Add adversarial invariants for repeated text/headings, absent geometry, rotations, unplaced tables, parser disagreement, invalid mappings/spans, and source marker collisions
- [ ] 6.3 Run focused tests, the complete backend suite, golden E2E, real Docling integration, and diagnostics
- [ ] 6.4 Update parsing-service and Studio documentation only when their production behavior changes
- [ ] 6.5 Record the canonical-content-stream decision in ADR 0005
- [ ] 6.6 Validate OpenSpec, Markdown, links, examples, and `git diff --check` before implementation completion and archival
