# Neural model benchmark — 5-fold cross-validation

Generated 2026-09-02 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `qwen-0.6b` — `Qwen/Qwen3-Reranker-0.6B@e61197ed45024b0ed8a2d74b80b4d909f1255473`
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
| 1 | 1790-06-17-1, ellekilde, herredsvejen, katrinesminde | -∞ | 1.0000 | 12/12 | 62/68 | 46/51 | 16/17 | 6 | 0 | 46/46 | 82%–96% | 92%–100% | 46 |
| 2 | age-related-disease, espana-en-cifras-2025-es, hojbakkegaard, nederland-in-cijfers-2024-nl | 3.875000 | 0.3125 | 20/20 | 72/78 | 51/57 | 21/21 | 4 | 1 | 51/52 | 84%–96% | 90%–100% | 95 |
| 3 | brondbylund, eurostat-key-figures-2025-de, hvissinge, polska-w-liczbach-2025-pl | -∞ | 1.0000 | 17/17 | 74/81 | 52/59 | 22/22 | 5 | 0 | 52/52 | 83%–96% | 93%–100% | 55 |
| 4 | catfish-collagen, fed-monetary-policy-report-2025-06-en, insee-bilan-demographique-2025-fr, suomi-lukuina-2025-fi | -∞ | 1.0000 | 26/26 | 71/82 | 51/62 | 20/20 | 11 | 0 | 51/51 | 78%–92% | 93%–100% | 73 |
| 5 | desnz-annual-report-2024-25-en, free-ports-hamburg, istat-ambiente-2025-it, us-census-income-2024-en | -∞ | 1.0000 | 20/20 | 64/73 | 45/54 | 19/19 | 9 | 0 | 45/45 | 78%–93% | 92%–100% | 261 |
| **pooled** | all | — | — | 95/95 | 343/382 | 245/283 | 98/99 | 35 | 1 | 245/246 | 86%–92% | 98%–100% | 75 |

## Document results (thresholds from the document's own fold)

| document | fold | correct decisions | review | wrong links |
|---|---:|---:|---:|---:|
| 1790-06-17-1 | 1 | 5/5 | 0 | 0 |
| ellekilde | 1 | 14/15 | 1 | 0 |
| herredsvejen | 1 | 21/25 | 4 | 0 |
| katrinesminde | 1 | 22/23 | 1 | 0 |
| age-related-disease | 2 | 17/21 | 3 | 0 |
| espana-en-cifras-2025-es | 2 | 19/20 | 1 | 0 |
| hojbakkegaard | 2 | 16/17 | 0 | 1 |
| nederland-in-cijfers-2024-nl | 2 | 20/20 | 0 | 0 |
| brondbylund | 3 | 15/18 | 2 | 0 |
| eurostat-key-figures-2025-de | 3 | 20/20 | 0 | 0 |
| hvissinge | 3 | 20/23 | 2 | 0 |
| polska-w-liczbach-2025-pl | 3 | 19/20 | 1 | 0 |
| catfish-collagen | 4 | 19/22 | 3 | 0 |
| fed-monetary-policy-report-2025-06-en | 4 | 16/20 | 4 | 0 |
| insee-bilan-demographique-2025-fr | 4 | 17/20 | 3 | 0 |
| suomi-lukuina-2025-fi | 4 | 19/20 | 1 | 0 |
| desnz-annual-report-2024-25-en | 5 | 18/20 | 2 | 0 |
| free-ports-hamburg | 5 | 10/13 | 3 | 0 |
| istat-ambiente-2025-it | 5 | 20/20 | 0 | 0 |
| us-census-income-2024-en | 5 | 16/20 | 4 | 0 |

Peak device VRAM in use: 4.11 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.54 GiB
Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds.
