# Grounding lab: performance report

Status: report only. This document changes no code. It collects the measured
accuracy, review workload, and latency of the grounding lab policies, and the
production reference points from the Beier rehearsal. The text follows
ASD-STE100. The design notes are in
[`grounding-lab-design-notes.md`](grounding-lab-design-notes.md).

Sources: `prototypes/grounding_lab` on branch `experiment/radical-context-prune`
(`AUDIT.md`, `EXTRACTED_E_NEMOTRON.md`, `EXTRACTED_CV6_GATED_NEMOTRON.md`,
`EXTRACTED_LLM_HITSET.md`, `experiments/2026-09-05/EVALUATION.md`,
`WORKFLOW_TIMINGS.md`, `pruning/SUMMARY.md`,
`experiments/2026-09-05-bounded/RESULTS.md`, `ENVIRONMENT.md`) and
`docs/validation/2026-09-07-beier-user-test.md`.

## 1. How to read the numbers

- A **claim** is one populated value from an extraction. A claim is
  **supported** when the source states the value. It is **unsupported** when
  the source does not.
- A policy gives each claim one outcome: **link** (one anchor), **review**
  (an anchor is shown, but not accepted), or **abstain** (no anchor).
- A **correct decision** is a correct link for a supported claim, or an
  abstain for an unsupported claim. A **wrong link** is a link to an
  incorrect anchor, or a link for an unsupported claim.
- **Auto precision** is correct links divided by all links. The audit
  forbids automatic acceptance, so this number describes the policy, not a
  product behavior.
- **Errors caught** are unsupported claims that got no link or a review flag.
- Latency is the whole per-claim path after one anchor normalization for each
  document. The median and the p95 come from all claims of a run. Desktop
  timings are noisy. Repetitions are repeated inputs, not independent
  observations.
- All labels of the frozen experiments are model-generated with adjudication.
  They are not human ground truth.

## 2. Hardware and software

| Item | Value |
|---|---|
| Lab grounding host | NVIDIA GeForce RTX 4090, 24,564 MiB; Windows 11 build 26200 |
| Lab software | Python 3.13.15; PyTorch 2.13.0+cu130; Node 24.19.0 |
| Reranker | `nvidia/llama-nemotron-rerank-1b-v2`, pinned revision; peak VRAM 4.4 GiB |
| LLM scorer | `qwen3.8:latest` (27B Q4) on the local Ollama; prompts cut at 16 k tokens |
| Extraction model of the frozen experiments | `qwen3.8:27b` on the DGX Spark Ollama 0.32.14; temperature 0; context 262,144 |
| Production reference host | Local `pnpm dev` stack; model routes on the DGX Spark Ollama |

## 3. Development set: 360 claims from the real extractor

Six copyrighted grave catalogues, 60 sampled leaves each, labeled blind:
256 supported and 104 unsupported claims. Thresholds "frozen" are
`-9.375 / 0.5625` from the fixtures. "Blind-tuned" is leave-one-document-out
on this set.

### 3.1 Policies

| Policy | Correct | Supported links | Correct abstains | Review | Wrong | Auto precision | Median ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| E, frozen | 230/360 | 160/256 | 70/104 | 35 | 61 | 160/221 | 28 | 1,053 |
| E + sibling gate, frozen | 233/360 | 155/256 | 78/104 | 39 | 52 | 155/207 | 15 | 366 |
| E, blind-tuned | 234/360 | 154/256 | 80/104 | 33 | 41 | 154/195 | 27 | 1,116 |
| E + sibling gate, blind-tuned | 224/360 | 145/256 | 79/104 | 41 | 39 | 145/184 | 16 | 381 |
| E with the LLM as scorer | 251/360 | 168/256 | 83/104 | – | 36 | – | 5,238 | – |

### 3.2 The reviewer's view of the same runs

| Policy | Errors caught | Missed (linked) | Correct values passed | Correct values to review or abstained | Correct value, wrong anchor |
|---|---:|---:|---:|---:|---:|
| E, frozen | 77/104 (74 %) | 27 | 160/256 | 62 | 34 |
| E + sibling gate, frozen | 84/104 (81 %) | 20 | 155/256 | 69 | 32 |
| E, blind-tuned | 86/104 (83 %) | 18 | 154/256 | 79 | 23 |
| E + sibling gate, blind-tuned | 87/104 (84 %) | 17 | 145/256 | 89 | 22 |
| Single hits pass, every hit set to review | 94/104 (90 %) | 10 | 79/256 | 177 | 0 |
| Gated single hits pass, hit sets to review | 93/104 (89 %) | 11 | 84/256 | 170 | 2 |
| LLM as scorer, same contract | 83/104 (80 %) | 21 | 168/256 | 73 | 15 |

The last two lexical-only rows need no model.

### 3.3 Policy E by document, frozen thresholds

| Document | Correct | Review | Wrong | Median ms | p95 ms | Index ms |
|---|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 29/60 | 7 | 16 | 76 | 440 | 46 |
| buchvaldek-koutecky-1972-vikletice-de | 51/60 | 3 | 6 | 882 | 1,039 | 27 |
| conrad-2011-bbc-graves-de | 43/60 | 5 | 7 | 4 | 350 | 24 |
| dobes-1998-kugelamphoren-de | 39/60 | 4 | 16 | 9 | 147 | 35 |
| durankulak-catalogue-de | 24/60 | 10 | 8 | 37 | 2,577 | 119 |
| shbat-2009-skeletal-health-en | 44/60 | 6 | 8 | 22 | 152 | 16 |

The buchvaldek-koutecky extraction ended early (`finishReason = length`). It
contributes 59 of the 104 unsupported values. Without it, the gated policy
catches 29 of 45 unsupported values (64 %).

### 3.4 Policy E with the sibling gate, six-fold cross-validation

Each document uses thresholds selected on the other five documents.

| Document | Abstain threshold | Correct | Review | Wrong | Median ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 0.879 | 22/60 | 10 | 8 | 52 | 221 |
| buchvaldek-koutecky-1972-vikletice-de | -1.430 | 58/60 | 1 | 1 | 6 | 7 |
| conrad-2011-bbc-graves-de | -1.430 | 42/60 | 8 | 5 | 4 | 354 |
| dobes-1998-kugelamphoren-de | -2.453 | 37/60 | 4 | 14 | 9 | 156 |
| durankulak-catalogue-de | 4.156 | 21/60 | 10 | 4 | 31 | 2,619 |
| shbat-2009-skeletal-health-en | -∞ | 44/60 | 8 | 7 | 22 | 151 |
| Pooled | – | 224/360 | 41 | 39 | 16 | 381 |

### 3.5 What no scorer corrects

- 27 supported values have no lexical hit: soft hyphens in the OCR, values
  composed from two cells, expanded abbreviations, a year inside a date.
- 12 of the 17 errors that the gated policy still links are place names from
  citations. The only occurrence is a bibliography entry that also holds the
  sibling district.
- 2 are grave numbers that lost their letter (`1117` for `1117A`).
- Bare numbers give hit sets up to 174 anchors. The gate narrows them, and
  this halves the p95.

## 4. Secondary set: 164 hand-labeled blind claims

The same six documents. A labeler who never saw the pipeline wrote 164 typed
claims, 116 supported and 48 unsupported.

| Policy | Correct | Supported links | Correct abstains | Review | Wrong | Auto precision |
|---|---:|---:|---:|---:|---:|---:|
| E, frozen | 91/164 | 72/116 | 19/48 | 13 | 37 | 72/109 |
| E + sibling gate, frozen | 92/164 | 70/116 | 22/48 | 17 | 30 | 70/100 |
| E, blind-tuned | 99/164 | 65/116 | 34/48 | 4 | 19 | 65/84 |
| E + sibling gate, blind-tuned | 99/164 | 66/116 | 33/48 | 12 | 15 | 66/81 |
| E with the LLM as scorer | 114/164 | 86/116 | 28/48 | – | 25 | – |

The first blind set moved policy E from 97 percent (verbatim hand labels) to
55 percent. The 372 of 382 from the retired fixtures measured the labels, not
the pipeline. Do not quote it.

## 5. Traps: 40 single-hit values under the wrong field

Policy E links 34 of 40 traps wrong at confidence 1.0. The sibling gate
removes 4, because 32 traps are top-level fields with no sibling. Policy H
(score every single hit) caught 20 more traps but sent 65 correct links to
review. Policy H was dropped.

## 6. Row-pruning ablations

Nine warmed runs in rotated order. The decisions were identical in every
repetition.

| Policy | Correct links | Unsupported links | Wrong anchors | Review or abstain | Recoverable gold kept | Neural pairs |
|---|---:|---:|---:|---:|---:|---:|
| E | 154 | 18 | 23 | 165 | 214/214 | 12,434 |
| E + bare-number row pruning | 148 | 18 | 18 | 176 | 214/214 | 12,038 |
| E + all-value row pruning | 148 | 18 | 17 | 177 | 214/214 | 11,509 |

Claim latency in milliseconds, one warmed repetition per row:

| Repetition | Policy | Claim p50 | Claim p95 | Claim p99 | Document p50 | Document p95 | Document max |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | E | 31.0 | 763.1 | 1,679.5 | 5,034.5 | 23,270.5 | 25,943.1 |
| 1 | bare-number row | 38.6 | 783.0 | 1,689.1 | 5,075.9 | 23,873.7 | 27,964.5 |
| 1 | all-value row | 28.5 | 768.3 | 1,734.3 | 3,462.5 | 23,441.6 | 26,805.0 |
| 2 | E | 27.9 | 764.4 | 1,660.5 | 4,443.2 | 23,332.6 | 25,302.5 |
| 2 | bare-number row | 41.0 | 850.9 | 2,102.9 | 4,334.5 | 25,439.4 | 32,112.7 |
| 2 | all-value row | 29.8 | 823.2 | 1,916.5 | 4,460.4 | 24,375.5 | 27,766.6 |
| 3 | E | 39.1 | 942.9 | 1,798.3 | 7,414.6 | 27,175.0 | 29,311.8 |
| 3 | bare-number row | 30.6 | 848.0 | 1,802.7 | 4,203.1 | 25,820.6 | 27,648.2 |
| 3 | all-value row | 35.0 | 778.0 | 1,912.9 | 3,405.5 | 23,576.5 | 29,282.0 |

Median claim p95 across the repetitions: E 764.4 ms, bare-number row 848.0 ms,
all-value row 778.0 ms. Each variant beats its E repetition on claim p95 one
time out of three. The neural candidate count p95/p99/max stays at 417/461/759
for every policy. Result: retain E.

## 7. Frozen four-family experiment (2026-09-05)

Four full catalogues (Beier, Bosch, Kirsch, Wiermann), the first 20 burial
records requested, two extraction arms (baseline, quote), all emitted values
labeled by two model labelers and one adjudicator. Four of eight extraction
calls failed. Only Kirsch has two valid arms. Beier is a transfer case because
of prior overlap.

### 7.1 Best-candidate proposals by family

| Arm / grounder | Family | Claims | Supported | Correct evidence | Unsupported proposals | Wrong evidence | Missing evidence |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline / E | beier | 556 | 453 | 120 | 95 | 314 | 19 |
| baseline / E | bosch (diagnostic) | 438 | 414 | 182 | 24 | 218 | 14 |
| baseline / E | kirsch | 322 | 286 | 127 | 34 | 136 | 23 |
| baseline / E | wiermann | 536 | 500 | 224 | 32 | 271 | 5 |
| quote / E | beier (diagnostic) | 560 | 489 | 154 | 60 | 315 | 20 |
| quote / quote-only | beier (diagnostic) | 560 | 489 | 167 | 48 | 63 | 259 |
| quote / E | kirsch | 297 | 271 | 133 | 26 | 126 | 12 |
| quote / quote-only | kirsch | 297 | 271 | 177 | 9 | 8 | 86 |
| baseline / E | all pooled | 1,852 | 1,653 | 653 | 185 | 939 | 61 |

### 7.2 Frozen E routing (links still require review)

| Arm | Family | Linked | Review | Abstain | Correct linked evidence | Unsupported linked | Wrong linked evidence |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline / E | beier | 305 | 149 | 102 | 91 | 53 | 161 |
| baseline / E | bosch | 230 | 114 | 94 | 160 | 1 | 69 |
| baseline / E | kirsch | 157 | 46 | 119 | 97 | 21 | 39 |
| baseline / E | wiermann | 256 | 69 | 211 | 177 | 16 | 62 |
| baseline / E | all pooled | 948 | 378 | 526 | 525 | 91 | 331 |
| quote / E | kirsch | 150 | 47 | 100 | 103 | 13 | 34 |

### 7.3 Family macro averages

| Cohort | Arm | Families | Value support | Correct evidence |
|---|---|---:|---:|---:|
| All outputs | baseline / E | 4 | 89.6 % | 36.1 % |
| All outputs | quote / quote-only | 2 | 89.4 % | 44.8 % |
| Untouched, conforming | baseline / E | 2 | 91.2 % | 40.7 % |
| Untouched, conforming | quote / quote-only | 1 | 91.2 % | 59.6 % |

### 7.4 Extraction attempts

| Arm | Family | Status | Records / expected | Seconds | Reranker calls | Input tokens | Output tokens |
|---|---|---|---|---:|---:|---:|---:|
| baseline | beier | complete | 20 / 20 | 946.6 | 498 | 226,661 | 10,030 |
| baseline | bosch | failed (21 records) | 21 / 20 | 760.3 | 395 | 193,008 | 8,740 |
| baseline | kirsch | complete | 20 / 20 | 476.9 | 262 | 122,430 | 7,353 |
| baseline | wiermann | complete | 20 / 20 | 512.4 | 464 | 93,180 | 10,591 |
| quote | beier | failed (25 records) | 25 / 20 | 2,007.5 | 492 | 226,969 | 32,490 |
| quote | bosch | failed (output limit) | unknown | 1,821.3 | 0 | 193,308 | 32,768 |
| quote | kirsch | complete | 20 / 20 | 1,051.6 | 258 | 122,778 | 22,684 |
| quote | wiermann | failed (output limit) | unknown | 1,294.1 | 0 | 93,528 | 32,768 |

Totals: 8 extraction calls, 2,369 reranker calls, 1,271,862 input tokens,
157,424 output tokens, 8,870.8 seconds of generation.

### 7.5 Generation plus core scoring, seconds

| Family | Arm | Generation | Core phase sum | Workflow span sum |
|---|---|---:|---:|---:|
| beier | baseline / E | 946.6 | 2,144.3 | 2,180.9 |
| bosch | baseline / E | 760.3 | 1,372.3 | 1,412.4 |
| kirsch | baseline / E | 476.9 | 722.1 | 737.0 |
| wiermann | baseline / E | 512.4 | 670.5 | 690.8 |
| beier | quote / E | 2,007.5 | 3,117.7 | 3,153.2 |
| beier | quote / quote-only | 2,007.5 | 2,007.5 | 2,007.5 |
| kirsch | quote / E | 1,051.6 | 1,297.0 | 1,309.6 |
| kirsch | quote / quote-only | 1,051.6 | 1,051.6 | 1,051.6 |

The core timer excludes risk inference and outcome files. The workflow span
comes from file timestamps and includes them. Neither is a production request
measurement. On Kirsch, quote-only (1,051.6 s) is slower than baseline plus E
(722.1 s).

### 7.6 Review workload and calibration

- Joint-error precision of the risk queue at review depths 1, 3, and 5 is
  100 percent in every family, but recall is below 5 percent at depth 5.
- Value-error precision at depth 1 is 0 percent in three of four families.
  The queue finds evidence errors, not semantic value errors.
- Brier scores of the frozen E risk: value 0.154, evidence 0.221, joint
  0.202 on all outputs. Reliability is poor in the low bins: values with a
  predicted correctness of 13 percent are correct 93 percent of the time.
- Risk versus coverage, untouched conforming cohort: at 25 percent retained
  coverage the joint-error rate is 18.7 percent for E and 8.0 percent for
  quote-only; at 100 percent it is 59.0 percent and 40.4 percent.

## 8. Bounded Conrad experiment (2026-09-05-bounded)

One development source. Attempt 3 is the only scope-valid comparison: 20 of 20
records in both arms, all required context intact.

| Values / grounder | Correct evidence | Wrong supported anchors | Unsupported proposals | Missing supported evidence |
|---|---:|---:|---:|---:|
| Baseline / E | 183 | 80 | 26 | 2 |
| Quote / E replay | 185 | 81 | 17 | 2 |
| Quote / quote-only | 210 | 18 | 15 | 40 |
| Quote / quote-E fallback | 227 | 41 | 18 | 0 |

Timing of the final revision (n = 1 for each arm):

| Stage | Seconds |
|---|---:|
| Shared discovery | 166.7 |
| Baseline extraction plus E | 296.2 |
| Quote extraction plus deterministic mapping | 584.2 |
| Quote extraction plus full E replay | 624.0 |
| Full paired workflow | 1,086.9 |

E per-claim quantiles: p50 43.1 ms, p95 527.3 ms, p99 1,114.0 ms for the
baseline arm (291 claims); p50 38.5 ms, p95 358.6 ms, p99 1,123.2 ms for the
quote-arm replay (287 claims). Across attempts: 52 extraction requests, 414,593
input tokens, 55,951 output tokens; the largest completed output was 3,824
tokens of an 8,192-token limit.

## 9. Production reference points (Beier rehearsal, 2026-09-07)

These numbers come from the production grounder (the pinned Ollama model over
the record slice), not from a lab policy. They have no gold labels, so they
measure workload and coverage only.

| Item | Value |
|---|---|
| Records | 420 |
| Values extraction | 57 min 42 s for 420 calls |
| Grounding | 38 min 53 s for 420 calls (about 5.6 s per record) |
| Populated values with an Evidence link | 3,513 of 3,514 |
| Links flagged "value not found in the linked passage" | 363 |
| Links flagged "value also appears in other passages" | 1,287 (document-wide count; PR #132 changes it to the record slice) |
| "To check" total | 1,650 |
| Links into other entries | 0 |

## 10. Caveats

- The 372 of 382 for policy E measured verbatim hand labels. It is retired.
- The development set has one output-truncated extraction that supplies 59 of
  104 unsupported values.
- The frozen experiment has one family with two valid arms. Pooled arm
  results contain different families and cannot show a paired gain.
- Desktop timings are noisy; the p95 and p99 of six documents are identical
  by construction.
- Labels of the frozen and bounded experiments are model judgments with
  adjudication; five and one judgments stay unresolved.
- No lab number is a production probability. No lab number authorizes
  automatic acceptance.
