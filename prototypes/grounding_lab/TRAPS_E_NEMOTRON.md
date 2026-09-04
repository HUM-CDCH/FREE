# Neural model benchmark — reranking

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: linked directly
- candidate scope: all lexical hits
- abstain threshold: -9.375000
- containment cap: 0.25
- auto-accept threshold: 0.562500
- links below the auto-accept threshold count as review, not supported or wrong

| split | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dev | 69/69 | 264/294 | 190/195 | 74/99 | 5 | 24 | 190/214 | 86%–93% | 84%–92% | 113 |
| validation | 32/32 | 105/128 | 79/88 | 26/40 | 11 | 11 | 79/90 | 74%–88% | 79%–93% | 62 |
| all | 101/101 | 369/422 | 269/283 | 100/139 | 16 | 35 | 269/304 | 84%–90% | 84%–92% | 100 |

Validation wrong-link gate: FAIL (more than 7 validation wrong links)

## Requested-split document results

| document | correct decisions | review | wrong links |
|---|---:|---:|---:|
| 1790-06-17-1 | 5/5 | 0 | 0 |
| age-related-disease | 19/23 | 2 | 2 |
| brondbylund | 17/23 | 0 | 5 |
| catfish-collagen | 21/24 | 1 | 2 |
| desnz-annual-report-2024-25-en | 20/20 | 0 | 0 |
| ellekilde | 15/17 | 0 | 2 |
| espana-en-cifras-2025-es | 20/20 | 0 | 0 |
| eurostat-key-figures-2025-de | 20/22 | 0 | 2 |
| fed-monetary-policy-report-2025-06-en | 20/21 | 0 | 1 |
| free-ports-hamburg | 12/16 | 0 | 4 |
| herredsvejen | 21/30 | 5 | 4 |
| hojbakkegaard | 17/22 | 1 | 4 |
| hvissinge | 21/25 | 2 | 1 |
| insee-bilan-demographique-2025-fr | 20/22 | 0 | 2 |
| istat-ambiente-2025-it | 18/23 | 4 | 1 |
| katrinesminde | 23/26 | 1 | 2 |
| nederland-in-cijfers-2024-nl | 20/21 | 0 | 1 |
| polska-w-liczbach-2025-pl | 20/21 | 0 | 1 |
| suomi-lukuina-2025-fi | 20/21 | 0 | 1 |
| us-census-income-2024-en | 20/20 | 0 | 0 |

Peak device VRAM in use: 8.20 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.85 GiB
Thresholds were supplied explicitly; this run performed no calibration.
