<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Extraction requests identify a completed parsing task and explicit strategy

The Studio extraction endpoint SHALL accept an `application/json` body `{ taskId, schema, strategy }`, where `schema` is a full FREE Extraction Schema envelope containing an object-valued `record` and object-valued `_schema_metadata`, and `strategy` is explicitly `catalog` or `article`. The browser SHALL NOT send Source Document bytes or a complete `ParsedDocument` in the extraction request.

#### Scenario: Catalog extraction is requested

- **WHEN** the browser submits `{ taskId, schema, strategy: "catalog" }`
- **THEN** the server starts Catalog extraction for the completed parsing task
- **AND** the strategy is not inferred from the shape of the Extraction Schema

#### Scenario: Article extraction is requested

- **WHEN** the browser submits `{ taskId, schema, strategy: "article" }`
- **THEN** the server starts Article extraction for the completed parsing task
- **AND** the strategy is not inferred from the shape of the Extraction Schema

#### Scenario: Strategy is absent or unsupported

- **WHEN** an extraction request omits `strategy` or supplies a value other than `catalog` or `article`
- **THEN** the endpoint rejects the request before model invocation

#### Scenario: Schema is not a full envelope

- **WHEN** an extraction request supplies a plain record template or omits `record` or `_schema_metadata`
- **THEN** the endpoint rejects the request before fetching the canonical document or invoking the model

### Requirement: Extraction resolves the shipped canonical document server-side

The Studio server SHALL fetch `GET /tasks/{task_id}/parsed-document` from the parsing service configured by `PARSING_SERVICE_URL`, falling back to `VITE_PARSING_SERVICE_URL` and then `http://127.0.0.1:8000`, and validate the `parsed_document.v1` fields required by extraction. Extraction SHALL consume canonical LLM Markdown, pages, spans, tables, and optional Evidence Anchors from that response without opening or reparsing the Source Document.

#### Scenario: Completed canonical document is available

- **WHEN** the parsing task is complete and returns a valid `parsed_document.v1`
- **THEN** extraction uses its canonical Markdown and grounding structures as Source Context
- **AND** no extraction path reads Source Document bytes or invokes PDF, Docling, OCR, or Camelot processing

#### Scenario: Parsing task is not complete

- **WHEN** the parsing service reports that the requested task has not completed
- **THEN** the extraction endpoint returns a mapped client-visible error
- **AND** no model call is made

#### Scenario: Canonical document contract is invalid

- **WHEN** the parsing service response has a different schema version or omits a field required by extraction
- **THEN** the extraction endpoint fails at its canonical-document boundary
- **AND** it does not fabricate missing canonical values

### Requirement: Model extraction remains server-side and uses the existing raw NuExtract boundary

Catalog and Article extraction SHALL call one server-side structured-generation function that uses Studio's existing hand-built NuExtract prompt and direct Ollama generate path with `raw: true`. Provider configuration and credentials SHALL NOT be sent to or selected by the browser.

#### Scenario: Structured generation is requested

- **WHEN** either extraction strategy needs model output
- **THEN** it calls the shared server-side structured-generation function
- **AND** the function renders the NuExtract prompt and invokes the configured model boundary

#### Scenario: Browser starts extraction

- **WHEN** a browser client submits an extraction request
- **THEN** it supplies only task identity, Extraction Schema, and strategy
- **AND** it does not receive provider credentials or execute model generation locally

### Requirement: Article strategy performs one whole-document extraction

Article extraction SHALL make one structured-generation call over the complete canonical LLM Markdown plus a deterministic inventory of canonical tables when tables exist. The table inventory SHALL identify tables by document-global 1-based `table_index` and cells by 0-based `row` and `col`, then extraction SHALL recursively conform the model result to `schema.record` and normalize embedded Evidence through the shared result path.

#### Scenario: Article schema contains a repeated entries field

- **WHEN** Article extraction uses a schema such as `collagen_extraction.json` that also contains `record.entries`
- **THEN** the endpoint performs one whole-document Article call
- **AND** it does not route to Catalog behavior based on that repeated field

#### Scenario: Article canonical tables are available

- **WHEN** Article extraction receives a canonical document containing tables
- **THEN** its single model call retains the complete canonical LLM Markdown
- **AND** includes each canonical table's document-global 1-based index, page, and cell row, column, role, and text

#### Scenario: Article extraction succeeds

- **WHEN** the model returns a parseable result for the whole canonical document
- **THEN** the endpoint returns the conformed schema-shaped Extraction Result with embedded Evidence and minimal warnings

### Requirement: Extraction returns a schema-shaped result and minimal warnings

The extraction endpoint SHALL return exactly `{ result, warnings }`, where `result` is the conformed `schema.record` shape and `warnings` is an ordered string array. `boundary_fallback` SHALL be the only warning introduced by this change. The endpoint SHALL NOT persist or cache the Extraction Result.

#### Scenario: Extraction succeeds without fallback

- **WHEN** extraction completes without a warning condition
- **THEN** the response contains the schema-shaped Extraction Result
- **AND** its warnings collection is empty

#### Scenario: Extraction succeeds with a recoverable condition

- **WHEN** extraction uses a defined fallback or otherwise produces a recoverable warning
- **THEN** the response contains both the successful Extraction Result and the warning

#### Scenario: Response is returned

- **WHEN** the endpoint completes successfully
- **THEN** the result is returned directly to the caller
- **AND** no filesystem cache, database record, or parsing-service persistence is created for it
