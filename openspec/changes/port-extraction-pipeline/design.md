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

The browser sends an `application/json` body `{ taskId, schema, strategy }` to `prototypes/studio/api/extract.ts`. `schema` must be a full FREE Extraction Schema envelope with a `record` object and `_schema_metadata` object. Pinned schemas live at the same `schemas/<DocumentType>/<Schema>.json` paths as the reference repository; Studio imports the verbatim files into its schema selector and preserves the selected envelope through extraction. The existing generated-template path adapts its template to an envelope at the schema-generation boundary, rather than `requestExtraction` discarding a caller's metadata. The server fetches the completed canonical document, builds prompts, invokes the configured model, parses and conforms model output against `schema.record`, executes the selected strategy, and normalizes Evidence. Successful responses are exactly `{ result, warnings }`, where warnings are ordered strings and `boundary_fallback` is the only warning introduced by this change.

This keeps provider configuration out of the browser and keeps parsing/OCR in Python. Moving extraction into `parsing_service` was rejected because hierarchy, conformance, retry, merge, and Evidence transformations have no Python-only dependency once a `ParsedDocument` exists.

### Consume a narrow `parsed_document.v1` boundary

The extraction endpoint validates `schema_version === "parsed_document.v1"` and only the fields extraction reads from `GET /tasks/{task_id}/parsed-document`. Optional `evidence_index.anchors` are consumed when present but are not required. It does not introduce an `ExtractionDocument` schema or wait for the parked `parsed_document.v2` change. The server resolves the parsing service from `PARSING_SERVICE_URL`, then `VITE_PARSING_SERVICE_URL`, then `http://127.0.0.1:8000`.

A narrow boundary minimizes coupling while preserving the shipped contract. If v2 is published later, only these field reads need migration.

### Require an explicit extraction strategy

The request carries `strategy: "catalog" | "article"`. Strategy is never inferred from schema shape because both reference fixtures contain `record.entries`, and the pinned implementation selects the extractor explicitly.

Catalog is delivered first; Article follows through the same document, model, conformance, and Evidence path. Article includes one deterministic inventory of canonical tables in its single model prompt.

### Port Catalog behavior as characterized pure functions

`api/_catalog.ts` owns primary repeated-array inference, boundary prompting, marker resolution, source-ordered slicing, whole-document fallback, suspicious-record detection, one retry, merge, and scalar-fingerprint deduplication. The model call is injected so pure behavior and orchestration can be tested with deterministic responses.

The port intentionally preserves reference limitations: document-level fields outside the repeated array remain empty, unresolved boundaries produce one whole-document section, suspicious records retry once, and fingerprint deduplication can collapse similar records.

### Keep conformance and Evidence in existing responsibility areas

`api/_model_output.ts` owns faithful recursive `_conform_to_schema` behavior: unknown keys are dropped, missing fields are restored, missing scalars become `null`, missing arrays become `[]`, singleton values can become one-element arrays, free-form `{}` and `[]` remain free-form, and non-scalars in scalar slots become `null`.

`api/_evidence_template.ts` owns traversal and normalization of schema-local `_evidence` slots, including nested `fundliste` Evidence. Final table Evidence Anchors come from deterministic matching against document-global canonical `ParsedTable` and cell order; model-provided page, table, row, and column coordinates are hints, not authority. Catalog discards those location hints before applying the pinned default-extractor table backfill algorithm because each hierarchical model call sees only a section and may emit section-local coordinates. It accepts only a unique match supported by Evidence snippets and the Extraction Result value, leaving the location empty when matching is ambiguous. Article may use its document-global table inventory as a verified hint, but canonical matching still owns the final Evidence Anchor. This is an intentional correction to the pinned hierarchical Catalog path, which did not receive table files or deterministically backfill table locations. Text Evidence is grounded first through slices of canonical `text_views.llm_markdown` selected by page spans, then page text and optional anchors. The pinned ellipsis behavior is retained by splitting `...` and `…`-glued snippets into trimmed contiguous snippets.

A separate result codec or evidence service was rejected because this port has one public result shape and no persistence boundary.

### Reuse the raw NuExtract model boundary

`api/_model.ts` exposes one callable structured-generation function while retaining the hand-built prompt and direct Ollama `POST /api/generate` request with `raw: true`. Catalog and Article orchestration depend on that callable boundary rather than introducing a provider abstraction.

The installed AI SDK remains available where useful, but `ai-sdk-ollama` is not substituted for the raw path because it cannot reproduce the required NuExtract control channel.

### Document supported provider profiles instead of enforcing model names

FREE documents supported execution profiles but does not parse model names to enforce a quantization level, silently route extraction strategies to different providers, or reject custom models. Local Catalog uses NuExtract Q4 or better with a context appropriate to the available machine. Article uses either authenticated Codex CLI or NuExtract Q4 or better on a capable Ollama host such as the Spark machine. Ollama accepts an optional positive `AI_NUM_CTX`, which is serialized into the raw generation request; Codex CLI owns its context configuration.

Concrete examples and allowed values remain valid researcher-authored Extraction Schema metadata and are sent verbatim in the instructions channel, separate from Source Context. FREE does not sanitize arbitrary metadata because doing so would destroy legitimate extraction guidance. Provider qualification instead includes a live Catalog fixture whose Source Document values conflict with a metadata example, proving that a supported model does not copy the example as an Extraction Result.

Completion requires two explicit live lanes outside ordinary CI: a NuExtract Q4-or-better Ollama Catalog smoke that rejects metadata-example leakage, and an Article smoke through at least one Article-capable provider (Codex CLI or Spark-hosted Ollama) that returns schema-shaped values with canonical table Evidence. Both lanes retain deterministic CI counterparts; when both Article providers are available, both may be exercised and the passing provider profiles are recorded.

### Keep production code shape narrow

Prefer edits to `src/api.ts`, `api/extract.ts`, `api/_model.ts`, `api/_model_output.ts`, and `api/_evidence_template.ts`. In addition to `api/_catalog.ts` and `api/_article.ts`, review corrections authorize two cohesion modules: `api/_table_evidence.ts` for canonical table matching and `src/pdfTextMatching.ts` for the pure reference-derived PDF token matcher. These splits keep table grounding separate from Evidence traversal and text matching separate from PDF rendering; no broader Catalog split is part of this change.

An API/server TypeScript configuration is referenced by the Studio build so `api/*.ts` cannot remain outside type checking.

## Risks / Trade-offs

- **Reference behavior contains known lossy heuristics** → Pin characterization tests and preserve the behavior instead of redesigning it during the port.
- **The v1 document contract may later be superseded** → Validate only the fields extraction reads and isolate the fetch/selection boundary.
- **Model output is nondeterministic** → Use injected deterministic responses for CI and keep live NuExtract checks opt-in.
- **Evidence may fail when model text differs from canonical text** → Preserve reference normalization and ellipsis handling; do not invent fuzzy matching beyond the pinned behavior.
- **Vercel filesystem is ephemeral** → Return results directly and add no filesystem cache or persistence convention.
- **A growing Catalog module could become difficult to navigate** → Begin with the constrained module shape and split only after tests demonstrate a real cohesion boundary.

## Migration Plan

1. Characterize and port pure Catalog behavior and recursive conformance with tests that consume the same pinned production schemas as Studio.
2. Replace the browser extraction contract and deliver Burial Finds through the server endpoint.
3. Complete canonical Evidence normalization and add Article extraction.
4. Run Studio tests and build after every slice; keep live model smoke tests opt-in.

Rollback is source-level: revert the slice before depending on its new request shape. No persisted extraction data or database migration requires rollback.

## Open Questions

None. Any newly discovered contract decision that changes the pinned behavior or expands the do-not-build list requires human review before implementation continues.
