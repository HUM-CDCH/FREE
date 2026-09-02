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

E-Nemotron is the current policy. Its reviews include the four OCR/PDF-spacing
claims (`Im Dol 2-6`, `Øster Voldgade 5-7`, `Carlos José Dias Pereira`,
`AAR33284`), linked through the whitespace-tolerant fallback at the 0.25 cap,
and the `Poul Kragh` excavation-leader trap, capped because the extraction
claims the value under two fields. The two true paraphrases,
`cirka 1100-900 f.Kr.` and `at least two individuals`, abstain and belong to
the extractor, not the grounder. H routes `Poul Kragh` to review without the
collision signal but sends 58 other links there too, so it is rejected.

A-D, F and G predate the whitespace-tolerant fallback and the review bucket;
their rows are reclassified from the saved aggregates and their per-fold
reports were not kept. Per-fold and per-document detail for E and H:
[`CV5_E_ZEROHIT_RICH_REPORT.md`](CV5_E_ZEROHIT_RICH_REPORT.md),
[`CV5_NEMOTRON_ZEROHIT_RICH_REPORT.md`](CV5_NEMOTRON_ZEROHIT_RICH_REPORT.md),
[`CV5_H_ONEHIT_NEMOTRON_REPORT.md`](CV5_H_ONEHIT_NEMOTRON_REPORT.md).

Model revisions are pinned in `grounding_lab/model_benchmark.py`. Jina is
non-commercial; Liquid uses the LFM Open License v1.0 commercial-use threshold.
