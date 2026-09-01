# Calibration report (config: lexical+ce-bare)

Generated 2026-09-01 by `pnpm --filter grounding-lab calibrate` — do not hand-edit.

dev: 5 docs, 67 claims — held-out: 5 docs, 110 claims

## Bi-encoder shortlist recall@K (neural-fallback linkable claims)

| K | dev | held-out |
|---|---|---|
| 5 | 11/17 | 16/25 |
| 10 | 13/17 | 17/25 |
| 20 | 13/17 | 22/25 |
| 30 | 13/17 | 24/25 |
| 50 | 14/17 | 24/25 |

## Dev sweep (top 5 by correct decisions, then fewest wrong links)

| K | abstain | cap | accept | links | abstains | wrong | auto |
|---|---|---|---|---|---|---|---|
| 10 | 0.7 | 0.1 | 0.3 | 39/44 | 21/23 | 2 | 29/29 |
| 10 | 0.7 | 0.25 | 0.3 | 39/44 | 21/23 | 2 | 29/29 |
| 10 | 0.7 | 0.4 | 0.3 | 39/44 | 21/23 | 2 | 29/29 |
| 20 | 0.7 | 0.1 | 0.3 | 39/44 | 21/23 | 2 | 28/28 |
| 20 | 0.7 | 0.25 | 0.3 | 39/44 | 21/23 | 2 | 28/28 |

Chosen on dev: K=10, abstain=0.7, cap=0.1, auto-accept=0.3
Incumbent:     K=10, abstain=0.5, cap=0.25, auto-accept=0.5

## Held-out results

| constants | links | abstains | wrong | auto precision | links 95% CI | auto 95% CI |
|---|---|---|---|---|---|---|
| chosen | 72/85 | 19/25 | 6 | 66/66 | 76%–91% | 94%–100% |
| incumbent | 73/85 | 19/25 | 7 | 66/66 | 77%–92% | 94%–100% |

Dev numbers for the same constants:

| constants | links | abstains | wrong | auto precision |
|---|---|---|---|---|
| chosen | 39/44 | 21/23 | 2 | 29/29 |
| incumbent | 40/44 | 19/23 | 5 | 29/29 |
