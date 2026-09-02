# Neural evidence-linking model comparison

> **Status: diagnostic only.** Final set 2 completed its pre-registered
> one-shot run, but the exact frozen runner was uncommitted and is no longer
> recoverable; the set was later reused for diagnostic cross-validation. No
> result here is adoption evidence. A production decision requires a new frozen
> set evaluated once from committed code.

Generated 2026-09-01/02 with `grounding_lab.model_benchmark`. Thresholds are
the only fitted quantities; no weights are trained. Dev = the five original
`dataset/` documents (tunes thresholds), validation = the five later ones,
final set 2 = completed one shot on frozen thresholds
(`FINAL_TEST_SOURCES_2.md`), CV = later diagnostic 5-fold analysis over all 20
documents. The lexical tier and the 0.25 containment cap are unchanged
throughout.

## Retriever screen (bare scalar queries, validation fallback claims)

| retriever | eligibility | R@10 | R@20 | R@30 | R@50 | median query ms | peak device GiB |
|---|---|---:|---:|---:|---:|---:|---:|
| Jina ColBERT v2 | research-only | **25/25** | **25/25** | **25/25** | **25/25** | 54 | 2.83 |
| MiniLM control | production | 17/25 | 22/25 | 24/25 | 24/25 | 16 | 2.13 |
| Jina v5 small | research-only | 18/25 | 21/25 | 21/25 | 24/25 | 95 | 5.91 |
| Qwen3 8B | production | 19/25 | 19/25 | 19/25 | 24/25 | 125 | 16.44 |
| Qwen3 4B | production | 13/25 | 17/25 | 18/25 | 21/25 | 116 | 10.49 |
| Qwen3 0.6B | production | 13/25 | 14/25 | 17/25 | 21/25 | 93 | 5.91 |

No dense retriever reached 25/25; ColBERT (research-only, custom code pinned
at `bd55a5ec8e6c0fb1d6c26efb4b6a4a74ce8a88d3`, `einops` supplied ephemerally)
did. Reranker pairs were screened for ColBERT and MiniLM.

## Bare reranker screen (dense top-30, dev-tuned thresholds, validation)

Eligible only with at most the incumbent's 7 wrong links; then most correct
decisions, fewest wrong links. Instruction for instruction-aware models:
"Judge whether the candidate passage directly supports the extracted scalar.
Near-variant names, identifiers, dates, units, and numbers are not evidence."

| retriever | reranker | eligibility | correct | links | abstains | wrong | auto precision | neural ms | peak device GiB |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| MiniLM | Qwen3 0.6B | **validation winner** | **97/110** | 75/85 | 22/25 | 4 | 72/72 | 208 | 5.46 |
| MiniLM | BGE v2 m3 | eligible | 96/110 | 74/85 | 22/25 | 3 | 73/75 | 133 | 5.36 |
| ColBERT | BGE v2 m3 | research-only | 96/110 | 76/85 | 20/25 | 5 | 69/72 | 196 | 5.76 |
| ColBERT | Qwen3 0.6B | research-only | 96/110 | 74/85 | 22/25 | 5 | 72/72 | 275 | 7.23 |
| ColBERT | Jina v3.5 | research-only | 95/110 | 73/85 | 22/25 | 3 | 73/76 | 222 | 15.74 |
| MiniLM | Jina v3.5 | research-only | 94/110 | 73/85 | 21/25 | 4 | 73/77 | 132 | 14.09 |
| MiniLM | Qwen3 4B | **gate fail** | 98/110 | 79/85 | 19/25 | 8 | 79/86 | 419 | 10.54 |
| ColBERT | Qwen3 4B | **gate fail / research-only** | 97/110 | 79/85 | 18/25 | 9 | 76/83 | 808 | 11.61 |
| MiniLM | Qwen3 8B | **gate fail** | 89/110 | 68/85 | 21/25 | 8 | 66/66 | 3,041 | 18.96 |
| ColBERT | Qwen3 8B | **gate fail / research-only** | 89/110 | 68/85 | 21/25 | 8 | 64/64 | 3,454 | 20.01 |

Rich claims (field + siblings) on the dense path traded abstention for links
(95/110, 9 wrong), so bare input was frozen for dense configs.

## Policy screen (validation; final set 1 is diagnostic only)

| id | candidates | claim | zero-hit | K | abstain / accept | correct | links | abstains | wrong | auto precision | final set 1 |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---|
| A incumbent MiniLM + BGE | retrieval | bare | neural | 10 | 0.5 / 0.5 | 92/110 | 73/85 | 19/25 | 7 | 66/66 | 61/100, 15 wrong |
| B MiniLM + Qwen3 0.6B | retrieval | bare | neural | 30 | 4.25 / 0.625 | 97/110 | 75/85 | 22/25 | 4 | 72/72 | 69/100, 6 wrong |
| C hit-set | hitset | bare | neural | 30 | 4.25 / 1.0 | 98/110 | 76/85 | 22/25 | 3 | 71/71 | 80/100, 6 wrong |
| D hit-set, rich | hitset | rich-hitset | neural | 30 | 4.25 / 0.5 | 100/110 | 78/85 | 22/25 | 3 | 74/74 | 93/100, 6 wrong |
| **E hit-set, rich, zero-hit abstain** | hitset | rich-hitset | abstain | - | -inf / 1.0 | **108/110** | 83/85 | 25/25 | **0** | 76/76 | 100/100, 0 wrong |

Final set 1 (`final_dataset/`) was replayed after a reporting change and
relabeled after inference, so it cannot support adoption; it remains CV data.

## Final set 2, completed one shot — diagnostic (2026-09-02)

Five newly acquired documents, 100 claims (25 absent/adversarial), sources and
claim hashes frozen before inference; each configuration run once with
explicit thresholds. Recall counts the 27 linkable claims reaching the neural
stage.

The measurements are preserved, but the recorded `model_benchmark.py` hash no
longer matches the working tree and the frozen source was never committed. The
run therefore cannot be reproduced from a recoverable code revision and cannot
support adoption.

| configuration | recall@K | correct | links | abstains | wrong | auto precision | total 95% CI | neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A incumbent: MiniLM + BGE, K=10, dense, bare | 4/27 | 70/100 | 52/75 | 18/25 | 16 | 48/48 | 60%-78% | 48 |
| B MiniLM + Qwen3 0.6B, K=30, dense, bare | 6/27 | 75/100 | 51/75 | 24/25 | 2 | 51/51 | 66%-82% | 111 |
| C hit-set candidates, bare | 27/27 | 84/100 | 60/75 | 24/25 | 1 | 51/51 | 76%-90% | 174 |
| D hit-set candidates, rich-hitset | 27/27 | 88/100 | 64/75 | 24/25 | 1 | 61/61 | 80%-93% | 169 |
| **E hit-set, rich-hitset, zero-hit abstain** | 27/27 | **99/100** | 74/75 | 25/25 | **1** | 62/62 | 95%-100% | 144 |

B-E met the pre-registered numerical gate (more correct decisions than the
incumbent, no more wrong links), and E was the numerical winner. This diagnostic
result does not establish a production candidate. Its wrong link is the Fed
`unemploymentRateMedianProjection2027` cell: every cell in a table row shares
the same row context. Raw output: `FINAL2_E_ZEROHIT_RICH_REPORT.md`.

## Diagnostic 5-fold cross-validation, 20 documents, 377 claims (2026-09-02)

Pooled roots `dataset`, `final_dataset`, `final_dataset_2`; documents dealt
round-robin into five folds of four; each fold's thresholds tuned on the other
four; pooled counts sum the held-out folds. Because both final sets were already
used, this analysis is diagnostic only and is not final or adoption evidence.

| configuration | recall@K | correct | links | abstains | wrong | auto precision | total 95% CI | neural ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A incumbent shape | 41/101 | 290/377 | 205/279 | 85/98 | 14 | 181/181 | 72%-81% | 84 |
| B Qwen3 0.6B, K=30, dense | 51/101 | 301/377 | 213/279 | 88/98 | 13 | 206/207 | 75%-84% | 213 |
| C hit-set, bare | 101/101 | 333/377 | 255/279 | 78/98 | 23 | 220/222 | 85%-91% | 177 |
| D hit-set, rich-hitset | 101/101 | 347/377 | 269/279 | 78/98 | 24 | 238/242 | 89%-94% | 177 |
| **E hit-set, rich-hitset, zero-hit abstain** | 99/99 | **370/377** | 272/279 | **98/98** | **5** | 243/247 | **96%-99%** | 126 |

Hit-set candidates raise fallback recall to 101/101 but, while zero-hit claims
still reach the reranker, add wrong links on absent values (23-24 versus
13-14). Abstaining on zero hits removes them (98/98 abstentions in every
fold); E's 7 missed links are its 5 wrong links plus 2 zero-hit PDF whitespace
artifacts. E's thresholds are stable: abstain -inf in all folds, accept 1.0 in
four; fold 5 picks 0.5 and holds the only auto-accept errors (46/50). The five
wrong links: four on `free-ports-hamburg` (publisher and port/year cells with
9-12 citation hits), one on the Fed projection table. Only E is separated from
every other configuration by its interval. Per-fold and per-document detail:
`CV5_E_ZEROHIT_RICH_REPORT.md`.

## Pinned model revisions

| key | repository | revision |
|---|---|---|
| mini | sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 | e8f8c211226b894fcb81acc59f3b34ba3efd5f42 |
| qwen-embed-0.6b | Qwen/Qwen3-Embedding-0.6B | 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3 |
| qwen-embed-4b | Qwen/Qwen3-Embedding-4B | 5cf2132abc99cad020ac570b19d031efec650f2b |
| qwen-embed-8b | Qwen/Qwen3-Embedding-8B | 1d8ad4ca9b3dd8059ad90a75d4983776a23d44af |
| jina-v5 | jinaai/jina-embeddings-v5-text-small-retrieval | 6856e76bb72982e58de0620458a4e8b3614da340 |
| jina-colbert | jinaai/jina-colbert-v2 | a9dc5cd7293d4c71dbbba04829923ba4d0e4f6ea |
| bge | BAAI/bge-reranker-v2-m3 | 953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e |
| qwen-rerank-0.6b | Qwen/Qwen3-Reranker-0.6B | e61197ed45024b0ed8a2d74b80b4d909f1255473 |
| qwen-rerank-4b | Qwen/Qwen3-Reranker-4B | 22e683669bc0f0bd69640a1354a6d0aebcfeede5 |
| qwen-rerank-8b | Qwen/Qwen3-Reranker-8B | 77d193c791ed757ca307ee72715aa132723da912 |
| jina-rerank-3.5 | jinaai/jina-reranker-v3.5 | e8a93f33f0b22108f8c2364f8484ce3422552fbc |

Jina results are diagnostic only (non-commercial licenses). No production
code or public FREE API was changed.
