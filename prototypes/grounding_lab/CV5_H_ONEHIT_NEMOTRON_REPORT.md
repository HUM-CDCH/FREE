# Neural model benchmark — 5-fold cross-validation

Generated 2026-09-02 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: reranked with rich claims
- candidate scope: all lexical hits
- containment cap: 0.25
- links below the auto-accept threshold count as review, not supported or wrong
- documents: 20 from `dataset`, `final_dataset`, `final_dataset_2`

| fold | documents | abstain | accept | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1790-06-17-1, ellekilde, herredsvejen, katrinesminde | -∞ | 0.4961 | 51/51 | 43/68 | 27/51 | 16/17 | 25 | 0 | 27/27 | 51%–74% | 88%–100% | 25 |
| 2 | age-related-disease, espana-en-cifras-2025-es, hojbakkegaard, nederland-in-cijfers-2024-nl | -9.375000 | 0.4121 | 57/57 | 64/78 | 43/57 | 21/21 | 9 | 0 | 43/43 | 72%–89% | 92%–100% | 44 |
| 3 | brondbylund, eurostat-key-figures-2025-de, hvissinge, polska-w-liczbach-2025-pl | -9.375000 | 0.4121 | 57/57 | 69/81 | 47/59 | 22/22 | 10 | 0 | 47/47 | 76%–91% | 92%–100% | 38 |
| 4 | catfish-collagen, fed-monetary-policy-report-2025-06-en, insee-bilan-demographique-2025-fr, suomi-lukuina-2025-fi | -9.375000 | 0.4121 | 62/62 | 78/82 | 58/62 | 20/20 | 4 | 0 | 58/58 | 88%–98% | 94%–100% | 42 |
| 5 | desnz-annual-report-2024-25-en, free-ports-hamburg, istat-ambiente-2025-it, us-census-income-2024-en | -9.375000 | 0.4121 | 54/54 | 57/73 | 38/54 | 19/19 | 11 | 0 | 38/38 | 67%–86% | 91%–100% | 196 |
| **pooled** | all | — | — | 281/281 | 311/382 | 213/283 | 98/99 | 59 | 0 | 213/213 | 77%–85% | 98%–100% | 37 |

## Document results (thresholds from the document's own fold)

| document | fold | correct decisions | review | wrong links |
|---|---:|---:|---:|---:|
| 1790-06-17-1 | 1 | 2/5 | 3 | 0 |
| ellekilde | 1 | 12/15 | 3 | 0 |
| herredsvejen | 1 | 16/25 | 9 | 0 |
| katrinesminde | 1 | 13/23 | 10 | 0 |
| age-related-disease | 2 | 18/21 | 3 | 0 |
| espana-en-cifras-2025-es | 2 | 20/20 | 0 | 0 |
| hojbakkegaard | 2 | 15/17 | 2 | 0 |
| nederland-in-cijfers-2024-nl | 2 | 11/20 | 4 | 0 |
| brondbylund | 3 | 14/18 | 3 | 0 |
| eurostat-key-figures-2025-de | 3 | 19/20 | 1 | 0 |
| hvissinge | 3 | 18/23 | 4 | 0 |
| polska-w-liczbach-2025-pl | 3 | 18/20 | 2 | 0 |
| catfish-collagen | 4 | 20/22 | 2 | 0 |
| fed-monetary-policy-report-2025-06-en | 4 | 19/20 | 1 | 0 |
| insee-bilan-demographique-2025-fr | 4 | 20/20 | 0 | 0 |
| suomi-lukuina-2025-fi | 4 | 19/20 | 1 | 0 |
| desnz-annual-report-2024-25-en | 5 | 19/20 | 1 | 0 |
| free-ports-hamburg | 5 | 11/13 | 2 | 0 |
| istat-ambiente-2025-it | 5 | 7/20 | 8 | 0 |
| us-census-income-2024-en | 5 | 20/20 | 0 | 0 |

Peak device VRAM in use: 4.43 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.85 GiB
Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds.
