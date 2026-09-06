# Neural model benchmark — 6-fold cross-validation

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: linked directly
- sibling gate: off
- bare-number row pruning: off
- all-value row pruning: off
- latency: whole path per claim (lexical scan and scorer) after a one-off anchor normalization per document (index ms)
- candidate scope: all lexical hits
- containment cap: 0.25
- links below the auto-accept threshold count as review, not supported or wrong
- documents: 6 from `final_dataset_3`

| fold | documents | abstain | accept | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median ms | p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | buchvaldek-1970-vikletice-tables-de | -1.429687 | 1.0000 | 44/44 | 26/60 | 26/59 | 0/1 | 10 | 10 | 26/36 | 32%–56% | 56%–84% | 100 | 339 |
| 2 | buchvaldek-koutecky-1972-vikletice-de | -1.429687 | 1.0000 | 0/0 | 60/60 | 1/1 | 59/59 | 0 | 0 | 1/1 | 94%–100% | 21%–100% | 990 | 1216 |
| 3 | conrad-2011-bbc-graves-de | -1.429687 | 1.0000 | 15/16 | 43/60 | 35/47 | 8/13 | 6 | 6 | 35/41 | 59%–81% | 72%–93% | 10 | 371 |
| 4 | dobes-1998-kugelamphoren-de | -2.406250 | 1.0000 | 16/16 | 37/60 | 25/34 | 12/26 | 3 | 15 | 25/40 | 49%–73% | 47%–76% | 18 | 174 |
| 5 | durankulak-catalogue-de | -1.429687 | 1.0000 | 21/34 | 24/60 | 24/58 | 0/2 | 10 | 5 | 24/29 | 29%–53% | 65%–92% | 65 | 2686 |
| 6 | shbat-2009-skeletal-health-en | -4.750000 | 1.0000 | 39/40 | 44/60 | 43/57 | 1/3 | 4 | 5 | 43/48 | 61%–83% | 78%–95% | 42 | 127 |
| **pooled** | all | — | — | 135/150 | 234/360 | 154/256 | 80/104 | 33 | 41 | 154/195 | 60%–70% | 73%–84% | 52 | 1208 |

## Document results (thresholds from the document's own fold)

| document | fold | correct decisions | review | wrong links | median ms | p95 ms | index ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 1 | 26/60 | 10 | 10 | 100 | 339 | 93 |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 60/60 | 0 | 0 | 990 | 1216 | 46 |
| conrad-2011-bbc-graves-de | 3 | 43/60 | 6 | 6 | 10 | 371 | 49 |
| dobes-1998-kugelamphoren-de | 4 | 37/60 | 3 | 15 | 18 | 174 | 66 |
| durankulak-catalogue-de | 5 | 24/60 | 10 | 5 | 65 | 2686 | 215 |
| shbat-2009-skeletal-health-en | 6 | 44/60 | 4 | 5 | 42 | 127 | 27 |

Peak device VRAM in use: 4.42 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.85 GiB
Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds.
