# Neural model benchmark — 6-fold cross-validation

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: linked directly
- sibling gate: off
- bare-number row pruning: on (repeated bare numbers keep exact-value cells whose own row contains a sibling; singleton hits are untouched)
- all-value row pruning: off
- latency: whole path per claim (lexical scan and scorer) after a one-off anchor normalization per document (index ms)
- candidate scope: all lexical hits
- containment cap: 0.25
- links below the auto-accept threshold count as review, not supported or wrong
- documents: 6 from `final_dataset_3`

| fold | documents | abstain | accept | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median ms | p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | buchvaldek-1970-vikletice-tables-de | 0.878906 | 1.0000 | 44/44 | 24/60 | 24/59 | 0/1 | 7 | 7 | 24/31 | 29%–53% | 60%–89% | 101 | 311 |
| 2 | buchvaldek-koutecky-1972-vikletice-de | -1.429687 | 1.0000 | 0/0 | 60/60 | 1/1 | 59/59 | 0 | 0 | 1/1 | 94%–100% | 21%–100% | 1014 | 1244 |
| 3 | conrad-2011-bbc-graves-de | -1.429687 | 1.0000 | 15/16 | 43/60 | 35/47 | 8/13 | 6 | 6 | 35/41 | 59%–81% | 72%–93% | 9 | 363 |
| 4 | dobes-1998-kugelamphoren-de | -2.406250 | 1.0000 | 16/16 | 37/60 | 25/34 | 12/26 | 3 | 15 | 25/40 | 49%–73% | 47%–76% | 20 | 163 |
| 5 | durankulak-catalogue-de | 4.156250 | 1.0000 | 21/34 | 21/60 | 21/58 | 0/2 | 10 | 3 | 21/24 | 24%–48% | 69%–96% | 62 | 2722 |
| 6 | shbat-2009-skeletal-health-en | -4.750000 | 1.0000 | 39/40 | 43/60 | 42/57 | 1/3 | 5 | 5 | 42/47 | 59%–81% | 77%–95% | 41 | 160 |
| **pooled** | all | — | — | 135/150 | 228/360 | 148/256 | 80/104 | 31 | 36 | 148/184 | 58%–68% | 74%–86% | 51 | 1244 |

## Document results (thresholds from the document's own fold)

| document | fold | correct decisions | review | wrong links | median ms | p95 ms | index ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 1 | 24/60 | 7 | 7 | 101 | 311 | 97 |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 60/60 | 0 | 0 | 1014 | 1244 | 49 |
| conrad-2011-bbc-graves-de | 3 | 43/60 | 6 | 6 | 9 | 363 | 42 |
| dobes-1998-kugelamphoren-de | 4 | 37/60 | 3 | 15 | 20 | 163 | 65 |
| durankulak-catalogue-de | 5 | 21/60 | 10 | 3 | 62 | 2722 | 246 |
| shbat-2009-skeletal-health-en | 6 | 43/60 | 5 | 5 | 41 | 160 | 28 |

Peak device VRAM in use: 4.42 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.85 GiB
Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds.
