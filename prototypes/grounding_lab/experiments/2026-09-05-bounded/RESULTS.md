# Bounded extraction: completed development experiment

The reliability change works on Conrad: both final arms return the first 20
eligible graves, preserve their identities, retain every mandatory source
context block from an independent source-only audit, and finish within their
per-call budgets. This is a development result, not a production winner.

Keep quote-only as the evidence-quality candidate. Do not promote the tested
quote/E fallback: filling missing evidence increases erroneous suggestions too
much. E remains the frozen comparison and latency baseline. No automatic
acceptance, new confidence fitting, production changes, push or merge occurred.

## Final comparison

Attempt 3 is the only scope-valid comparison. Baseline emits 291 populated
values: 265 supported and 26 unsupported. Quote extraction emits 287: 268
supported, 18 unsupported and one unresolved interpretation of the title field.
These are model-generated adjudicated judgments. Missing/null fields are not
silently counted as correct values; this experiment does not establish full
field-extraction recall.

| Values / grounder | Correct evidence | Wrong supported anchors | Unsupported proposals | Missing supported evidence |
|---|---:|---:|---:|---:|
| Baseline / E | 183 | 80 | 26 | 2 |
| Quote / E replay | 185 | 81 | 17 | 2 |
| Quote / quote-only | 210 | 18 | 15 | 40 |
| Quote / quote-E fallback | 227 | 41 | 18 | 0 |

On identical quote-arm values, quote-only adds 25 correct evidence selections
and avoids 63 wrong supported anchors compared with E, at the cost of 38 more
missing evidence selections. Fallback adds 17 correct selections relative to
quote-only, but also 23 wrong supported anchors and 3 unsupported proposals.
One additional fallback judgment is unresolved. Proposed links remain review
suggestions; the table does not measure automatic acceptance precision.

Quote matching uses whitespace normalization only and retains every occurrence.
The final arm has 243 uniquely mapped values, 37 ambiguous locations and 7
unmatched quotes. Location alone does not establish semantic support. Evidence
correctness uses the existing exact acceptable-anchor-set rule, with alternative
locations separate from anchors that must jointly support a claim.

The frozen value-risk order catches 1/26 unsupported baseline values in the
first three reviews and 0/18 quote-arm unsupported values. Quote-status order
catches 1/18 in three reviews and 2/18 in five. Its joint-error precision at
three reviews is 3/3 for quote-only, but only 1/3 after fallback fills gaps.
There is no adequate semantic-error prioritizer here. Brier/reliability and
risk/coverage diagnostics are in evaluation.json; Conrad is among the existing
risk model's training families, so these are descriptive development figures.

## Timing and failures

Final shared discovery takes 166.71 seconds. Measured arm time is 296.18 seconds
for baseline plus E, 584.21 seconds for quote extraction plus deterministic
mapping, and 623.97 seconds for quote extraction plus full E replay. Adding the
shared discovery yields stage-composed times of 462.90, 750.92 and 790.68 seconds;
the discovery physically ran once. The full paired workflow timer is 1086.93
seconds, including output writing before the final timing-bookkeeping write.
Hybrid suggestions reuse full E replay; selective-fallback execution has no
standalone latency measurement and no speedup is claimed for it.

Each arm/policy timing has n=1 in the final revision. E per-claim p50/p95/p99 are
43.05/527.29/1114.00 ms for baseline (291 claims), and
38.46/358.60/1123.20 ms for quote-arm replay (287 claims). Full observed
quantiles and sample counts, including the earlier completed diagnostic run,
are retained in evaluation.json. These are not production tail estimates.

- Attempt 1: aborted after discovery collapsed individual graves into sites.
  Completed model responses remain available and their 77 emitted values were
  labeled diagnostically. The interrupted request has unknown usage.
- Attempt 2: both arms completed, but missing shared context left ten later
  sites null. It fails the source-scope gate; all outputs and labels remain.
- Attempt 3: both arms completed with 20/20 returned identities and all
  independently required context intact. Both complete outputs were evaluated.

Across attempts: 52 extraction-model requests, 51 saved responses, 414,593
reported input tokens and 55,951 output tokens, plus unknown usage for the
interrupted request. Maximum completed output was 3,824 tokens against an
8,192-token limit. Local reranker call counts are in each grounding_meta.json;
labeling-agent work is separate from Extraction timing and token totals.

Two independent blind labelers and a fresh adjudicator handled each immutable
round. All 1,203 emitted values are covered by 1,053 distinct judgments; 71 and
28 disagreements were adjudicated, with one unresolved title judgment. A
round-2 labeler encountered a capacity error after writing its complete file,
then confirmed semantic completion. Its artifact passed full validation; the
event is retained in labeling_runs.json.

## Reproduction and next gate

Run from the lab using the command in PROTOCOL.md and a new output directory.
The final runner snapshot, dependency/configuration hashes, source/schema
hashes, all requests/responses and record manifest are in conrad-attempt-3/.
CANDIDATE_FREEZE.json preserves the implementation and original frozen risk
parameters. Blinding uses only canonical source, schema and anonymized claims;
arm mappings stay outside the packets. No evaluation label enters extraction,
region selection, quote matching, thresholds or risk fitting.

```powershell
.venv/Scripts/python.exe -X utf8 -m grounding_lab.bounded_evaluation report experiments/2026-09-05-bounded
.venv/Scripts/python.exe -X utf8 -m unittest discover -s tests
node --experimental-strip-types --test scripts/*.test.mts
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 verify
```

Validation: 98 Python and 12 Node checks pass, focused report checks pass after
the final reporting changes, and the previous experiment's freeze verifies.
No new family was opened. The remaining Matthias series in the supplied folder
is one related family, not several independent holdouts. Additional independent
sources are needed for the next untouched comparison. Retain this source as
development; do not relabel it as untouched. Before promotion, the remaining
questions are semantic error detection, evidence gaps and quote-output latency.
