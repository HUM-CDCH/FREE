# Neural model benchmark — reranking

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: reranked with rich claims
- candidate scope: all lexical hits
- abstain threshold: -9.375000
- containment cap: 0.25
- auto-accept threshold: 0.562500
- links below the auto-accept threshold count as review, not supported or wrong

| split | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dev | 194/194 | 232/294 | 151/195 | 81/99 | 40 | 11 | 151/162 | 74%–83% | 88%–96% | 83 |
| validation | 87/87 | 85/128 | 59/88 | 26/40 | 38 | 4 | 59/63 | 58%–74% | 85%–98% | 62 |
| all | 281/281 | 317/422 | 210/283 | 107/139 | 78 | 15 | 210/225 | 71%–79% | 89%–96% | 66 |

Validation wrong-link gate: PASS

## Requested-split document results

| document | correct decisions | review | wrong links |
|---|---:|---:|---:|
| 1790-06-17-1 | 2/5 | 3 | 0 |
| age-related-disease | 17/23 | 4 | 2 |
| brondbylund | 15/23 | 5 | 2 |
| catfish-collagen | 20/24 | 3 | 1 |
| desnz-annual-report-2024-25-en | 19/20 | 1 | 0 |
| ellekilde | 12/17 | 4 | 1 |
| espana-en-cifras-2025-es | 20/20 | 0 | 0 |
| eurostat-key-figures-2025-de | 19/22 | 1 | 2 |
| fed-monetary-policy-report-2025-06-en | 19/21 | 1 | 1 |
| free-ports-hamburg | 12/16 | 3 | 1 |
| herredsvejen | 16/30 | 14 | 0 |
| hojbakkegaard | 18/22 | 3 | 1 |
| hvissinge | 18/25 | 5 | 1 |
| insee-bilan-demographique-2025-fr | 19/22 | 1 | 2 |
| istat-ambiente-2025-it | 8/23 | 9 | 1 |
| katrinesminde | 14/26 | 12 | 0 |
| nederland-in-cijfers-2024-nl | 12/21 | 4 | 0 |
| polska-w-liczbach-2025-pl | 18/21 | 3 | 0 |
| suomi-lukuina-2025-fi | 19/21 | 2 | 0 |
| us-census-income-2024-en | 20/20 | 0 | 0 |

Peak device VRAM in use: 8.32 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.85 GiB
Thresholds were supplied explicitly; this run performed no calibration.
