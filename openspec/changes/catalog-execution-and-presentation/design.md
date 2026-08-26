## Context

The server-owned lifecycle persists a pinned Article attempt after one values call and canonical grounding. Catalog must retain that lifecycle's source package, Evidence Anchor, UUID identity, cancellation, and terminal persistence rules while applying the same visible record schema to multiple canonical source slices. `parsed_document.v2` remains the only source authority; model output selects server-marked heading IDs, never source identity or Evidence.

## Goals / Non-Goals

**Goals:**

- Add a durable `CATALOG` strategy distinct from Article and include it in run identity and reopen DTOs.
- Resolve discovery output deterministically against canonical headings, with no fuzzy recovery.
- Extract up to 100 records in source order, retain successful records after individual failures, and make stage/record outcomes visible.
- Apply top-level document/package value sources consistently to Article and Catalog, then ground assembled content values once.
- Support explicit Catalog child retries that reuse successful parent components and freshly ground the child result.

**Non-Goals:**

- No Parsing Service changes, model-provider fallback, automatic/provider retry, queue, background job, or compatibility migration. Targeted retries are explicit Catalog child attempts.
- No researcher-visible `records` schema field, model-authored Evidence, generated snippets, or inferred boundaries.
- No provider-matrix automation; the representative live calls remain a manual approval gate.

## Decisions

### Canonical headings own identity and slices

The server enumerates heading blocks from the decoded canonical content stream and marks them for the discovery call with unique, document-local short IDs (`H1`, `H2`, ...). Discovery has the strict shape `{ starts: string[] }` and returns only those IDs in source order. Matching is exact with no normalization. The server rejects an invalid shape or unknown, duplicate, or non-monotonic IDs before record extraction. Short IDs and markers are call-local aliases: they are never persisted and never become source identity.

The canonical start block ID is the record identity. After alias resolution, the pure boundary resolver rejects unknown, duplicate, non-heading, or non-monotonic canonical starts. A persisted boundary records the start block ID and inclusive content-stream index plus an exclusive end content-stream index; heading text and level are diagnostic display data, not identity. Each selected start ends immediately before the next selected start. The final record ends immediately before the next later heading at the same or shallower level. If no such heading exists, the canonical document end is its unambiguous exclusive end.

This is stricter than heading-text or fuzzy fallback because OCR corruption, merged headings, or model text normalization cannot silently select a different boundary. Compact aliases are copy-safe for the model while canonical block IDs remain the sole durable authority. Resolution stays auditable through one model-call-local alias map and one pure canonical resolver.

### One orchestration shell, strategy-specific execution

`extractions.ts` retains loading, route resolution, accounting, grounding, cancellation, and terminal persistence in a shared shell. Its strategy-specific branches supply Article or Catalog values and diagnostics. Article keeps its one whole-source values call and hidden `{ records: [...] }` envelope.

This avoids duplicating lifecycle guarantees. A separate API route or browser orchestration would make identity, cancellation, and persistence diverge.

### Immediate-parent targeted retry

Catalog retry requests create a new child UUID and may name only their immediate parent. The child reuses the parent's pins and Catalog strategy, resolves the current configured route, and records the selected document/discovery/record components. Successful values and boundaries are reused with zero-call `reused` diagnostics. Rediscovery is required before rerunning dependent records when the parent discovery did not succeed; selected failed or limit-skipped records are the only record work rerun otherwise. The child performs a fresh full grounding pass over its assembled result and starts with no copied review decisions.

### Top-level field-source partition and deterministic overlay

`valueSource` is accepted only on a top-level schema node. Omitted nodes are record scoped; `document` nodes remain whole-document values and `source-filename` nodes are copied from package metadata. A top-level declaration applies to that node's whole subtree; declarations physically placed on nested nodes are rejected. Partitioning moves whole top-level subtrees intact.

Catalog sends only document-scoped content nodes in its one whole-document values call and only record-scoped content nodes in each slice call. Article retains one whole-source values call containing both record- and document-scoped content nodes. Both strategies then overlay model-derived content by its original top-level schema position and overlay package values last. Unexpected model keys are rejected rather than allowed to cross partitions. Only deterministic package-origin paths are exempt from grounding; document-scoped model values remain content-derived and require Evidence Anchors.

### Bounded partial Catalog success

`CATALOG_RECORD_LIMIT = 100` limits attempted discovered records, not total model calls. A run makes zero or one document-values call when document-scoped fields exist, exactly one discovery call, at most 100 record-values calls, and the grounding batches required for the final assembled result. Every discovered item has ordered diagnostics; items after the first 100 receive `not_attempted_limit`. Individual record failures do not create placeholder records.

Invalid or failed discovery is `FAILED` because no canonical records can be resolved. A failed requested document-values call may still produce `SUCCEEDED, complete: false` when at least one record succeeds; its document fields remain absent. Successful records are overlaid, assembled in source order, and grounded once. A run with no assembled records is `FAILED`. A run with assembled records is `SUCCEEDED`; it is complete only when document extraction (if requested), every discovered record, the limit, and grounding all complete successfully. A fully grounded partial result remains reviewable, including a limit-truncated result. Cancellation writes `CANCELLED` with no result and discards partial work.

This bounds synchronous work while preserving usable research output. Retrying automatically would obscure provenance and inflate provider calls.

### Diagnostics are contract data, not UI-derived inference

The shared extraction contract records Catalog stage outcomes and per-record canonical boundaries, finish reason, usage, latency, and failure code. The UI renders only successful records in the primary tab space and keeps diagnostics and applicable retry controls behind one collapsed, height-bounded native disclosure.

The durable contract makes partial/reopened runs explainable without re-running a provider.

### Result navigation stays local and reversible

The Review view uses local path and history stacks over the displayed result. Root is always visible, ancestors remain directly selectable, and Clear resets the path plus both history stacks without changing the stored extraction or Evidence paths.

## Risks / Trade-offs

- [Heading formats may lack an unambiguous terminal boundary] → reject/diagnose that terminal instead of silently extending it.
- [One hundred synchronous calls can be slow] → hard limit and per-record diagnostics; introduce asynchronous work only with a future lifecycle design.
- [Grounding one assembled payload can leave successful values ungrounded] → retain values but set incomplete/reviewability from canonical grounding outcomes.
- [Strategy expands strict DTO/database validation] → update all contract fixtures and lifecycle/reopen tests together.

## Migration Plan

The prototype is not backward compatible: update the strict strategy/diagnostics decoders and persistence contract together, then deploy the server and Studio as one workspace build. Existing Article attempts retain their Article strategy and decode through the updated contract. Roll back by reverting the change before accepting new Catalog attempts; no data migration or compatibility path is added.
