# Neural model benchmark — 6-fold cross-validation

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: linked directly
- sibling gate: on (window 3 anchors on the page, siblings of 3+ characters; a single hit sharing no sibling value goes to review, a bare number links only through a sibling-supported hit)
- latency: whole path per claim (lexical scan and scorer) after a one-off anchor normalization per document (index ms)
- candidate scope: all lexical hits
- containment cap: 0.25
- links below the auto-accept threshold count as review, not supported or wrong
- documents: 6 from `final_dataset_3`

| fold | documents | abstain | accept | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median ms | p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | buchvaldek-1970-vikletice-tables-de | 0.878906 | 1.0000 | 32/32 | 22/60 | 22/59 | 0/1 | 10 | 8 | 22/30 | 26%–49% | 56%–86% | 52 | 221 |
| 2 | buchvaldek-koutecky-1972-vikletice-de | -1.429687 | 1.0000 | 0/0 | 58/60 | 0/1 | 58/59 | 1 | 1 | 0/1 | 89%–99% | 0%–79% | 6 | 7 |
| 3 | conrad-2011-bbc-graves-de | -1.429687 | 1.0000 | 15/16 | 42/60 | 34/47 | 8/13 | 8 | 5 | 34/39 | 57%–80% | 73%–94% | 4 | 354 |
| 4 | dobes-1998-kugelamphoren-de | -2.453125 | 1.0000 | 16/16 | 37/60 | 25/34 | 12/26 | 4 | 14 | 25/39 | 49%–73% | 48%–77% | 9 | 156 |
| 5 | durankulak-catalogue-de | 4.156250 | 1.0000 | 21/32 | 21/60 | 21/58 | 0/2 | 10 | 4 | 21/25 | 24%–48% | 65%–94% | 31 | 2619 |
| 6 | shbat-2009-skeletal-health-en | -∞ | 1.0000 | 37/38 | 44/60 | 43/57 | 1/3 | 8 | 7 | 43/50 | 61%–83% | 74%–93% | 22 | 151 |
| **pooled** | all | — | — | 121/134 | 224/360 | 145/256 | 79/104 | 41 | 39 | 145/184 | 57%–67% | 72%–84% | 16 | 381 |

## Document results (thresholds from the document's own fold)

| document | fold | correct decisions | review | wrong links | median ms | p95 ms | index ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 1 | 22/60 | 10 | 8 | 52 | 221 | 46 |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 58/60 | 1 | 1 | 6 | 7 | 27 |
| conrad-2011-bbc-graves-de | 3 | 42/60 | 8 | 5 | 4 | 354 | 25 |
| dobes-1998-kugelamphoren-de | 4 | 37/60 | 4 | 14 | 9 | 156 | 35 |
| durankulak-catalogue-de | 5 | 21/60 | 10 | 4 | 31 | 2619 | 122 |
| shbat-2009-skeletal-health-en | 6 | 44/60 | 8 | 7 | 22 | 151 | 16 |

Peak device VRAM in use: 4.23 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.66 GiB
Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds.
