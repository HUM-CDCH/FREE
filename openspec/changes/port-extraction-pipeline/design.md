<!-- markdownlint-disable MD013 MD041 -->

## Context

The parsing service already publishes a canonical `parsed_document.v1` containing Markdown, page mapping, spans, and tables. Its Evidence Anchor collection is optional and currently has no producer, so extraction must use canonical pages and spans as the baseline and consume anchors only when present. Studio still uses an older browser-facing extraction flow and does not implement the Catalog hierarchy, recursive conformance, retry, merge, or embedded Evidence behavior proven in `FREE-technical` at commit `67ea4dc535a2ab674ed8c4b558068e13e7c2980d`.

The port crosses the Studio browser/API boundary but does not change parsing. Provider configuration must remain server-side, and the raw NuExtract prompt renderer in `api/_model.ts` must remain authoritative because `ai-sdk-ollama` cannot express the required raw Ollama generate control.

## Goals / Non-Goals

**Goals:**

- Reproduce the pinned Catalog behavior against a completed canonical `ParsedDocument`.
- Preserve faithful recursive conformance and schema-shaped embedded Evidence.
- Support explicit Catalog and Article strategies through one server endpoint.
- Add deterministic tests and server TypeScript checking before live-model verification.

**Non-Goals:**

- Parsing, OCR, PDF inspection, table discovery, or canonical-document publication.
- Compatibility with the current extraction request/result shape.
- Schema editing, human review, evaluation, export, or durable extraction storage.
- A Python extraction worker, new provider abstraction, queue, database, repository layer, dependency-injection framework, or rollout/version registry.

## Decisions

### Keep extraction in the Studio server runtime

The browser sends an `application/json` body `{ taskId, schema, strategy }` to `prototypes/studio/api/extract.ts`. `schema` must be a full FREE Extraction Schema envelope with a `record` object and `_schema_metadata` object. Studio wraps its current generated record template in that envelope before sending it. The server fetches the completed canonical document, builds prompts, invokes the configured model, parses and conforms model output against `schema.record`, executes the selected strategy, and normalizes Evidence. Successful responses are exactly `{ result, warnings }`, where warnings are ordered strings and `boundary_fallback` is the only warning introduced by this change.

This keeps provider configuration out of the browser and keeps parsing/OCR in Python. Moving extraction into `parsing_service` was rejected because hierarchy, conformance, retry, merge, and Evidence transformations have no Python-only dependency once a `ParsedDocument` exists.

### Consume a narrow `parsed_document.v1` boundary

The extraction endpoint validates `schema_version === "parsed_document.v1"` and only the fields extraction reads from `GET /tasks/{task_id}/parsed-document`. Optional `evidence_index.anchors` are consumed when present but are not required. It does not introduce an `ExtractionDocument` schema or wait for the parked `parsed_document.v2` change. The server resolves the parsing service from `PARSING_SERVICE_URL`, then `VITE_PARSING_SERVICE_URL`, then `http://127.0.0.1:8000`.

A narrow boundary minimizes coupling while preserving the shipped contract. If v2 is published later, only these field reads need migration.

### Require an explicit extraction strategy

The request carries `strategy: "catalog" | "article"`. Strategy is never inferred from schema shape because both reference fixtures contain `record.entries`, and the pinned implementation selects the extractor explicitly.

Catalog is delivered first; Article follows through the same document, model, conformance, and Evidence path.

### Port Catalog behavior as characterized pure functions

`api/_catalog.ts` owns primary repeated-array inference, boundary prompting, marker resolution, source-ordered slicing, whole-document fallback, suspicious-record detection, one retry, merge, and scalar-fingerprint deduplication. The model call is injected so pure behavior and orchestration can be tested with deterministic responses.

The port intentionally preserves reference limitations: document-level fields outside the repeated array remain empty, unresolved boundaries produce one whole-document section, suspicious records retry once, and fingerprint deduplication can collapse similar records.

### Keep conformance and Evidence in existing responsibility areas

`api/_model_output.ts` owns faithful recursive `_conform_to_schema` behavior: unknown keys are dropped, missing fields are restored, missing scalars become `null`, missing arrays become `[]`, singleton values can become one-element arrays, free-form `{}` and `[]` remain free-form, and non-scalars in scalar slots become `null`.

`api/_evidence_template.ts` owns traversal and normalization of schema-local `_evidence` slots. It preserves `table_index`, including nested `fundliste` Evidence, and resolves that 1-based index against deterministic canonical table order. Applying the pinned default-extractor table backfill to canonical `ParsedTable` cells is an intentional extension of the pinned hierarchical Catalog path, which did not receive table files. Text Evidence is grounded through canonical page text/spans, with optional anchors as an additional source. The pinned ellipsis behavior is retained by splitting `...` and `…`-glued snippets into trimmed contiguous snippets.

A separate result codec or evidence service was rejected because this port has one public result shape and no persistence boundary.

### Reuse the raw NuExtract model boundary

`api/_model.ts` exposes one callable structured-generation function while retaining the hand-built prompt and direct Ollama `POST /api/generate` request with `raw: true`. Catalog and Article orchestration depend on that callable boundary rather than introducing a provider abstraction.

The installed AI SDK remains available where useful, but `ai-sdk-ollama` is not substituted for the raw path because it cannot reproduce the required NuExtract control channel.

### Keep production code shape narrow

Prefer edits to `src/api.ts`, `api/extract.ts`, `api/_model.ts`, `api/_model_output.ts`, and `api/_evidence_template.ts`. Add only `api/_catalog.ts` and, when Article begins, `api/_article.ts` unless a file becomes demonstrably difficult to test or navigate.

An API/server TypeScript configuration is referenced by the Studio build so `api/*.ts` cannot remain outside type checking.

## Risks / Trade-offs

- **Reference behavior contains known lossy heuristics** → Pin characterization tests and preserve the behavior instead of redesigning it during the port.
- **The v1 document contract may later be superseded** → Validate only the fields extraction reads and isolate the fetch/selection boundary.
- **Model output is nondeterministic** → Use injected deterministic responses for CI and keep live NuExtract checks opt-in.
- **Evidence may fail when model text differs from canonical text** → Preserve reference normalization and ellipsis handling; do not invent fuzzy matching beyond the pinned behavior.
- **Vercel filesystem is ephemeral** → Return results directly and add no filesystem cache or persistence convention.
- **A growing Catalog module could become difficult to navigate** → Begin with the constrained module shape and split only after tests demonstrate a real cohesion boundary.

## Migration Plan

1. Characterize and port pure Catalog behavior and recursive conformance with fixtures.
2. Replace the browser extraction contract and deliver Burial Finds through the server endpoint.
3. Complete canonical Evidence normalization and add Article extraction.
4. Run Studio tests and build after every slice; keep live model smoke tests opt-in.

Rollback is source-level: revert the slice before depending on its new request shape. No persisted extraction data or database migration requires rollback.

## Open Questions

None. Any newly discovered contract decision that changes the pinned behavior or expands the do-not-build list requires human review before implementation continues.
