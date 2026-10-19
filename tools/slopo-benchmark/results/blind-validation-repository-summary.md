# Slopo blind-validation result

Decision: **PASS**

Holdout: pinned slopo repository commit `3bc52539f8b6386707302a2f58e3ab77fbbc73f3`, 138 files and 621 indexed units.

Frozen configuration SHA-256: `a5fcf8fe859effb262162490f7482e62437e184936deafb7cecec8a7fbd6c0d7`

The model thresholds, dimensions, fusion cutoff, candidate pool, and acceptance rule were frozen before model output was reviewed. No planted fixtures or holdout threshold tuning were used.

| Ranking | Returned | Reviewed | Positives | Unknown | Reviewed precision |
|---|---:|---:|---:|---:|---:|
| pplx baseline P@20 | 20 | 20 | 18 | 0 | 90.0% |
| consensus P@20 | 20 | 20 | 19 | 0 | 95.0% |

Acceptance requires at least 20 consensus candidates, all first 20 reviewed, and at least 90.0% precision.

Completed blinded reviews: 28.

## Post-unblinding audit

Consensus moved 1 manually rejected pplx top-20 candidate(s) below the review cutoff.

It changed 8 of 20 slots: the entering candidates contained 8 positive(s) and 0 negative(s), while the displaced candidates contained 7 positive(s) and 1 negative(s).

Confirmed positives in the consensus top 20 without a matching primary-model top-50 cluster: 0.
