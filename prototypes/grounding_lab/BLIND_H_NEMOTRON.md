# Neural model benchmark — reranking

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: reranked with rich claims
- candidate scope: all lexical hits
- abstain threshold: -9.375000
- containment cap: 0.25
- auto-accept threshold: 0.562500
- links below the auto-accept threshold count as review, not supported or wrong

| split | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dev | 92/101 | 85/164 | 65/116 | 20/48 | 27 | 28 | 65/93 | 44%–59% | 60%–78% | 67 |
| validation | 0/0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0/0 | 0%–100% | 0%–100% | 0 |
| all | 92/101 | 85/164 | 65/116 | 20/48 | 27 | 28 | 65/93 | 44%–59% | 60%–78% | 67 |

Validation wrong-link gate: PASS

## Requested-split document results

| document | correct decisions | review | wrong links |
|---|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 14/25 | 1 | 2 |
| buchvaldek-koutecky-1972-vikletice-de | 18/26 | 4 | 4 |
| conrad-2011-bbc-graves-de | 6/31 | 8 | 9 |
| dobes-1998-kugelamphoren-de | 14/25 | 6 | 1 |
| durankulak-catalogue-de | 17/30 | 5 | 5 |
| shbat-2009-skeletal-health-en | 16/27 | 3 | 7 |

Peak device VRAM in use: 7.80 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.66 GiB
Thresholds were supplied explicitly; this run performed no calibration.
