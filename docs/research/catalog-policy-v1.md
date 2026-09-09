# Catalog policy v1: fewer model calls, same links

Status: measured on 2026-09-09 with the production executor on local models;
default flipped in `packages/extraction/src/catalog.ts`. Links stay reviewer
suggestions: no score, no threshold, no automatic acceptance.

Sources: the catalog experiments
([RESULTS](../../prototypes/studio/experiments/catalog/RESULTS.md),
[models](../../prototypes/studio/experiments/catalog/models-v1/README.md),
[transfer](../../prototypes/studio/experiments/catalog/examples-transfer-v1/README.md),
[verification](../../prototypes/studio/experiments/catalog/verification-v1/README.md)),
the grounding lab ([design notes](grounding-lab-design-notes.md),
[performance report](grounding-lab-performance-report.md)), the Beier
rehearsal ([validation](../validation/2026-09-07-beier-user-test.md)) and the
policy experiment ([protocol](../../prototypes/studio/experiments/catalog/policy-v1/PROTOCOL.md);
generated results under `artifacts/catalog-lab/policy-v1/`, git-ignored).

## 1. The problem

The Catalog strategy made one discovery call per page chunk, one values call
per record and one grounding call per record. The full Beier catalogue
(420 entries) took **885 calls in 1 h 46 min**: 45 discovery, 420 values,
420 grounding.

## 2. What the two labs established

- The catalog experiment measured, on a 29-record Beier excerpt with a
  frozen seven-field schema, that record batching, code linking and one
  selective grounding call gave 11 calls instead of 61 with equal or better
  accuracy. Its three follow-ups were negative: the Beier `Fdpl.` rule
  boundaries find zero records on five Danish reports; the frozen batch
  linker's integer-dot row binding drops rows; no OCR, retriever or GLiNER
  model beats the incumbents; every measured burial-axis verifier loses
  correct axes. Nothing in it was fit to ship as is.
- The grounding lab concluded that no non-model grounder replaces the model
  and that its confidence numbers are not confidence. Two findings carried
  over: single lexical hits that pass unverified link the wrong passage on
  traps, and a grounder shown the field name and siblings was its best scorer.
- Both labs diagnosed the same production defect: the grounding request sent
  anonymous `C1 → value` pairs with no field name or definition, so a string
  located under another meaning (a pavement direction as `burial_axis`, an
  archive name as `locality`) received a link.

## 3. The policy

`CatalogPolicy` (`packages/extraction/src/catalog.ts`), read by Studio from
`FREE_CATALOG_POLICY` (JSON) in `api/_extraction_runtime.ts`:

| Key | Production default | Meaning |
|---|---|---|
| `recordBatchSize` | 5 | Records per values call. Each slice sits under a `### Record R<n>` heading and the response must return every identity once, in order; otherwise the batch re-runs one record per call. |
| `groundingGroupSize` | 5 | Records whose claims share one grounding call. Every link is validated against its own record's anchors; a link into a neighbouring record is rejected. |
| `fieldAwareGrounding` | true | The grounder sees each claim's record, field name and schema description, and is told that the same string under another meaning is not evidence. |
| `lexicalLinks` | false | Linking a single lexical hit in code without the model. Measured and rejected (section 5). |

Discovery is unchanged: its page chunking was fixed deliberately on
2026-09-07 and costs 45 of 885 calls on Beier. `{"recordBatchSize":1,
"groundingGroupSize":1,"fieldAwareGrounding":false}` reproduces the previous
behaviour exactly.

## 4. Measurement

Harness: `prototypes/studio/experiments/catalog/policy-v1/run.ts` runs
`createExtractionJobExecutor` with the production Ollama adapters and the
production grounding prompt (`api/_grounding_prompt.ts`), saving every
request and response. `suite.py` froze the harness, the scoring inputs and
the production files before the first run. Discovery and grounding used
`qwen3.8:latest` (27B Q4_K_M) on the local RTX 4090 because the Spark
server was unreachable; the production route uses the same model family on
Spark, so absolute seconds differ from the rehearsal.

### 4.1 Beier excerpt (29 records, 203 values, 164 populated fields)

Pre-registered arms, two repetitions each, identical results across
repetitions at temperature 0:

| Arm | batch | lexical | group | field-aware | calls | seconds | values/203 | supported/164 | precision |
|---|---:|---|---:|---|---:|---:|---:|---:|---:|
| baseline (previous default) | 1 | off | 1 | off | 61 | 88 | 203 | 164 | 1.000 |
| batch-only | 5 | off | 1 | off | 38 | 82 | 203 | 164 | 1.000 |
| policy-v1 | 5 | on | 5 | on | 15 | 56 | 203 | 156 | 0.987 |
| policy-v1-b3 | 3 | on | 5 | on | 19 | 58 | 202 | 157 | 0.987 |
| policy-v1-nuextract (values by NuExtract) | 5 | on | 5 | on | 15 | 47 | 185 | 146 | 0.918 |

Every arm returned 29 of 29 records with no batch fallback and no link into
another record. The baseline is perfect on this excerpt with this model, so
gate G3 demands no loss at all. The pre-registered policy arms lost 7–8
supported fields, so the failure was isolated with five exploratory arms
(one run each, GPU shared with another suite, so their seconds are not
comparable):

| Arm | batch | lexical | group | field-aware | calls | values/203 | supported/164 | precision | cross-record links |
|---|---:|---|---:|---|---:|---:|---:|---:|---:|
| batch-group-field (**adopted**) | 5 | off | 5 | on | 15 | 203 | 164 | 1.000 | 0 |
| batch-group | 5 | off | 5 | off | 15 | 203 | 163 | 0.994 | 0 |
| policy-v1-nofield | 5 | on | 5 | off | 15 | 203 | 156 | 0.987 | 5 |
| policy-v1-g1 | 5 | on | 1 | on | 21 | 203 | 162 | 0.988 | 0 |
| policy-v1-g1-nofield | 5 | on | 1 | off | 21 | 203 | 162 | 0.988 | 0 |

Two further repetitions of the adopted arm on an idle GPU reproduced
203 of 203 values, 164 of 164 supported fields and precision 1.000 at
15 calls in 72 s each, against the baseline's 61 calls in 87–88 s.

### 4.2 Transfer set (five Danish grave reports, same schema)

Same schema as the Beier excerpt, so most fields are empty by design; the
set tests identity, call structure and links on foreign headings, not
recall. Two reports (Brondbylund, Katrinesminde) returned no records under
every arm, as in the original transfer test. On the other three:

| Report | Arm | records | calls (discovery) | values | correct links | wrong anchor | missing | links on unsupported values | cross-record |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Herredsvejen | baseline | 2/2 | 28 (25) | 2 | 2 | 0 | 0 | 0 | 0 |
| Herredsvejen | adopted | 2/2 | 26 (25) | 0 | – | – | – | – | 0 |
| Hojbakkegaard | baseline | 7/7 | 33 (20) | 10 | 9 | 0 | 1 | 0 | 0 |
| Hojbakkegaard | adopted | 7/7 | 24 (20) | 8 | 8 | 0 | 0 | 0 | 0 |
| Hvissinge | baseline | 6/6 | 27 (21) | 0 | – | – | – | – | 0 |
| Hvissinge | adopted | 6/6 | 24 (21) | 5 | 3 | 0 | 0 | 2 | 0 |

Labels came from one blind labeller per report who saw only the document
text and an unlabelled sheet (18 distinct claims, 16 supported; the two
unsupported are `burial_axis` values composed from "head in the north").
Every boundary yielded exactly one record, no batch fell back, no link
crossed into another record, and no link pointed at a wrong passage. On
these reports discovery is 20 of 24 calls, so the policy changes little.
Batching is not value-neutral when the schema does not fit the document:
the five-record call left `catalog_number` empty on three Hojbakkegaard
graves and both Herredsvejen records, and filled five axes on Hvissinge
that the per-record calls had left empty. On Beier, where the schema
fits, values were identical across every arm.

### 4.3 Where the time goes

Batching does not shorten output: a five-record values call emits about
470 tokens and takes 6–7 s where five single calls took about 1.5 s each; a
grouped grounding call of about 28 claims takes 5–6 s where five per-record
calls took about 1.2 s each. On the local model the excerpt therefore runs
in roughly the same wall time with a quarter of the calls. The saving in
calls is certain; the saving in time depends on the per-call overhead of
the deployed route and is measured in the acceptance run (section 7).

## 5. What was rejected, and why

- **Lexical auto-linking** (`lexicalLinks`). It linked 145 of 164 Beier
  claims without the model, and two of them were the trap the lab
  predicted: `burial_axis = O-W` linked to "3 in O-W-Richtung … gelegte
  Sandsteinplatten" (slabs, not the grave), and `locality = Großkorbetha`
  linked to "OA Großkorbetha im LM Halle" (an archive), because the heading
  reads `Groβkorbetha` with a Greek beta. Both links carry `verbatim: true`
  and `lexicalHits: 1`, so the reviewer sees no doubt. It also made the
  grouped grounder's remaining claims harder: one grouped call answered
  NONE for all five of its claims, including `find_type = G` beside a
  passage reading "FA: G". With the model seeing every claim of a record,
  as in the adopted arm, the same passages were linked.
- **NuExtract for values** without the prototype's few-shot examples:
  185 of 203 values. The prototype's numbers depended on examples the
  production adapter has no slot for.
- **Grouping without field names**: five links into neighbouring records.
- **Rule boundaries, few-shot examples, hit-set-only candidates, sibling
  gate, thresholds, risk scores**: not measured here; rejected by the labs.

## 6. Reviewer-facing behaviour

Unchanged. Every populated value still gets a model-proposed link or none;
`verbatim` and `lexicalHits` still flag doubts; nothing is accepted
automatically. Per-record diagnostics now show the batch's call on its
first record and zero calls on the others; the stage totals count each
call once. A batch that fails identity validation re-runs its records one
per call, which the diagnostics show as single-record calls.

## 7. Acceptance on the deployment

Run a new Catalog extraction in Studio on the prepared Beier Source
Document (Schema Revision 6) with the flipped default and compare with run
`5c2e6fbc`: expected about 45 discovery + 84 values + 84 grounding calls
instead of 885, 420 records, zero links into other entries, and a "To
check" count near the rehearsal's 1,650. Record the outcome in
`docs/validation/`. The Spark route was unreachable when this policy was
measured, so the deployment timing is still open.
