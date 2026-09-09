# Catalog policy v1: fewer model calls, same links

Status: measured on 2026-09-09 with the production executor on local models.
**Opt-in, not the default.** The candidate passed every Beier gate but failed
two transfer gates (section 4.2), so `DEFAULT_CATALOG_POLICY` stays the
per-record behaviour and `CATALOG_POLICY_V1` is enabled through
`FREE_CATALOG_POLICY`. A review on 2026-09-09 also found two runtime defects
in the first implementation, fixed with regression tests (section 6). Links
stay reviewer suggestions: no score, no threshold, no automatic acceptance.

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

| Key | Default | `CATALOG_POLICY_V1` | Meaning |
|---|---|---|---|
| `recordBatchSize` | 1 | 5 | Records per values call. Each slice sits under a `### Record R<n>` heading and the response must return every identity once, in order, under a routing key no schema field uses; otherwise the whole batch re-runs one record per call, and no row of the rejected batch is kept. |
| `groundingGroupSize` | 1 | 5 | Records whose claims share one grounding call. Every link is validated against its own record's anchors; a link into a neighbouring record is rejected. |
| `fieldAwareGrounding` | false | true | The grounder sees each claim's record, field name and schema description, and is told that the same string under another meaning is not evidence. |
| `lexicalLinks` | false | false | Linking a single lexical hit in code without the model. Measured and rejected (section 5). |

Discovery is unchanged: its page chunking was fixed deliberately on
2026-09-07 and costs 45 of 885 calls on Beier. To run the candidate, set
`FREE_CATALOG_POLICY` to `{"recordBatchSize":5,"groundingGroupSize":5,"fieldAwareGrounding":true}`.

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

| Report | Arm | records | non-discovery calls | values | coverage of the sheet's supported claims | wrong anchor | links on unsupported values | cross-record |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Herredsvejen | baseline | 2/2 | 3 | 2 | 2/2 | 0 | 0 | 0 |
| Herredsvejen | candidate | 2/2 | 1 | 0 | 0/2 | 0 | 0 | 0 |
| Hojbakkegaard | baseline | 7/7 | 13 | 10 | 9/11 | 0 | 0 | 0 |
| Hojbakkegaard | candidate | 7/7 | 4 | 8 | 8/11 | 0 | 0 | 0 |
| Hvissinge | baseline | 6/6 | 6 | 0 | 0/3 | 0 | 0 | 0 |
| Hvissinge | candidate | 6/6 | 3 | 5 | 3/3 | 0 | 2 | 0 |

Labels came from one blind labeller per report who saw only the document
text and an unlabelled sheet (18 distinct claims, 16 supported; the two
unsupported are `burial_axis` values composed from "head in the north").
Coverage uses one denominator for both arms: every supported claim on the
sheet, whichever arm emitted it, so a field the candidate left empty counts
against it. Every boundary yielded exactly one record, no batch was
rejected, no link crossed into another record, and no link pointed at a
wrong passage.

**Two transfer gates fail.** G2 requires non-discovery calls at most 40% of
the baseline on each document; Hvissinge has 3 against 6 (50%), because
six records make batches of five and one. G4 requires coverage within five
points of the baseline; Herredsvejen falls from 2/2 to 0/2 and Hojbakkegaard
from 9/11 to 8/11 (9.1 points), because the five-record values call left
`catalog_number` empty on three Hojbakkegaard graves and both Herredsvejen
records, while it filled five axes on Hvissinge that the per-record calls
had left empty. Batching is therefore not value-neutral when the schema
does not fit the document. On Beier, where the schema fits, values were
identical across every arm. Under the protocol a failed gate leaves the
default unchanged; revising the gates for sparse documents, or accepting
the candidate on Beier-like catalogues only, is an explicit decision that
has not been taken.

### 4.3 Other models on the adopted call structure

Asked whether another model could take values or grounding while Qwen keeps
discovery, the same harness ran NuExtract3 (Q4_K_M, the only other
extraction model installed locally) in each role. Beier excerpt, two
repetitions each, seconds split by phase:

| Values model | Grounding model | few-shot | calls | values/203 | supported/164 | cross-record | values s | grounding s |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Qwen | Qwen (adopted) | – | 15 | 203 | 164 | 0 | 31 | 28 |
| NuExtract | Qwen | no | 15 | 185–186 | 148–149 | 0 | 16 | 33 |
| NuExtract | Qwen | yes | 15 | 201 | 163 | 0 | 16 | 34 |
| Qwen | NuExtract | – | 15 | 203 | 152–156 | 4–8 | 31 | 15 |
| NuExtract | NuExtract | yes | 15 | 200–201 | 154 | 4–5 | 16 | 11 |

The few-shot rows splice the prototype's two synthetic Beier-schema
examples into the NuExtract prompt through the harness; the production
adapter has no example slot, and the examples are specific to this schema.
On the Danish reports with blind labels, NuExtract values populated far
more fields than Qwen, and the extra ones were mostly schema violations:
Hojbakkegaard 20 values, 12 supported and 8 unsupported (grave-type words
in `find_type`, an axis never stated) against Qwen's 8 of 8; Herredsvejen
5 values, 3 supported, one unsupported linked. Over the shared
denominator NuExtract covers more supported claims (Hojbakkegaard 12/13
against Qwen's 8/13, Herredsvejen 3/4 against 0/4) because it fills
`catalog_number` where the batched Qwen call leaves it empty, at the price
of those unsupported values. NuExtract as grounder made links into
neighbouring records on Beier and on Hojbakkegaard linked one wrong
passage and missed three of eight.

Verdict: NuExtract halves the values time and is 3–4 seconds per call
faster, but it needs schema-specific examples to come within two values of
Qwen and it invents values on schemas that do not fit; as a grounder it is
worse in every count. The adopted route stays Qwen for all three stages.
Generated tables: `experiments/catalog/policy-v1/RESULTS.md`.

### 4.4 Where the time goes

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

## 6. Reviewer-facing behaviour, and the defects found in review

Unchanged for the reviewer. Every populated value still gets a
model-proposed link or none; `verbatim` and `lexicalHits` still flag
doubts; nothing is accepted automatically. Per-record diagnostics show the
batch's call on its first record and zero calls on the others; the stage
totals count each call once. A batch whose response fails validation
re-runs its records one per call, which the diagnostics show as
single-record calls.

The 2026-09-09 review of the first implementation found, and the fixes
now guard with regression tests in `module.test.ts`:

- A batch appended rows before validating the remaining ones, so a later
  malformed row re-ran the whole batch while the earlier rows stayed:
  two records became three results with ordinals 0, 0, 1. Every row is now
  restored before any row is kept.
- The routing key `record_id` could collide with a researcher's own
  `record_id` field and overwrite its value with `R1`. The key is now
  `record_id` only when the schema does not use it, otherwise prefixed with
  underscores until free, and it is stripped before the record is kept.
- In the acceptance checks: coverage was never compared (fixed with the
  shared denominator above); a normal final batch of one record counted as
  a fallback (the harness now marks only single calls for a slice that a
  rejected batch already carried, and the recorded runs were re-checked
  from their saved requests: no fallback occurred); the frozen input hash
  was recorded but not enforced (the suite now refuses a different input).

## 7. Acceptance on the deployment

Run a new Catalog extraction in Studio on the prepared Beier Source
Document (Schema Revision 6) with `FREE_CATALOG_POLICY` set to the
candidate and compare with run `5c2e6fbc`: expected about 45 discovery + 84 values + 84 grounding calls
instead of 885, 420 records, zero links into other entries, and a "To
check" count near the rehearsal's 1,650. Record the outcome in
`docs/validation/`. The Spark route was unreachable when this policy was
measured, so the deployment timing is still open.
