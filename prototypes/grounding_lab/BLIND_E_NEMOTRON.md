# Neural model benchmark — reranking

Generated 2026-09-04 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `nemotron-1b` — `nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- strict single hits: linked directly
- candidate scope: all lexical hits
- abstain threshold: -9.375000
- containment cap: 0.25
- auto-accept threshold: 0.562500
- links below the auto-accept threshold count as review, not supported or wrong

| split | hit-set recall | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dev | 55/62 | 91/164 | 72/116 | 19/48 | 13 | 37 | 72/109 | 48%–63% | 57%–74% | 95 |
| validation | 0/0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0/0 | 0%–100% | 0%–100% | 0 |
| all | 55/62 | 91/164 | 72/116 | 19/48 | 13 | 37 | 72/109 | 48%–63% | 57%–74% | 95 |

Validation wrong-link gate: PASS

## Requested-split document results

| document | correct decisions | review | wrong links |
|---|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 14/25 | 1 | 2 |
| buchvaldek-koutecky-1972-vikletice-de | 19/26 | 1 | 6 |
| conrad-2011-bbc-graves-de | 8/31 | 5 | 10 |
| dobes-1998-kugelamphoren-de | 17/25 | 1 | 3 |
| durankulak-catalogue-de | 17/30 | 2 | 9 |
| shbat-2009-skeletal-health-en | 16/27 | 3 | 7 |

Peak device VRAM in use: 7.81 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 2.66 GiB
Thresholds were supplied explicitly; this run performed no calibration.
