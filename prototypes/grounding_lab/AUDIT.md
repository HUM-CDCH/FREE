# Grounding lab: results and next steps (2026-09-05)

One question: can a tiered non-LLM grounder (normalized lexical containment,
then a small cross-encoder inside the lexical hit set) replace LLM evidence
linking, given that the product's aim is to catch extractor errors and put
them in front of a reviewer? Code is in `grounding_lab/`, development labels
in `final_dataset_3/`, the frozen four-family comparison in
[`experiments/2026-09-05/EVALUATION.md`](experiments/2026-09-05/EVALUATION.md),
and session state in [`HANDOFF.md`](HANDOFF.md).

## Verdict

- The bounded-batch follow-up is complete on the existing Conrad development
  source: [results](experiments/2026-09-05-bounded/RESULTS.md). The final revision
  preserves all 20 independent record identities and required source context;
  both arms finish. Quote-only is the stronger evidence candidate. On the same
  quote-arm values it yields 210 correct evidence selections versus E's 185,
  with 18 versus 81 wrong supported anchors, but 40 versus 2 missing supported
  evidence selections. It is slower. Adding E fallback supplies 17 correct
  links but also 23 wrong anchors and 3 unsupported links: do not promote that
  hybrid. One development source does not establish a production winner.

- The controlled pruning experiment is complete. Retain E: both variants
  preserve recoverable gold but lose six correct links and improve p95 in
  only one of three warmed repetitions.
- The frozen four-family experiment is complete, including adjudication and
  failures. Four of eight extraction attempts failed; only Kirsch has two
  runner-valid arms. Quote-only mapping improves Kirsch evidence accuracy
  on the same values, but increases missing evidence and does not reduce
  complete workflow latency. Beier has prior-record overlap and is excluded
  from strictly untouched summaries. No production replacement is established.
- The earlier 372/382 for policy E was a property of the labels, not the
  pipeline: every claim was a string copied verbatim out of an anchor, 187 of
  283 linkable claims were single lexical hits linked unverified, only 35
  could be scored wrong at all, and 98 of the 99 must-abstain values were
  simply absent from the text. Those three sets (`dataset`, `final_dataset`,
  `final_dataset_2`) are regression fixtures now and produce no headline
  number.
- The 360-claim extractor-output set is useful development data, not a
  production estimate. One output-truncated Extraction contributes 59/104
  unsupported values. Excluding it, the gated policy catches 29/45 (64%);
  the unweighted per-Extraction mean is about 52%.
- Policy E's shape remains the best tested latency/workload compromise, but
  its confidence is not confidence: singleton hits are assigned `1.0`, while
  neural links use a clipped top-two margin. Correct and wrong links share the
  maximum score. Keep links as reviewer suggestions and do not auto-accept.

## Exploratory extractor-output set, blind labels

`final_dataset_3/<doc>/claims_extracted.json`. The real extractor
(`qwen3.8:latest`, local Ollama, every prompt cut to 16k tokens by the
server, [`RAW_EXTRACTION_BLIND.md`](RAW_EXTRACTION_BLIND.md)) was run with
each document's `schema.json`; 60 emitted leaves per document were sampled
(seeded) and labeled by six labelers who saw only their document directory
([`final_dataset_3/LABELS.md`](final_dataset_3/LABELS.md), last section).
256 supported, 104 unsupported; the unsupported values are what the extractor
really produces: a runaway enumeration of type codes, place names harvested
from the bibliography, composed labels.

Policy E: one strict hit links at confidence 1.0, zero hits abstain, several
hits go to the reranker (Nemotron 1B) with field name and sibling values.
`--sibling-gate`: a single hit whose page neighbourhood (3 anchors either
side) and table row hold none of the claim's sibling values goes to review; a
bare number (4 characters or fewer, no unit) links only through a
sibling-supported hit, and its hit set is narrowed to those. Frozen thresholds
are the fixture-tuned `-9.375 / 0.5625`; "blind-tuned" is leave-one-document-out
on this set (the abstain threshold lands at about 0.52, so the scorer can say
"none" inside a hit set). Latency is the whole per-claim path after a one-off
anchor normalization per document.

| policy | correct | supported links | correct abstains | review | wrong | auto precision | median ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| E, frozen | 230/360 | 160/256 | 70/104 | 35 | 61 | 160/221 | 28 | 1 053 |
| E + sibling gate, frozen | 233/360 | 155/256 | 78/104 | 39 | 52 | 155/207 | 15 | 366 |
| E, blind-tuned | 234/360 | 154/256 | 80/104 | 33 | 41 | 154/195 | 27 | 1 116 |
| E + sibling gate, blind-tuned | 224/360 | 145/256 | 79/104 | 41 | 39 | 145/184 | 16 | 381 |
| E with the LLM as scorer, same contract | 251/360 | 168/256 | 83/104 | – | 36 | – | 5 238 | – |

The reviewer's view of the same runs (`outcomes/*.jsonl` from
`model_benchmark --dump`; the two lexical-only rows need no model):

| policy | extractor errors caught | missed (auto-linked) | correct values passed | correct values sent to review or abstained | correct value, wrong anchor |
|---|---:|---:|---:|---:|---:|
| E, frozen | 77/104 (74%) | 27 | 160/256 | 62 | 34 |
| E + sibling gate, frozen | 84/104 (81%) | 20 | 155/256 | 69 | 32 |
| E, blind-tuned | 86/104 (83%) | 18 | 154/256 | 79 | 23 |
| E + sibling gate, blind-tuned | 87/104 (84%) | 17 | 145/256 | 89 | 22 |
| single hits pass, every hit set to review | 94/104 (90%) | 10 | 79/256 | 177 | 0 |
| gated single hits pass, hit sets to review | 93/104 (89%) | 11 | 84/256 | 170 | 2 |
| LLM as scorer, same contract | 83/104 (80%) | 21 | 168/256 | 73 | 15 |

What is left, and why no scorer fixes it:

- **27 supported values have no lexical hit** (soft hyphens in the OCR,
  strings the extractor composed from two cells, legend abbreviations it
  expanded to the typed form, a year inside a date). Missed by construction.
- **12 of the 17 errors the gated variant still links are citation place
  names**: the only occurrence is a bibliography entry that also holds the
  sibling district, so the gate confirms the wrong passage.
- **2 are grave numbers that lost their letter** (1117 for 1117A while a grave
  1117 exists).
- Bare numbers produce hit sets up to 174 anchors; the gate's narrowing is
  what halves the p95.

Reports: [`EXTRACTED_E_NEMOTRON.md`](EXTRACTED_E_NEMOTRON.md),
[`EXTRACTED_GATED_NEMOTRON.md`](EXTRACTED_GATED_NEMOTRON.md),
[`EXTRACTED_CV6_E_NEMOTRON.md`](EXTRACTED_CV6_E_NEMOTRON.md),
[`EXTRACTED_CV6_GATED_NEMOTRON.md`](EXTRACTED_CV6_GATED_NEMOTRON.md),
[`EXTRACTED_LLM_HITSET.md`](EXTRACTED_LLM_HITSET.md).

### Follow-up: auditable outcomes, risk ranking and row pruning

The benchmark dump now retains the proposed and gold anchors, every candidate
and raw score, the unclipped margin, route, pruning mode, pre-pruning keep/drop
diagnostics, suffix ambiguity, structural sibling coverage and per-claim/index
timing. Fresh anchor dumps also carry kind, table and row identity; this
existing set predates the latter two fields. `legacyConfidence`
is kept only to audit the retired decision rule. `review_risk.py` fits separate
leave-one-Extraction-out value and evidence risk scores and combines them for
review ordering; it never auto-accepts and calls the results risk scores
because this set cannot calibrate production probabilities.

Two conservative candidate-only ablations were replayed. Both require an
exact-value cell with its own table-row context containing at least one claim
sibling, fall back to the full hit set, and still score a pruned singleton.

| policy | multi-hit candidate pairs | candidate p95 | recoverable gold retained | legacy CV correct | legacy CV wrong | auto precision | measured p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| E, instrumented replay | 12,433 | 417 | 134/134 | 234/360 | 41 | 154/195 | 1,208 |
| E + bare-number row pruning | 12,037 | 417 | 134/134 | 228/360 | 36 | 148/184 | 1,244 |
| E + all-value row pruning | 11,508 | 417 | 134/134 | 229/360 | 35 | 148/183 | 815 |

Neither pruning mode changes the candidate-count tail. The all-value replay's
lower p95 is one noisy run, not an established latency win, and both variants
pass fewer correct values. Keep E's routing; retain these as ablations, not
production gates.

A broader joint-record heuristic was rejected: it cut candidate volume by only
1.04% while dropping a recoverable `pathology_type = Trauma` gold anchor.

On the instrumented E replay, the joint queue's error precision is
1.000/0.944/0.967 at review depths 1/3/5. Among already-linked proposals the
new score is 0.833/0.833/0.800 versus 0.667/0.833/0.900 for the legacy margin:
it is not uniformly better. Value/evidence/joint Brier scores are
0.156/0.140/0.139. This is a useful prototype, not validated confidence. The
next calibration set must be complete, untouched, non-windowed, and grouped
by genuinely different Source Document families.

## 2026-09-05 completion and paired follow-up

The controlled pruning experiment is complete: nine warmed runs in rotated
order reproduced identical decisions in every repetition. All 16,764 regenerated
anchors preserve IDs, text, pages, reading order and scoring context. E passes
154 supported values; either pruning variant passes 148. Unsupported proposals
remain 18; wrong anchors fall from 23 to 18/17, at the cost of larger queues
(165 versus 176/177). Candidate p95/max remains 417/759. Neither variant beats
E's claim p95 consistently (one of three repetitions). **Retain E.** Without
the historical runaway all three catch 27/45 unsupported values; pooled capture
is 86/104. Full data, hashes, snapshots and timing methodology are in
[`experiments/2026-09-05/pruning/SUMMARY.md`](experiments/2026-09-05/pruning/SUMMARY.md).

All eight full-source extraction calls finished under the frozen configuration:
four runner-valid completions and four failures. Beier quote emitted 25 records,
and Bosch baseline emitted 21; their complete typed outputs remain failed but
are retained in diagnostic-only sidecars and included in full blind labeling. Wiermann quote and
Bosch quote exhausted the 32,768-token output budget; neither JSON prefix is
salvaged. There were no holdout retries. Recorded generation usage, including
failures, is 1,271,862 input and 157,424 output tokens over 8,870.801 seconds.

The source-only overlap audit identifies Beier records in prior Dobeš material:
Menz already appeared in a labeled output, and Estedt is confirmed in the prior
source prose. Beier remains a transfer case and is excluded from strictly
untouched summaries. Bosch, Wiermann and Kirsch retain scoped untouched status;
none was substituted. Only Kirsch has two runner-valid arms. Pooled arm results
therefore have different family composition and cannot establish a paired gain.

On Kirsch's same 297 quote-arm values, quote-only mapping finds 177 correct
evidence sets versus E's 133, with 9 versus 26 unsupported proposals and 8 versus
126 wrong supported-value proposals. It leaves 86 supported values without a
unique mapping versus E's 12. These are best-candidate proposal counts; frozen
E routing is reported separately. Quote-only takes 1,051.645 seconds, compared
with 722.075 seconds for baseline extraction plus E's core timer (736.968 seconds
including the observed risk/audit-file span). Both arms select the same
20 records, but their sequence differs from the source-only first-20 manifest.
One completed pair cannot establish production accuracy, calibration or tails.

The frozen Kirsch value-risk queue catches no semantic extraction errors in its
top five reviews, while the joint queue finds evidence errors. The two doubts
must remain separate; a useful evidence-error queue is not validated value
confidence. No holdout labels fit thresholds, risk coefficients or features.
All four families now have two independent model labelers and a separate
adjudicator: 2,687 distinct blind claims cover all 2,709 populated emissions;
326 disagreements were adjudicated, with five judgments still unresolved.
These are model labels, not human ground truth. All six usable outputs have
frozen E replays. The complete family/macro/pooled comparison, queue metrics,
risk/coverage, calibration diagnostics and explicit failures are in
[`EVALUATION.md`](experiments/2026-09-05/EVALUATION.md). Timing boundaries and
broader workflow quantiles are in
[`WORKFLOW_TIMINGS.md`](experiments/2026-09-05/WORKFLOW_TIMINGS.md).
All 95 Python and 10 Node checks pass. Frozen hashes, label coverage, blind
packet integrity, label-free scoring inputs and the failure ledger pass the
completion audit in [`validation.json`](experiments/2026-09-05/validation.json).

The first Conrad quote pilot failed at the HTTP client's five-minute header
timeout; the retained native-HTTP retry completed, with 235 unique mappings,
48 repeated occurrences and two absent quotes among 285 populated values.
These are development location diagnostics, not semantic accuracy. The code,
schemas, prompts and risk parameters were frozen before opening holdout labels.

The natural-output validator reports unsupported lexical prevalence instead of
selecting documents on it. Labels distinguish alternative acceptable anchors
from jointly required sets, and missing labels remain errors. Frozen risk
inference uses development-only coefficients and never authorizes auto-accept.

## Secondary set: hand-labeled blind claims

The same six documents, 164 typed claims (116 supported) written by a labeler
who never saw the pipeline (`claims.json`, [`LABELS.md`](final_dataset_3/LABELS.md)).

| policy | correct | supported links | correct abstains | review | wrong | auto precision |
|---|---:|---:|---:|---:|---:|---:|
| E, frozen | 91/164 | 72/116 | 19/48 | 13 | 37 | 72/109 |
| E + sibling gate, frozen | 92/164 | 70/116 | 22/48 | 17 | 30 | 70/100 |
| E, blind-tuned | 99/164 | 65/116 | 34/48 | 4 | 19 | 65/84 |
| E + sibling gate, blind-tuned | 99/164 | 66/116 | 33/48 | 12 | 15 | 66/81 |
| E with the LLM as scorer | 114/164 | 86/116 | 28/48 | – | 25 | – |

Two diagnostics on the fixtures, kept as `<doc>/traps.json`: 40 single-hit
traps (a value present exactly once, under the wrong field) are linked wrong
34 times by E at confidence 1.0; the gate removes 4, because 32 traps are
top-level fields with no sibling to check. Reranking every single hit (policy
H) caught 20 more traps but sent 65 correct links to review, so it was
dropped. Also fixed on the way: `dump-anchors` gave header cells the whole row
as context, which caused 28 of the LLM baseline's 33 wrong links on the
fixtures; production `anchorText()` in `packages/extraction/src/grounding.ts`
has no such leak, but it hands the scorer bare cell text (no row, no header),
less than the lab does, and cuts a cell containing ` | `.

## Next steps toward production

Applied so far (2026-09-06): the first half of step 1. Production links carry
`verbatim` and `lexicalHits` from the lexical tier only, and Studio flags a
link whose value is absent from its anchor or occurs in more than one
candidate. Ungrounded values still carry no lexical count.

1. **Contract: separate the two doubts.** Add reviewer-visible value risk and
   Evidence risk plus the proposed anchor; neither score authorizes
   auto-accept.
2. **Instrument first.** Carry the lab dump's route, candidates, raw scores,
   structural identity and timings through a production-shaped replay.
3. **Preserve this evaluation.** The dated full-source comparison is complete;
   its labels must not be used to tune the reported policy or risk model.
   Obtain separate representative families for any future calibration.
4. **Harden quote emission on development data.** The lab implementation now
   exists, but three of four quote attempts failed and the completed pair did
   not improve total latency. Freeze any subsequent revision before testing
   it on new source families.
5. **Only then test the non-LLM replacement.** Keep E's routing shape, use
   structural pruning only to narrow candidates, and always score or review a
   pruned singleton. Calibrate value and Evidence risks on new independent
   calibration data, then evaluate them on a separate untouched test set.
6. **Do not** auto-accept links, compare more rerankers, or tune on the
   fixtures.

## Reproduction

```bash
cd prototypes/grounding_lab
pnpm --filter grounding-lab test
pnpm --filter grounding-lab extract-real -- final_dataset_3
.venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims final_dataset_3
.venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims final_dataset_3 --sheet --sample 60
.venv/Scripts/python.exe -X utf8 -m grounding_lab.label_review final_dataset_3 --claims claims_extracted.json --natural-output
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 --stage rerank --retriever mini --reranker nemotron-1b --split all --abstain-threshold -9.375 --accept-threshold 0.5625 --sibling-gate --claims claims_extracted.json --dump outcomes/extracted_gated.jsonl
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 --stage rerank --retriever mini --reranker nemotron-1b --cv 6 --sibling-gate --claims claims_extracted.json
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset final_dataset_3 qwen3.8:latest --think --claims claims_extracted.json
```

`final_sources_3/` holds the six PDFs; they are copyrighted scans and
git-ignored. `document.md`, `parsed_document.json` and `anchors.json` under
`final_dataset_3/` are full-text derivatives of them and are committed; drop
them if that is too much, the labels and schemas stand alone.
