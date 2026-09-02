# Neural model benchmark — reranking

> **Diagnostic only.** The exact frozen runner is unrecoverable, so this is not
> adoption evidence. See `FINAL_TEST_SOURCES_2.md` and `MODEL_REPORT.md`.

Generated 2026-09-02 by `grounding_lab.model_benchmark`.

- retriever: `mini` — `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (not loaded: hit-set candidates with zero-hit abstain never retrieve)
- reranker: `qwen-0.6b` — `Qwen/Qwen3-Reranker-0.6B@e61197ed45024b0ed8a2d74b80b4d909f1255473`
- claim mode: `rich-hitset`
- candidates: `hitset`
- zero-hit claims: `abstain`
- K: 30
- abstain threshold: -∞
- containment cap: 0.25
- auto-accept threshold: 1.000000

| split | recall@30 | correct decisions | correct links | correct abstains | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| final | 27/27 | 99/100 | 74/75 | 25/25 | 1 | 62/62 | 95%–100% | 94%–100% | 144 |

## Requested-split document results

| document | correct decisions | wrong links |
|---|---:|---:|
| espana-en-cifras-2025-es | 20/20 | 0 |
| fed-monetary-policy-report-2025-06-en | 19/20 | 1 |
| nederland-in-cijfers-2024-nl | 20/20 | 0 |
| polska-w-liczbach-2025-pl | 20/20 | 0 |
| suomi-lukuina-2025-fi | 20/20 | 0 |

Peak device VRAM in use: 3.28 GiB (whole-device sample)
Peak PyTorch CUDA reservation: 1.71 GiB
Thresholds were supplied explicitly; this run performed no calibration.
