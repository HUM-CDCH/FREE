## Why

Article extraction is currently orchestrated and grounded in the browser, and it becomes durable only when a researcher accepts it. That leaves completed model work, failures, cancellation, idempotency, and reopen state outside the authoritative server and PostgreSQL lifecycle settled by Wayfinder #74 and the canonical implementation resolution in #78.

## What Changes

- Add a server-owned Article operation that loads the pinned Source Representation Revision and Schema Revision, runs one whole-source value extraction, grounds content-derived values against canonical `parsed_document.v2` anchors, and persists a terminal attempt before responding.
- Add UUID idempotency for in-flight, completed, failed, and cancelled attempts; identical requests share or replay one attempt and mismatched reuse returns `409`.
- Persist append-only terminal Extraction attempts separately from review finalization, with PostgreSQL-enforced outcome shapes, pin ownership, retry identity, and write-once review decisions.
- Replace the browser-supplied reviewed-extraction payload with review-by-Extraction-ID, and reopen both the latest attempt and latest reviewed Extraction with each attempt's own pins.
- Move canonical grounding and anchored-document construction to shared server/browser modules; remove browser-only orchestration and the obsolete combined persistence path.
- Apply the settled raw NuExtract context/output options and persist truncation as an incomplete terminal attempt while retaining usable tolerant-parser output.
- **BREAKING**: replace the existing client-owned extraction-review endpoint and reopen payload; no compatibility endpoint or migration path is retained for prototype data.

## Capabilities

### New Capabilities

- `server-owned-article-extraction-lifecycle`: Article operation ownership, terminal persistence, idempotency, cancellation, grounding, review finalization, and reopen selection.

### Modified Capabilities

- `extraction-results-view`: Drive Article runs, review, rerun, failure, cancellation, and reopen from server-owned attempt DTOs.
- `nuextract-request-construction`: Use the settled structured-extraction token limits and classify `done_reason: length` as incomplete without discarding usable parsed output.

## Impact

- Studio API routes, model execution metadata, shared grounding modules, browser extraction state, and Vite route dispatch.
- `ProjectStore`, the generated database contract, PostgreSQL migrations and constraints, and Source Document reopen DTOs.
- Focused Vitest, disposable-PostgreSQL, Playwright lifecycle, live-provider smoke, and retained Article/Catalog matrix evidence.
- No new runtime dependency, Catalog operation, feature flag, compatibility layer, or shared research-database reset.
