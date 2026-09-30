# Extraction research harness

One configuration, one runner, one evaluator, for comparing techniques for extracting many records with source evidence
from long documents. Research tooling, like `experiments/extraction/`: not imported by the serving pipeline, no change to
`src/`. It reuses the service's parsing types (`Evidence`, `Passage`, `Schema`), `contexts.partition`,
`rendering.structured_source`, `locate`, `calls.complete`, `selection.words` and the study manifest helpers, and adds only
what the service lacks (sampling, token probabilities, alignment variants, verification gate, merging with provenance,
record-level evaluation, confidence and risk control). Install with `uv sync --extra experiments`: the harness directly
imports `scipy`, `jsonschema` and `requests`, declared as optional experiment dependencies; `numpy` is a runtime dependency.

## Commands

Run from `prototypes/parsing_service` with the repository's Python environment and `PYTHONPATH=src:.`.

```sh
H=$(mktemp -d); cp experiments/harness/examples/study.json $H/
# edit provider.url and provider.model in $H/study.json (drop "counter" for a server without /tokenize, and add --uncounted below)
python -m experiments.harness synth $H/synthetic.json --cases 16 --records 6          # synthetic dataset, gold by construction

python -m experiments.harness run $H/study.json $H/out                                 # projection only: cells, calls, upper bound
python -m experiments.harness run $H/study.json $H/out --variant base --execute       # the frozen baseline
python -m experiments.harness run $H/study.json $H/out --execute                      # the bounded ablation matrix (sealed cells resume)
python -m experiments.harness compare $H/study.json $H/out $H/report.json --split dev # pooled metrics, group intervals, paired effects
python -m experiments.harness confidence $H/study.json $H/out $H/confidence.json --variant combined
python -m experiments.harness score $H/synthetic.json case000 artifact.json           # a saved production Article/Catalog artifact
```

`compare` reuses `experiments.extraction.analyze.paired_interval` and the manifest helpers. It reports, per variant, pooled
metrics with group intervals, `cost_as_if_cold` for the sealed cells and `attempt_spend` for every attempt including failed
ones; per comparison, the paired effect over the groups both arms completed (the rest listed), the cost difference on those
same cases, and whether the two arms sent identical requests (a configuration that differs while every request is the same
either changed only what happens after the model, or did nothing: a pilot run found an overlap setting silently dropped that
way, now fixed); and the provenance of the cells. `score` reads a saved production artifact (Article or Catalog, versions 1
to 3) through the same scorer, so the service's own extraction options can be run with the existing study tooling and
compared to the research variants on one gold.

Tests: `pytest tests/test_harness_*.py` (mocked; fast tier). Real-provider smoke: `KEI_EXTRACT_URL=... KEI_EXTRACT_MODEL=...
[HARNESS_LIVE_COUNTER=vllm] pytest -m live_model -s tests/test_harness_live.py`.

A study file names the dataset, provider, scoring rules, base configuration, variants (section overrides), declared
one-factor comparisons, interactions and an optional `combined` variant with combined-minus-one ablations. Everything is
checked before a call: an incompatible variant, a comparison that changes more than its declared factor, or an over-budget
projection stops the run. Cells (variant x case) are sealed and resumable. `test` runs only for the study's declared `final`
variant and its baseline, and its report names no winner. Budgets: `budget.calls`, `budget.tokens`, `budget.workers`,
`recovery.retries`, and the study's `budget.max_calls`, a hard allowance of fresh calls for the study (what earlier attempts
spent is gone); a cell it cuts short is not sealed, and raising the budget continues the same experiment (a study's identity
leaves its budget out). Expensive runs need `--execute`. `--split` and `--variant` narrow a run.

Attribution: the output's manifest pins the study, the resolved dataset (source, schema and gold of every case, wherever its
file got them), the scoring rules, the provider's reported identity, the code (the service, the harness and the study helpers)
and the environment. Resuming under another study, dataset, scorer or provider is refused, and other code or environment only
with `--allow-code-change`. Each cell records the code and environment it ran under; `compare` and `confidence` refuse cells
made under another configuration, case, source or study and report the code versions that made the cells beside the current
one. `confidence --assess test` reports the frozen fit and calibration on the test split, for the final variant or the
baseline. Replies come from a content-addressed cache keyed by the complete request, so a repeated run replays them: replayed
cost is reported apart from real inference and `cost_as_if_cold` adds them, never showing a replayed run as cheap.

## Configuration switches (`config.py`; recorded and hashed; unsupported values are refused with the prerequisite)

| Section | Switch | Effect |
| --- | --- | --- |
| `input` | `mode`: `text` \| `layout` | plain text, or `<block id label page>` markup with table cells (`images`, `text+images`: unsupported) |
| `chunking` | `mode`: `whole` \| `fixed` \| `page` \| `structure`; `max_chars`, `overlap` | whole passages, disjoint primary text; `structure` keeps tables with captions; overlap repeats the previous chunk's tail passages as context on top of `max_chars` (never traded against it) |
| `retrieval` | `mode`: `exhaustive` \| `lexical`; `top_k`, `expand` | BM25 over chunks against the fields' names and descriptions; skipped chunks stay on the ledger; neighbours measured apart |
| `decompose` | `mode`: `whole` \| `groups` \| `max_fields`; `groups`, `max_fields` | field groups (each repeats the record key); size-bounded, not budget-aware |
| `output` | `constraint`: `schema` \| `prompt`; `max_tokens` | provider-native structured output (never a silent fallback) or prompt-only; local `jsonschema` validation always |
| `recovery` | `retries`, `subdivide`, `depth` | retry a failed task (a new call with the same request: at temperature 0 it can repeat a deterministic failure); halve the fields (after a cut-off) or the passages of a failed task, each level from what failed |
| `evidence` | `mode`: `none` \| `ids` \| `quote` (`coords`: unsupported); `alignment.{exact,normalized,fuzzy,fuzzy_threshold,fuzzy_growth,disambiguate}` | what the model cites and how it is resolved to canonical spans (alignment settings are refused with `mode: none`, where they would do nothing) |
| `verification` | `model`, `gate`: `off` \| `flag` \| `abstain` | a separate model verdict on the cited text; the gate flags or withholds fields the checks or the verdict call unsupported |
| `merge` | `keys`, `min_fields`, `continuation`: `off` \| `flags`, `resolver` | record matching, joining a record a chunk cut, a costed model choice between conflicting scalars |
| `sampling` | `n`, `temperature`, `seed`, `aggregate`: `strict` \| `majority`, `views`: `field` [+ `document`] | repeated extraction and voting; a document-guided listing whose disagreement with the field view is a signal |
| `signals` | `verbalized`, `top_logprobs` | verbalised confidence; token probabilities |
| `budget` | `input_chars`, `calls`, `tokens`, `workers` | per-case limits; a call over budget fails its task visibly; `workers` also runs verification and conflict-resolution calls |

## What a prediction says (and what it does not)

Every (record, field) has a status: `value`, `absent` (a processed region was asked and it is not there), `unresolved`
(values conflict or do not conform), `omitted` (no successful call covered it, or the record touches an unread region),
`unsupported` (withheld by the evidence gate; the raw value is kept). Gold says `value`, `absent` or unannotated, and only
annotated gold enters a denominator. Raw and normalised values are kept apart; evidence references resolve in an immutable
snapshot (a digest) or the run refuses. The artifact's ledger lists every (chunk, group) region as `processed`, `partial`
(part of it failed; the valid parts keep their records), `failed`, `refused` or `not_retrieved`, and issues list each failed
task even when the region was read; `recall` is always `unmeasured`. A budget that runs out fails only the task it cuts (a
region failure on the ledger, the finished halves kept); a field the budget left unverified says so in its verdict. Whether a
null is `absent` or `omitted` is decided per sample and per field: a field is read only if every task that asked for it
succeeded, so a failed half of a subdivided task voids only its own fields, and a failed passage half voids all of them.

Voting over samples: `majority` needs more than half of the *answering* samples (a null counts as an answer; a failed
sample is left out, never counted as dissent), `strict` needs every answering sample, otherwise the field is `unresolved`
with every alternative and its votes kept. A set field keeps the items most samples state; its agreement is the share of
samples that state exactly the kept set. Records are matched across samples by declared key, else by assignment on the values
or cited spans they share (at least `merge.min_fields`), so a sample that disagrees on a field neither splits the record nor
hides its own dissent. Under `majority` a record that most of the samples that read its region did not find is outvoted (an
issue, not a silent drop); under `strict` it stays, every field unresolved.

Nested values of one record stated by several candidates are parts, not rival answers: objects fill in child by child (a
null child erases nothing), collections keep every item in reading order and fold only an item another candidate already
gave (flag `repeated_items_merged`; every chunk's own list stays in `alternatives`), and a nested scalar conflict leaves the
field `unresolved`. A case declared `record_scope: "document"` (the ExtractBench adapter's object root) is one record per
document, whatever the chunking. Structured scoring (evaluator 3) leaves a collection no gold record annotates unscored under
every parent (`unscored_records`).

Scoring (`evaluate.py`): field precision/recall/F1 with the abstentions, missing, duplicate and hallucinated records beside
them, strict record and document correctness, cross-page fragments, evidence page/segment/span hits (denominators fixed by
the gold, so abstaining cannot raise a joint rate) with the conditional rates separate, the verifier scored against
annotated spans and decoys, schema-valid reply rate, and real versus replayed calls, tokens and seconds. Records are paired
by declared key, then by the Hungarian algorithm over shared annotated values with eligibility masked first. Every predicted
value with a defined correctness is exactly one outcome, duplicates and extra records included. Comparators are fixed per
study. Fields are scored at top level: a nested value is compared whole.

## Technique inventory

| Technique | Status | Notes |
| --- | --- | --- |
| Text and layout input, whole/fixed/page/structure chunks, overlap | reused | `text_of`, `structured_source`, `contexts.partition` |
| Page images, text + images, coordinate generation | unsupported | needs a served vision model and an adapter that sends image content (`llm.py` sends text only); coordinates also need boxes in the input |
| Exhaustive chunking; lexical retrieve-then-extract | implemented | BM25 (adapted from `routing.rank_units`); semantic/hybrid retrieval not added (would need an embedding dependency) |
| Field groups, output-constraint modes, retry and subdivision recovery | implemented | budget-aware subdivision acts on measured length failures only |
| Quote and id evidence; exact, normalised and fuzzy alignment | implemented | fuzzy is a bounded difflib adaptation of SafePassage's alignment idea (not Smith-Waterman) and always approximate |
| Deterministic checks, model verifier, gate | implemented | the verifier sees only the cited passages (cited spans marked `[[ ]]`) and the field/record definitions; field- and record-assignment verdicts are recorded but not scored (no annotation) |
| Merger: keys, conservative keyless matching, sets, conflicts, continuation, resolver | implemented | cluster-wide compatibility stops transitive merges of conflicting records |
| Sampling with agreement/majority; field vs document view | implemented (adapted) | LMDX-lite voting; the document view is ExtractConf-Mapper-inspired and only feeds a disagreement signal (no free-label-to-field mapper) |
| Signals: verbalised, first/mean/span probability, margin, top-k entropy, agreement, view agreement, alignment, verifier, validity, OCR | implemented | probabilities as ConfBench defines the first-token and mean-token forms, value tokens only, JSON excluded; top-k entropy is a lower bound and top-k tokens are not alternative values |
| CeRTS-style alternative-sequence probability | not implemented | only the abstract was accessible; the algorithm cannot be verified |
| Fusion (L2 logistic, scipy), rank baseline, Platt, isotonic | implemented | fit on `fit`; calibrators and thresholds on `calibration`; separate `value` and `supported` targets; the fitted models are saved in the report |
| Risk-coverage (tie blocks accepted together), AURC, ECE, Brier, AUROC, errors at a review budget | implemented | empirical, never a guarantee; group intervals |
| Learn-then-Test (HB p-values, fixed sequence), Conformal Risk Control | implemented (faithful) | unit is the document group; fixed grid; with too few groups the guarantee is reported unavailable |
| Split conformal prediction | algorithm and guard implemented, not wired | needs a closed-label field per document with full label probabilities (top-k tokens are not that) and about 20 independent documents; refuses repeated units |
| Evidence-supervised fine-tuning / evidence reward | unsupported | no training workflow in the repository; needs evidence-labelled data, weights and a training stack |
| Production Article/Catalog options as arms | exposed by `score` | run them with the existing study tooling; the adapter reads their artifacts (null fields become `absent`, or `omitted` when processing was incomplete) |

## Papers checked against primary sources (methods only; no headline numbers are used)

LMDX (segment-id citations, verbatim check, K-sample vote: adapted, no fine-tuning, no coordinates); Problem Solved? (one-factor
ablation with the comparator held fixed); the multistage financial-document pipeline (per-field page retrieval; adapted to a text
model); From chaos to clarity (field-group payloads, agree-or-flag merge, set union); ExStrucTiny and both ExtractBench papers
(evaluation: Hungarian records, absent versus missing, grounding requires a correct value, group-level aggregation; the
datasets were not downloaded); Evidence Attribution without Coordinates (images: not applicable; the alignment similarity as an
abstention signal is used); SafePassage; DocScope (stage-decoupled, conditional-on-correct reporting); ConfBench (signal
definitions); Beyond Accuracy (only the abstract was accessible); CeRTS (abstract only); Learn then Test and Conformal Risk
Control (algorithms and guarantees verified from the papers); Beyond Logprobs / ExtractConf (two-view disagreement; its
reported 99.1% accuracy at 80% coverage is inconsistent with its stated denominators: on 267 test fields with a 26.6% failure
rate, at least 18 errors remain among 214 kept fields, so at most about 91.6%).

## Limits

Synthetic cases test the implementation, not real-world superiority. Token probabilities are the server's as reported and
their kind is deployment-specific: on the DGX Spark's vLLM they are post-grammar (a forced token has probability 1), on
Ollama they are raw; `tests/test_harness_live.py` prints which. A model call is not deterministic because a seed was sent,
repeated samples are not independent, and agreement is a signal, not proof. Risk-control guarantees hold only for exchangeable
groups, a fixed grid, and the stated loss, and need on the order of dozens of groups.

The output directory holds every prompt and reply (the cache) and the sealed artifacts: keep it where the source documents are
kept, and send calls only to a provider those documents may go to.

Known gaps: a set kept by majority that no single sample stated whole has unknown citation checks (the gate does not withhold
on an unknown), and its rejected items stay in `alternatives`; a sample that gets a record's *key* wrong is a different record to the aligner, so its dissent is not counted on
the right one; a table that continues across a chunk boundary is joined only by overlap or the
model's continuation flags, never stitched cell by cell; the verifier's field-assignment and record-assignment verdicts are
not scored; nested values are compared whole; the passage dimension of coverage is conservative (a failed passage half makes
every field of the region `omitted`); retrieval recall is never measured, so a lexical run is compared on the records it
covered and its ledger says which regions it did not read; a study's paired effects use only groups whose cases ran in both
arms, and the groups left out are listed.

Pilot evidence (a real model on synthetic data, with the protocol deviations and what the numbers can and cannot say):
`docs/plans/2026-09-30-extraction-research-harness-evidence/`.

## Real-data validation and evaluator v2

The dated [screening protocol](../../../../docs/research/2026-09-30-extractbench-validation/protocol.md)
fixes field normalization, raw versus canonical scores, evidence selection/localization/support,
annotation availability, the A0–A3 deltas, local provider, budgets and untouched holdout.
It supersedes pilot scoring claims; this harness does not establish a formal certificate.

```sh
python -m experiments.harness extractbench SELECTION.json PINNED_JSONL_DIR DATA_DIR --smoke
python -m experiments.harness compare OLD_STUDY.json OLD_OUTPUT NEW_REPORT.json --split dev --rescore
```

The adapter reads pinned public JSONLs and only downloads development representatives. It writes
separate `inputs/` and evaluator-only `annotations/`, plus checksummed parser and dataset manifests.
Keep those PDFs, annotations and model replies in quota-checked ignored storage. Use `TMPDIR` and
pytest `--basetemp` there too. The eight held-out representatives have no ingestion command in this increment.
