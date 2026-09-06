# Frozen four-family grounding comparison

All labeled populated values are reported, including flagged recovered outputs from failed attempts. Original failures remain failed. No auto-accept.

| arm | family | claims | diagnostic claims | supported | supported without canonical evidence | correct evidence | unsupported proposals | wrong evidence | missing evidence | unresolved |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline/E | beier | 556 | 0 | 453 | 1 | 120 | 95 | 314 | 19 | 1 |
| baseline/E | bosch | 438 | 438 | 414 | 0 | 182 | 24 | 218 | 14 | 0 |
| baseline/E | kirsch | 322 | 0 | 286 | 0 | 127 | 34 | 136 | 23 | 0 |
| baseline/E | wiermann | 536 | 0 | 500 | 28 | 224 | 32 | 271 | 5 | 2 |
| quote/E | beier | 560 | 560 | 489 | 1 | 154 | 60 | 315 | 20 | 2 |
| quote/quote-only | beier | 560 | 560 | 489 | 1 | 167 | 48 | 63 | 259 | 2 |
| quote/E | kirsch | 297 | 0 | 271 | 0 | 133 | 26 | 126 | 12 | 0 |
| quote/quote-only | kirsch | 297 | 0 | 271 | 0 | 177 | 9 | 8 | 86 | 0 |
| baseline/E | all-output pooled | 1852 | 438 | 1653 | 29 | 653 | 185 | 939 | 61 | 3 |
| quote/E | all-output pooled | 857 | 560 | 760 | 1 | 287 | 86 | 441 | 32 | 2 |
| quote/quote-only | all-output pooled | 857 | 560 | 760 | 1 | 344 | 57 | 71 | 345 | 2 |
| baseline/E | untouched all-output pooled | 1296 | 438 | 1200 | 28 | 533 | 90 | 625 | 42 | 2 |
| quote/E | untouched all-output pooled | 297 | 0 | 271 | 0 | 133 | 26 | 126 | 12 | 0 |
| quote/quote-only | untouched all-output pooled | 297 | 0 | 271 | 0 | 177 | 9 | 8 | 86 | 0 |
| baseline/E | conforming pooled | 1414 | 0 | 1239 | 29 | 471 | 161 | 721 | 47 | 3 |
| quote/E | conforming pooled | 297 | 0 | 271 | 0 | 133 | 26 | 126 | 12 | 0 |
| quote/quote-only | conforming pooled | 297 | 0 | 271 | 0 | 177 | 9 | 8 | 86 | 0 |
| baseline/E | untouched conforming pooled | 858 | 0 | 786 | 28 | 351 | 66 | 407 | 28 | 2 |
| quote/E | untouched conforming pooled | 297 | 0 | 271 | 0 | 133 | 26 | 126 | 12 | 0 |
| quote/quote-only | untouched conforming pooled | 297 | 0 | 271 | 0 | 177 | 9 | 8 | 86 | 0 |

Frozen E routing (distinct from best-candidate proposals above; links still require review):

| arm | family | linked | review | abstain | correct linked evidence | unsupported linked | wrong linked evidence |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline/E | beier | 305 | 149 | 102 | 91 | 53 | 161 |
| baseline/E | bosch | 230 | 114 | 94 | 160 | 1 | 69 |
| baseline/E | kirsch | 157 | 46 | 119 | 97 | 21 | 39 |
| baseline/E | wiermann | 256 | 69 | 211 | 177 | 16 | 62 |
| quote/E | beier | 286 | 136 | 138 | 112 | 26 | 147 |
| quote/E | kirsch | 150 | 47 | 100 | 103 | 13 | 34 |
| baseline/E | all-family pooled | 948 | 378 | 526 | 525 | 91 | 331 |
| quote/E | all-family pooled | 436 | 183 | 238 | 215 | 39 | 181 |
| baseline/E | untouched pooled | 643 | 229 | 424 | 434 | 38 | 170 |
| quote/E | untouched pooled | 150 | 47 | 100 | 103 | 13 | 34 |

Strictly untouched families: bosch, kirsch, wiermann.
Families with two runner-valid arms: kirsch. Pooled arm results can contain different families; use the per-family comparisons to distinguish grounding from extraction and failure effects.
Excluded from strictly untouched summaries: beier: transfer.

| extraction arm | family | status | diagnostic output | records / expected | extraction seconds | model calls | reranker calls | input tokens | output tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| baseline | beier | complete | False | 20 / 20 | 946.632 | 1 | 498 | 226661 | 10030 |
| baseline | bosch | failed | True | 21 / 20 | 760.305 | 1 | 395 | 193008 | 8740 |
| baseline | kirsch | complete | False | 20 / 20 | 476.899 | 1 | 262 | 122430 | 7353 |
| baseline | wiermann | complete | False | 20 / 20 | 512.44 | 1 | 464 | 93180 | 10591 |
| quote | beier | failed | True | 25 / 20 | 2007.475 | 1 | 492 | 226969 | 32490 |
| quote | bosch | failed | False | unknown / unknown | 1821.344 | 1 | 0 | 193308 | 32768 |
| quote | kirsch | complete | False | 20 / 20 | 1051.645 | 1 | 258 | 122778 | 22684 |
| quote | wiermann | failed | False | unknown / unknown | 1294.061 | 1 | 0 | 93528 | 32768 |

Planned holdout extractions: 8; complete: 4; failed: 4; incomplete: 0; not executed: 0.
Literal first-20 scope mismatches: 6; unassessed: 2. Scope mismatches can overlap generation failures and are not added to the failure count.

Physical holdout usage totals count each extraction once, even when both E and quote-only are evaluated.

| usage | reported total | attempts with unknown usage |
|---|---:|---:|
| extractionModelCalls | 8 | 0 |
| rerankerCalls | 2369 | 0 |
| promptTokens | 1271862 | 0 |
| outputTokens | 157424 | 0 |

## First-20 scope checks

Literal catalogue-ID comparison is a diagnostic, not semantic matching. A runner-valid output can still choose the wrong records.

| family | extraction arm | record count matches | catalogue-ID sequence matches | emitted IDs | expected IDs |
|---|---|---|---|---|---|
| beier | baseline | True | False | 3, 8, 9, 10, 14, 16, 17, 18, 21, 25, 26, 28, 30, 37, 40, 40, 42, 51, 53, 55 | 3, 8, 9, 10, 14, 17, 18, 21, 25, 26, 28, 29, 30, 40, 40, 42, 51, 53, 55, 61 |
| bosch | baseline | False | False | 1, 2, 3.1, 3.2, 4, 5, 6.1, 6.2, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.11, 7.12, 7.13, 7.14 | 1, 2, 3.1, 3.2, 4, 5, 6.1, 6.2, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12 |
| kirsch | baseline | True | False | 311, 316, 331, 356, 363, 364.4, 369.1, 369.2, 369.3, 369.4, 369.5, 369.6, 369.7, 371, 375.1, 383, 397, 398.1, 402, 403 | 311, 315, 316, 325, 331, 356, 363, 364.4, 369.1, 369.2, 369.3, 369.4, 369.5, 369.6, 369.7, 370, 370, 370, 371, 383 |
| wiermann | baseline | True | False | [5], [6], [11], [12], [13], [14], [15], [16], [17], [18], [19], [22], [23], [34], [41], [50], [59], [64], [65], [74] | 5, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22, 23, 34, 41, 49, 50, 59, 64, 74 |
| beier | quote | False | False | 3, 9, 10, 14, 16, 17, 18, 25, 26, 28, 30, 37, 40, 40, 42, 51, 53, 55, 61, 62, 72, 74, 76, 77, 80 | 3, 8, 9, 10, 14, 17, 18, 21, 25, 26, 28, 29, 30, 40, 40, 42, 51, 53, 55, 61 |
| bosch | quote | unknown | unknown | — | — |
| kirsch | quote | True | False | 311, 316, 331, 356, 363, 364.4, 369.1, 369.2, 369.3, 369.4, 369.5, 369.6, 369.7, 371, 375.1, 383, 397, 398.1, 402, 403 | 311, 315, 316, 325, 331, 356, 363, 364.4, 369.1, 369.2, 369.3, 369.4, 369.5, 369.6, 369.7, 370, 370, 370, 371, 383 |
| wiermann | quote | unknown | unknown | — | — |

## Family macro averages

Conforming means runner-valid completion, types and record limit; it does not certify first-20 scope. All-output cohorts include flagged diagnostic failures.

| cohort | arm | families | value support | correct evidence |
|---|---|---:|---:|---:|
| all outputs | baseline/E | 4 | 89.6% | 36.1% |
| all outputs | quote/E | 2 | 89.4% | 36.2% |
| all outputs | quote/quote-only | 2 | 89.4% | 44.8% |
| conforming | baseline/E | 3 | 88.0% | 34.3% |
| conforming | quote/E | 1 | 91.2% | 44.8% |
| conforming | quote/quote-only | 1 | 91.2% | 59.6% |
| untouched, all outputs | baseline/E | 3 | 92.3% | 41.0% |
| untouched, all outputs | quote/E | 1 | 91.2% | 44.8% |
| untouched, all outputs | quote/quote-only | 1 | 91.2% | 59.6% |
| untouched, conforming | baseline/E | 2 | 91.2% | 40.7% |
| untouched, conforming | quote/E | 1 | 91.2% | 44.8% |
| untouched, conforming | quote/quote-only | 1 | 91.2% | 59.6% |

## Review workload

Cells show precision / recall. Family rows rank within one Extraction; macro rows average those family results. Unresolved judgments are excluded. Joint error includes missing or incorrect evidence; value error means an unsupported value.

| cohort / family | arm | target | review 1 | review 3 | review 5 |
|---|---|---|---:|---:|---:|
| family beier (all outputs) | baseline/E | joint | 100.0% / 0.2% | 100.0% / 0.7% | 100.0% / 1.1% |
| family beier (all outputs) | baseline/E | value | 100.0% / 1.0% | 66.7% / 2.0% | 60.0% / 2.9% |
| family bosch (all outputs) | baseline/E | joint | 100.0% / 0.4% | 100.0% / 1.2% | 100.0% / 2.0% |
| family bosch (all outputs) | baseline/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| family kirsch (all outputs) | baseline/E | joint | 100.0% / 0.5% | 100.0% / 1.5% | 100.0% / 2.6% |
| family kirsch (all outputs) | baseline/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| family wiermann (all outputs) | baseline/E | joint | 100.0% / 0.3% | 100.0% / 1.0% | 100.0% / 1.6% |
| family wiermann (all outputs) | baseline/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| family beier (all outputs) | quote/E | joint | 100.0% / 0.2% | 100.0% / 0.7% | 100.0% / 1.2% |
| family beier (all outputs) | quote/E | value | 100.0% / 1.4% | 66.7% / 2.9% | 40.0% / 2.9% |
| family beier (all outputs) | quote/quote-only | joint | 100.0% / 0.3% | 100.0% / 0.8% | 100.0% / 1.3% |
| family beier (all outputs) | quote/quote-only | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| family kirsch (all outputs) | quote/E | joint | 100.0% / 0.6% | 100.0% / 1.8% | 100.0% / 3.0% |
| family kirsch (all outputs) | quote/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| family kirsch (all outputs) | quote/quote-only | joint | 100.0% / 0.8% | 100.0% / 2.5% | 100.0% / 4.2% |
| family kirsch (all outputs) | quote/quote-only | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| all outputs macro | baseline/E | joint | 100.0% / 0.4% | 100.0% / 1.1% | 100.0% / 1.8% |
| all outputs macro | baseline/E | value | 25.0% / 0.2% | 16.7% / 0.5% | 15.0% / 0.7% |
| all outputs macro | quote/E | joint | 100.0% / 0.4% | 100.0% / 1.3% | 100.0% / 2.1% |
| all outputs macro | quote/E | value | 50.0% / 0.7% | 33.3% / 1.4% | 20.0% / 1.4% |
| all outputs macro | quote/quote-only | joint | 100.0% / 0.5% | 100.0% / 1.6% | 100.0% / 2.7% |
| all outputs macro | quote/quote-only | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| conforming macro | baseline/E | joint | 100.0% / 0.4% | 100.0% / 1.1% | 100.0% / 1.8% |
| conforming macro | baseline/E | value | 33.3% / 0.3% | 22.2% / 0.7% | 20.0% / 1.0% |
| conforming macro | quote/E | joint | 100.0% / 0.6% | 100.0% / 1.8% | 100.0% / 3.0% |
| conforming macro | quote/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| conforming macro | quote/quote-only | joint | 100.0% / 0.8% | 100.0% / 2.5% | 100.0% / 4.2% |
| conforming macro | quote/quote-only | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| untouched, all outputs macro | baseline/E | joint | 100.0% / 0.4% | 100.0% / 1.2% | 100.0% / 2.0% |
| untouched, all outputs macro | baseline/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| untouched, all outputs macro | quote/E | joint | 100.0% / 0.6% | 100.0% / 1.8% | 100.0% / 3.0% |
| untouched, all outputs macro | quote/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| untouched, all outputs macro | quote/quote-only | joint | 100.0% / 0.8% | 100.0% / 2.5% | 100.0% / 4.2% |
| untouched, all outputs macro | quote/quote-only | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| untouched, conforming macro | baseline/E | joint | 100.0% / 0.4% | 100.0% / 1.3% | 100.0% / 2.1% |
| untouched, conforming macro | baseline/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| untouched, conforming macro | quote/E | joint | 100.0% / 0.6% | 100.0% / 1.8% | 100.0% / 3.0% |
| untouched, conforming macro | quote/E | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| untouched, conforming macro | quote/quote-only | joint | 100.0% / 0.8% | 100.0% / 2.5% | 100.0% / 4.2% |
| untouched, conforming macro | quote/quote-only | value | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |

## Risk versus retained coverage

Each cell shows observed joint-error rate (retained n; actual coverage). Columns are requested coverage levels; small samples may round upward. E retains low frozen risk scores first; quote-only retains mapped quotes first using the reversed frozen ordinal queue, without probabilities.

| cohort | arm | 10% | 25% | 50% | 75% | 100% |
|---|---|---|---|---|---|---|
| all outputs | baseline/E | 36.8% (n=185; 10.0%) | 34.3% (n=463; 25.0%) | 50.8% (n=925; 50.0%) | 56.4% (n=1387; 75.0%) | 64.7% (n=1849; 100.0%) |
| all outputs | quote/E | 34.9% (n=86; 10.1%) | 41.6% (n=214; 25.0%) | 56.1% (n=428; 50.1%) | 60.4% (n=642; 75.1%) | 66.4% (n=855; 100.0%) |
| all outputs | quote/quote-only | 17.4% (n=86; 10.1%) | 22.9% (n=214; 25.0%) | 26.9% (n=428; 50.1%) | 46.4% (n=642; 75.1%) | 59.8% (n=855; 100.0%) |
| conforming | baseline/E | 38.7% (n=142; 10.1%) | 33.4% (n=353; 25.0%) | 52.8% (n=706; 50.0%) | 59.2% (n=1059; 75.1%) | 66.6% (n=1411; 100.0%) |
| conforming | quote/E | 10.0% (n=30; 10.1%) | 17.3% (n=75; 25.3%) | 32.9% (n=149; 50.2%) | 42.2% (n=223; 75.1%) | 55.2% (n=297; 100.0%) |
| conforming | quote/quote-only | 6.7% (n=30; 10.1%) | 8.0% (n=75; 25.3%) | 5.4% (n=149; 50.2%) | 20.6% (n=223; 75.1%) | 40.4% (n=297; 100.0%) |
| untouched, all outputs | baseline/E | 27.7% (n=130; 10.0%) | 25.3% (n=324; 25.0%) | 36.6% (n=647; 50.0%) | 47.8% (n=971; 75.0%) | 58.8% (n=1294; 100.0%) |
| untouched, all outputs | quote/E | 10.0% (n=30; 10.1%) | 17.3% (n=75; 25.3%) | 32.9% (n=149; 50.2%) | 42.2% (n=223; 75.1%) | 55.2% (n=297; 100.0%) |
| untouched, all outputs | quote/quote-only | 6.7% (n=30; 10.1%) | 8.0% (n=75; 25.3%) | 5.4% (n=149; 50.2%) | 20.6% (n=223; 75.1%) | 40.4% (n=297; 100.0%) |
| untouched, conforming | baseline/E | 26.7% (n=86; 10.0%) | 18.7% (n=214; 25.0%) | 36.2% (n=428; 50.0%) | 48.0% (n=642; 75.0%) | 59.0% (n=856; 100.0%) |
| untouched, conforming | quote/E | 10.0% (n=30; 10.1%) | 17.3% (n=75; 25.3%) | 32.9% (n=149; 50.2%) | 42.2% (n=223; 75.1%) | 55.2% (n=297; 100.0%) |
| untouched, conforming | quote/quote-only | 6.7% (n=30; 10.1%) | 8.0% (n=75; 25.3%) | 5.4% (n=149; 50.2%) | 20.6% (n=223; 75.1%) | 40.4% (n=297; 100.0%) |

## Calibration diagnostics

Brier scores and reliability treat one minus frozen E risk scores as predicted correctness, with no holdout fitting. Quote-only has no probability model, so its Brier and reliability are unavailable.

| cohort | arm | target | n | Brier |
|---|---|---|---:|---:|
| all outputs | baseline/E | value | 1849 | 0.154 |
| all outputs | baseline/E | evidence | 1592 | 0.221 |
| all outputs | baseline/E | joint | 1849 | 0.202 |
| all outputs | quote/E | value | 855 | 0.140 |
| all outputs | quote/E | evidence | 728 | 0.241 |
| all outputs | quote/E | joint | 855 | 0.211 |
| all outputs | quote/quote-only | unavailable | — | — |
| conforming | baseline/E | value | 1411 | 0.172 |
| conforming | baseline/E | evidence | 1192 | 0.211 |
| conforming | baseline/E | joint | 1411 | 0.196 |
| conforming | quote/E | value | 297 | 0.175 |
| conforming | quote/E | evidence | 259 | 0.180 |
| conforming | quote/E | joint | 297 | 0.187 |
| conforming | quote/quote-only | unavailable | — | — |
| untouched, all outputs | baseline/E | value | 1294 | 0.143 |
| untouched, all outputs | baseline/E | evidence | 1158 | 0.201 |
| untouched, all outputs | baseline/E | joint | 1294 | 0.195 |
| untouched, all outputs | quote/E | value | 297 | 0.175 |
| untouched, all outputs | quote/E | evidence | 259 | 0.180 |
| untouched, all outputs | quote/E | joint | 297 | 0.187 |
| untouched, all outputs | quote/quote-only | unavailable | — | — |
| untouched, conforming | baseline/E | value | 856 | 0.168 |
| untouched, conforming | baseline/E | evidence | 758 | 0.175 |
| untouched, conforming | baseline/E | joint | 856 | 0.182 |
| untouched, conforming | quote/E | value | 297 | 0.175 |
| untouched, conforming | quote/E | evidence | 259 | 0.180 |
| untouched, conforming | quote/E | joint | 297 | 0.187 |
| untouched, conforming | quote/quote-only | unavailable | — | — |

Reliability cells show mean predicted / observed correctness and sample count; empty bins remain unavailable.

| cohort | arm | target | 0–20% | 20–40% | 40–60% | 60–80% | 80–100% |
|---|---|---|---|---|---|---|---|
| all outputs | baseline/E | value | 13.1% / 93.4% (n=76) | 31.6% / 95.1% (n=82) | 50.2% / 85.9% (n=85) | 68.4% / 86.7% (n=225) | 95.2% / 89.5% (n=1381) |
| all outputs | baseline/E | evidence | 11.7% / 19.7% (n=426) | 29.4% / 34.4% (n=355) | 50.2% / 39.4% (n=363) | 67.9% / 61.0% (n=200) | 95.2% / 73.4% (n=248) |
| all outputs | baseline/E | joint | 9.0% / 16.9% (n=688) | 30.0% / 30.5% (n=446) | 48.7% / 43.6% (n=362) | 68.6% / 71.4% (n=140) | 94.2% / 67.1% (n=213) |
| all outputs | quote/E | value | 11.1% / 89.7% (n=29) | 30.1% / 91.3% (n=23) | 53.5% / 77.4% (n=31) | 67.7% / 88.8% (n=98) | 94.1% / 89.3% (n=674) |
| all outputs | quote/E | evidence | 12.2% / 27.7% (n=137) | 29.6% / 33.0% (n=179) | 50.0% / 32.6% (n=227) | 67.9% / 56.7% (n=97) | 95.6% / 69.3% (n=88) |
| all outputs | quote/E | joint | 8.6% / 18.2% (n=247) | 30.8% / 27.1% (n=269) | 48.5% / 40.4% (n=203) | 68.1% / 69.8% (n=63) | 94.9% / 58.9% (n=73) |
| conforming | baseline/E | value | 13.1% / 93.3% (n=75) | 30.1% / 92.7% (n=55) | 52.4% / 83.6% (n=61) | 68.2% / 89.3% (n=150) | 94.5% / 87.2% (n=1070) |
| conforming | baseline/E | evidence | 11.9% / 19.1% (n=325) | 29.5% / 29.4% (n=255) | 50.2% / 34.4% (n=279) | 67.9% / 67.1% (n=143) | 95.6% / 74.7% (n=190) |
| conforming | baseline/E | joint | 8.9% / 16.6% (n=512) | 30.0% / 24.3% (n=341) | 48.7% / 39.6% (n=285) | 68.4% / 75.2% (n=105) | 94.3% / 66.1% (n=168) |
| conforming | quote/E | value | 11.5% / 92.9% (n=28) | 30.1% / 95.5% (n=22) | 52.2% / 60.0% (n=15) | 67.9% / 88.5% (n=26) | 94.4% / 93.2% (n=206) |
| conforming | quote/E | evidence | 10.9% / 25.3% (n=75) | 28.1% / 32.9% (n=73) | 50.0% / 65.9% (n=41) | 67.9% / 80.0% (n=30) | 95.1% / 97.5% (n=40) |
| conforming | quote/E | joint | 6.9% / 19.7% (n=132) | 28.7% / 41.2% (n=68) | 50.2% / 70.7% (n=41) | 69.0% / 87.0% (n=23) | 93.6% / 90.9% (n=33) |
| untouched, all outputs | baseline/E | value | 13.4% / 95.8% (n=72) | 31.6% / 97.5% (n=79) | 48.9% / 83.6% (n=67) | 68.7% / 85.4% (n=144) | 95.8% / 93.9% (n=932) |
| untouched, all outputs | baseline/E | evidence | 11.4% / 19.0% (n=379) | 28.9% / 37.0% (n=257) | 49.7% / 59.1% (n=176) | 68.6% / 68.8% (n=141) | 95.1% / 80.5% (n=205) |
| untouched, all outputs | baseline/E | joint | 8.7% / 17.5% (n=590) | 29.0% / 42.4% (n=245) | 49.3% / 61.6% (n=177) | 69.4% / 79.0% (n=105) | 93.9% / 75.7% (n=177) |
| untouched, all outputs | quote/E | value | 11.5% / 92.9% (n=28) | 30.1% / 95.5% (n=22) | 52.2% / 60.0% (n=15) | 67.9% / 88.5% (n=26) | 94.4% / 93.2% (n=206) |
| untouched, all outputs | quote/E | evidence | 10.9% / 25.3% (n=75) | 28.1% / 32.9% (n=73) | 50.0% / 65.9% (n=41) | 67.9% / 80.0% (n=30) | 95.1% / 97.5% (n=40) |
| untouched, all outputs | quote/E | joint | 6.9% / 19.7% (n=132) | 28.7% / 41.2% (n=68) | 50.2% / 70.7% (n=41) | 69.0% / 87.0% (n=23) | 93.6% / 90.9% (n=33) |
| untouched, conforming | baseline/E | value | 13.3% / 95.8% (n=71) | 30.1% / 96.2% (n=52) | 51.3% / 79.1% (n=43) | 68.6% / 89.9% (n=69) | 95.0% / 92.1% (n=621) |
| untouched, conforming | baseline/E | evidence | 11.5% / 18.0% (n=278) | 28.7% / 30.6% (n=157) | 49.5% / 62.0% (n=92) | 69.2% / 84.5% (n=84) | 95.6% / 85.0% (n=147) |
| untouched, conforming | baseline/E | joint | 8.5% / 17.4% (n=414) | 28.2% / 36.4% (n=140) | 49.8% / 64.0% (n=100) | 69.6% / 88.6% (n=70) | 93.9% / 77.3% (n=132) |
| untouched, conforming | quote/E | value | 11.5% / 92.9% (n=28) | 30.1% / 95.5% (n=22) | 52.2% / 60.0% (n=15) | 67.9% / 88.5% (n=26) | 94.4% / 93.2% (n=206) |
| untouched, conforming | quote/E | evidence | 10.9% / 25.3% (n=75) | 28.1% / 32.9% (n=73) | 50.0% / 65.9% (n=41) | 67.9% / 80.0% (n=30) | 95.1% / 97.5% (n=40) |
| untouched, conforming | quote/E | joint | 6.9% / 19.7% (n=132) | 28.7% / 41.2% (n=68) | 50.2% / 70.7% (n=41) | 69.0% / 87.0% (n=23) | 93.6% / 90.9% (n=33) |

## Observed generation plus core-scoring latency

Seconds; empirical nearest-rank quantiles, with one observation per source/arm. All-output cohorts include recovered diagnostic failures. One-time PDF parsing, warmed reranker loading, risk-sidecar computation and outcome serialization are excluded. E sums measured extraction/mapping and core scoring; quote-only adds no reranker call. Broader workflow spans, including risk and audit-file work, are reported in [WORKFLOW_TIMINGS.md](WORKFLOW_TIMINGS.md) with timestamp provenance.

| cohort | arm | n | p50 | p95 | p99 |
|---|---|---:|---:|---:|---:|
| all outputs | baseline/E | 4 | 722.075 | 2144.313 | 2144.313 |
| all outputs | quote/E | 2 | 1296.962 | 3117.749 | 3117.749 |
| all outputs | quote/quote-only | 2 | 1051.645 | 2007.475 | 2007.475 |
| conforming | baseline/E | 3 | 722.075 | 2144.313 | 2144.313 |
| conforming | quote/E | 1 | 1296.962 | 1296.962 | 1296.962 |
| conforming | quote/quote-only | 1 | 1051.645 | 1051.645 | 1051.645 |
| untouched, all outputs | baseline/E | 3 | 722.075 | 1372.308 | 1372.308 |
| untouched, all outputs | quote/E | 1 | 1296.962 | 1296.962 | 1296.962 |
| untouched, all outputs | quote/quote-only | 1 | 1051.645 | 1051.645 | 1051.645 |
| untouched, conforming | baseline/E | 2 | 670.488 | 722.075 | 722.075 |
| untouched, conforming | quote/E | 1 | 1296.962 | 1296.962 | 1296.962 |
| untouched, conforming | quote/quote-only | 1 | 1051.645 | 1051.645 | 1051.645 |

## Labeling and adjudication

Counts refer to anonymized distinct claims shared across extraction arms, so they need not equal summed arm counts. These are model judgments, not human ground truth; missing artifacts are shown as unknown.

| family | labeler A | labeler B | disagreements | adjudicated | final | unresolved | provenance |
|---|---:|---:|---:|---:|---:|---:|---|
| beier | 1116 | 1116 | 187 | 187 | 1116 | 3 | [blind/beier/](blind/beier/) |
| bosch | 438 | 438 | 66 | 66 | 438 | 0 | [blind/bosch/](blind/bosch/) |
| kirsch | 597 | 597 | 61 | 61 | 597 | 0 | [blind/kirsch/](blind/kirsch/) |
| wiermann | 536 | 536 | 12 | 12 | 536 | 2 | [blind/wiermann/](blind/wiermann/) |

Full family/macro/pooled diagnostics, review@1/3/5, reliability bins, risk/coverage and observed latency quantiles: `evaluation.json`.
Quote-only review order was frozen before holdout labels in `review-order.json`; ordinal priorities are not probabilities.

- Four source families; empirical tails are not production latency estimates.
- Value-support rates evaluate emitted populated scalars; they do not measure recall of source attributes omitted or returned null.
- Strictly untouched summaries include only families marked untouched by the source-only overlap audit; transfer and pending families remain in all-family results.
- Attempt totals count each physical extraction once; quote/E and quote-only reuse the same extraction. Unknown failed-run token usage remains unknown.
- All-output summaries retain every labeled value recovered from a typed over-record-limit failure as diagnosticOnly. Conforming summaries exclude those outputs; original attempts and failure counts remain failed.
- Extraction latency excludes one-time PDF parsing and warmed reranker model loading; E includes its measured per-Extraction grounding time.
- A supported value without canonical gold anchors is reported as evidence loss, not a semantic extraction error.
- First-20 scope diagnostics compare source-manifest counts and literal catalogue IDs; matching is not proof of record eligibility or subrecord identity.
- Conforming summaries mean runner-valid completion, types and record limit; they do not certify correct first-20 record selection.
- Labels are independent model judgments with adjudication, not human ground truth.
- Correct evidence requires exact equality with an acceptable anchor set; partial or broader sets do not count.
- Core phase latency sums generation/mapping and E scoring; it excludes risk-sidecar computation and outcome serialization. WORKFLOW_TIMINGS.md reports broader observed file-boundary spans with archived timestamps and hashes; neither is a single integrated production request.
- E reports proposed best candidates, including candidates below legacy acceptance thresholds; none are auto-accepted.
- Separate routing summaries report the frozen linked/review/abstain decisions and correctness of linkedAnchorId; best-candidate proposal metrics do not replace them.
- Quote-only review@1/3/5 uses the pre-label frozen ordinal status order; coverage reverses that priority. Quote-only Brier and reliability are unavailable because no probability is assigned.
- Failed extraction: beier/quote: Error: Result exceeds 20 burial records
- Failed extraction: wiermann/quote: Error: Incomplete generation: length
- Failed extraction: bosch/baseline: Error: Result exceeds 20 burial records
- Failed extraction: bosch/quote: Error: Incomplete generation: length
