# Neural model benchmark — reranking

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: linked directly
- sibling gate: off
- latency: whole path per claim (lexical scan and scorer) after a one-off anchor normalization per document (index ms)
- candidate scope: all lexical hits
- abstain threshold: -9.375000
- containment cap: 0.25
- auto-accept threshold: 0.562500
- links below the auto-accept threshold count as review, not supported or wrong

| split | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dev | 135/150 | 230/360 | 160/256 | 70/104 | 35 | 61 | 160/221 | 59%–69% | 66%–78% | 28 | 1053 |
| validation | 0/0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0/0 | 0%–100% | 0%–100% | 0 | 0 |
| all | 135/150 | 230/360 | 160/256 | 70/104 | 35 | 61 | 160/221 | 59%–69% | 66%–78% | 28 | 1053 |

Validation wrong-link gate: PASS

## Requested-split document results

| document | correct decisions | review | wrong links | median ms | p95 ms | index ms |
|---|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 29/60 | 7 | 16 | 76 | 440 | 46 |
| buchvaldek-koutecky-1972-vikletice-de | 51/60 | 3 | 6 | 882 | 1039 | 27 |
| conrad-2011-bbc-graves-de | 43/60 | 5 | 7 | 4 | 350 | 24 |
| dobes-1998-kugelamphoren-de | 39/60 | 4 | 16 | 9 | 147 | 35 |
| durankulak-catalogue-de | 24/60 | 10 | 8 | 37 | 2577 | 119 |
| shbat-2009-skeletal-health-en | 44/60 | 6 | 8 | 22 | 152 | 16 |

Peak device VRAM in use: 4.42 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.85 GiB
Thresholds were supplied explicitly; this run performed no calibration.
