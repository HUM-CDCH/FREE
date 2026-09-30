# ExtractBench source and adapter audit

Status: metadata selection frozen on 2026-09-30 before inference; three development sources visually spot-checked. This is a custom screening study, not an official benchmark submission. See the [selection manifest](2026-09-30-extractbench-selection.json) for the full identifiers, related-source membership, URLs, sizes, and checksums.

## Pins and public format

- Dataset: `llamaindex/ExtractBench`, revision `51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc`.
- Official evaluation source: `run-llama/ExtractBench`, commit `c8e59696b19c50d904801390dedef8d292d529e7`.
- The dataset card identifies this as v1.1: revised boxes, new grounding annotations, and minor value corrections; documents and schemas are unchanged from v1.0. Its 370 documents comprise 325 real and 45 synthetic documents. Grounding coverage is reported as 339 documents. The `short`/`medium`/`long` files contain 252/98/20 cases and denote length buckets, not development/test allocation. Use `source:real` tags, not filename prefixes: several `real_…` files are tagged synthetic. [Pinned dataset card](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/README.md)

Downloaded JSONL checksums were verified against Hugging Face LFS metadata:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `short.jsonl` | 30,717,761 | `3373bfdd44077f852b8f60e1d5b878a582c0c9517b22bcc5f4ec0d28f2ada36c` |
| `medium.jsonl` | 64,175,355 | `3fe712510db5cfaa80ff4469349ddc0071c70722dab26ed021bee218dac75b87` |
| `long.jsonl` | 163,097,453 | `b932c32a59a87a3e430cb475d2db94581aaf6a5589219579d2b43171cfe13b72` |

Each row has `id`, `category`, `pdf`, `data_schema`, `expected_output`, `field_rules`, `repeated_structure`, and `tags`. The four structured payloads are JSON-encoded strings. Rules can decode to a path-keyed dictionary or a legacy list. The official downloader reconstructs `_field_rules` or `test_rules` accordingly; it maps `repeated_structure` to evaluator-only `_eval_row_identity`, not the provider schema. Empty `repeated_structure` does not mean no arrays: both invoice smoke cases have `line_items` arrays and an empty identity block. [Pinned downloader](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/data/download.py#L1), [evaluation-only identity contract](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/test_cases/schema.py#L419)

## Gold and inference boundary

Preserve the complete nested expected object, all record arrays, field rules, and identity metadata in evaluator-only artifacts. A field's evidence entries may provide alternate values or alternate locations. At an array parent, object-valued evidence entries can instead represent its different records; those entries are not interchangeable replacements for the whole array. Keep the parent `structural`, `exhaustive`, and `expected_min` declarations. [Rule definitions](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/test_cases/schema.py#L215), [array comparison](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/evaluation/metrics/field_grounding/evidence_comparator.py)

There are no `values` or `alternatives` aliases in the typed rule contract. The unified scorer adds only non-null `evidence[*].value` alternatives to the expected-output value. Thus an expected null can also accept a declared non-null reading; a null evidence entry alone does not add null as an alternative to a non-null expected value. An absent field rule leaves expected-output scoring possible and supplies no grounding annotation. [Exact index construction](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/evaluation/metrics/extract/unified_evidence_metric.py#L1356)

Evidence uses one-based pages and normalized COCO boxes `[x, y, width, height]`. Preserve `quote`, `value`, `coarse`, and `layer` as well as `verified`, `evidence_required`, and `source_policy`. Layers include word, structural, and checkbox geometries. A nonempty evidence list may still have null pages, boxes, and quotes: it supplies acceptable values without locatable grounding. `evidence_required=true` and `verified=true` alone do not establish a page or box annotation. Keep explicit null values distinct from missing annotations and missing prediction keys. Legacy boxes may be represented losslessly with their supplied expected value; inventing a box, quote, or parser character span is not justified. [Evidence types](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/test_cases/schema.py#L168), [legacy conversion](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/test_cases/schema.py#L709)

The public utility schema contains examples of exact document readings and where to find them. Merely withholding `expected_output` and `field_rules` therefore does not remove answer disclosure. Preserve the original schema and its digest for provenance, and record the inference schema transformation explicitly: remove prose descriptions, examples, defaults, and other answer-bearing metadata before inference; retain structural schema constraints. Gold must remain unavailable to extraction, retrieval, evidence refinement, alignment, and merging. This deliberately changes the task instructions and prevents a claim of official protocol equivalence. The finding comes from the selected Pepco row in [pinned short cases](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/short.jsonl).

## Official scores versus harness scores

The official headline scorer recursively matches schema-defined objects and arrays, uses keyless Hungarian record assignment, and accepts the expected value or leaf evidence alternatives. Its equality includes whitespace/date normalization, explicit field normalizers, and named fuzzy-field defaults. These differ from both raw exact equality and a custom field-specific canonical score. Some other official diagnostics use declared comparators and row-identity rules; implementing only those diagnostics does not reproduce the headline score. [Unified scorer](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/evaluation/metrics/extract/unified_evidence_metric.py#L1), [cell equality and fuzzy defaults](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/evaluation/metrics/extract/array_record_match_metric.py#L46), [evaluator composition](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/evaluation/evaluators/extract.py#L309)

Official page/box correctness also requires a correct value. Box matching defaults to IoU 0.5 with envelope handling for multiline evidence; merely touching one line may fail. Missing annotation is ungradeable, and documents with no box annotations do not receive a box score. Precision counts only claims aligned to annotated gold cells. Official dataset reports average documents equally. The custom native-text parser supplies pages and character spans without boxes; it cannot measure official box grounding. Report annotation coverage and custom page/quote/localization outcomes separately, without synthesizing box labels. [Grounding contract](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/evaluation/metrics/extract/unified_evidence_metric.py#L34), [official reporting description](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/README.md)

For this study, the declared parser is pinned PDFium native text through `pypdfium2`, split into source lines with page and character offsets. Only annotated page grounding is measurable; semantic-support and exact value-localization labels are unavailable and remain N/A. Parser-derived positions are not new gold annotations.

## Frozen screening sample and grouping

The manifest selects **20 source groups and 20 representative PDFs: 12 development and 8 held out**. One preselected clean representative is scheduled per group. It reserves 75 related documents to those same splits (27 development, 48 held out); those 75 are not the study's executed-document count. The sample is purposeful, metadata-stratified screening, not a random population sample.

Development groups: Grafton invoice, Pepco utility bill, Mission invoice, Viega catalogue, Lancaster purchase order, Caterpillar specifications, Illinois fleet rates, Byline investor deck, Erie audit, Mitchell vehicle valuation, DD1155 schedules, and DoD CLIN schedules. The latter two select long documents; Mission, Viega, Erie, and CLIN have cross-page structure tags. Holdout groups: CFPB closing disclosures, Mississippi Medicaid remittance, TI specifications, Oklahoma purchase order, CBP7501 continuations, RRC H5 filings, SEC13F filings, and SF1449 schedules.

Grouping uses source stems and conservative family matching: clean/degraded captures stay together; both Caterpillar models, both Medicaid segments, all CFPB examples, and each selected regulatory-form family stay in one split. The official card describes recaptures and stripped PDF metadata, while the row format supplies no upstream source URL or authoritative source-family identifier. Consequently these groups are conservative assumptions, not proof of statistical independence. Audit upstream provenance before treating them as independent certification units. [Dataset metadata and capture description](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/README.md)

Only metadata, input schema structure, and source tags were used to choose the sample. Holdout PDFs were not downloaded, and holdout annotation strings were not decoded or viewed. The original immutable JSONL cache necessarily contains the published annotation strings; it stays outside inference inputs and committed files.

## Three development spot-checks

Used Poppler `pdfinfo`, `pdftotext -layout`, and rendered page images; these checks concern adapter interpretation, not a new annotation campaign. Counts below are field-rule entries, including array parents, not score denominators.

| Source | Pages / gold records | Rules / page-bearing / box-bearing | Interpretation checked against source |
| --- | --- | --- | --- |
| Grafton | 1 / 1 line item | 42 / 28 / 25 | Account-summary rows are not billable records. Nested vendor/customer fields and null absent fields remain intact. |
| Pepco | 3 / 1 meter | 22 / 20 / 20 | Meter evidence is on page 2. The absent combined-current-charges field is null despite separate delivery/supply totals. A due amount must not be replaced by the late-payment amount. |
| Mission | 2 / 8 line items | 98 / 57 / 49 | Billable group fees differ from unpriced component lines. One group's component list continues onto page 2; continuation does not create extra billable records. |

Sources: [Grafton PDF](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/docs/short/grafton_isotrope_invoice_19503.pdf), [Pepco PDF](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/docs/short/dc-pepco-residential-bill.pdf), [Mission PDF](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/docs/short/mission-tx-tyler-invoice.pdf), and their [pinned annotation rows](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/short.jsonl). These observations do not authorize document-specific scoring exceptions.

## Terms and local storage

The dataset card declares Apache-2.0 and describes the source documents as publicly available records. It does not provide per-source rights statements or original publication URLs in each row. This increment commits metadata, checksums, and sanitized notes, not PDFs; it makes no additional assertion about rights in every underlying source. [Publisher copyright statement](https://huggingface.co/datasets/llamaindex/ExtractBench/blob/51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc/README.md)

The research cache is `.scratch/extractbench-source/` on the workspace filesystem. A quota failure in the task's initial `/tmp` cache was resolved by moving only that task-owned directory. JSONL checksums are SHA-256. PDF metadata uses LFS SHA-256 where available and a Git blob SHA-1 otherwise; verify that algorithm before recording a downloaded PDF's additional SHA-256. Do not label an undownloaded ordinary Git blob's SHA-1 as SHA-256.
