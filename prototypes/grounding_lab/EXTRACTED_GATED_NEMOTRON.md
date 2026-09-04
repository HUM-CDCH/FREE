# Neural model benchmark — reranking

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
- abstain threshold: -9.375000
- containment cap: 0.25
- auto-accept threshold: 0.562500
- links below the auto-accept threshold count as review, not supported or wrong

| split | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dev | 121/134 | 233/360 | 155/256 | 78/104 | 39 | 52 | 155/207 | 60%–69% | 69%–80% | 15 | 366 |
| validation | 0/0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0/0 | 0%–100% | 0%–100% | 0 | 0 |
| all | 121/134 | 233/360 | 155/256 | 78/104 | 39 | 52 | 155/207 | 60%–69% | 69%–80% | 15 | 366 |

Validation wrong-link gate: PASS

## Requested-split document results

| document | correct decisions | review | wrong links | median ms | p95 ms | index ms |
|---|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 26/60 | 10 | 13 | 52 | 222 | 47 |
| buchvaldek-koutecky-1972-vikletice-de | 58/60 | 1 | 1 | 6 | 7 | 27 |
| conrad-2011-bbc-graves-de | 42/60 | 7 | 6 | 5 | 357 | 25 |
| dobes-1998-kugelamphoren-de | 39/60 | 5 | 15 | 9 | 150 | 36 |
| durankulak-catalogue-de | 24/60 | 10 | 9 | 32 | 2614 | 122 |
| shbat-2009-skeletal-health-en | 44/60 | 6 | 8 | 22 | 148 | 16 |

Peak device VRAM in use: 4.23 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.66 GiB
Thresholds were supplied explicitly; this run performed no calibration.
