# Neural evidence-linking model comparison

> **Diagnostic only.** All three datasets have been reused. Adoption needs a
> new frozen set evaluated once from committed code.

Generated 2026-09-02 with `grounding_lab.model_benchmark`; thresholds are the
only fitted quantities. Policy shapes are in [`PIPELINES.md`](PIPELINES.md).

Twenty documents and 382 claims are pooled across `dataset`, `final_dataset`,
and `final_dataset_2`; each fold tunes thresholds on the other four folds.
Links below the fold's accept threshold count as review, neither supported nor
wrong.

| configuration (382 claims) | candidate recall | correct | supported | abstains | review | wrong | auto precision | total 95% CI | neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A MiniLM + BGE, K=10, dense | 40/96 | 273/382 | 187/283 | 86/99 | 40 | 2 | 187/189 | 67%-76% | **53** |
| B MiniLM + Qwen3 0.6B, K=30, dense | 51/96 | 292/382 | 204/283 | 88/99 | 25 | 3 | 204/207 | 72%-80% | 243 |
| C hit-set, bare, zero-hit neural | 95/96 | 285/382 | 216/283 | 69/99 | 74 | 7 | 216/223 | 70%-79% | 186 |
| D hit-set, rich, zero-hit neural | 95/96 | 323/382 | 234/283 | 89/99 | 40 | 2 | 234/236 | 81%-88% | 169 |
| E, Qwen3 0.6B | 95/95 | 343/382 | 245/283 | 98/99 | 35 | 1 | 245/246 | 86%-92% | 75 |
| **E, Nemotron 1B** | 95/95 | **372/382** | **274/283** | 98/99 | **8** | **0** | **274/274** | **95%-99%** | 62 |
| F Jina ColBERT top 10 + Nemotron | **96/96** | 326/382 | 257/283 | 69/99 | 35 | 1 | 257/258 | 81%-89% | **87** |
| F Liquid LFM2.5-ColBERT top 10 + Nemotron | **96/96** | 318/382 | 243/283 | 75/99 | 26 | 1 | 243/244 | 79%-87% | 122 |
| G Liquid LFM2.5-ColBERT top 10 + MiniCheck | **283/283** | 147/382 | 49/283 | **98/99** | 2 | **0** | 49/49 | 34%-43% | 60 |
| H all strict single hits reranked with Nemotron | 281/281 | 311/382 | 213/283 | 98/99 | 59 | **0** | 213/213 | 77%-85% | **37** |

E is the current policy; Qwen3 0.6B is the pinned scorer and Nemotron 1B is
the measured candidate. E-Nemotron's eight reviews are the four OCR/PDF-spacing
claims (`Im Dol 2-6`, `Øster Voldgade 5-7`, `Carlos José Dias Pereira`,
`AAR33284`) linked through the whitespace-tolerant fallback at the 0.25 cap,
the `Poul Kragh` field-collision trap, and three sub-threshold multiple-hit
links. Its two misses, `cirka 1100-900 f.Kr.` and `at least two individuals`,
are paraphrases the document never states: an extractor defect, not a
grounder miss. A-D and F-H are rejected; A-D, F and G were reclassified from
saved aggregates after the review bucket was added. Per-fold detail for E:
[`CV5_E_ZEROHIT_RICH_REPORT.md`](CV5_E_ZEROHIT_RICH_REPORT.md) (Qwen3),
[`CV5_NEMOTRON_ZEROHIT_RICH_REPORT.md`](CV5_NEMOTRON_ZEROHIT_RICH_REPORT.md).

## LLM baseline on the same claims

[`LLM_BASELINE.md`](LLM_BASELINE.md): the incumbent-shaped LLM grounding
(qwen3.8:27b, thinking, DGX Spark) on 18 of the 20 documents scores 223/253
links, 86/89 abstains, 33 wrong links at ≈9.8 s per claim; E-Nemotron on the
same 342 claims scores 332 correct, 0 wrong, 8 review at 62 ms. 28 of the
LLM's wrong links choose a table row label instead of the value cell. The two
remaining documents exceed its 262k context under the single-prompt protocol
production also uses.

Model revisions are pinned in `grounding_lab/model_benchmark.py`.
