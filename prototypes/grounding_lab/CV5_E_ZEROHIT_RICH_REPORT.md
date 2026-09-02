# Neural model benchmark — 5-fold cross-validation

> **Diagnostic only.** This analysis reused both burned final sets and is not
> final or adoption evidence. See `MODEL_REPORT.md`.

Generated 2026-09-02 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `qwen-0.6b` — `Qwen/Qwen3-Reranker-0.6B@e61197ed45024b0ed8a2d74b80b4d909f1255473`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- K: 30
- containment cap: 0.25
- documents: 20 from `dataset`, `final_dataset`, `final_dataset_2`

| fold | documents | abstain | accept | recall@30 | correct decisions | correct links | correct abstains | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1790-06-17-1, ellekilde, herredsvejen, katrinesminde | -∞ | 1.0000 | 11/11 | 66/66 | 50/50 | 16/16 | 0 | 46/46 | 94%–100% | 92%–100% | 90 |
| 2 | age-related-disease, espana-en-cifras-2025-es, hojbakkegaard, nederland-in-cijfers-2024-nl | -∞ | 1.0000 | 19/19 | 76/77 | 55/56 | 21/21 | 0 | 49/49 | 93%–100% | 93%–100% | 126 |
| 3 | brondbylund, eurostat-key-figures-2025-de, hvissinge, polska-w-liczbach-2025-pl | -∞ | 1.0000 | 17/17 | 79/79 | 57/57 | 22/22 | 0 | 54/54 | 95%–100% | 93%–100% | 108 |
| 4 | catfish-collagen, fed-monetary-policy-report-2025-06-en, insee-bilan-demographique-2025-fr, suomi-lukuina-2025-fi | -∞ | 1.0000 | 25/25 | 80/82 | 60/62 | 20/20 | 1 | 48/48 | 92%–99% | 93%–100% | 123 |
| 5 | desnz-annual-report-2024-25-en, free-ports-hamburg, istat-ambiente-2025-it, us-census-income-2024-en | -∞ | 0.5000 | 27/27 | 69/73 | 50/54 | 19/19 | 4 | 46/50 | 87%–98% | 81%–97% | 375 |
| **pooled** | all | — | — | 99/99 | 370/377 | 272/279 | 98/98 | 5 | 243/247 | 96%–99% | 96%–99% | 126 |

## Document results (thresholds from the document's own fold)

| document | fold | correct decisions | wrong links |
|---|---:|---:|---:|
| 1790-06-17-1 | 1 | 5/5 | 0 |
| ellekilde | 1 | 15/15 | 0 |
| herredsvejen | 1 | 23/23 | 0 |
| katrinesminde | 1 | 23/23 | 0 |
| age-related-disease | 2 | 19/20 | 0 |
| espana-en-cifras-2025-es | 2 | 20/20 | 0 |
| hojbakkegaard | 2 | 17/17 | 0 |
| nederland-in-cijfers-2024-nl | 2 | 20/20 | 0 |
| brondbylund | 3 | 17/17 | 0 |
| eurostat-key-figures-2025-de | 3 | 20/20 | 0 |
| hvissinge | 3 | 22/22 | 0 |
| polska-w-liczbach-2025-pl | 3 | 20/20 | 0 |
| catfish-collagen | 4 | 21/22 | 0 |
| fed-monetary-policy-report-2025-06-en | 4 | 19/20 | 1 |
| insee-bilan-demographique-2025-fr | 4 | 20/20 | 0 |
| suomi-lukuina-2025-fi | 4 | 20/20 | 0 |
| desnz-annual-report-2024-25-en | 5 | 20/20 | 0 |
| free-ports-hamburg | 5 | 9/13 | 4 |
| istat-ambiente-2025-it | 5 | 20/20 | 0 |
| us-census-income-2024-en | 5 | 20/20 | 0 |

Peak device VRAM in use: 4.10 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.53 GiB
Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds.
