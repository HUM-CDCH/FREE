<!-- markdownlint-disable MD013 MD041 -->

## Why

FREE can publish a canonical `ParsedDocument`, but Studio cannot yet reproduce the proven extraction behavior from `FREE-technical` against that document. Porting the pinned reference behavior now provides a narrow path to Catalog and Article Extraction Results without moving parsing back into Studio or waiting for the parked `parsed_document.v2` contract.

## What Changes

- Add a server-side JSON extraction endpoint that accepts `{ taskId, schema, strategy }`, where `schema` is a full FREE Extraction Schema envelope, fetches the completed `parsed_document.v1`, and runs extraction without reopening or reparsing the Source Document.
- Port Catalog boundary detection, marker resolution, slicing, whole-document fallback, per-section extraction, one retry, source-ordered merge, and scalar-fingerprint deduplication from the pinned `FREE-technical` reference.
- Port faithful recursive conformance and embedded local Evidence normalization, including nested `fundliste` Evidence and deterministic `table_index` resolution.
- Add explicit Article extraction through the same canonical-document, model, conformance, and Evidence path.
- Reuse Studio's existing raw NuExtract/Ollama boundary and display the resulting record plus minimal warnings.
- **BREAKING** Replace the current multipart browser extraction request and legacy result/evidence envelope with JSON `{ taskId, schema, strategy }` and `{ result, warnings }`.

## Capabilities

### New Capabilities

- `canonical-document-extraction`: Server-side Extraction orchestration over a completed `parsed_document.v1`, with explicit Catalog or Article strategy and the existing model boundary.
- `catalog-extraction`: Reference-compatible Catalog boundary, fallback, retry, merge, ordering, and deduplication behavior.
- `extraction-result-normalization`: Recursive record-schema conformance and embedded local Evidence normalization against canonical pages, optional anchors, tables, and cells.

### Modified Capabilities

- `frontend-api-client`: Replace the current extraction transport contract with task-ID-based canonical-document extraction and retain the parsing task ID for later extraction.
- `extraction-results-view`: Display the schema-shaped Extraction Result and minimal extraction warnings returned by the new endpoint.
- `evidence-highlight-layer`: Restore PDF text-layer highlighting for finite number and boolean Extraction Result leaves through scalar stringification.

## Impact

- Affects `prototypes/studio/src/api.ts`, the existing Results view/state flow, and server modules under `prototypes/studio/api`.
- Adds the planned `_catalog.ts` and `_article.ts` production modules plus the approved `_table_evidence.ts` and `pdfTextMatching.ts` cohesion splits while extending `_model.ts`, `_model_output.ts`, and `_evidence_template.ts`.
- Adds API/server TypeScript checking to the Studio build and deterministic pure/API tests based on the pinned `FREE-technical` commit `67ea4dc535a2ab674ed8c4b558068e13e7c2980d`.
- Depends on the parsing service's shipped `GET /tasks/{task_id}/parsed-document` and `parsed_document.v1`; it does not change Python parsing, OCR, canonical publication, or provider configuration.
- Does not add persistence, queues, a new provider abstraction, schema editing, review, evaluation, export, or production rollout machinery.
