# Neural model benchmark — 5-fold cross-validation

Generated 2026-09-02 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: linked directly
- candidate scope: all lexical hits
- containment cap: 0.25
- links below the auto-accept threshold count as review, not supported or wrong
- documents: 20 from `dataset`, `final_dataset`, `final_dataset_2`

| fold | documents | abstain | accept | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1790-06-17-1, ellekilde, herredsvejen, katrinesminde | -∞ | 0.7500 | 12/12 | 63/68 | 47/51 | 16/17 | 5 | 0 | 47/47 | 84%–97% | 92%–100% | 26 |
| 2 | age-related-disease, espana-en-cifras-2025-es, hojbakkegaard, nederland-in-cijfers-2024-nl | -9.375000 | 0.5625 | 20/20 | 76/78 | 55/57 | 21/21 | 2 | 0 | 55/55 | 91%–99% | 93%–100% | 60 |
| 3 | brondbylund, eurostat-key-figures-2025-de, hvissinge, polska-w-liczbach-2025-pl | -9.375000 | 0.5625 | 17/17 | 79/81 | 57/59 | 22/22 | 0 | 0 | 57/57 | 91%–99% | 94%–100% | 39 |
| 4 | catfish-collagen, fed-monetary-policy-report-2025-06-en, insee-bilan-demographique-2025-fr, suomi-lukuina-2025-fi | -9.375000 | 0.5625 | 26/26 | 81/82 | 61/62 | 20/20 | 1 | 0 | 61/61 | 93%–100% | 94%–100% | 77 |
| 5 | desnz-annual-report-2024-25-en, free-ports-hamburg, istat-ambiente-2025-it, us-census-income-2024-en | -9.375000 | 0.5625 | 20/20 | 73/73 | 54/54 | 19/19 | 0 | 0 | 54/54 | 95%–100% | 93%–100% | 230 |
| **pooled** | all | — | — | 95/95 | 372/382 | 274/283 | 98/99 | 8 | 0 | 274/274 | 95%–99% | 99%–100% | 62 |

## Document results (thresholds from the document's own fold)

| document | fold | correct decisions | review | wrong links |
|---|---:|---:|---:|---:|
| 1790-06-17-1 | 1 | 5/5 | 0 | 0 |
| ellekilde | 1 | 15/15 | 0 | 0 |
| herredsvejen | 1 | 21/25 | 4 | 0 |
| katrinesminde | 1 | 22/23 | 1 | 0 |
| age-related-disease | 2 | 19/21 | 2 | 0 |
| espana-en-cifras-2025-es | 2 | 20/20 | 0 | 0 |
| hojbakkegaard | 2 | 17/17 | 0 | 0 |
| nederland-in-cijfers-2024-nl | 2 | 20/20 | 0 | 0 |
| brondbylund | 3 | 17/18 | 0 | 0 |
| eurostat-key-figures-2025-de | 3 | 20/20 | 0 | 0 |
| hvissinge | 3 | 22/23 | 0 | 0 |
| polska-w-liczbach-2025-pl | 3 | 20/20 | 0 | 0 |
| catfish-collagen | 4 | 21/22 | 1 | 0 |
| fed-monetary-policy-report-2025-06-en | 4 | 20/20 | 0 | 0 |
| insee-bilan-demographique-2025-fr | 4 | 20/20 | 0 | 0 |
| suomi-lukuina-2025-fi | 4 | 20/20 | 0 | 0 |
| desnz-annual-report-2024-25-en | 5 | 20/20 | 0 | 0 |
| free-ports-hamburg | 5 | 13/13 | 0 | 0 |
| istat-ambiente-2025-it | 5 | 20/20 | 0 | 0 |
| us-census-income-2024-en | 5 | 20/20 | 0 | 0 |

Peak device VRAM in use: 4.43 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.85 GiB
Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds.
