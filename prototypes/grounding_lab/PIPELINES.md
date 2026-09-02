# Grounding Lab pipeline views

[`architecture.c4`](architecture.c4) is the executable [LikeC4](https://likec4.dev/)
model for the A-H policy comparison in [`MODEL_REPORT.md`](MODEL_REPORT.md).
It describes the experiment, not FREE's production architecture. From the
repository root:

```bash
pnpm exec likec4 dev prototypes/grounding_lab        # policy_comparison, current_policy_e, ...
pnpm exec likec4 validate prototypes/grounding_lab
```

## Policy key

| Policy | Zero verbatim hits | One verbatim hit | Multiple verbatim hits | Claim | Neural scorer |
|---|---|---|---|---|---|
| A — incumbent shape | MiniLM top 10 | direct link | MiniLM top 10 | bare | BGE v2 m3 reranker |
| B — stronger dense | MiniLM top 30 | direct link | MiniLM top 30 | bare | Qwen3 0.6B reranker |
| C — hit set | MiniLM top 30 | direct link | all lexical hits | bare | Qwen3 0.6B reranker |
| D — rich hit set | MiniLM top 30 | direct link | all lexical hits | bare for zero hits, rich for multiple hits | Qwen3 0.6B reranker |
| E — current policy | whitespace-tolerant hits (capped), else abstain | direct link, unless the value is claimed under two fields (capped) | all lexical hits | rich | Qwen3 0.6B or Nemotron 1B reranker |
| F-Jina — semantic fallback | Jina ColBERT v2 top 10 | direct link | all lexical hits | bare for zero hits, rich for multiple hits | Nemotron 1B reranker |
| F-Liquid — comparison | Liquid LFM2.5-ColBERT top 10 | direct link | all lexical hits | bare for zero hits, rich for multiple hits | Nemotron 1B reranker |
| G — verifier first | Liquid LFM2.5-ColBERT top 10 | verify hit | verify all lexical hits | rich sentence | MiniCheck DeBERTa verifier |
| H — generic single-hit rerank | as E | rerank the hit | all lexical hits | rich | Nemotron 1B reranker |

"Capped" means reranked with the 0.25 non-verbatim cap: the link goes to
review and never auto-accepts. G links only when exactly one candidate clears
its calibrated support threshold (floor 0.5). H keeps the verbatim flag on
single hits, so its calibrated absolute-score gate can abstain while a strong
hit still auto-accepts. E and H never load the dense retriever. F-Jina is
research-only; the Liquid variants use the LFM Open License v1.0 commercial-use
threshold.
