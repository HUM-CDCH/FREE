## Why

Researchers need to extract many records from one canonical Source Document without losing the exact source boundaries, provenance, or useful partial results. The existing lifecycle only executes Article extraction, so Catalog work needs a bounded, deterministic server path and visible diagnostics.

## What Changes

- Add `CATALOG` alongside `ARTICLE` as a durable Extraction Strategy.
- Resolve model-discovered record starts only against canonical heading blocks, then execute bounded per-record extraction and a single final grounding pass.
- Add explicit Catalog stage and record diagnostics, including truncation and canonical boundaries.
- Add top-level field-source rules so document and source-filename values are deterministic in both strategies.
- Add Article/Catalog selection and partial-result diagnostics to Studio.
- Add explicit, immediate-parent Catalog child retries for selected failed components and fresh grounding.

## Capabilities

### New Capabilities

- `catalog-boundary-resolution`: Canonically validate model-selected heading IDs and derive stable Catalog record slices.
- `catalog-execution`: Execute, persist, reopen, cancel, retry selected components, and ground bounded Catalog extractions with ordered partial results.

### Modified Capabilities

- `extraction-results-view`: Display strategy, incomplete Catalog results, and stage/record diagnostics without failed placeholders.
- `frontend-api-client`: Submit strategy as part of Extraction identity and restore it from durable attempts.
- `studio-model-operation-contract`: Extend strict Extraction strategy, diagnostics, and field-source contracts for Catalog execution.

## Impact

Changes Studio's shared contracts, extraction API, schema-node utilities, ProjectStore DTO use, extraction controls/results UI, and deterministic/lifecycle tests. It does not change the Parsing Service's canonical `parsed_document.v2` ownership or add provider fallback, automatic/provider retries, queues, or background jobs. Targeted Catalog retries are explicit child attempts on the current configured route.
