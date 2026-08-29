# FREE-technical Catalog and Article Extraction Strategies

Research snapshot: upstream `HUM-CDCH/FREE-technical` `main` at [`67ea4dc`](https://github.com/HUM-CDCH/FREE-technical/commit/67ea4dc535a2ab674ed8c4b558068e13e7c2980d) (2026-05-19). Only first-party source and documentation were used.

## Bottom line

`Article` and `Catalog` are two strategies for applying the **same selected schema** to one document. They do not define different schema types or result contracts:

- **Article** is the default, whole-document path: Docling plain text plus separately extracted Camelot tables go through one schema-shaped LLM call.
- **Catalog** is a repeated-record path: Docling DocTags are simplified to Markdown, a model finds boundaries for the schema's primary repeated collection, each section is extracted separately, and Python merges, checks, and selectively retries the records.

The reusable product behavior is the strategy choice—whole-document versus boundary-driven repeated-record extraction. The Streamlit state, DocTags/Camelot wiring, filesystem layout, prompt-authored `_evidence`, and current validation heuristics are implementation-specific and should not be copied as architecture.

## Exact researcher-visible semantics

| Concern | Article | Catalog |
|---|---|---|
| UI | First/default option in a radio labelled **Document type** | Second option in the same radio |
| Help text | “Docling text and Camelot table pipeline” | “hierarchical DocTags multi-pass pipeline” |
| Parsed input | Docling `text`; page markers are added and Camelot tables are supplied separately | Docling `doctags`, simplified to Markdown; no separate Camelot appendix |
| Model scope | One whole-document extraction call | Boundary call, then one extraction call per resolved primary record, with optional retry |
| Result | One schema-shaped object appended to `results` | Per-section items merged into one schema-shaped object, then appended once to `results` |
| Availability | Single-document dialog and all folder/batch runs | Single-document dialog only |

The UI sets `Article` by default. Selecting `Catalog` changes only `extract.parse_format` to `DocTags` and enables the hierarchical extractor; selecting `Article` sets plain `Text` and disables it. The same choice is shown both before a first run and when rerunning an opened extraction. See [`core/app_state.py` lines 5-17](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/app_state.py#L5-L17) and [`ui/validation.py` lines 571-625](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/ui/validation.py#L571-L625).

This “Document type” is distinct from the schema selector's **Document Type**, which is merely the schema directory/domain (`FieldReports`, `JournalArticles`, etc.). Any selected schema can be run through either strategy; there is no code-level mapping from a schema domain to Article or Catalog. See [`1_Extraction.py` lines 106-143](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/1_Extraction.py#L106-L143).

Folder/batch extraction exposes no Article/Catalog choice and always uses Docling text, Camelot tables, and the default extractor. See [`1_Extraction.py` lines 257-332](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/1_Extraction.py#L257-L332) and [`services/batch_extraction.py` lines 54-94](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/services/batch_extraction.py#L54-L94).

Catalog routing is also PDF-only in practice. Non-PDF uploads keep a source such as `txt` rather than acquiring the `_doctags` suffix, so the extractor falls through to the default whole-document path even when Catalog is selected. See [`services/single_extraction.py` lines 70-88](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/services/single_extraction.py#L70-L88) and [`services/single_extraction.py` lines 220-252](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/services/single_extraction.py#L220-L252).

## Shared schema and output contract

Both strategies consume the same wrapper:

- `record`: the desired output object, including scalars, arrays, nested arrays, and `_evidence` templates;
- `_schema_metadata`: path-keyed `instance_description` and optional `allowed_values` instructions.

There is no Article-specific or Catalog-specific schema. The schema authoring model is independently **Simple** (one document-level record) or **Hierarchical** (`record.entries[]`, optionally with one nested sub-list level). Arrays express multiplicity; `instance_description` defines what counts as one item. See [`docs/schema_creation.md` lines 9-32](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/docs/schema_creation.md#L9-L32) and [`docs/schema_creation.md` lines 133-175](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/docs/schema_creation.md#L133-L175).

Runtime conformance is shape-oriented: it drops extra keys, fills missing containers, wraps singletons into arrays, and accepts any basic scalar at scalar leaves. It does not enforce scalar types or `_schema_metadata.allowed_values` after generation. See [`core/extract.py` lines 18-65](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/extract.py#L18-L65).

Catalog becomes meaningfully multi-pass only when `record` contains a top-level array with exactly one object template. If several exist, the implementation chooses the one with the longest `instance_description`, then declaration order. With no such array, Catalog degenerates to one whole-document extraction call. See [`core/hierarchical/schema_infer.py` lines 6-45](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/schema_infer.py#L6-L45) and [`core/hierarchical/orchestrate.py` lines 78-99](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/orchestrate.py#L78-L99).

## Pipeline branches

### Article

For PDFs, the single-document service extracts Camelot tables only when the parsed source is neither Markdown nor DocTags. It selects the default extractor, which receives page-marked text, the whole `record` schema, metadata, and the separate table payload in one call. The response is conformed to the schema, extra keys are dropped, missing values are filled from the template, and table evidence fields may be backfilled from Camelot matches. See [`services/single_extraction.py` lines 220-255](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/services/single_extraction.py#L220-L255), [`services/pipeline.py` lines 28-100](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/services/pipeline.py#L28-L100), and [`core/extract.py` lines 891-935](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/extract.py#L891-L935).

Although `process_first_pages` is passed through the service API, the pipeline does not use it; the current Article call receives the full parsed text as one “giant block.” See [`services/pipeline.py` lines 28-59](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/services/pipeline.py#L28-L59).

### Catalog

Catalog first converts DocTags to Markdown-like text, preserving headings and converting/merging OTSL table chunks across page breaks. It then:

1. infers the primary repeated array from the schema;
2. asks the model for every record's verbatim start/end markers;
3. resolves markers and slices the document;
4. extracts exactly one item per section using the array item schema and its metadata;
5. merges items into the original `record` shape;
6. flags empty, duplicate, or suspiciously table-empty items and retries them once.

See [`core/doctags_simplify.py` lines 107-180](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/doctags_simplify.py#L107-L180), [`core/hierarchical/prompts.py` lines 15-79](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/prompts.py#L15-L79), and [`core/hierarchical/orchestrate.py` lines 101-225](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/orchestrate.py#L101-L225).

The validation is a recovery heuristic, not a completeness proof. Unresolvable proposed boundaries are skipped; if none resolve, the implementation falls back to one section covering the whole document. Its count check compares resolved sections to the items produced by iterating those sections, so it does not prove that every source record was discovered. See [`core/hierarchical/boundaries.py` lines 97-139](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/boundaries.py#L97-L139), [`core/hierarchical/orchestrate.py` lines 112-124](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/orchestrate.py#L112-L124), and [`core/hierarchical/validate.py` lines 13-23](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/validate.py#L13-L23).

The current merge is also lossy for mixed document/entry schemas: when a primary array exists, it initializes document-level fields to schema defaults and inserts only the merged array. Per-section duplicates are removed using a fingerprint of top-level scalar values and array lengths. These are implementation defects/heuristics, not reusable Catalog semantics. See [`core/hierarchical/merge.py` lines 9-67](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/hierarchical/merge.py#L9-L67).

## Persistence, review, and export implications

- Parsed representations are cached separately by `text_source`, so the same PDF may retain both `docling` and `docling_doctags` forms. See [`core/save_json.py` lines 233-305](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/save_json.py#L233-L305).
- Extraction identity is only document hash + schema + model. The saved metadata includes `text_source`, but not the Article/Catalog choice or extractor variant. Running the other strategy for the same tuple writes the same extraction JSON and prompt-audit paths. See [`core/save_json.py` lines 76-106](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/save_json.py#L76-L106) and [`core/save_json.py` lines 109-162](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/save_json.py#L109-L162).
- Catalog's structured boundary, section, validation, failure, and retry diagnostics are not persisted; the adapter saves only a concatenated prompt audit. See [`core/extract_doctags.py` lines 266-290](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/extract_doctags.py#L266-L290).
- Review/validation is downstream and strategy-agnostic: annotations are keyed by schema/model and record identity, without an Extraction Strategy. See [`ui/validation.py` lines 406-438](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/ui/validation.py#L406-L438).
- JSON export returns the original extraction files. Excel export is schema-agnostic, omits underscore-prefixed evidence data, and can emit one row per document or explode a populated top-level/nested array up to two levels. This behavior is equally available to both strategies. See [`core/export.py` lines 82-167](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/export.py#L82-L167) and [`pages/6_Export.py` lines 162-208](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/pages/6_Export.py#L162-L208).

## Relationship to this FREE repository

Catalog/Article should be a separate Extraction Strategy dimension from FREE's established Direct Extraction and Schema-Guided Extraction modes:

- **Direct Extraction** means extraction without prior annotations, schema suggestion review, or approved Extraction Schema.
- **Schema-Guided Extraction** means extraction using an explicit Extraction Schema for precision and repeatability.

Those terms describe the research workflow and schema authority; Article/Catalog describe how a document is parsed and how repeated records are scheduled. Therefore neither `Article = Direct` nor `Catalog = Schema-Guided` is valid. Both upstream paths require a selected schema. See current FREE terminology in [`CONTEXT.md` lines 39-45](https://github.com/HUM-CDCH/FREE/blob/f46f42f7e2228a175b37577539cc8943f249e464/CONTEXT.md#L39-L45).

The upstream evidence mechanism must not cross the architecture boundary. Both upstream paths ask the extraction model to author `_evidence` snippets, inferred flags, pages, and sometimes table coordinates; the example schemas persist those fields beside values. See [`core/extract.py` lines 849-868](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/core/extract.py#L849-L868) and [`schemas/FieldReports/Burial_Finds.json` lines 4-40](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/schemas/FieldReports/Burial_Finds.json#L4-L40).

Current FREE instead separates extracted values from grounding: the model may select only exact call-scoped labels that resolve to parser-published Evidence Anchor IDs, and it is explicitly forbidden to add snippets, pages, or coordinates. Accepted review state persists `evidenceLinks` plus occurrence IDs derived from those canonical anchors. See [`extractionGrounding.ts` lines 238-349](https://github.com/HUM-CDCH/FREE/blob/f46f42f7e2228a175b37577539cc8943f249e464/prototypes/studio/src/extractionGrounding.ts#L238-L349), [`useExtraction.ts` lines 48-72](https://github.com/HUM-CDCH/FREE/blob/f46f42f7e2228a175b37577539cc8943f249e464/prototypes/studio/src/useExtraction.ts#L48-L72), and [`useExtraction.ts` lines 296-319](https://github.com/HUM-CDCH/FREE/blob/f46f42f7e2228a175b37577539cc8943f249e464/prototypes/studio/src/useExtraction.ts#L296-L319).

### Reuse boundary

Reuse:

- an explicit, orthogonal extraction-strategy choice;
- whole-document extraction for article-like sources;
- boundary discovery, per-instance extraction, merge, diagnostics, and targeted retry for catalogue-like repeated records;
- the same Extraction Schema and Extraction Result shape across strategies;
- strategy-agnostic review and JSON/row-oriented export behavior.

Redesign for current FREE:

- run both strategies over `parsed_document.v2` canonical content rather than introducing DocTags as a second source authority;
- keep values-only extraction separate from canonical Evidence grounding;
- persist the chosen strategy and its model attribution with the Extraction so reopening and comparison are deterministic;
- use `ProjectStore`/PostgreSQL lifecycle boundaries rather than upstream local folders and session state;
- treat boundary coverage and retry diagnostics as observable quality signals, not proof of completeness.

Upstream automated coverage for the hierarchical path is deterministic unit coverage with no live LLM calls, so the source establishes intended mechanics but not provider-independent runtime reliability. See [`tests/test_hierarchical.py` lines 1-12](https://github.com/HUM-CDCH/FREE-technical/blob/67ea4dc535a2ab674ed8c4b558068e13e7c2980d/tests/test_hierarchical.py#L1-L12).
