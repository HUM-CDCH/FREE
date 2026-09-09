# Catalog policy v1: fewer model calls, same links

Status: measured on 2026-09-09 with the production executor on local models.
**Default since 2026-09-09**, by the user's acceptance decision after the
review below, verified the same day on the full Beier catalogue over the
Spark model route: 213 calls instead of 885, 420 records, complete, no link
into another entry (section 7, `docs/validation/2026-09-09-catalog-policy-v1-acceptance.md`).
The candidate passed every Beier gate; on the
Danish reports it failed two transfer gates under the Beier schema (section
4.2) and, re-measured under a schema that fits those reports (section 4.2,
revision 2), it beats the per-record policy on every count except one
wrong link. G2 was reformulated on 2026-09-09 to count only the calls the
policy changes; it passes on Beier and the three gated Danish reports and
fails on Katrinesminde, where a rejected batch cost the saving, and on
Hvissinge under the Beier schema. After a review of every disputed
adjudication, delegated by the user to Claude and made with the arm hidden,
G4 passes on all three gated reports (section 4.2, revision 2).
`DEFAULT_CATALOG_POLICY` is now `CATALOG_POLICY_V1`; the per-record
behaviour stays reachable through `FREE_CATALOG_POLICY`. Accepted with three
caveats on record: the call gate was amended after results and has not been
confirmed on documents outside the study, the review was an agent's, and
the deployment acceptance run is still to be done. A review on 2026-09-09 also found two runtime defects
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

| Key | Previous default (per-record) | `CATALOG_POLICY_V1` (default) | Meaning |
|---|---|---|---|
| `recordBatchSize` | 1 | 5 | Records per values call. Each slice sits under a `### Record R<n>` heading and the response must return every identity once, in order, under a routing key no schema field uses; otherwise the whole batch re-runs one record per call, and no row of the rejected batch is kept. |
| `groundingGroupSize` | 1 | 5 | Records whose claims share one grounding call. Every link is validated against its own record's anchors; a link into a neighbouring record is rejected. |
| `fieldAwareGrounding` | false | true | The grounder sees each claim's record, field name and schema description, and is told that the same string under another meaning is not evidence. |
| `lexicalLinks` | false | false | Linking a single lexical hit in code without the model. Measured and rejected (section 5). |

Discovery is unchanged: its page chunking was fixed deliberately on
2026-09-07 and costs 45 of 885 calls on Beier. To restore the previous
behaviour, set `FREE_CATALOG_POLICY` to
`{"recordBatchSize":1,"groundingGroupSize":1,"fieldAwareGrounding":false}`.

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

**Two transfer gates fail under this schema.** G2, reformulated to count
only record values and grounding calls, fails on Hvissinge with 3 against
6: the per-record arm produced no values there and so made no grounding
call, while the candidate produced five values and one grounding call, so
the comparison is confounded by claim eligibility; it passes on
Herredsvejen (1 against 3) and Hojbakkegaard (4 against 13). G4 requires
coverage within five points of the baseline; Herredsvejen falls from 2/2 to 0/2 and Hojbakkegaard
from 9/11 to 8/11 (9.1 points), because the five-record values call left
`catalog_number` empty on three Hojbakkegaard graves and both Herredsvejen
records, while it filled five axes on Hvissinge that the per-record calls
had left empty. Batching is therefore not value-neutral when the schema
does not fit the document. On Beier, where the schema fits, values were
identical across every arm. Under the protocol a failed gate leaves the
default unchanged; revising the gates for sparse documents, or accepting
the candidate on Beier-like catalogues only, is an explicit decision that
has not been taken.

**Revision 2: the same reports under a schema that fits them.** The
failed gates above were measured with the Beier schema, so most fields
were empty by design and a handful of `catalog_number` values decided the
outcome. Astra's `models-policy-v2` experiment wrote a Danish grave schema
(`grave_id`, `site_name`, `grave_type`, `burial_rite`, `burial_axis`,
`dating`, `finds`) and ran the candidate under it, but never the
per-record policy. Revision 2 of the harness (`run.ts --schema danish`)
ran both, one repetition, scored on Astra's fixed-denominator references
with its recorded adjudications plus 66 further decisions for the
per-record arm's values under the same rules
(`artifacts/catalog-lab/policy-v1-danish/adjudications-rev2.json`,
agent-made, not independent):

| Report | Arm | calls | discovery | values | grounding | seconds | correct units | linked units | unsupported | wrong record | wrong passage |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Herredsvejen | per-record | 32 | 25 | 4 | 3 | 65.5 | 12/22 | 12/22 | 11 | 0 | 0 |
| Herredsvejen | candidate | 28 | 25 | 2 | 1 | 47.9 | 15/22 | 14/22 | 9 | 1 | 0 |
| Hojbakkegaard | per-record | 39 | 20 | 10 | 9 | 95.1 | 54/66 | 53/66 | 10 | 0 | 1 |
| Hojbakkegaard | candidate | 25 | 20 | 3 | 2 | 56.2 | 60/66 | 60/66 | 7 | 0 | 0 |
| Hvissinge | per-record | 46 | 21 | 13 | 12 | 205.8 | 38/49 | 38/49 | 27 | 0 | 0 |
| Hvissinge | candidate | 28 | 21 | 4 | 3 | 105.6 | 39/49 | 39/49 | 21 | 0 | 0 |

Gates, as generated by `score_danish.py`:

- **Herredsvejen_SBM1694**: G1 pass (fallbacks 0 of 1 batches); G2 pass (2 policy-sensitive calls vs 6; all non-discovery calls 3 vs 7); G4 pass (units 17 vs 14, links 17 vs 14 of 22, wrong-link rate 0.000 vs 0.000, unsupported 7 vs 9)
- **Hojbakkegaard_TAK_1177**: G1 pass (fallbacks 0 of 2 batches); G2 pass (4 policy-sensitive calls vs 18; all non-discovery calls 5 vs 19); G4 pass (units 61 vs 55, links 61 vs 54 of 66, wrong-link rate 0.000 vs 0.018, unsupported 6 vs 9)
- **Hvissinge_Ost_TAK_1728**: G1 pass (fallbacks 0 of 3 batches); G2 pass (6 policy-sensitive calls vs 24; all non-discovery calls 7 vs 25); G4 pass (units 39 vs 38, links 39 vs 38 of 49, wrong-link rate 0.000 vs 0.000, unsupported 21 vs 27)
- **Katrinesminde_SBM1116**: G1 FAIL (fallbacks 2 of 1 batches); G2 FAIL (4 policy-sensitive calls vs 4; all non-discovery calls 5 vs 5); G4 not gated (the reference credits graves the schema excludes)
- **Brondbylund_3_TAK_1506**: not gated (a run did not succeed)

Under a fitting schema the candidate extracts more correct values and links
more of them than the per-record policy on all three reports, with fewer
unsupported values on each. G2 as pre-registered failed on Herredsvejen for
a structural reason: three records need one batch call, one document-level
values call and one grounding call, and three is more than 40% of seven.
A first revision gave the ratio a floor; a second opinion from GPT Astra
objected to the cliff it creates, and the gate was reformulated
(PROTOCOL.md, "G2 reformulated"): it compares only the calls the policy
changes, record values and grounding, every attempt counted, at most 40%
of the per-record arm's, per document. Beier (12 against 58), Herredsvejen
(2 against 6), Hojbakkegaard (4 against 18) and Hvissinge (6 against 24)
pass; Katrinesminde fails G2 (4 against 4) and G1 (its one batch was
rejected). Both amendments were decided after the results and are recorded
as such; a gate chosen post hoc needs fresh confirmation on documents not
used to choose it.

G4 was provisional on one Herredsvejen link: the grounder tied A240's
`brandgrave` to a sentence in A240's own slice that compares the comb with
brandgrave finds elsewhere. Astra, asked for a second opinion
(`REVIEW-g4-second-opinion.md`), read that passage as supporting a
cremation burial, against its own earlier label, so the user decided that
every uncertain adjudication goes to review. `review_queue.py` routed every
negative decision and every disagreement between the two agents to a sheet
that hides the arm and the prior decisions: 134 items on the three gated
reports. The user delegated that review to Claude; it was made from the
sheet and the source text with one rule per class applied to both arms
(PROTOCOL.md, "Review outcome"). Of 134 items, 4 values were accepted, 121
rejected, the A240 link was judged supported, four other links wrong, and
the loose-remains record unbound. With the review applied, G4 passes on all
three reports with the candidate ahead on correct units, linked units and
unsupported values; the wrong-link rate is zero on both arms except one
per-record link on Hojbakkegaard. Two rules carry most of the rejected
values and apply to both arms equally: a body or head direction is not a
grave axis (20 values), and a report-level period is not a grave's date. The candidate's batch of two on Katrinesminde
was rejected because the model returned `R1` twice, and both records re-ran
one per call with identical values; that is the first rejected batch in
any recorded run and the fallback behaved as specified.

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

Astra's follow-up (`experiments/catalog/models-policy-v2/`, results copied
to its `RESULTS.md`) put three more substitutes on the candidate's call
structure with hash-checked replay of the unchanged stages: EVIE-4.5B and
NeoMME-260M as retrievers that prune grounding candidates to the top three
page regions, and GLiNER 2.5 as the values extractor; four OCR models were
prepared as alternative document representations and then excluded before
their runs. None qualifies. A retrieval pre-filter can only remove
candidates, so it loses 1–11 supported links per document (top-three page
recall on Danish prose was 44/60 and 48/70) and, on Beier, induced a
wrong-passage pick where the full candidate set had none, with no time
gain once encoding is counted. GLiNER returned 31 of 164 Beier fields.
The experiment's own limits: its baseline is the candidate, not the
per-record policy; two repetitions of a deterministic model replicate
nothing; and the Katrinesminde reference credits eleven graves that the
schema tells the model to exclude.

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

Done on 2026-09-09 with the production executor driven by the harness on
the same prepared source, Schema Revision 6 and the Spark `qwen3.8:27b`
route, against run `5c2e6fbc`: 45 + 84 + 84 = 213 calls instead of 885,
420 records with identical boundaries and no rejected batch, complete
(0 ungrounded paths against 1), no link into another entry, 92 minutes
against 106 (output tokens are the floor), and 324 "To check" links
against 1,650, of which the repeated-passage part is mostly PR #132's
candidate scoping rather than the policy. Full record:
`docs/validation/2026-09-09-catalog-policy-v1-acceptance.md`. Still to
observe: the first Studio UI Catalog run under the new default, which
exercises the job worker and persistence the harness bypasses.

## 8. What the Danish runs showed about discovery

These are production behaviours of Catalog mode that no policy setting
changes, observed on every arm:

- Figure captions become records. Hvissinge has six graves; discovery
  returned twelve boundaries because captions such as "Grav 6, fotomosaik"
  and the reconstruction paragraph "Grav 3 består af mange elementer" were
  taken as record starts. The scorer never credits a duplicate, so this
  costs values and calls alike.
- A document without records fails the job. Brøndbylund has no individually
  described grave, and the executor threw "Catalog discovery returned no
  records" instead of returning an empty catalogue.
- Discovery dominates short reports: 20–25 of 25–32 calls. Batching cannot
  bring such documents near 40% of the per-record call count, which is why
  G2 now counts only the calls the policy changes.
- OCR errors pass through unchanged: Beier entry 228 prints `Fdpl. 1.`,
  the parsed text reads `4,`, and every arm copied the parsed text. The
  evidence link lets a reviewer see the scan, which is the only place the
  error can be caught.
