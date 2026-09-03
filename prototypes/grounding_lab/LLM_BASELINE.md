# LLM grounding baseline — qwen3.8:27b, thinking, on the DGX Spark

Generated 2026-09-02 by `grounding_lab.llm_baseline` (incumbent-shaped
prompt: bare values under opaque labels, bracketed anchor listing, one call
per record). `OLLAMA_HOST` pointed at the Spark; `--think`; temperature 0;
`num_ctx` sized from the prompt (see `llm_baseline.py`).

Scope: 18 of the 20 documents, 342 of 382 claims. `desnz-annual-report-2024-25-en`
(12 285 anchors, ~600k prompt tokens) and `us-census-income-2024-en`
(14 609 anchors, ~1M tokens) exceed the model's 262 144-token context and
cannot be grounded under the single-prompt protocol that production also uses.

| set | claims | links | correct abstains | wrong links | protocol failures | avg ms/claim |
|---|---:|---:|---:|---:|---:|---:|
| `dataset` (10 docs) | 182 | 130/133 | 47/49 | 5 | 0 | 9 596 |
| `final_dataset` (3 of 5 docs) | 60 | 45/45 | 15/15 | 0 | 0 | 3 883 |
| `final_dataset_2` (5 docs) | 100 | 48/75 | 24/25 | 28 | 0 | 13 669 |
| **pooled** | **342** | **223/253** | **86/89** | **33** | **0** | **≈9 800** |

Policy E with Nemotron 1B on the same 18 documents (from the 5-fold report):
332/342 correct, 0 wrong, 8 review, 2 missed, 62 ms median neural time.

All 28 wrong links in `final_dataset_2` pick a table row label or header
("Número de nacimientos", "Ludność w tys.", "Total assets") instead of the
cell that holds the value; none of the picked anchors contains the claimed
value. The `dataset` misses are the Poul Kragh collision, the near-variant
"Merete"/"Merethe" trap, two free-ports years and one author name.


## LLM baseline (qwen3.8:27b, 37 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| qwen3.8:27b | 130/133 | 47/49 | 5 | 0 | 9596 |

### Misses

| doc | claim | LLM pick |
|---|---|---|
| age-related-disease | Kathryn E. Marklein | ✗ anchor_233d1ab87aa |
| free-ports-hamburg | 1591 | ✗ anchor_b771fc1a940 |
| free-ports-hamburg | 1706 | ✗ anchor_e1eee399279 |
| herredsvejen | Poul Kragh | ✗ anchor_c0395884a7d |
| herredsvejen | Merete Schifter Bagge | ✗ anchor_30e2ff5d0f8 |


## LLM baseline (qwen3.8:27b, 3 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| qwen3.8:27b | 45/45 | 15/15 | 0 | 0 | 3883 |

### Misses

| doc | claim | LLM pick |
|---|---|---|


## LLM baseline (qwen3.8:27b, 5 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| qwen3.8:27b | 48/75 | 24/25 | 28 | 0 | 13669 |

### Misses

| doc | claim | LLM pick |
|---|---|---|
| espana-en-cifras-2025-es | 48.619.695 | ✗ anchor_2b0a14e8a54 |
| espana-en-cifras-2025-es | 320.656 | ✗ anchor_d3f6db988ee |
| espana-en-cifras-2025-es | 1,12 | ✗ anchor_d11395d569f |
| espana-en-cifras-2025-es | 436.124 | ✗ anchor_b030e5e575b |
| espana-en-cifras-2025-es | 83,77 años | ✗ anchor_e9f3ec43caf |
| espana-en-cifras-2025-es | 172.430 | ✗ anchor_919d421e6d5 |
| espana-en-cifras-2025-es | 128 litros | ✗ anchor_f2cde1b09f4 |
| espana-en-cifras-2025-es | 505.983 | ✗ anchor_9a35a245d66 |
| espana-en-cifras-2025-es | 83.445,0 | ✗ anchor_34372dc092d |
| espana-en-cifras-2025-es | 52,0% | ✗ anchor_df9b07b7a22 |
| fed-monetary-policy-report-2025-06-en | 4,212 | ✗ anchor_a1176bd1ab9 |
| fed-monetary-policy-report-2025-06-en | 6,677 | ✗ anchor_ef508827b94 |
| fed-monetary-policy-report-2025-06-en | -344 | ✗ anchor_5bb11daa501 |
| fed-monetary-policy-report-2025-06-en | 2.4 percent | ✗ anchor_336c6bd420c |
| polska-w-liczbach-2025-pl | 37 489 | ✗ anchor_be423be8d9d |
| polska-w-liczbach-2025-pl | 2 477 | ✗ anchor_a943af55342 |
| polska-w-liczbach-2025-pl | 1 864 | ✗ anchor_bc9370ad19e |
| polska-w-liczbach-2025-pl | 43,3 | ✗ anchor_716ebbbfdbf |
| polska-w-liczbach-2025-pl | 6,7 | ✗ anchor_89614006670 |
| polska-w-liczbach-2025-pl | -4,2 | ✗ anchor_b4a90d4fbba |
| polska-w-liczbach-2025-pl | 8 181,72 | ✗ anchor_40df83c14ae |
| polska-w-liczbach-2025-pl | 1 512,2 | ✗ anchor_c613413baf8 |
| polska-w-liczbach-2025-pl | 3 167,17 | ✗ anchor_4cae1c550fd |
| polska-w-liczbach-2025-pl | 2,41 | ✗ anchor_2eccee3b8b8 |
| polska-w-liczbach-2025-pl | 102,9 | ✗ anchor_ef4de22e4e4 |
| polska-w-liczbach-2025-pl | 1 491 700 | ✗ anchor_4ef6d9cf988 |
| polska-w-liczbach-2025-pl | 119 | ✗ anchor_21157b98fa4 |
| polska-w-liczbach-2025-pl | 2 499 | ✗ anchor_57e7c7400c4 |
