# Slopo blind-validation result

Decision: **FAIL**

Holdout: installed fastapi `0.139.2` production source, 48 files and 332 indexed units.

Frozen configuration SHA-256: `db8b82f0e1bcf1334fcdb05df6e5c3ce60bc066b3ca6b0ba8362458c0767953c`

The model thresholds, dimensions, fusion cutoff, candidate pool, and acceptance rule were frozen before model output was reviewed. No planted fixtures or holdout threshold tuning were used.

| Ranking | Returned | Reviewed | Positives | Unknown | Reviewed precision |
|---|---:|---:|---:|---:|---:|
| pplx baseline P@20 | 20 | 20 | 6 | 0 | 30.0% |
| consensus P@20 | 20 | 20 | 5 | 0 | 25.0% |

Acceptance requires at least 20 consensus candidates, all first 20 reviewed, and at least 90.0% precision.

Completed blinded reviews: 29.

## Post-unblinding audit

Consensus moved 7 manually rejected pplx top-20 candidate(s) below the review cutoff.

It changed 9 of 20 slots: the entering candidates contained 1 positive(s) and 8 negative(s), while the displaced candidates contained 2 positive(s) and 7 negative(s).

Confirmed positives in the consensus top 20 without a matching primary-model top-50 cluster: 0.
