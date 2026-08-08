## Why

The current one-call Extraction contract asks NuExtract to produce values and a citation wrapper for every leaf, which increased output tokens by 73% in the controlled Ellekilde benchmark, required tolerant JSON repair, and still selected 29 known but inconsistent table-cell anchors. Separating value extraction from canonical-anchor grounding lets each model call perform one task while preserving parser-owned Evidence identity and the existing reviewed persistence contract.

## What Changes

- **BREAKING** Stop asking the value-extraction model call to return `{ value, anchor_id }` wrappers; it returns the clean Extraction Schema result only.
- Add a distinct grounding call that receives immutable extracted claims, canonical source content with prompt-local anchor labels, and returns only compact claim-to-anchor-label selections or explicit abstentions.
- Resolve claim and anchor labels by exact call-scoped lookup, reject unknown or ambiguous references, and never create Evidence from snippets, pages, bounding boxes, coordinates, or fuzzy text matching.
- **BREAKING** Replace wrapper-polluted Extraction JSON with one Extraction aggregate containing a clean `result` plus separate canonical `evidenceLinks`; adapt review and reopen without adding a second Evidence authority or a database schema migration.
- Represent extraction and grounding as explicit runtime stages so a grounding failure does not corrupt or silently discard a valid extracted value result.
- Compare the current combined flow, full-document two-pass grounding, full-source record batching, and deterministic candidate-retrieval record batching under the same schemas, model, seed, and assertions across all three shipped example documents, and stop production acceptance if none passes live quality gates.
- Add focused and live lifecycle coverage for strict extraction shape, abstention, unknown-label rejection, wrong-known-anchor detection, review persistence, and fresh-browser reopen.
- **BREAKING** Persist each Schema Revision as recursive ordered `SchemaNode[]` JSON, return those nodes on reopen, and compile the model template in browser order so PostgreSQL JSONB cannot reorder semantically significant fields.

## Capabilities

### New Capabilities

- `extraction-grounding`: Separates value extraction from exact canonical Evidence grounding while preserving generation scope, review ownership, and the final reviewed-result contract.

### Modified Capabilities

- `studio-model-operation-contract`: Clarifies that one user Extraction action may compose two buffered model operations while retaining stable per-operation success and failure envelopes.
- `extraction-results-view`: Exposes extraction and grounding progress and keeps ungrounded values visible without creating PDF highlights or Review Decisions.

## Impact

- Studio extraction orchestration and state in `prototypes/studio/src/useExtraction.ts`.
- Canonical source projection and result attribution in `prototypes/studio/src/anchoredDocument.ts` or a replacement grounding module.
- Studio model-operation request construction and tolerant output parsing under `prototypes/studio/api/`.
- Extraction aggregate DTOs, `ProjectStore` JSON persistence/reopen, result rendering, Evidence highlighting, Review Decision construction, and existing lifecycle Playwright coverage.
- Disposable performance evidence under `.manual-test-runtime/evidence-performance-analysis`; no new provider dependency or database schema is required.
- Schema Revision JSON validation, reopen DTOs, browser initialization, and a disposable PostgreSQL/browser ordering E2E; the existing JSONB column remains unchanged.
