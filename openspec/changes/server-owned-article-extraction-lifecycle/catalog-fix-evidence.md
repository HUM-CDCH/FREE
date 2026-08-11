# Catalog hierarchy and production-path verification

Follow-up to [`provider-gate-solution-space.md`](provider-gate-solution-space.md). These checks exercised the implemented server-owned operation with zero automatic retries and the existing Ollama `num_ctx: 32768` / `num_predict: 8192` limits.

## Deterministic checks

- The retained Zhang flat-heading fixture publishes 27 headings as 7 level-1, 18 level-2, and 2 level-3 headings.
- Exact boundary tests reject unknown, duplicate, non-monotonic, wrong-level, and terminally invalid starts without fuzzy matching or fallback.
- The candidate compiler retains the four top-level numbered Zhang sections and the seven `Grav N` Beretning headings while excluding nested/spurious headings.
- Catalog tests cover valid empty discovery, ordered assembly, partial record failure, zero automatic retry, and the 100-record execution limit.

## Focused live Ollama smokes

Provider: `hf.co/numind/NuExtract3-GGUF:Q4_K_M` through the real `POST /api/extractions` orchestration seam.

| Source | Strategy | Exact records | Model calls | Complete | Reviewable | Observed latency |
|---|---|---:|---:|---:|---:|---:|
| Bundled one-record fixture | Article | 1/1 | 2 | yes | yes | 1.5 s |
| Compact two-section fixture | Catalog | 2/2 | 5 | yes | yes | 2.6 s |
| Retained Zhang canonical content with corrected published levels | Catalog | 4/4 | 9 | yes | yes | 6.0 s |
| Retained Beretning canonical content | Catalog | 7/7 | 15 | yes | yes | 9.9 s |

Zhang starts were exactly `1. Introduction`, `2. Materials and Methods`, `3. Results and Discussion`, and `4. Conclusions`. Beretning starts and grounded values were exactly graves 8, 13, 24, 26, 28, 30, and 31. No smoke retried, switched strategy/provider, increased the output cap, or accepted an invalid boundary.

These are focused release smokes, not population estimates. The deterministic suites remain the blocking regression signal.
